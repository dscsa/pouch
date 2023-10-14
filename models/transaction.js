"use strict"
//defaults

//All Google Sheets with old view names
//- Good Pill records
//- Good Pill Live inventory
//- Good Pill V1 V2 Merge
//- Jeff Data Scientist Views

module.exports = exports = Object.create(require('../helpers/model'))

let drug     = require('./drug')
let shipment = require('./shipment')
let csv = require('csv/server')
let crypto = require('crypto')
let admin  = {ajax:{jar:false, auth:{username: process.env.COUCH_USERNAME, password: process.env.COUCH_PASSWORD}}}


exports.lib = {

  qty(doc) {
    return doc.qty.to || doc.qty.from || 0
  },

  price(doc) {
    return doc.drug.price ? doc.drug.price.goodrx || doc.drug.price.nadac || doc.drug.price.retail || 0 : 0
  },

  value(doc) {
    return +(require('price')(doc) * require('qty')(doc)).toFixed(2)
  },

  //For authorization purposes.  Only allow recipients to see their own metrics
  to_id(doc) {
    return doc.shipment && doc.shipment._id && doc.shipment._id.slice(0, 10)
  },

  //Identify the donor (for repacked this is the same as the recipient)
  from_id(doc) {
    return doc.shipment && doc.shipment._id && doc.shipment._id.slice(-10)
  },

  createdAt(doc) {
    return doc._id.slice(0, 10).split('-')
  },

  receivedAt(doc) {
    return doc.shipment && doc.shipment._id && ~ doc.shipment._id.indexOf('.') && doc.shipment._id.slice(11, 21).split('-')
  },

  //Want:
  //1. Logged and refused (next.disposed, no verified, bin === "", or bin === null)
  //2. Logged and verified (verified, bin.length === 4)
  //3. Logged No From/Shipment (next.disposed, bin === "" or bin === null, otherwise looks very similar to autodisposed repack surplus)

  //Do not want:
  //1. Repacked (no verified, bin.length === 3, no shipment) e.g 2019-01-15T14:43:33.378000Z
  //2. Repack Surplus - Autodisposed (next.disposed, bin is undefined, no verified, no shipmentt)

  //doc.verifiedAt because for drugs like 2018-12-04T16:08:34.722200Z and 2019-01-24T17:19:48.798700Z that were bulk entered might not have a receivedAt date
  enteredAt(doc) {

    var receivedAt = require('receivedAt')(doc)
    var createdAt  = require('createdAt')(doc)

    return (doc.verifiedAt || receivedAt) && createdAt
  },

  //MECE breakdown of entered into verified and refused
  verifiedAt(doc) {
    var enteredAt  = require('enteredAt')(doc) //Align it with inventory which used enteredAt
    var expiredAt  = require('expiredAt')(doc)
    return doc.bin && (expiredAt >= enteredAt) && enteredAt
  },

  //MECE breakdown of entered into verified and refused
  refusedAt(doc) {
    var enteredAt = require('enteredAt')(doc) //Align it with inventory which used enteredAt
    var expiredAt = require('expiredAt')(doc)
    return ( ! doc.bin || (expiredAt < enteredAt)) && enteredAt
  },

  //This is when we no longer count the item as part of our inventory because it has expired (even if it hasn't been disposed) or it has a next value (disposed, dispensed, pended, etc)
  //if months is the number of months to subtract. This does not adjust days so subtracting 1 month from March 31st will give Febuaray 31st.
  expiredAt(doc) {
    var createdAt = require('createdAt')(doc)
    var expiredAt = doc.exp.to || doc.exp.from

    if ( ! expiredAt || ! doc.bin) {
      return false
    }

    expiredAt = expiredAt.slice(0, 10).split('-')

    //The inventory's eachMonth() method caps expiration at 10 years so we need to match that here
    if (expiredAt[0] - createdAt[0] > 10) {
        expiredAt[0] = createdAt[0]+10
    }

    return expiredAt
  },

  //MECE breakdown of ! refused (verified + repacked) into disposed, dispensed, pended
  //This category must include any repacking surplus which has bin === undefined (e.g., 2019-01-18T16:09:27.416600Z is incuded because enteredAt is false)
  //and exlude any items without a donor that were refused (e.g., 2019-01-24T17:24:21.063700Z because bin === "")
  disposedAt(doc) {
    return doc.bin && doc.next[0] && doc.next[0].disposed && doc.next[0].disposed._id && doc.next[0].disposed._id.slice(0, 10).split('-')
  },

  minExpiredOrDisposedAt(doc) {

      var disposedAt = require('disposedAt')(doc)
      var expiredAt  = require('expiredAt')(doc)

      //Math.min because items destroyed the month before expiration should be marked as expired rather than disposed
      //verified this works as expected with date ARRAYS
      return expiredAt > disposedAt ? disposedAt : expiredAt
  },

  //MECE breakdown of ! refused (verified + repacked) into disposed, dispensed, pended
  dispensedAt(doc) {
    return doc.bin && doc.next[0] && doc.next[0].dispensed && doc.next[0].dispensed._id && doc.next[0].dispensed._id.slice(0, 10).split('-')
  },


  //Locked when currently being pick if picked === {} so there might not be an _id yet
  pickedAt(doc) {
    return doc.bin && doc.next[0] && doc.next[0].picked && doc.next[0].picked._id && doc.next[0].picked._id.slice(0, 10).split('-')
  },

  //MECE breakdown of ! refused (verified + repacked) into disposed, dispensed, pended
  pendedAt(doc) {
    return doc.bin && doc.next[0] && doc.next[0].pended && doc.next[0].pended._id && doc.next[0].pended._id.slice(0, 10).split('-')
  },

  repackedAt(doc) {
    return doc.bin && doc.next[0] && doc.next[0].repacked && doc.next[0].repacked._id && doc.next[0].repacked._id.slice(0, 10).split('-')
  },

  nextAt(doc) {
    return require('dispensedAt')(doc) || require('disposedAt')(doc) || require('repackedAt')(doc)
  },

  //magic bin is the placeholder while they use/dispense it
  //M00 = monday
  //T00 = tuesday
  //W00 = wednesday
  //R00 = THURSDAY
  //F00 = Friday
  //S00 = Saturday/Sunday
  isMagicBin(doc) {
    return doc.bin && ~ ['M00', 'T00', 'W00', 'R00', 'F00', 'S00'].indexOf(doc.bin)
  },

  //This includes unpulled expired, no-way to remove those from view
  //removes all pended, dispensed, disposed, and previous (repacked)
  isInventory(doc) {
    return doc.bin && ! doc.next.length
  },

  //We want expiredAt to be accurate for expiration search of inventory BUT
  //for audit purposes if someone enters/accepts(verifies) and expired medicine
  //we want that to show up as refused on the entered date NOT expired on the expired date
  //this should also prevent expired records from being entered as "backdated" which changes the books
  isExpired(doc) {
    var enteredAt = require('enteredAt')(doc)
    var expiredAt = require('expiredAt')(doc)
    var nextAt    = require('nextAt')(doc)

    //If we remove something a month before the expiration date, use the disposed date not the expired date, but still label it as expired rather than disposed  //If we remove something a month before the expiration date, use the disposed date not the expired date, but still label it as expired rather than disposed
    //if not disposed, dispensed, or repacked then use the expiration date because its still in our inventory.  Without out this the formula previous_inventory + verified != disposed + expired + dispensed + current_inventory for every period
    return doc.bin && (expiredAt >= enteredAt) && ( ! nextAt || expiredAt <= nextAt)
  },

  isDisposed(doc) {
    var expiredAt  = require('expiredAt')(doc)
    var disposedAt = require('disposedAt')(doc)

    return doc.bin && disposedAt && expiredAt > disposedAt
  },

  //Added because 2017-08-08T17:04:23.843540Z was recorded as dispensed after it expired
  isDispensed(doc) {
    var expiredAt   = require('expiredAt')(doc)
    var dispensedAt = require('dispensedAt')(doc)
    var isMagicBin  = require('isMagicBin')(doc)

    return doc.bin && (isMagicBin || (dispensedAt && expiredAt > dispensedAt))
  },

  isPended(doc) {
     var nextAt   = require('nextAt')(doc)
     var pendedAt = require('pendedAt')(doc)
     return doc.bin && ! nextAt && pendedAt
  },

  //Because of Unicode collation order would be a000, A000, a001 even if I put delimiters like a space or comma inbetween characters
  //putting into an array seemed like the only remaining option http://docs.couchdb.org/en/stable/ddocs/views/collation.html#collation-specification
  sortedBin(doc) {
    if ( ! doc.bin)
        return ['', '', '', '']

    /* Switch Row & Col want shopper to walk backwards so this makes all movement forward */
    /* Keep all arrays with length 4 for backwards compatibility */

    //New aisle based shelving Aisle, Shelf, Row, Column, Slot.

    if (doc.bin[4])
        return [doc.bin[0], doc.bin[1], doc.bin[3], doc.bin[2]+''+doc.bin[4]]

    //Old shelf based inventory bins before new aisles
    //These should be sorted between new aisles but after prepacks
    if (doc.bin[3])
        return ['1'+doc.bin[0], doc.bin[2], doc.bin[1], doc.bin[3]]

    //Prepacks, sorted first, maintaining array length of 4
    return ['', doc.bin[0], doc.bin[2], doc.bin[1]]
  },

  groupByDate(emit, doc, stage, key, val) {
    var date = require(stage+'At')(doc)
     //stage = pickedAt
     //key = [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id],
     //val = [require('qty')(doc), require('value')(doc)])

    if ( ! date || ! val) return //don't emit disposed items with qty 0 or it throws off count


    var to_id = require('to_id')(doc)
    emit([to_id, ''].concat(key), val)
    emit([to_id, 'year',  date[0]].concat(key), val)
    emit([to_id, 'month', date[0], date[1]].concat(key), val)
    emit([to_id, 'day',   date[0], date[1], date[2]].concat(key), val)
    emit([to_id, key[0],  date[0], date[1], date[2]].concat(key.slice(1)), val) //If we want to search for a particular field rather than show all and group (Form 8283 and Data Entry Time Sheet)
  },

  //fromDate, toDate must be date arrays.
  //Inclusive, Callback(yyyy<string>, mm<string>, isLastMonth)
  eachMonth(fromDate, toDate, callback) {

    var fromY = +fromDate[0]
    var fromM = +fromDate[1]
    var toY   = +toDate[0]
    var toM   = +toDate[1]

    if (fromM > 12 || toM > 12) return //Protect against long loops from invalid data

    if (toY - fromY > 10) {
        //Protect against long loops neverending expiration, cap expiration at 10 years
        toY = fromY + 10
    }

    //Each month in range inclusive start, exclusive end so that if something is disposed the moment we log it doesn't count
    for (; fromY < toY || fromM < toM; fromM++) {
      if (fromM == 13) {
        fromY++;
        fromM = 0;
        continue
      }
      callback(''+fromY, ('0'+fromM).slice(-2))
    }
    callback(''+fromY, ('0'+fromM).slice(-2), true)
  },

  //Inventory at the end of each month (so we do not count the last month)
  //An item is in inventory from the moment it is entered (not verified because verified is unset once destroyed) until the moment it is removed (next property is set) or until it expires
  //We do a loop because couchdb cannot filter and group on different fields.  Emitting [exp, drug] would filter and group on exp.
  //Emitting [drug, exp] would filter and group by drug.  We want to group by drug and filter by exp.  To achieve this we emit
  //every month between the item being added and when it leaves inventory (see above).  This way search for [2018, 06] doesn't just
  //give us 2018-06 items but all items before that too e.g 2018-05, 2018-04 .... until enteredAt date.  In this way the Exp filter
  //is built into the view itself and doesn't require us to use start and end keys to filter by exp, and in this way we can group by drug
  inventory(emit, doc, key, val) {

    if ( ! doc.bin) return

    var to_id       = require('to_id')(doc)
    var createdAt   = require('createdAt')(doc) //Rather than enteredAt to account for repacks that were not "entered" docs like 2019-01-15T14:43:33.378000Z
    var repackedAt  = require('repackedAt')(doc)

    var isPended    = require('isPended')(doc)
    var isDispensed = require('isDispensed')(doc)
    var isDisposed  = require('isDisposed')(doc)
    var isExpired   = require('isExpired')(doc)

    //Default removal is from expired or disposed.  But if we dispose when close to expiry
    //we still want to count it as "expired" since that is likely the reason we removed it
    var removedAt = require('minExpiredOrDisposedAt')(doc)

    //Prioritize what we think will be the soonest potential "removal" date
    if (isPended)
      removedAt = require('pendedAt')(doc)
    else if (repackedAt) //Match disposed/expired views
      removedAt = repackedAt
    else if (isDispensed) //Match dispensed view
      removedAt = require('dispensedAt')(doc)

    if (createdAt > removedAt)
      return log(doc._id+' inventory createdAt > removedAt: createdAt:'+createdAt+' > removedAt:'+removedAt+',  minExpiredOrDisposedAt:'+minExpiredOrDisposedAt) //these are arrays but that seems to work okay

    require('eachMonth')(createdAt, removedAt, function(year, month, last) {
      if (last) return  //don't count it as inventory in the month that it was removed (expired okay since we use until end of the month)
      emit([to_id, 'month', year, month].concat(key), val) //gsns and brand are used by the live inventory page
      if (month == 12) emit([to_id, 'year', year].concat(key), val) //gsns and brand are used by the live inventory page
    })
  }
}

