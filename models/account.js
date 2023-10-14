"use strict"
//defaults
module.exports = exports = Object.create(require('../helpers/model'))

let csv = require('csv/server');

let admin = {ajax:{jar:false, auth:{username: process.env.COUCH_USERNAME, password: process.env.COUCH_PASSWORD}}}
//let cache = {}
//let DAILY_LIMIT = 1000

exports.views = {
  //Use _bulk_get here instead? Not supported in 1.6
  //ctx.db.account.get({_id:{$gt:null, $in:accounts[0].authorized}}),
  authorized(doc) {
    for (var i in doc.authorized) {
      emit(doc.authorized[i])
    }
  },

  state(doc) {
    emit(doc.state)
  },


  'all-accounts':function(doc) {
      emit(doc._id)
  },


}

exports.get_csv = async function (ctx, db) {
  let view = await ctx.db.account.allDocs({endkey:'_design', include_docs:true})

  for (let row of view.rows)
    delete row.doc.ordered

  ctx.body = csv.fromJSON(view.rows, ctx.query.fields)
  ctx.type = 'text/csv'
}

function currentDate(months, split) {
  let minExp   = new Date()
  let minMonth = minExp.getMonth() + (+months || 0) // TODO exlcudes expireds in the last month because they are set to the 1st of the month
  minExp.setMonth(minMonth) //internal search does 1 month, so let's pad it by an additional month
  minExp = minExp.toJSON()
  return split ? minExp.split('-') : minExp
}

//Shows everything in inventory AND all ordered items not in inventory
exports.inventory = async function(ctx, to_id) { //account._id will not be set because google does not send cookie

  let [invYear, invMonth] = currentDate(ctx.query.min_exp_months, true)

  let invOpts = {
    group_level:7, //by drug.generic, drug.gsns, drug.brand,
    startkey:[to_id, 'month', invYear, invMonth],
    endkey:[to_id, 'month', invYear, invMonth+'\uffff']
  }

  let [enteredYear, enteredMonth] = currentDate(-ctx.query.entered_months, true)

  let enteredOpts = {
    group_level:7, //by drug.generic, drug.gsns, drug.brand,
    startkey:[to_id, 'month', enteredYear, enteredMonth],
    endkey:[to_id, 'month', enteredYear, {}]
  }

  let [dispensedYear, dispensedMonth] = currentDate(-ctx.query.dispensed_months, true)

  let dispensedOpts = {
    group_level:7, //by drug.generic, drug.gsns, drug.brand,
    startkey:[to_id, 'month', dispensedYear, dispensedMonth],
    endkey:[to_id, 'month', dispensedYear, {}]
  }

  const [entered, dispensed, inventory, account] = await Promise.all([
    ctx.db.transaction.query('entered-by-generic', enteredOpts),
    ctx.db.transaction.query('dispensed-by-generic', dispensedOpts),
    ctx.db.transaction.query('inventory-by-generic', invOpts),
    ctx.db.account.get(to_id)
  ])

  let drugs = {}

  mergeRecord(drugs, inventory, 'inventory', genericKey)
  mergeRecord(drugs, dispensed, 'dispensed', genericKey)
  mergeRecord(drugs, entered, 'entered', genericKey, true)

  //Match inventory with ordered when applicable
  for (let i in drugs) {

    delete drugs[i].value.group //we will use key.2 instead
    let generic = drugs[i].key[4]

    if (account.ordered[generic]) {
      setOrderFields(generic, account, drugs[i].value)
      delete account.ordered[generic]
    }
  }

  //Add unmatched orders to the end of array.  Match fields in the order they were emitted
  for (let generic in account.ordered)
    drugs[generic] = {
      key:[to_id, '', invYear, invMonth, generic],
      value:setOrderFields(generic, account, {})
    }

  //Transform object into array
  drugs = Object.keys(drugs).map(i => drugs[i])

  ctx.body = csv.fromJSON(drugs, ctx.query.fields)
}

function genericKey(key) {
  return key[4]
}

function setOrderFields(generic, account, res ) {
  res.ordered   = true

  if ( ! generic || ! account.ordered[generic] || ! account.default)
    console.log('setOrderFields', 'generic', generic, 'account.ordered[generic]', account.ordered[generic], 'account.default', account.default)

  res['order.price30']          = account.ordered[generic].price30      || (account.default ? account.default.price30 : '')
  res['order.price90']          = account.ordered[generic].price90      || (account.default ? account.default.price90 : '')
  res['order.repackQty']        = account.ordered[generic].repackQty    || (account.default ? account.default.repackQty : '')
  res['order.minQty']           = account.ordered[generic].minQty       || (account.default ? account.default.minQty : '')
  res['order.minDays']          = account.ordered[generic].minDays      || (account.default ? account.default.minDays : '')
  res['order.maxInventory']     = account.ordered[generic].maxInventory || (account.default ? account.default.maxInventory : '')
  res['order.displayMessage']   = account.ordered[generic].displayMessage
  res['order.destroyedMessage'] = account.ordered[generic].destroyedMessage
  res['order.verifiedMessage']  = account.ordered[generic].verifiedMessage

  return res
}

//Thin wrapper to transform a couchdb view into a csv with as little magic as possible
exports.recordByView = async function(ctx, to_id, view_prefix, view_suffix) { //account._id will not be set because google does not send cookie

  const label = new Date().toJSON()+' '+view_prefix+'-'+view_suffix+'.csv '+ctx.request.origin+' ('+ctx.request.ip+') '+ctx.request.href

  console.time(label)

  let opts = getOpts(ctx, to_id)

  opts = view_prefix == 'inventory' ? opts.inventory : opts.date

  let query = await ctx.db.transaction.query(view_prefix+'-'+view_suffix, opts)

  let merged = {}

  mergeRecord(merged, query, view_prefix, uniqueKey)

  let records = sortRecords(merged)

  console.log('recordByView', view_prefix+'-'+view_suffix, opts, 'params', ctx.query, 'query', query.length, 'merged', merged.length, 'records', records.length)

  console.timeEnd(label)

  let defaultFields = ['key.0','key.1','key.2','key.3','key.4','key.5','key.6','key.7','key.8','key.9'].slice(0, opts.group_level-2)

  defaultFields.push('count.'+view_prefix, 'qty.'+view_prefix, 'value.'+view_prefix)

  ctx.body = csv.fromJSON(records, ctx.query.fields || defaultFields)
}

