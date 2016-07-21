window.Db = function Db() {}
var BASE_URL = window.location.hostname
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
  if ( ! document.cookie)
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

  obj[method] = function(selector, query) {
    return handler(arr[0], path, method, selector, query || {}).then(then)
  }
}

function findRemote(name, path, method, selector, query) {
  query.selector = selector
  query = Object.keys(query).map(function(key) {
     return key + '=' + JSON.stringify(query[key])
  })

  return ajax({method:'GET', url:BASE_URL+path+'?'+query.join('&')})
}

function findLocal(name, path, method, selector, query) {
  var start = performance.now()

  if (selector && typeof selector._id == 'string')
    return local[name].get(selector._id).then(function(doc) {
      console.log('found', name, 'with _id', selector._id, 'in', (performance.now() - start).toFixed(2), 'ms')
      return [doc]
    })

  if (selector && selector.generic)
    return drugGeneric(selector.generic)

  if (selector && selector.ndc)
    return drugNdc(selector.ndc)

  if (selector && selector.authorized)
    return accountAuthorized(selector.authorized)

  if (name == 'transaction' && query.history)
    return findRemote.apply(this, arguments)

  query.selector = selector
  return local[name].find(query).then(function(doc) {
    console.log('found', doc.docs.length, name+'s with query', JSON.stringify(query), 'in', (performance.now() - start).toFixed(2), 'ms')
    return doc.docs.reverse()
  })
}

function bodyRemote(name, path, method, body) {
  var timeout = 10000
  if (method == 'post' && Array.isArray(body)) {
    path   += '/_bulk_docs'
    body    = {docs:body}
    timeout = 20000
  }

  return ajax({method:method,url:BASE_URL+path,body:body, timeout:timeout}).then(updateProperties(method, body))
}

function bodyLocal(name, path, method, body) {
  return local[name][method == 'delete' ? 'remove' : method](body).then(updateProperties(method, body))
}

function updateProperties(method, body) {
  return res => {

    if (body && method != 'post')
      body._rev = res.rev
    else if (body)
      for (key in res) body[key] = res[key]

    return res
  }
}

function accountAuthorized(accountId) {
  //TODO can we abstract this into a {$text:term} mango query so that we can support more than just generic
  var opts   = {startkey:accountId, endkey:accountId+'\uffff'}
  return local.account.query('account/authorized', opts).then(function(accounts) {
    return accounts.rows.map(function(row) {
      return row.value
    })
  })
  .catch(_ => console.log('wow', new Error(_).stack))
}

function drugGeneric(generic) {
  //TODO can we abstract this into a {$text:term} mango query so that we can support more than just generic
  var tokens = generic.toLowerCase().replace('.', '\\.').split(/, |[, ]/g)
  var opts   = {startkey:tokens[0], endkey:tokens[0]+'\uffff'}
  return local.drug.query('drug/generic', opts).then(function(drugs) {

    //console.log(drugs.length, 'results for', tokens, 'in', Date.now()-start)
    var results = drugs.rows.map(function(drug) {
      drug.value.generic = genericName(drug.value)
      return drug.value
    })

    if ( ! tokens[1])
      return results

    //Use lookaheads to search for each word separately (no order)
    var regex = RegExp('(?=.*'+tokens.join(')(?=.*')+')', 'i')

    return results.filter(function(drug) {
      return regex.test(drug.generic)
    })
  })
}

function drugNdc(ndc) {
  if (ndc.length == 12 && ndc[0] == '3') //bardcode '3'+10 digit upc+checksum
    ndc = ndc.slice(1, 9)

  var term = ndc.replace('-', '')

  var upc  = local.drug.find({selector:{ upc:{$gte:term, $lt:term+'\uffff'}}, limit:200})
  //To avoid duplicates in upc search, filter out where term length is less than ndc9 labeler (no difference between upc an ndc9 here)
  var ndc9 = term.length > 5 ? local.drug.find({selector:{ndc9:{$gte:term, $lt:term+'\uffff'}}, limit:200}) : {docs:[]}

  return Promise.all([upc, ndc9]).then(function(results) {
    return results[0].docs.filter(filter).concat(results[1].docs).map(map)
  })

  function filter(drug) {
    //To avoid duplicates in upc search, filter out where term is less than ndc9 labeler (no difference between upc an ndc9 here)
    //and where upc is not 9 (no difference between ndc9 and upc when upc is length 9).
    return drug.upc.length != 9
  }

  function map(drug) {
    drug.generic = genericName(drug)
    return drug
  }
}

