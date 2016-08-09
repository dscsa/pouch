window.Db = function Db() {}
var BASE_URL = '//'+window.location.hostname+'/'
//Intention to keep syntax as close to the REST API as possible.
var resources = ['drug', 'account', 'user', 'shipment', 'transaction']
var synced    = {}
var remote    = {}
var local     = {}
var loading   = {}

//Client
//this.db.users.get({email:adam@sirum.org})
//this.db.users.post({})
//this.db.users.put({})
//this.db.users.delete({})
//this.db.users.session.post({})
//this.db.users.email.post({})
function ajax(opts) {
  opts.json = true
  return new Promise(function(resolve, reject) {
    PouchDB.ajax(opts, function(err, res) {
      if (err) reject(err)
      else resolve(res)
    })
  })
}

function sync(name, live) {
  if ( ! ~ document.cookie.indexOf('AuthUser'))
    return Promise.resolve()

  return synced[name] = remote[name].sync(local[name], {live:live, retry:true, filter:function(doc) {
      return doc._id.indexOf('_design') !== 0
  }})
}

function addMethod(path, method, handler, then) {
  var arr = path.split('/')
  var obj = Db.prototype

  for (var i in arr) {
    var key  = arr[i]
    obj = obj[key] = obj[key] || {}
  }

  obj[method] = function(body, query) {
    return handler(arr[0], path, method, body, query || {}).then(then)
  }
}

function drugUpdate(name, path, method, body, query) {
  return update(name, path, method, body, query, removeGeneric(body, body => body))
}

function drugUpdateRemote(name, path, method, body, query) {
  return updateRemote(name, path, method, body, query, removeGeneric(body, body => body))
}

function transactionUpdate(name, path, method, body, query) {
  return update(name, path, method, body, query, removeGeneric(body, body => body.drug))
}

function transactionUpdateRemote(name, path, method, body, query) {
  return updateRemote(name, path, method, body, query, removeGeneric(body, body => body.drug))
}

function removeGeneric(body, getDrug) {
  let copy = JSON.parse(JSON.stringify(body))
  addGenericName(getDrug(body))
  getDrug(copy).generic = undefined
  return copy
}

function update(name, path, method, body, query, copy) {
  return local[name][method == 'delete' ? 'remove' : method](copy || body).then(res => updateProps(method, res, body))
}

function updateRemote(name, path, method, body, query, copy) {
  var timeout = 10000
  if (method == 'post' && Array.isArray(body)) {
    path   += '/_bulk_docs'
    timeout = 1000 * body.length //one second per record
    body    = {docs:body}
  }

  return ajax({method,url:BASE_URL+path,body:copy || body, timeout}).then(res => updateProps(method, res, body))
}

//Deep (recursive) merge that keeps references intact to be compatiable with removeGeneric
//Note delete doesn't have a body
function updateProps(method, res, body) {

  if (body && method != 'post')
    body._rev = res.rev || res._rev
  else if (body)
    for (let key in res) {
      typeof res[key] == 'object' && typeof body[key] == 'object'
        ? updateProps(method, res[key], body[key])
        : body[key] = res[key]
    }

  return res
}

function accountAuthorized(accountId) {
  //TODO can we abstract this into a {$text:term} mango query so that we can support more than just generic
  var opts   = {startkey:accountId, endkey:accountId+'\uffff', include_docs:true}
  return local.account.query('account/authorized', opts).then(accounts => {
    return accounts.rows.map(row => row.doc)
  })
  .catch(_ => console.log('accountAuthorized Error', new Error(_).stack))
}

function drugGenericFind(generic) {
  return genericFind(generic, 'drug/generic', drug => drug)
}

function transactionGenericFind(generic) {
  return genericFind(generic, 'transaction/inventoryGeneric', transaction => transaction.drug)
}