exports.recordByGeneric = async function(ctx, to_id) { //account._id will not be set because google does not send cookie

  const label = new Date().toJSON()+' get recordByGeneric '+ctx.request.origin+' ('+ctx.request.ip+') '+ctx.request.href

  console.time(label)

  let records = await getRecords(ctx, to_id, 'by-generic')

  console.timeEnd(label)

  records = mergeRecords(records)

  records = sortRecords(records)

  ctx.body = csv.fromJSON(records, ctx.query.fields || defaultFieldOrder())
}

exports.recordByFrom = async function(ctx, to_id) { //account._id will not be set because google does not send cookie

  const label = new Date().toJSON()+' get recordByFrom '+ctx.request.origin+' ('+ctx.request.ip+') '+ctx.request.href

  console.time(label)

  let records = await getRecords(ctx, to_id, 'by-from-generic')

  console.timeEnd(label)

  records = mergeRecords(records)

  records = sortRecords(records, to_id)

  ctx.body = csv.fromJSON(records, ctx.query.fields || defaultFieldOrder())
}

exports.recordByUser = async function(ctx, to_id) { //account._id will not be set because google does not send cookie

  //If group_level by From or Shipment, let's add in some demornalized accout data that we can use in the V1 & V2 Merge gSheet
  //Baseline is group by [to_id, user], we need at least [to_id, user, from] in order to add account data.
  //NULL group_level will just result in a negative integer
  let defaultLevel = default_group_level(ctx.query.group || '').groupByDate

  //For example, group_level == 1 for user, so 1 + 2 - 3 == 0 and we can't show accounts, but group_level 2+ we would want to show accounts
  let denormalize  = +ctx.query.group_level + 2 - defaultLevel  //+2 because we don't make user group by first two keys [to_id, ''/'year'/'month'/'day']

  //console.log('START: recordByUser','group:', ctx.query.group, 'group_level:', +ctx.query.group_level, 'default_level:', defaultLevel, 'denormalize:', denormalize)

  const label = new Date().toJSON()+' get recordByUser '+ctx.request.origin+' ('+ctx.request.ip+') '+ctx.request.href
  console.time(label)

  let [records, accounts] = await Promise.all([
    getRecords(ctx, to_id, 'by-user-from-shipment'),
    denormalize >= 1 ? this.db.account.allDocs({endkey:'_design', include_docs:true}) : null
  ])

  console.timeEnd(label)

  records = mergeRecords(records)

  records = sortRecords(records)

  if (accounts) {
    let accountMap = {}

    for (let account of accounts.rows)
      accountMap[account.id] = account.doc

    for (let record of records)
      record.value['shipment.from'] = accountMap[record.key[defaultLevel]]
  }

  ctx.body = csv.fromJSON(records, ctx.query.fields || defaultFieldOrder(accounts))
}

function defaultFieldOrder(shipment) {
  return [
    'group',
    'count.entered',
    'count.refused',
    'count.verified',
    'count.expired',
    'count.disposed',
    'count.dispensed',
    'count.pended',
    'count.picked',
    'count.repacked',
    'count.inventory',
    'qty.entered',
    'qty.refused',
    'qty.verified',
    'qty.expired',
    'qty.disposed',
    'qty.dispensed',
    'qty.pended',
    'qty.picked',
    'qty.repacked',
    'qty.inventory',
    'value.entered',
    'value.refused',
    'value.verified',
    'value.expired',
    'value.disposed',
    'value.dispensed',
    'value.pended',
    'value.picked',
    'value.repacked',
    'value.inventory'
  ]
  .concat( ! shipment ? [] :
  [
    'shipment.from._id',
    'shipment.from.name',
    'shipment.from.license',
    'shipment.from.state',
    'shipment.from.phone',
    'shipment.from.createdAt',
  ])
  .concat([
    'key.0',
    'key.1',
    'key.2',
    'key.3'
  ])
}

function startkey(key) {
  return csv.parseJSON(key, [])
}

function endkey(key) {
  return [...startkey(key), {}]
}

function getOpts(ctx, to_id) {

  let group  = ctx.query.group || ''
  let opts   = {}

  opts.date  = {
    group_level:default_group_level(group).groupByDate,
    startkey:[to_id, group].concat(startkey(ctx.query.startkey)),
    endkey:[to_id, group].concat(endkey(ctx.query.endkey))
  }

  //Unlike the others inventory dates can be in the future (e.g, emitted every month until they expire).  We only want ones in
  //the past emit([to_id, 'month', year, month, doc.drug.generic, doc.drug.gsns, doc.drug.brand, doc.drug._id, sortedDrug, doc.bin], val)
  let invDate = group ? [] : currentDate(1, true).slice(0, 2)

  opts.inventory = {
    group_level:default_group_level(group).groupByInv + invDate.length,
    startkey:[to_id, group || 'month'].concat(invDate).concat(startkey(ctx.query.startkey)),
      endkey:[to_id, group || 'month'].concat(invDate).concat(endkey(ctx.query.endkey))
  }

  //Advanced use cases (Form 8283) might call for specifying a custom group level
  if (ctx.query.group_level) {
    //console.log('group_level', invOpts.group_level, ctx.query.group_level, opts.group_level)
    opts.inventory.group_level += +ctx.query.group_level + 2 - opts.date.group_level //we keep the inventory Group level relative to the new, custom group_level
    opts.date.group_level       = +ctx.query.group_level + 2
  }

  return opts
}