//1. Client (Public) Endpoints

//2. Server (Private) Endpoints for finding and updating denormalized data, etc.
//Transaction History, Update Brand Name across drugs, Update manufacturers across drugs, Update drug names across transactions

//3. Basic Metrics (Viewed in Google Sheets) for non-expired drugs that were in inventory for a given month:
//Uses: How much was received today?  How much did this user log?
//inventory.binned qty,val,count, inventory.repacked qty,val,count, inventory.pended qty,val,count,
//Key [to, y/m date until expired/next, drug, ndc, bin]

//4. Inventory Metrics (Viewed in Google Sheets) for non-expired drugs that were in inventory for a given month:
//Uses: Live Inventory, Audits
//inventory.binned qty,val,count, inventory.repacked qty,val,count, inventory.pended qty,val,count,
//Key [to, y/m date until expired/next, drug, ndc, bin]

//5. Year to Date Reports (helpful when grouping by drug at given date such as Audits, Inspections)
//Uses: Any aggregates that we need by drug at a specific point in time: Donor Reports, Live Inventory Dispensing Estimate, Inspection Record
//received.ytd, verified.ytd, ....
//Can't do any point in time here because unlike Inventory these states could be indefinite in length
//Key [to, y/m date until end of year, drug, ndc]

//6. Backups
//Export of all inventory in case v2 goes down. (Handled by 1?)
//Full CSV back up of each database