function genericFind(generic, index, getDrug) {
  var tokens = generic.toLowerCase().replace('.', '\\.').split(/, |[, ]/g)
  var opts   = {startkey:tokens[0], endkey:tokens[0]+'\uffff', include_docs:true}
  return local[index.split('/')[0]].query(index, opts).then(function(res) {
    //Use lookaheads to search for each word separately (no order)
    var regex  = RegExp('(?=.*'+tokens.join(')(?=.*')+')', 'i')
    let result = []
    for (let row of res.rows) {
      let doc  = row.doc
      let drug = getDrug(doc)
      addGenericName(drug)

      if ( ! tokens[1] || regex.test(drug.generic))
        result.push(doc)
    }

    return result
  })
}

function upcFind(upc, len) {
  return local.drug.find({selector:{upc:upc.slice(0, len)}, limit:1}).then(res => {
    for (let drug of res.docs) addGenericName(drug)
    return res.docs
  })
}

function ndc9Find(ndc9, len) {
  return local.drug.find({selector:{ndc9:ndc9.slice(0, len)}, limit:1}).then(res => {
    for (let drug of res.docs) addGenericName(drug)
    return res.docs
  })
}

function ndcFind(ndc) {
  var term = ndc.replace(/-/g, '')

  //This is a UPC barcode ('3'+10 digit upc+checksum).
  if (term.length == 12 && term[0] == '3')
    term = term.slice(1, -1)

  //Full 11 digit NDC
  if (term.length == 11)
    return ndc9Find(term, 9).then(pkgCode)

  //Full 10 digit UPC
  if (term.length == 10)
    return upcFind(term, 9).then(drugs => drugs.length ? drugs : upcFind(term, 8)).then(pkgCode)

  //If 9 digit or >12 digit, user is likely including a 1 or 2 digit package code with an exact NDC,
  if (term.length > 8)
    return ndc9Find(term, 9).then(drugs => drugs.length ? drugs : upcFind(term, 8)).then(pkgCode)

  //8 or less digits means we have a inexact search which could be UPC or NDC
  var upc  = local.drug.find({selector:{ upc:{$gte:term, $lt:term+'\uffff'}}, limit:200})
  var ndc9 = local.drug.find({selector:{ndc9:{$gte:term, $lt:term+'\uffff'}}, limit:200})

  return Promise.all([upc, ndc9]).then(deduplicate).then(drugs => {
    for (let drug of drugs) addGenericName(drug)
    return drugs
  })

  function pkgCode(drugs) {
    //If found, include the package code in the result
    return drugs.map(drug => {
      var ndc9  = '^'+drug.ndc9+'(\\d{1,2})$'
      var upc   = '^'+drug.upc+'(\\d{1,2})$'
      var match = term.match(RegExp(ndc9+'|'+upc))
      if (match)
        drug.pkg = match[1] || match[2] || match[3] || ''

      return drug
    })
  }
  //To avoid duplicates in upc search, filter out where term is less than ndc9 labeler (no difference between upc an ndc9 here)
  //and where upc is not 9 (no difference between ndc9 and upc when upc is length 9).
  function deduplicate(results) {
    return results[0].docs.filter(function(drug) { return drug.upc.length != 9 }).concat(results[1].docs)
  }
}

function drugFind(name, path, method, selector, query) {
  if (selector && selector.generic)
    return drugGenericFind(selector.generic)

  if (selector && selector.ndc)
    return ndcFind(selector.ndc)

  return find.apply(this, arguments).then(function(drugs) {
    for (let drug of drugs)
      addGenericName(drug)

    return drugs
  })
}

function transactionFind(name, path, method, selector, query) {
  if (selector && selector.generic)
    return transactionGenericFind(selector.generic)

  if (query.history)
    return findRemote.apply(this, arguments)

  return find.apply(this, arguments).then(function(transactions) {
    for (let transaction of transactions)
      addGenericName(transaction.drug)

    return transactions
  })
}

function accountFind(name, path, method, selector, query) {
  if (selector && selector.authorized)
    return accountAuthorized(selector.authorized)

  return find.apply(this, arguments)
}