async function getRecords(ctx, to_id, suffix) {

  let group = ctx.query.group || ''
  let opts  = getOpts(ctx, to_id)


  //console.log('getRecords', 'opts', opts)

  //Inventory cannot be kept by day because expiration date is kept by month.
  //Might be possible to eventually get it for custom group_level but doesn't seem worth trying to figure that out now.
  let queries = [
    optionalField(ctx, 'entered-'+suffix, opts.date),
    optionalField(ctx, 'refused-'+suffix, opts.date),
    optionalField(ctx, 'verified-'+suffix, opts.date),
    optionalField(ctx, 'expired-'+suffix, opts.date),
    optionalField(ctx, 'disposed-'+suffix, opts.date),
    optionalField(ctx, 'dispensed-'+suffix, opts.date),
    optionalField(ctx, 'pended-'+suffix, opts.date),
    optionalField(ctx, 'picked-'+suffix, opts.date),
    optionalField(ctx, 'repacked-'+suffix, opts.date),
  ]

  if (group === '' || group === 'month' || group === 'year') //inventory is not kept by day and other groupings not listed here
    //console.log('getRecords', 'invOpts', invOpts)
    queries.push(optionalField(ctx, 'inventory-'+suffix, opts.inventory).then(res => {
      //console.log('res', res && res.rows)
      group || res && res.rows.forEach(row => { row.key[1] = ''; row.key.splice(2, 2)}) //remove year and month from keys if no grouping is specified
      return res
    }))

  let records = await Promise.all(queries)

  return records
}

function optionalField(ctx, field, opts) {

  let fields = ctx.query.fields

  if (fields) {

    let fieldType = field.split('-')[0] //Hacky as this relies on consistent naming of fields.  eg.  dispensed-by-user-from-shipment -> dispensed

    //views have values of [qty _stat, value _stat] _stats also supplies the count, so here are no count views
    if ( ! fields.includes(fieldType))
      return Promise.resolve()
  }
  //console.log('optionalField specified', field, fields)
  return ctx.db.transaction.query(field, opts)
}

function mergeRecords(records) {
  let merged = {}

  mergeRecord(merged, records[0], 'entered', uniqueKey)
  mergeRecord(merged, records[1], 'refused', uniqueKey)
  mergeRecord(merged, records[2], 'verified', uniqueKey)
  mergeRecord(merged, records[3], 'expired', uniqueKey)
  mergeRecord(merged, records[4], 'disposed', uniqueKey)
  mergeRecord(merged, records[5], 'dispensed', uniqueKey)
  mergeRecord(merged, records[6], 'pended', uniqueKey)
  mergeRecord(merged, records[7], 'picked', uniqueKey)
  mergeRecord(merged, records[8], 'repacked', uniqueKey)
  mergeRecord(merged, records[9], 'inventory', uniqueKey)

  return merged
}

//Move primary group (Generic/User/From) to the first key of the array instead of the last
//we need it date first for emit order to enable searching etc, but we
///need it group first for sorting within node (expired calculations etc)
function uniqueKey(key, field) {
  key = key || []
  let groupBy = field.slice(0, 9) == 'inventory' ? 'groupByInv' : 'groupByDate'
  let level   = default_group_level(key[1])[groupBy] - 1
  let unique = key.slice(level).concat(key.slice(2, level)) // remove to_id and group and then move our date prefixes to end of key
  return unique.join(',') //remove to_id and anything after grouping just in case GSNs and/or Brands don't match we still want to group
}

//updateOnly means we won't add a group for that type (e.g. entered) unless that group already exists (e.g created by dispensed or inventory)
function mergeRecord(rows, record, field, groupFn, updateOnly) {

  if ( ! record) return

  for (let row of record.rows) {

    let group = groupFn(row.key, field)

    if ( ! rows[group]) {
      if (updateOnly) continue
      rows[group] = {key:row.key, value:{group}}
    }

    rows[group].value['count.'+field] = +(rows[group].value['count.'+field] || 0 + row.value[0].count || 0).toFixed(2)
    rows[group].value['qty.'+field]   = +(rows[group].value['qty.'+field] || 0 + row.value[0].sum || 0).toFixed(2)
    rows[group].value['value.'+field]   = +(rows[group].value['value.'+field] || 0 + row.value[1].sum || 0).toFixed(2)
  }
}

//console.log('recordByGeneric opts, rows', opts, rows)
//(Re)sort them in ascending order.  And calculate expired
function sortRecords(rows) {
  return Object.keys(rows).sort().map(key => rows[key])
}

function default_group_level(key) {
  return {
    ''    : {groupByDate:3, groupByInv:3}, //(default) [to_id:1, '':2, group:3...]
    year  : {groupByDate:4, groupByInv:4}, //[to_id:1, 'year':2, year:3, group:4...]
    month : {groupByDate:5, groupByInv:5}, //[to_id:1, 'month':2, year:3, month:4, group:5...]
    day   : {groupByDate:6, groupByInv:5}  //[to_id:1, 'day':2, year:3, month:4, day:5, group:6...]   //Inventory doesn't have group by day so do group by month instead
  }[key] || {groupByDate:2, groupByInv:1}  //[to_id:1, group[1]:2, year:3, month:4, day:5, group[2+]:6...] //Default in case they are searching for a specific from/user/generic
}

exports.validate = function(model) {
  return model
    .ensure('_id').custom(authorized).withMessage('You are not authorized to modify this account')
}

//Context-specific - options MUST have 'ctx' property in order to work.
function authorized(doc, opts) {

  if (opts.ctx.account && opts.ctx.account._id)
    return doc._id == opts.ctx.account._id

  if (exports.isNew(doc, opts)) {
    console.log('account is new')
    return opts.ctx.ajax = admin.ajax, true //enable user to be created even though current user doesn't exist and therefor doesn't have allAccounts role
  }

  console.log('account is not authorized', doc._rev, opts)
  return false
}

exports.authorized = {
  async get(ctx) {
    //Search for all accounts (recipients) that have authorized this account as a sender
    //shortcut to /accounts?selector={"authorized":{"$elemMatch":"${session.account}"}}
    ctx.status = 501 //not implemented
  },

  async post(ctx) {
    //Authorize a sender
    console.log(ctx.account._id, ctx.req.body)
    let account = await ctx.db.account.get(ctx.account._id)
    console.log(account.authorized, account.authorized.indexOf(ctx.req.body))
    //allow body to be an array of ids to authorize
    let index = account.authorized.indexOf(ctx.req.body)

    if (index != -1) {
      ctx.status  = 409
      ctx.message = 'This account is already authorized'
    } else {
      account.authorized.push(ctx.req.body)
      ctx.body = await ctx.db.account.put(account, {ctx})
      ctx.body.authorized = account.authorized
    }
  },

  async delete(ctx) {
    //Unauthorize a sender
    let account = await ctx.db.account.get(ctx.account._id)

    //allow body to be an array of ids to unauthorize
    let index   = account.authorized.indexOf(ctx.req.body)

    if (index == -1) {
      ctx.status  = 409
      ctx.message = 'This account is already not authorized'
    } else {
      account.authorized.splice(index, 1)
      ctx.body = await ctx.db.account.put(account, {ctx})
      ctx.body.authorized = account.authorized
    }
  }
}

