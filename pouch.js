window.Db = function Db() {}

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

  return remote[name].sync(local[name], {live:live, retry:true, filter:function(doc) {
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

  return ajax({method:'GET', url:'//localhost:3000/'+path+'?'+query.join('&')})
}

function findLocal(name, path, method, selector, query) {
  var start = performance.now()
  if (selector && selector.generic)
    return drugGeneric(selector.generic)

  if (selector && selector.ndc)
    return drugNdc(selector.ndc)

  if (name == 'transaction' && query.history)
    return findRemote.apply(this, arguments)

  query.selector = selector
  return local[name].find(query).then(function(doc) {
    console.log('found', doc.docs.length, name+'s with query', JSON.stringify(query), 'in', (performance.now() - start).toFixed(2), 'ms')
    return doc.docs.reverse()
  })
}

function bodyRemote(name, path, method, body) {
  return ajax({method:method,url:'//localhost:3000/'+path,body:body}).then(updateProperties(method, body))
}

function bodyLocal(name, path, method, body) {
  return local[name][method == 'delete' ? 'remove' : method](body).then(updateProperties(method, body))
}

function updateProperties(method, body) {
  return res => {
    console.log('pouch.updateProperties', method, body, res, Object.keys(res))
    if ( ! body) return res
    if (method != 'post') {
      body._rev = res.rev
    } else {
      for (key in res)
        body[key] = res[key]
    }

    return res
  }
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
  var term = ndc.replace('-', '')
  var ndc9 = drugs({ndc9:{$gte:term, $lt:term+'\uffff'}}, {limit:200})
  var upc  = drugs({ upc:{$gte:term, $lt:term+'\uffff'}}, {limit:200})
  return Promise.all([ndc9, upc]).then(function(results) {
    //Filter out where upc is not 9 because to avoid duplicates upc search
    return results[0].filter(filter).concat(results[1]).map(map)
  })

  function filter(drug) {
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
      synced[name] = sync(name, true)  //save reference so we can cancel sync on logout
      loading.resources.splice(loading.resources.indexOf(name), 1)
    })
  })
  return loading
}

//Stop database sync on logout
//Recreate some databases on logout
function deleteSession() {
  return Promise.all(resources.map(function(name) {
    console.log('destroying database', name)
    //keep these two for the next user's session
    if (name == 'accounts' || name == 'drugs')
      return synced[name] && synced[name].cancel()

    //Destroying will stop these from syncing as well
    return local[name].destroy().then(function() {
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
   local[r] = new PouchDB(r, {auto_compaction:true})
  remote[r] = new PouchDB('http://localhost:3000/'+r)
  buildIndex(r)
  sync(r, true)

  //Polyfill for find to support null selector
  //TODO get rid of this polyfill once mango supports .find() with null selector
  var find = local[r].find.bind(local[r])

  local[r].find = function(opts) {

    if (opts.selector)
      return find(opts)

    r == 'drugs' //drug _id is NDC (number) which starts before _ alphabetically
      ? opts.endkey   = '_design'
      : opts.startkey = '_design\uffff'

    opts.include_docs = true

    return local[r].allDocs(opts).then(function(docs) {
      console.log('allDocs', opts, docs)
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

    console.log('Building index for', name)
    var index
    if (name == 'drug') {
      index = ['upc', 'ndc9']
      mapGenerics()
    }
    else if (name == 'account')
      index = ['state', ['state', '_id']]
    else if (name == 'user')
      index = ['email', 'account._id']
    else if (name == 'shipment')
      index = ['tracking', 'account.to._id', 'account.from._id']
    else if (name == 'transaction')
      index = ['shipment._id', 'createdAt', 'verifiedAt']

    for (var i in index) {
      var fields = Array.isArray(index[i]) ? index[i] : [index[i]]
      //TODO capture promises and return Promise.all()?
      local[name].createIndex({index:{fields:fields}}).then(function() {
        console.log('Index built', index[i], _)
      })
    }
  })
}

function mapGenerics() {
  var start = Date.now()
  //Unfortunately mango doesn't index arrays so we have to make a traditional map function
  local.drug.put({_id: '_design/drug', views:{
    generic:{map:genericSearch.toString()}
  }})
  .then(function() {
    return local.drug.query('drug/generic', {limit:0})
  })
  .then(function() {
    console.log('Index built', 'drug.generic', Date.now() - start)
  }, function(e){
    console.trace(e)
  })
}

function genericSearch(doc) {
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
   return Promise.resolve(document.cookie && JSON.parse(document.cookie.slice(9)))
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