function find(name, path, method, selector, query) {
  var start = performance.now()
  if (selector && typeof selector._id == 'string' && ! query)
    return local[name].get(selector._id).then(function(doc) {
      console.log('found', name, 'with _id', selector._id, 'in', (performance.now() - start).toFixed(2), 'ms')
      return [doc]
    })

  query.selector = selector
  return local[name].find(query).then(function(res) {
    console.log('found', res.docs.length, name+'s with query', JSON.stringify(query), 'in', (performance.now() - start).toFixed(2), 'ms')
    return res.docs.reverse()
  })
}

function findRemote(name, path, method, selector, query) {
  query.selector = selector
  query = Object.keys(query).map(function(key) {
     return key + '=' + JSON.stringify(query[key])
  })

  return ajax({method:'GET', url:BASE_URL+path+'?'+query.join('&')})
}

//Only sync resources after user login. https://github.com/pouchdb/pouchdb/issues/4266
function postSession() {
  loading.resources = resources.slice()
  loading.syncing   = resources.map(function(name) {
    return sync(name).then(function() {
      console.log('db', name, 'synced')
      sync(name, true)  //save reference so we can cancel sync on logout
      loading.resources.splice(loading.resources.indexOf(name), 1)
      buildIndex(name)
    })
  })
  return loading
}

//Stop database sync on logout
//Recreate some databases on logout
function deleteSession() {
  return Promise.all(resources.map(function(name) {
    //keep these two for the next user's session
    if (name == 'account' || name == 'drug') {
      //Check if synced because a refresh on logout
      return synced[name] && synced[name].cancel()
    }

    //Destroying will stop these from syncing as well
    return local[name].destroy().then(function() {
      delete local[name]
      delete remote[name]
      delete synced[name]
      return createDatabase(name)
    })
  }))
}

//Create databases on load/refresh
//Create database steps
//1. Create local
//2. Create remote
//3. Build local index
//4. Poly Fill Find
resources.forEach(createDatabase)
function createDatabase(r) {
   local[r] =  local[r] || new PouchDB(r, {auto_compaction:true}) //this currently recreates unsynced dbs (accounts, drugs) but seems to be working.  TODO change to just resync rather than recreate
  remote[r] = remote[r] || new PouchDB('http:'+BASE_URL+r)
  buildIndex(r)
  setTimeout(_ => sync(r, true), 5000) //Kiah's laptop was maxing out on TCP connections befor app-bundle loaded.  Wait on _changes into static assets can load

  //Polyfill for find to support null selector
  //TODO get rid of this polyfill once mango supports .find() with null selector
  var find = local[r].find.bind(local[r])

  local[r].find = function(opts) {

    if (opts.selector)
      return find(opts)

    r == 'drug' //drug _id is NDC (number) which starts before _ alphabetically
      ? opts.endkey   = '_design'
      : opts.startkey = '_design\uffff'

    opts.include_docs = true

    return local[r].allDocs(opts).then(function(docs) {
      return {docs:docs.rows.map(function(doc) { return doc.doc })}
    })
  }
}