exports.pend = {

  //List of items pended with a given name
  async get(ctx, _id, group, generic) {

    const result = await ctx.db.transaction.query('currently-pended-by-group-priority-generic', {include_docs:true, reduce:false, startkey:[_id, group], endkey:[_id, group, {}]})

    ctx.body = result.rows.map(row => row.doc).filter(doc => {
      return ! generic || doc.drug.generic == generic
    })

    console.log('account/pend.get', group, generic, result.rows.length, '->', ctx.body.length)
  },

  //Body of request has all the transaction that you wish to pend under a name
  //wrap name array into tranactiond
  //in the ctx object the query paramaters
  async post(ctx, _id, group) {
    console.log('account/pend.post', 'ctx.user', ctx && ctx.user, '_id', _id, 'group', group, 'this.user', this && this.user)
    ctx.account = {_id}
    ctx.body = await updateNext(ctx, 'pended', {_id:new Date().toJSON(), group, repackQty:ctx.query.repackQty, priority:ctx.query.priority, user:ctx.user})
  },

  //Unpend all requests that match a name
  async delete(ctx, _id, group, generic) {

    await exports.pend.get(ctx, _id, group, generic)

    /*
    //If we have picked items already for a canceled order then don't unpend or it will be hard to return them to inventory
    //Don't do this yet because they will get repacked (and risk being short-dated) if we don't unpend
    */

    const len_with_picked = ctx.body.length

    ctx.req.body = ctx.body.filter(doc => {
      return doc.next[0] && ! doc.next[0].picked
    })

    const len_no_picked = ctx.req.body.length

    ctx.account  = {_id}
    ctx.body     = await updateNext(ctx, 'pended', null)

    console.log('account/pend.delete', group, generic, len_with_picked, '->', len_no_picked, ctx.body)
  }

}

exports.dispense = {

  async post(ctx, _id) {
    ctx.account = {_id}
    ctx.body = await updateNext(ctx, 'dispensed',{_id:new Date().toJSON(), user:ctx.user})
  },

  // async delete(ctx, _id) {
  //   ctx.account = {_id}
  //   ctx.body = await patchNext(ctx, [])
  // }
}

exports.picking = {

  async post(ctx) {

    const groupName = ctx.req.body.groupName;
    const action = ctx.req.body.action;

    console.log("Call to PICKING for:", groupName ? groupName : 'refresh');
    console.log("ACTION: " + action);

    if(action == 'refresh'){
      let groups = await refreshGroupsToPick(ctx);

      ctx.body = groups;
    } else if(action == 'load'){

      let pickingData = await loadPickingData(groupName, ctx);

      ctx.body = pickingData;

    } else if(action == 'unlock'){
      ctx.body = await unlockPickingData(groupName, ctx)
      //console.log('unlockPickingData', groupName, ctx.body)
    } else if(action == 'missing_transaction'){
      ctx.body = await compensateForMissingTransaction(groupName,ctx)
    }
    else if (action === 'check_owner'){
      ctx.body = {owner:true}
    }
    else if(action === 'group_info'){
      ctx.body = await loadPickingData(groupName, ctx)
    }
    else if(action === 'save_basket_number'){
      ctx.body = await saveBasket(groupName, ctx);
    }

  }
}

async function getUser(ctx){
  if(!ctx.user._id){
    console.log('=============================');
    console.log('        USER IS MISSING      ');
    console.log('=============================');
  }

  let user = await ctx.db.user.get(ctx.user._id);

  if(!user._id){
    throw new Error('Unable to retrieve user');
  }

  return user;
}

function compensateForMissingTransaction(groupName, ctx){
  let missing_generic = ctx.req.body.generic //in case we ever want to expand this
  let missing_ndc = ctx.req.body.ndc
  let missed_qty = Math.min(ctx.req.body.qty,  ctx.req.body.repackQty) //if we are missing a 1000 count bottle don't pend repend all 1000 just enough to meet the repack qty

  console.log("missing generic:", missing_generic)
  console.log("missing ndc:", missing_ndc)
  console.log("missed qty:", 'qty', ctx.req.body.qty,  'repackQty', ctx.req.body.repackQty, 'missed_qty', missed_qty)

  var date = new Date()
  var [year, month] = date.toJSON().split(/\-|T|:|\./)

  let opts = {
    include_docs:true,
    reduce:false,
    startkey: [ctx.account._id, 'month', year, month, missing_generic],
    endkey: [ctx.account._id, 'month', year, month, missing_generic, {}]
  }

  return ctx.db.account.get(ctx.account._id).then(account =>{

    ctx.account = account
    opts.ctx = ctx

    return ctx.db.transaction.query('inventory-by-generic', opts).then(res => {

      let items = res.rows
      if(items.length == 0) return []

      items = items.map(row => row.doc).sort(function(a,b){ //sorts in decreasing qty
        if(a.qty.to < b.qty.to) return 1
        if(a.qty.to > b.qty.to) return -1
        return 0
      })

      //console.log("following items found: ", items)

      //TODO: be able to find multiple transactions, until aggregate qty exceeds missed_qty
      let result = [] //we'll add here and hopefully reach desired total
      let tally = 0

      for(var i = 0; i < items.length; i++){
        if((!(~ ['M00', 'T00', 'W00', 'R00', 'F00', 'X00', 'Y00', 'Z00'].indexOf(items[i].bin))) //exclude special bins
            && (items[i].next.length == 0) && (items[i].drug._id == missing_ndc)){

          console.log("found the right kind of item, might not have enough qty though")

          tally += items[i].qty.to
          result.push(items[i])

          if(tally >= missed_qty) break

        }
      }

      console.log("tally: ", tally)
      console.log("result number: ", result.length)

      if(tally >= missed_qty){
        result.forEach(item => item.next = [{
            pended:{_id:new Date().toJSON(), user:ctx.user, repackQty:ctx.req.body.repackQty, group: groupName},
            picked:{} /* add this so it locks down on save */,
        }])

        let prepped = prepShoppingData(result, ctx)

        console.log("to pend into group:", result, prepped.raw)

        return ctx.db.transaction.bulkDocs(result, {ctx:ctx}).then(res =>{
          console.log("item saved", result, prepped.raw)
          return prepped
        })
      } else {
        return []
      }

    })
  })
}