//7. Backend Debugging
//Received qty,val,count, Verified, Disposed, Dispensed, Expired
//Key [to, Year, Month, Day, User] (can we make timesheet with this key order?)

//8. DEPRECATED views

exports.views = {

  //*** 1. Pure property lookups  ***

  //Client shipments page
  'shipment._id':function(doc) {
    emit([require('to_id')(doc), doc.shipment._id])
  },

  //*** 2. Server (Private) Endpoints ***
  //Used by history
  'next.transaction._id':function(doc) {
    var transaction_arr = (doc.next[0] && doc.next[0].repacked) ? doc.next[0].repacked.transactions : []
    for (var i in transaction_arr)
      transaction_arr[i] && emit(transaction_arr[i]._id)
  },

  //Used by drug endpoint to update transactions on drug name/form updates
  'by-ndc-generic':function(doc) {
    emit([doc.drug._id, doc.drug.generic, doc.drug.form])
  },

  'by-generic-price':function(doc) {
     emit([doc.drug.generic, require('price')(doc)])
  },

  //Along with the drug.js counterpart, Will be used to make sure all brand names are consistent for a given generic name
  'by-generic-brand':function(doc) {
    emit([doc.drug.generic, doc.drug.brand])
  },

  //Along with the drug.js counterpart, Will be used to make sure all gsn numbers are consistent for a given generic name
  'by-generic-gsns':function(doc) {
    emit([doc.drug.generic, doc.drug.gsns])
  },

  //*** 2. Filtered View  ***
  //TODO get rid of "Currently" in title and move the pendedAt check into the view's key between to_id and group name.  This will allow use to search through previously pended groups as well for debugging purposes.
  'currently-pended-by-group-priority-generic':{
    map(doc) {
      if ( ! require('isPended')(doc)) return;

      if(doc.next[0].pended)
        var priority = typeof doc.next[0].pended.priority == 'undefined' ? false : doc.next[0].pended.priority

      var picked = doc.next[0].picked ? (doc.next[0].picked._id ? true : null) : false

      var basket = doc.next[0].picked ? [doc.next[0].picked.matchType === 'missing', doc.next[0].picked.basket] : [] //include the matchtype bc dont wanna display baskets when == missing

      require('pendedAt')(doc) && emit([require('to_id')(doc), doc.next[0].pended.group, priority, picked, basket, require('sortedBin')(doc)],[require('qty')(doc)])
    },
    reduce:'_stats'
  },

  //Client bin checking and reorganization, & account/bins.csv for use by data loggers needing to pick empty boxes.  Skip reduce with reduce=false.  Alphabatize within bin
  //Split bin because of weird unicode collation a < A < aa so upper and lower case bins were getting mixed in search results http://docs.couchdb.org/en/stable/ddocs/views/collation.html
  //Notes on special bins/cases:
  //data-entry uses bin search with ansterix eg A23* across all slot number
  //they pull out expireds and things that dont show up (bc expired arent there)
  //basically compare box to that search: and if something's pended it doesnt appear so they were pulling out the drug
  //techs & pharm uses bin:
  //always shop for extra
  //extra goes into prepack shelf
  //the ac
  //magic bin is the placeholder while they use/dispense it
  //M00 = monday
  //T00 = tuesday
  //W00 = wednesday
  //X00, Y00 were before the day by
  /*
    its a repacked bottle thatll prbably be dispensed
    cindy ispense
    100% are new repacked
    the capsule tablet thing is reversed when
    we're also still using paper
  */
  'inventory-by-bin-verifiedat':{
    map(doc) {

      if (require('nextAt')(doc)) return; //if disposed, dispensed, repakced we don't want to include
      if(!require('isInventory')(doc) && !(require('pendedAt')(doc) && !require('pickedAt')(doc))) return //either be regularl inventory or pended and not picked

      var bin  = require('sortedBin')(doc)
      var val  = [require('qty')(doc), require('value')(doc)]
      var date = require('verifiedAt')(doc)
      emit([require('to_id')(doc)].concat(bin).concat(date), val)
    },
    reduce:'_stats'
  },

  //Expiration Date Search By Client
  'expired-by-bin':{
    map(doc) {

      if ( ! require('isInventory')(doc)) return

      var expiredAt  = require('expiredAt')(doc)
      var to_id      = require('to_id')(doc)
      var sortedBin  = require('sortedBin')(doc)

      emit([to_id].concat(expiredAt).concat(sortedBin), [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  //Donor Records.  Built for Clinical Solution but might be helpful for other orgs
  'entered-by-from-shipment-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'entered', [require('from_id')(doc), doc.shipment._id, doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },


  //The are the core views.
  //  Entered/Refused/Verified/Expired/Disposed/Dispensed/Pended/Picked/Repacked/Inventory
  //  BY
  //  Generic/From-Generic/User-From-Shipment
  'entered-by-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'entered', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'refused-by-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'refused', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'verified-by-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'verified', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'expired-by-generic':{
    map(doc) {
      if (require('isExpired')(doc))
        require('groupByDate')(emit, doc, 'minExpiredOrDisposed', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'disposed-by-generic':{
    map(doc) {
      if (require('isDisposed')(doc))
        require('groupByDate')(emit, doc, 'disposed', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'dispensed-by-generic':{
    map(doc) {
      if (require('isDispensed')(doc))
        require('groupByDate')(emit, doc, 'dispensed', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'pended-by-generic':{
    map(doc) {
      if (require('isPended')(doc))
        require('groupByDate')(emit, doc, 'pended', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'picked-by-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'picked', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'repacked-by-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'repacked', [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'inventory-by-generic':{
    map(doc) {
      if (require('isMagicBin')(doc)) return
      require('inventory')(emit, doc, [doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'entered-by-from-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'entered', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'refused-by-from-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'refused', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'verified-by-from-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'verified', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'expired-by-from-generic':{
    map(doc) {
      if (require('isExpired')(doc))
        require('groupByDate')(emit, doc, 'minExpiredOrDisposed', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'disposed-by-from-generic':{
    map(doc) {
      if (require('isDisposed')(doc))
        require('groupByDate')(emit, doc, 'disposed', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'dispensed-by-from-generic':{
    map(doc) {
      if (require('isDispensed')(doc))
        require('groupByDate')(emit, doc, 'dispensed', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'pended-by-from-generic':{
    map(doc) {
      if (require('isPended')(doc))
        require('groupByDate')(emit, doc, 'pended', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'picked-by-from-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'picked', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'repacked-by-from-generic':{
    map(doc) {
      require('groupByDate')(emit, doc, 'repacked', [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'inventory-by-from-generic':{
    map(doc) {
      if (require('isMagicBin')(doc)) return
      require('inventory')(emit, doc, [require('from_id')(doc), doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, doc.exp.to || doc.exp.from, require('sortedBin')(doc), doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'entered-by-user-from-shipment':{
    map(doc) {
      require('groupByDate')(emit, doc, 'entered', [doc.user._id, require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'refused-by-user-from-shipment':{
    map(doc) {
      require('groupByDate')(emit, doc, 'refused', [doc.user._id, require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'verified-by-user-from-shipment':{
    map(doc) {
      require('groupByDate')(emit, doc, 'verified', [doc.user._id, require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'expired-by-user-from-shipment':{
    map(doc) {
      if (require('isExpired')(doc))
        require('groupByDate')(emit, doc, 'minExpiredOrDisposed', [doc.user._id, require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'disposed-by-user-from-shipment':{
    map(doc) {
      if (require('isDisposed')(doc))
        require('groupByDate')(emit, doc, 'disposed', [doc.next[0].disposed && doc.next[0].disposed.user ? doc.next[0].disposed.user._id : '', require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'dispensed-by-user-from-shipment':{
    map(doc) {
      if (require('isDispensed')(doc))
        require('groupByDate')(emit, doc, 'dispensed', [doc.next[0].dispensed && doc.next[0].dispensed.user ? doc.next[0].dispensed.user._id : '', require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'pended-by-user-from-shipment':{
    map(doc) {
      if (require('isPended')(doc))
        require('groupByDate')(emit, doc, 'pended', [doc.next[0] && doc.next[0].pended && doc.next[0].pended.user ? doc.next[0].pended.user._id : '', require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'picked-by-user-from-shipment':{
    map(doc) {
      require('groupByDate')(emit, doc, 'picked', [doc.next[0] && doc.next[0].picked && doc.next[0].picked.user ? doc.next[0].picked.user._id : '', require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'repacked-by-user-from-shipment':{
    map(doc) {
      require('groupByDate')(emit, doc, 'repacked', [doc.next[0] && doc.next[0].repacked && doc.next[0].repacked.user ? doc.next[0].repacked.user._id : '', require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  },

  'inventory-by-user-from-shipment':{
    map(doc) {
      if (require('isMagicBin')(doc)) return
      require('inventory')(emit, doc, [doc.user._id, require('from_id')(doc), doc.shipment._id, doc.bin, doc._id], [require('qty')(doc), require('value')(doc)])
    },
    reduce:'_stats'
  }

}

exports.get_csv = async function (ctx, db) {
  const opts = {startkey:[ctx.account._id], endkey:[ctx.account._id, {}], include_docs:true}
  let view = await ctx.db.transaction.query('shipment._id', opts)
  ctx.body = csv.fromJSON(view.rows, ctx.query.fields)
  ctx.type = 'text/csv'
}

//Server-side validation methods to supplement shared ones.
exports.validate = function(model) {
  return model
    .ensure('isChecked').set(doc => undefined) //client sets this but we don't want to save it
    .ensure('_rev').custom(authorized).withMessage('You are not authorized to modify this transaction')
}

//Context-specific - options MUST have 'ctx' property in order to work.
function authorized(doc, opts) {
  var id = doc.shipment._id.split('.')
  return id[0] == opts.ctx.account._id || id[2] == opts.ctx.account._id
}

//TODO don't search for shipment if shipment._id doesn't have two periods (inventory)
//TODO option to include full from/to account information
exports.history = async function history(ctx, id) {

  let result = []
  //console.log('recurse 0', id)
  ctx.body = await recurse(id, result)

  async function recurse (_id, list) {
    //console.log('recurse 1', _id, list, ctx.account)
    let [trans, {rows:prevs}] = await Promise.all([
      ctx.db.transaction.get(_id), //don't use show function because we might need to see transactions not directly authorized
      ctx.db.transaction.query('next.transaction._id', {key:_id})
    ])
    //console.log('recurse 2', prevs)

    list.push(trans)
    let indentedList = []

    if (prevs.length > 1) {
      trans.type = 'Repackaged'
      list.push([indentedList])
    } else {
      trans.type = 'Transaction'
    }

    let all = [exports.lib.receivedAt(trans) ? ctx.db.shipment.get(trans.shipment._id) : {account:{from:ctx.account}}]

    //console.log('recurse 3', all)
    //Recursive call!
    for (let prev of prevs) {
      //console.log('recurse 4', prev.id, prev._id, prev)
      all.push(recurse(prev.id, prevs.length == 1 ? list : indentedList))
    }
    //Search for transaction's ancestors and shipment in parallel
    all = await Promise.all(all) //TODO this is co specific won't work when upgrading to async/await which need Promise.all
    //Now we just fill in full shipment and account info into the transaction
    //console.log('recurse 5', all)
    trans.shipment = all[0]
    let account    = all[0].account
    //TODO this call is serial. Can we do in parallel with next async call?
    //TODO this is co specific won't work when upgrading to async/await which need Promise.all
    let accounts = await Promise.all([
      ctx.db.account.get(account.from._id),
      account.to && ctx.db.account.get(account.to._id)
    ])
    account.from = accounts[0]
    account.to   = accounts[1] //This is redundant (the next transactions from is the transactions to), but went with simplicity > speed

    delete account.from.ordered
    delete account.from.authorized
    if (account.to) {
      delete account.to.ordered
      delete account.to.authorized
    }
    //console.log('recurse 6', result)
    return result
  }
}