//Only sync resources after user login. https://github.com/pouchdb/pouchdb/issues/4266
function postSession() {
  loading.resources = resources.slice()
  loading.syncing   = resources.map(function(name) {
    return sync(name).then(function() {
      console.log('db', name, 'synced')
      sync(name, true)  //save reference so we can cancel sync on logout
      loading.resources.splice(loading.resources.indexOf(name), 1)
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
resources.forEach(createDatabase)

//Create database steps
//1. Create local
//2. Create remote
//3. Build local index
//4. Poly Fill Find
function createDatabase(r) {
   local[r] = local[r] || new PouchDB(r, {auto_compaction:true}) //this currently recreates unsynced dbs (accounts, drugs) but seems to be working.  TODO change to just resync rather than recreate
  remote[r] = remote[r] || new PouchDB('http:'+BASE_URL+r)
  buildIndex(r)
  sync(r, true)

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

    if (info.update_seq != 0)
     return

    if (name == 'drug') {
      mangoIndex('upc', 'ndc9')
      customIndex('generic', genericIndex) //Unfortunately mango doesn't currently index arrays so we have to make a traditional map function
    }

    else if (name == 'account') {
      mangoIndex('state')
      customIndex('authorized', authorizedIndex) //Unfortunately mango doesn't currently index arrays so we have to make a traditional map function
    }

    else if (name == 'user')
      mangoIndex('email', 'account._id')

    else if (name == 'shipment')
      mangoIndex('tracking', 'account.to._id', 'account.from._id')

    else if (name == 'transaction')
      mangoIndex('shipment._id', 'createdAt', 'verifiedAt')
  })

  function mangoIndex() {
    for (var i in arguments) {
      var fields = Array.isArray(arguments[i]) ? arguments[i] : [arguments[i]]
      //TODO capture promises and return Promise.all()?
      console.log('Building mangoIndex', arguments[i])
      local[name].createIndex({index:{fields:fields}})
    }
  }

  function customIndex(index, mapFn) {
    var start = Date.now()

    var design = {_id: '_design/'+name, views:{}}

    design.views[index] = {map:mapFn.toString()}
    console.log('Building customIndex', name)
    local[name].put(design).then(function() {
      return local[name].query(name+'/'+index, {limit:0})
    }).then(function() {
      console.log('customIndex built', name+'/'+index, Date.now() - start)
    })
    .catch(_ => console.log('customIndex failed', name+'/'+index))
  }
}

function authorizedIndex(doc) {
  for (var i in doc.authorized) {
    emit(doc.authorized[i], doc)
  }
}

function genericIndex(doc) {
  for (var i in doc.generics) {
    if ( ! doc.generics[i].name)
      log('generic map error for', doc)

    emit(doc.generics[i].name.toLowerCase(), doc)
  }
}

function genericName(drug) {
  return drug.generics.map(function(g) { return g.name+" "+g.strength}).join(', ')+' '+drug.form
}

addMethod('user', 'get', findLocal)
addMethod('user', 'post', bodyRemote)
addMethod('user', 'put', bodyLocal)
addMethod('user', 'delete', bodyLocal)
addMethod('user/session', 'post', bodyRemote, postSession)
addMethod('user/session', 'delete', bodyRemote, deleteSession)
addMethod('user/session', 'get', function() {
   let AuthUser = document.cookie && document.cookie.match(/AuthUser=([^;]+)/)
   return Promise.resolve(AuthUser && JSON.parse(AuthUser[1]))
})

addMethod('account', 'get', findLocal)
addMethod('account', 'post', bodyRemote)
addMethod('account', 'put', bodyLocal)
addMethod('account', 'delete', bodyLocal)
addMethod('account/authorized', 'post', bodyRemote)
addMethod('account/authorized', 'delete', bodyRemote)

addMethod('shipment', 'get', findLocal)
addMethod('shipment', 'post', bodyRemote)
addMethod('shipment', 'put', bodyLocal)
addMethod('shipment', 'delete', bodyLocal)

//TODO custom methods for pickup, shipped, received
// addMethod('shipment/attachment', 'get')
// addMethod('shipment/attachment', 'post')
// addMethod('shipment/attachment', 'delete')
// if (typeof arg == 'string')
//   return local['shipments'].getAttachment(selector._id, arg)
// console.log('saving attachment', selector._id, arg._id, arg._rev, arg, arg.type)
// return local['shipments']
// .putAttachment(selector._id, arg._id, arg._rev, arg, arg.type)

addMethod('transaction', 'get', findLocal)
addMethod('transaction', 'post', bodyRemote)
addMethod('transaction', 'put', bodyLocal)
addMethod('transaction', 'delete', bodyLocal)
addMethod('transaction/verified', 'post', bodyRemote)
addMethod('transaction/verified', 'delete', bodyRemote)

addMethod('drug', 'get', findLocal)
addMethod('drug', 'post', bodyRemote)
addMethod('drug', 'put', bodyLocal)
addMethod('drug', 'delete', bodyLocal)