async function saveBasket(groupName, ctx){
  let transactionId = ctx.req.body.id,
      basket = ctx.req.body.basket;

  console.log('saveBasket', groupName, transactionId, basket, ctx)

  let transaction =  await ctx.db.transaction.get(transactionId._id);

  console.log('saveBasket', transaction)

  if(transaction.next && transaction.next[0]){
    if(!transaction.next[0].picked){
      transaction.next[0].picked = {};
    }
    transaction.next[0].picked.basket = basket.fullBasket;

    if(!transaction.next[0].picked || !transaction.next[0].pickedArchive){
      transaction.next[0].pickedArchive = {};
    }
    transaction.next[0].pickedArchive.basket = basket.fullBasket;

    if(!transaction.next[0].lock){
      transaction.next[0].lock = {};
    }
    transaction.next[0].lock.basket = basket;
  }

  return await ctx.db.transaction.put(transaction, {ctx});
}

function unlockPickingData(groupName, ctx){
  console.log("unlocking group:", groupName);

  return ctx.db.transaction.query('currently-pended-by-group-priority-generic', {include_docs:true, reduce:false, startkey:[ctx.account._id, groupName], endkey:[ctx.account._id,groupName,{}]})
  .then(res => {

    if(!res.rows.length) {
        console.log("unlocking group: no rows", groupName, res);
        return;
    }

    let transactions = []

    for(var i = 0; i < res.rows.length; i++){
      if(!(res.rows[i].doc.next[0].picked && res.rows[i].doc.next[0].picked._id))
      {
        transactions.push({'raw':res.rows[i].doc})
      } //don't unlock fully picked items
    }

    //console.log("unlocking group: transactions", groupName, transactions);
    return saveShoppingResults(transactions, 'unlock', ctx).then(_ => {
      //console.log("unlocking group: after save", groupName, transactions);
      return refreshGroupsToPick(ctx).then(res => {
          //console.log("unlocking group: after refresh", groupName, res);
          return res
      })
    })
  })
  .catch(err => {
      console.log('unlocking group: err', groupName, err)
  })
};

function sortTransactionsForPickList(transactions){
  return transactions.map(row => row.doc).sort(function(a,b){
    var aName = a.drug.generic;
    var bName = b.drug.generic;

    //sort by drug name first
    if(aName > bName) return -1
    if(aName < bName) return 1

    var aBin = a.bin
    var bBin = b.bin

    var aPack = aBin && aBin.length == 3
    var bPack = bBin && bBin.length == 3

    if (aPack > bPack) return -1
    if (aPack < bPack) return 1

    //Flip columns and rows for sorting, since shopping is easier if you never move backwards
    var aFlip = aBin[0]+aBin[2]+aBin[1]+(aBin[3] || '')
    var bFlip = bBin[0]+bBin[2]+bBin[1]+(bBin[3] || '')

    if (aFlip > bFlip) return 1
    if (aFlip < bFlip) return -1

    return new Date(a._id) - new Date(b._id) //not important other than always being deterministic
  });
}

async function loadPickingData(groupName, ctx){
    console.log("loading group:", groupName);

//    return empty array if not authorized
    let pickingData = {shopList:[], groupData:{}};

    //console.log(await ctx.db.account.get(ctx.account._id));

    let account = await ctx.db.account.get(ctx.account._id);


      ctx.account = account

      let res = await ctx.db.transaction.query('currently-pended-by-group-priority-generic', {include_docs:true, reduce:false, startkey:[ctx.account._id, groupName], endkey:[ctx.account._id,groupName, {}]})

      if(!res.rows.length) return //TODO how to return error here

      if(!true /**check the first transaction for ownership**/){
        return;
      }

      let rawTransactions = sortTransactionsForPickList(res.rows);

      pickingData.groupData = getGroupInfoFromTransactionList(
          rawTransactions,
          groupName,
          ctx,
          false
      );

      pickingData.shopList = prepShoppingData(rawTransactions, ctx);

      if(!pickingData.shopList.length) return //TODO: return error here

      await saveShoppingResults(pickingData.shopList, 'lockdown', ctx);


      return pickingData;

}

function getOutcomeName(outcomeObject){
  let match = Object.entries(outcomeObject).filter((entry) => {
    return entry[1] == true ? entry[1] : null
  });

  return match.length ? match[0][0] : null;
}

function isLocked(transaction, userId){
  if(transaction.next && transaction.next[0]){
    let next = transaction.next[0];

    if(next.picked){
       if(next.lock && next.lock.userId && next.lock.userId === userId){
         return false;
       }
       return true;
    }
    else return false;
  }

  return false;
}