//Build all the type's indexes
//PouchDB.debug.enable('pouchdb:find')
//PouchDB.debug.disable('pouchdb:find')
function buildIndex(name) {
  return local[name].info().then(function(info) {
    if (name == 'drug') {
      mangoIndex('upc', 'ndc9')
      customIndex('generic', drugGenericIndex) //Unfortunately mango doesn't currently index arrays so we have to make a traditional map function
    }

    else if (name == 'account') {
      mangoIndex('state')
      customIndex('authorized', authorizedIndex) //Unfortunately mango doesn't currently index arrays so we have to make a traditional map function
    }

    else if (name == 'user')
      mangoIndex('email', 'account._id')

    else if (name == 'shipment')
      mangoIndex('tracking', 'account.to._id', 'account.from._id')

    else if (name == 'transaction') {
      mangoIndex('shipment._id', 'createdAt', 'verifiedAt')
      customIndex('inventoryGeneric', inventoryGenericIndex)
    }

    function mangoIndex() {
      [].slice.call(arguments).forEach(function(field) { //need to freeze field which doesn't happen with a for..in loop
        var field = Array.isArray(field) ? field : [field]
        if (info.update_seq == 0) {
          return local[name].createIndex({index:{fields:field}}).catch(function() {
            console.log('Preparing mango index', name+'/'+field)
          })
        }

        var start  = Date.now()
        local[name].find({limit:0}).then(function() {
          console.log('Mango index', name+'/'+field, 'built in', Date.now() - start)
        })
      })
    }

    function customIndex(index, mapFn) {
      if (info.update_seq == 0) {
        var design = {_id: '_design/'+name, views:{}}
        design.views[index] = {map:mapFn.toString()}
        return local[name].put(design).catch(function() {
          console.log('Preparing custom index', name+'/'+index)
        })
      }

      var start = Date.now()
      return local[name].query(name+'/'+index, {limit:0}).then(function() {
        console.log('Custom index', name+'/'+index, 'built in', Date.now() - start)
      })
    }
  })
}

function authorizedIndex(doc) {
  for (var i in doc.authorized) {
    emit(doc.authorized[i])
  }
}

function drugGenericIndex(doc) {
  for (var i in doc.generics) {
    if ( ! doc.generics[i].name)
      log('drug generic map error for', doc)

    emit(doc.generics[i].name.toLowerCase())
  }
}

function inventoryGenericIndex(doc) {
  for (var i in doc.drug.generics) {
    if ( ! doc.drug.generics[i].name)
      log('transaction generic map error for', doc)

    if (doc.shipment._id.split('.').length == 1) //inventory only
      emit(doc.drug.generics[i].name.toLowerCase())
  }
}

function addGenericName(drug) {
  drug.generic = drug.generics.map(generic => generic.name+" "+generic.strength).join(', ')+' '+drug.form
}

addMethod('user', 'get', find)
addMethod('user', 'post', updateRemote)
addMethod('user', 'put', update)
addMethod('user', 'delete', update)
addMethod('user/session', 'post', updateRemote, postSession)
addMethod('user/session', 'delete', updateRemote, deleteSession)
addMethod('user/session', 'get', function() {
   let AuthUser = document.cookie && document.cookie.match(/AuthUser=([^;]+)/)
   return Promise.resolve(AuthUser && JSON.parse(AuthUser[1]))
})

addMethod('account', 'get', accountFind)
addMethod('account', 'post', updateRemote)
addMethod('account', 'put', update)
addMethod('account', 'delete', update)
addMethod('account/authorized', 'post', updateRemote)
addMethod('account/authorized', 'delete', updateRemote)

addMethod('shipment', 'get', find)
addMethod('shipment', 'post', updateRemote)
addMethod('shipment', 'put', update)
addMethod('shipment', 'delete', update)

//TODO custom methods for pickup, shipped, received
// addMethod('shipment/attachment', 'get')
// addMethod('shipment/attachment', 'post')
// addMethod('shipment/attachment', 'delete')
// if (typeof arg == 'string')
//   return local['shipments'].getAttachment(selector._id, arg)
// console.log('saving attachment', selector._id, arg._id, arg._rev, arg, arg.type)
// return local['shipments']
// .putAttachment(selector._id, arg._id, arg._rev, arg, arg.type)

addMethod('transaction', 'get', transactionFind)
addMethod('transaction', 'post', transactionUpdateRemote)
addMethod('transaction', 'put', transactionUpdate)
addMethod('transaction', 'delete', transactionUpdate)
addMethod('transaction/verified', 'post', updateRemote)
addMethod('transaction/verified', 'delete', updateRemote)

addMethod('drug', 'get', drugFind)
addMethod('drug', 'post', drugUpdateRemote)
addMethod('drug', 'put', drugUpdate)
addMethod('drug', 'delete', drugUpdate)