//given an array of transactions, then build the shopList array
//which has the extra info we need to track during the shopping process
function prepShoppingData(raw_transactions, ctx) {

  let shopList = [] //going to be an array of objects, where each object is {raw:{transaction}, extra:{extra_data}}

  let uniqueDrugs = {}
  let generic_index = 1

  for(var i = 0; i < raw_transactions.length; i++){

    //isLocked(raw_transactions[i], ctx.user._id) || //don't show picked.  commented out because including this made length of shopList increase or decrease on missing item, make our counts and finish status hard to reason about
    if(raw_transactions[i].next[0].pended.priority === null) continue //fully unchecked boxes (fromt he inventory drawer)

    if(uniqueDrugs[raw_transactions[i].drug.generic]){
      uniqueDrugs[raw_transactions[i].drug.generic].count += 1
    } else {
      uniqueDrugs[raw_transactions[i].drug.generic] = {count:1, global_index:generic_index++, relative_index:1} //relative index is useful in next loop of editing the extra field
    }

    //this will track info needed during the miniapp running, and which we'd need to massage later before saving
    var extra_data = {
      outcome:{
        'exact_match':false,
        'roughly_equal':false,
        'slot_before':false,
        'slot_after':false,
        'missing':false,
      },
      saved:null, //will be used to avoid double-saving
      basketNumber:'' //distinct from basketLetter at this point, will eventually combine into a fullBasket property
    };

    evaluateAndAddArchivedPickingData(raw_transactions[i], extra_data,  ctx);

    shopList.push({raw:raw_transactions[i], extra:extra_data})
  }

  let generic_total = Object.keys(uniqueDrugs).length;

  //then go back through to add the drug count and basket
  for(var i = 0; i < shopList.length; i++){

    const hazard   = ctx.account.hazards ? ctx.account.hazards[shopList[i].raw.drug.generic] : false //Drug is marked for USP800
    const recall   = ~shopList[i].raw.next[0].pended.group.toLowerCase().indexOf('recall')
    const large    = uniqueDrugs[shopList[i].raw.drug.generic].count > 15
    const small    = uniqueDrugs[shopList[i].raw.drug.generic].count <= 4
    const priority = shopList[i].raw.next[0].pended.priority == true

    if (priority)
      shopList[i].extra.basketLetter = 'G'
    else if (hazard || recall || large)
      shopList[i].extra.basketLetter = 'B'
    else if (small)
      shopList[i].extra.basketLetter = 'S'
    else
      shopList[i].extra.basketLetter = 'R'

    shopList[i].extra.genericIndex = {
      relative_index: [
        uniqueDrugs[shopList[i].raw.drug.generic].relative_index++,
        uniqueDrugs[shopList[i].raw.drug.generic].count
      ],
      global_index: [
        uniqueDrugs[shopList[i].raw.drug.generic].global_index,
        generic_total
      ]
    }
  }

  getImageURLS(shopList, ctx) //must use an async call to the db
  return shopList
}

function evaluateAndAddArchivedPickingData(transaction, extra, ctx){
  if(transaction.next && transaction.next[0]){
    let next0 = transaction.next[0];

    if(next0.pickedArchive && next0.lock && next0.lock.userId === ctx.user._id){
      let archive = next0.pickedArchive;

      next0.picked = archive;
      transaction.next[0] = next0;

      if(archive.matchType){
        extra.saved = archive.matchType;
      }

      if(archive.matchType && extra.outcome){
        extra.outcome[archive.matchType] = true;
      }

      if(next0.pickedArchive.basket){
        extra.fullBasket = next0.pickedArchive.basket;
        extra.basketLetter = next0.pickedArchive.basket[0];
        extra.basketNumber = next0.pickedArchive.basket.substr(1);
      }
    }
  }
}

function getGroupNameFromTransaction(transaction){
  return transaction.next[0].pended && transaction.next[0].pended.group
      ? transaction.next[0].pended.group
      : null;
}

function ifExists(obj, path){
  let currentNode = obj;
  path = path.split('.');

  for(let part of path){
    currentNode = currentNode[part];

    if(!currentNode)
      break;
  }

  return currentNode;
}

function getGroupInfoFromTransactionList(transactionList, nameOfSpecificGroupToGet, ctx, withLogging = false){
  let groupInfo = {}, transactionsToOutput = ['2021-02-25 R59576'], output = {};

  function logIfNewBasketAdded(groupName, transactionBasket) {
    if(groupInfo[groupName].baskets.indexOf(transactionBasket) === -1){
      console.log('basket added - ' + transactionBasket);
    }
  }

  for(let i = 0; i < transactionList.length; i++){

    let transaction = transactionList[i];

    if(transaction.next && transaction.next[0])
    {
      let groupName = getGroupNameFromTransaction(transaction);

      if(!groupName)
        continue;

      if(!groupInfo[groupName]){
        groupInfo[groupName] = {name:groupName, numTransactions:0, pickedTransactions:0, isCompletelyPicked:false};
      }

      if(!groupInfo[groupName].lock && transaction.next[0].lock){
        groupInfo[groupName].lock = transaction.next[0].lock;
        //console.log('adding lock');
      }

      //Priority === True means BTF, Priority === False means regular shopping, Priority === NULL means unselected from inventory drawer so that it will not be shopped
      if(transaction.next[0].pended && transaction.next[0].pended.priority == null) {
        continue;
      }

      groupInfo[groupName].numTransactions++;

      if(withLogging === true && transactionsToOutput.indexOf(groupName) !== -1){
        if(!output[groupName])
          output[groupName] = [];

        output[groupName].push({
          step:output[groupName].length + 1,
          id:transaction._id,
          rev:transaction._rev,
          picked:ifExists(transaction.next[0], 'picked.matchType'),
          archive: ifExists(transaction.next[0], 'pickedArchive.matchType'),
          //pended:transaction.next[0].pended
        });
      }

      if(transaction.next[0].pickedArchive && transaction.next[0].pickedArchive.basket){
        if(transaction.next[0].pickedArchive.matchType !== 'missing'){
          let transactionBasket = transaction.next[0].pickedArchive.basket;

          if(!groupInfo[groupName].baskets)
            groupInfo[groupName].baskets = [];

          //logIfNewBasketAdded(groupName, transactionBasket);

          groupInfo[groupName].baskets = mergeBaskets([groupInfo[groupName].baskets, transactionBasket]);

          if(!groupInfo[groupName].basketsByGeneric)
          {
            //console.log('REQUEST ' + ctx.req.body.action);
            groupInfo[groupName].basketsByGeneric = {};
          }


          let genericName = transaction.drug.generic.replace(/\s/g, '');
          //console.log(genericName, transactionBasket);
          groupInfo[groupName].basketsByGeneric[genericName] = mergeBaskets([transactionBasket, groupInfo[groupName].basketsByGeneric[genericName] || null]);
          //console.log(groupInfo);
        }

        if( transaction.next[0].picked){
          groupInfo[groupName].pickedTransactions++;
        }
      }
    }
  }

  if(withLogging === true){
    logGroupStatuses(groupInfo, output);
  }

  return nameOfSpecificGroupToGet ? groupInfo[nameOfSpecificGroupToGet] : groupInfo;
}

function logGroupStatuses(groupInfo, output){
  return;
  let completeGroups = [];
  for (let name of Object.keys(groupInfo)){
    const group = groupInfo[name];
    const lockedBy = group.lock && group.lock.user && group.lock.user.name ? "\nLocked by: " + group.lock.user.name : '';
    const isDone = group.numTransactions === group.pickedTransactions ? "\nComplete" : '';

    if(isDone.length){
      group.isCompletelyPicked = true;
      completeGroups.push(group);
    }

    console.log(`Group info from transactions: ${name} \n numTransactions: ${group.numTransactions}\n pickedTransaction: ${group.pickedTransactions} ${lockedBy} ${isDone}\n\n`);
  }

  console.log('============================');
  for(let groupName of Object.keys(output)){
    console.log(groupName);
    console.log(output[groupName]);
  }
}

function mergeBaskets(basketsData){
  let merged = [];

  for(let basketData of basketsData){
    if(basketData instanceof Set){
      //modify a copy of the set otherwise we're destroying the actual set that was sent into the function
      basketData = Array.from(new Set(basketData));
    }
    else if(typeof basketData === 'string' || basketData instanceof String){
      //modify a copy of the string otherwise we're destroying the actual string that was sent into the function
      basketData = basketData.slice(0).split(' ');
    }
    else if (basketData === null){
      basketData = [];
    }

    if(!Array.isArray(basketData)){
      throw 'Basket data is incorrect: ' + JSON.stringify(basketData);
    }

    merged = merged.concat(basketData);
  }

  return merged.filter((value, index, self) => {
      return self.indexOf(value) === index;
  });
}

async function refreshGroupsToPick(ctx, today){
    console.log("refreshing groups")

  let transactions = await ctx.db.transaction.query('currently-pended-by-group-priority-generic', {reduce:false,startkey:[ctx.account._id], endkey:[ctx.account._id, {}]});
   console.log(transactions.rows.length);


   let lockData = {},
    transactionIndex = {},
   transactionIds = [];

   transactions.rows.forEach(row => {
    let id = row.id,
      groupName = row.key[1],
      basket = row.key[4] && row.key[4][1] ? row.key[4][1] : '';

      if(!lockData[groupName])
        lockData[groupName] = {name:groupName, transactions:[]};


      if(basket && basket.length){
        if(!lockData[groupName].baskets){
          lockData[groupName].baskets = new Set();
        }

        lockData[groupName].baskets.add(basket);
      }

      lockData[groupName].transactions.push({id:id, basket:basket});
      //transactionIndex[id] = [groupName, lockData[groupName].transactions.length - 1];
      transactionIds.push(id);
   });

   console.log(transactionIndex.length);

  let options = {
    include_docs:true,
    keys: transactionIds
  };

  await ctx.db.transaction.allDocs(options, function (err, response) {
    let transactionDocs = response.rows.map(function(transaction){
      return transaction.doc ? transaction.doc : null;
    });

    let groupData = getGroupInfoFromTransactionList(transactionDocs, null, ctx);

    for(let groupName of Object.keys(groupData)){
      if(lockData[groupName]){
        for(let groupDatum of Object.keys(groupData[groupName])){
          lockData[groupName][groupDatum] = groupData[groupName][groupDatum];
        }
      }
    }
    // handle err or response
  });

  /////////////


    return ctx.db.transaction.query('currently-pended-by-group-priority-generic', {startkey:[ctx.account._id], endkey:[ctx.account._id, {}], group_level:5})
    .then(res => {
      //key = [account._id, group, priority, picked (true, false, null=locked), basket]
      let groups = {};
      //gotta extract some of these fields before sorting
      let groups_raw = res.rows.sort(sortOrders); //sort before stacking so that the cumulative count considrs priority and final sort logic

      for (var group of groups_raw) {
        let groupName = group.key[1];
        if ((groupName.length > 0) && (group.key[2] != null)) {

          if (groups[groupName] && (group.key[4].length > 0) && (!group.key[4][0])) {

            groups[groupName].baskets.push(group.key[4][1]);

            if(lockData[groupName].baskets) {
              let baskets = groups[groupName].baskets;

              baskets = baskets.concat(Array.from(lockData[groupName].baskets));

              baskets = baskets.filter((value, index, self) => {
                return self.indexOf(value) === index;
              });

              groups[groupName].baskets = baskets;
            }
          }
          else if (group.key[3] != true) { //so fully picked items will only be added if there is a not-picked/locked item in order
            groups[groupName] = {
              name: groupName,
              priority: group.key[2],
              locked: group.key[3] == null,
              qty: group.value.count,
              baskets: []
            }

            if(lockData[groupName] && lockData[groupName].lock){
              groups[groupName].lock  = lockData[groupName].lock;
              groups[groupName].debug = lockData[groupName] //not used, just for debugging

              if(lockData[groupName].baskets){
                groups[groupName].baskets = Array.from(lockData[groupName].baskets);
              }
            }
          }
        }
      }

      for (let group of Object.values(groups)){
        group.isLockedByCurrentUser = !!group.lock && (group.lock.userId === ctx.user._id);
      }

//       for(let i = 0; i < groups.length; i++){
//
//         let groupInstance = new Group(groups[i].name);
//         groups[i].groupData = groupInstance;
//         groups[i].isLockedByCurrentUser = groupInstance.userIsOwner(ctx.user);
//
//         //add any baskets saved in lock file
//         if(groups[i].groupData.basket && groups[i].baskets){
//           let baskets = groups[i].baskets;
//           baskets.push(groups[i].groupData.basket.fullBasket);
// console.log(this.shopList[i]);
//
//           //remove dupes
//           //https://stackoverflow.com/a/14438954
//           groups[i].baskets = baskets.filter((value, index, self) => {
//             return self.indexOf(value) === index;
//           });
//
//         }
//       }

      return Object.values(groups)
    });
}

function sortOrders(a,b){ //given array of orders, sort appropriately.

    let urgency1 = a.key[2]
    let urgency2 = b.key[2]

    if(urgency2 && !urgency1) return 1
    if(urgency1 && !urgency2) return -1

    //Manually pended groups might not have a date.  If no date is set, then assume that it is wanted today
    let dateRegex = /\d\d\d\d-\d\d-\d\d [a-zA-Z]/
    let yyyymmdd  = new Date().toJSON().slice(0, 10)+' N' //pended._id date would be better but that is not available at group_level == 5.  Add it to view's key?
    let group1 = a.key[1].match(dateRegex) ? a.key[1] : yyyymmdd+a.key[1]
    let group2 = b.key[1].match(dateRegex) ? b.key[1] : yyyymmdd+b.key[1]

    //They either both have prepended date or both do not have it
    if (group1 > group2) return 1
    if (group1 < group2) return -1

    let picked1 = a.key[3] == true
    let picked2 = b.key[3] == true

    if(!picked1 && picked2) return -1
    if(picked1 && !picked2) return 1

}

function getImageURLS(shopList, ctx){

    let saveImgCallback = (function(drug){
      for(var n = 0; n < shopList.length; n++){
        if(shopList[n].raw.drug._id == drug._id) shopList[n].extra.image = drug.image
      }
    }).bind(shopList)

    for(var i = 0; i < shopList.length; i++){
      ctx.db.drug.get(shopList[i].raw.drug._id).then(drug => saveImgCallback(drug)).catch(err=>console.log(err))
    }
  }

  function createLockTimestamp(){
  let bigTimestamp = {},
      date = new Date(),
        months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Nov', 'Dec'],
        minutes = date.getMinutes(),
        hours = date.getHours(),
        ampm = hours >= 12 ? 'pm' : 'am';

    hours = hours % 12;

    // the hour '0' should be '12'  ;
    if(hours === 0)
      hours = 12;

    minutes = minutes < 10 ? '0'+minutes : minutes;

    bigTimestamp.date = `${months[date.getMonth() + 1]} ${date.getDate()}`;
    bigTimestamp.time = `${hours}:${minutes}${ampm}`;
    bigTimestamp.fullTime = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear().toString().substring(2)} ${hours}:${minutes}${date.getSeconds()}${ampm}`;

    return bigTimestamp;
  }

function createLock(user){
    let lock = {
      _id: user._id,
      userId: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone
    };

    lock = Object.assign(lock, createLockTimestamp());

    return lock;
  }
  function outcomeChanged(transaction, newOutcome){
  let data = transaction.next[0];

  if(data && data.picked && data.pickedArchive){
    return newOutcome !== data.pickedArchive.matchType;
  }
  else return false;
}

async function saveShoppingResults(arr_enriched_transactions, key, ctx){

    if(arr_enriched_transactions.length == 0) return Promise.resolve()

    //go through enriched trasnactions, edit the raw transactions to store the data,
    //then save them
    var transactions_to_save = [],
        numComplete = {};

    console.log('saveShoppingResults', 'ctx.user', ctx && ctx.user, 'this.user')

    for(var i = 0; i < arr_enriched_transactions.length; i++){

      var reformated_transaction = arr_enriched_transactions[i].raw
      let next = reformated_transaction.next

      if(next[0]){
        if(key == 'shopped'){
          var outcome = this.getOutcome(arr_enriched_transactions[i].extra);

          //TODO: SE: Branch does not seem reachable. Investigate

          next[0].picked = {
            _id:new Date().toJSON(),
            basket:arr_enriched_transactions[i].extra.fullBasket,
            repackQty: reformated_transaction.qty.to ? reformated_transaction.qty.to : reformated_transaction.qty.from,
            matchType:outcome,
            user:this.user,
          };
          next[0].pickedArchive = next[0].picked;
        } else if(key == 'unlock'){
          delete next[0].picked;
          delete next[0].lock;
          delete next[0].pickedArchive;

        } else if(key == 'lockdown'){
          let user = await getUser(ctx);

          if(!!next[0].lock && (next[0].lock.userId === ctx.user._id)){
              //DO NOT REMOVE THE PICK INFORMATION IF ITS THE SAME PERSON
              if(!next[0].relocks)
                next[0].relocks = [];

              next[0].relocks.push(createLockTimestamp().fullTime);
          }
          else if (next[0].picked) {
            next[0].lock = createLock(user);
          }
          else {
            next[0].picked = {};
            next[0].lock = createLock(user);
          }

        }

        let groupName = getGroupNameFromTransaction(reformated_transaction);
        if(next[0].picked && next[0].picked.matchType){
          if(!numComplete[groupName])
            numComplete[groupName] = 0;

          numComplete[groupName]++;
        }
      }

      reformated_transaction.next = next;
      transactions_to_save.push(reformated_transaction);
    }
console.log(numComplete);

    //console.log(ctx.account)
    return ctx.db.transaction.bulkDocs(transactions_to_save, {ctx:ctx})
    .then(res => {
        console.log("results of saving: " + res.map(row => row.ok === true).length + '/' + res.length + ' ok');
        return true
    })
    .catch(err => {
      console.log("error saving:", JSON.stringify(err))
      return false
    })
  }

function getOutcome(extraItemData){
    let res = ''
    for(let possibility in extraItemData.outcome){
      if(extraItemData.outcome[possibility]) res += possibility //this could be made to append into a magic string if there's multiple conditions we want to allow
    }
    return res
  }

exports.dispose = {

  async post(ctx, _id) {
    ctx.account = {_id}
    ctx.body = await updateNext(ctx, 'disposed',{_id:new Date().toJSON(), user:ctx.user})
  },

  // async delete(ctx, _id) {
  //   ctx.account = {_id}
  //   ctx.body = await patchNext(ctx, [])
  // }
}

function updateNext(ctx, key, object){

  for (let transaction of ctx.req.body) {

    if(object){

      if ( !transaction.next[0] || Array.isArray(transaction.next[0])) {
        transaction.next[0] = {}
      }   //for ones where there's already [[]]

      transaction.next[0][key] = object

    } else if (transaction.next[0] && !transaction.next[0].picked) { //then we're clearing out the next property unless it has picked

      transaction.next = []

    }
  }

  return ctx.db.transaction.bulkDocs(ctx.req.body, {ctx})

}

function replaceNext(ctx, next) {

  for (let transaction of ctx.req.body) {
    transaction.next = next
  }
  return ctx.db.transaction.bulkDocs(ctx.req.body, {ctx})
}
