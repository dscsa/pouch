window.Db = function Db() {}
var BASE_URL = '//'+window.location.hostname+'/'
//Intention to keep syntax as close to the REST API as possible.
var resources = ['drug', 'account', 'user', 'shipment'] //Don't sync transaction to increase installation speed
var db        = {}
var loading   = {}
var synced    = {}
var remote    = {}

//Client
//this.db.users.get({email:adam@sirum.org})
//this.db.users.post({})
//this.db.users.put({})
//this.db.users.delete({})
//this.db.users.session.post({})
//this.db.users.email.post({})
function ajax(url, method, body, opts = {}) {

  return fetch(BASE_URL.replace(/:\d{2,4}/, '')+url, {
  	method:method,
    mode:'cors',
  	headers:opts.headers,
    timeout:opts.timeout,
    credentials:"include",
    body:JSON.stringify(body)
  }).then(res => {
    return res.json().then(body => {
      if (res.status >= 200 && res.status < 400) return body
      throw {body, headers:res.headers, status:res.status, reason:body.reason || res.statusText, url:res.url}
    })
  })
}

function addMethod(path, method) {
  var arr = path.split('/')
  var obj = Db.prototype

  for (var i in arr) {
    var key  = arr[i]
    obj = obj[key] = obj[key] || {}
  }

  obj[method.name] = function(body, opts) {
    return method(arr[0], path, body, opts || {})
  }
}

function toDoc(name, docs, copy) {
  if ( ! Array.isArray(docs))
    return _toDoc[name](docs, copy)

  return docs.map(doc => _toDoc[name](doc, copy))
}

var _toDoc = {
  transaction(doc, copy) {
    return ! copy ? doc : {
      _id:doc._id,
      _rev:doc._rev,
      createdAt:doc.createdAt,
      verifiedAt:doc.verifiedAt,
      next:doc.next,
      exp:{from:doc.exp.from, to:doc.exp.to},
      qty:{from:doc.qty.from, to:doc.qty.to},
      location:doc.location,
      shipment:doc.shipment,
      user:doc.user,
      drug:{
        _id:doc.drug._id,
        brand:doc.drug.brand,
        generic:doc.drug.generic,
        generics:doc.drug.generics,
        form:doc.drug.form,
        pkg:doc.drug.pkg,
        price:{
          updatedAt:doc.drug.price.updatedAt,
          nadac:doc.drug.price.nadac,
          goodrx:doc.drug.price.goodrx
        }
      }
    }
  },

  shipment(doc, copy) {
    return ! copy ? doc : {
      _id:doc._id,
      _rev:doc._rev,
      status:doc.status,
      tracking:doc.tracking,
      createdAt:doc.createdAt,
      account:{
        to:{
          _id:doc.account.to._id,
          name:doc.account.to.name
        },
        from:{
          _id:doc.account.from._id,
          name:doc.account.from.name
        }
      }
    }
  },

  account(doc, copy) {
    return ! copy ? doc : {
      _id:doc._id,
      _rev:doc._rev,
      license:doc.license,
      name:doc.name,
      street:doc.street,
      city:doc.city,
      state:doc.state,
      zip:doc.zip,
      authorized:doc.authorized,
      ordered:doc.ordered,
      createdAt:doc.createdAt
    }
  },

  user(doc, copy) {
    return ! copy ? doc : {
      _id:doc._id,
      _rev:doc._rev,
      email:doc.email,
      password:doc.password,
      phone:doc.phone,
      createdAt:doc.createdAt,
      account:{_id:doc.account._id},
      name:{
        first:doc.name.first,
        last:doc.name.last
      }
    }
  },

  drug(doc, copy) {
    doc.price = doc.price || {}
    return ! copy ? doc : {
      _id:doc._id,
      _rev:doc._rev,
      createdAt:doc.createdAt,
      form:doc.form,
      generics:doc.generics,
      generic:doc.generic,
      brand:doc.brand,
      ndc9:doc.ndc9,
      upc:doc.upc,
      labeler:doc.labeler,
      image:doc.image,
      price:{
        updatedAt:doc.price.updatedAt,
        nadac:doc.price.nadac,
        goodrx:doc.price.goodrx
      }
    }
  }
}

var localMethod = {

  get(name, path, body, opts) {
    if ( ! body) {//Polyfill for pouchdb-find null selector which returns everything if body is not specified

      path == 'drug' //drug _id is NDC (number) which starts before _ alphabetically
        ? opts.endkey   = '_design'
        : opts.startkey = '_design\uffff'

      opts.include_docs = true
      return db[name].allDocs(opts).then(docs => toDoc(name, docs.rows.map(doc => doc.doc)))
    }

    //Quick get if _id is specified
    if (typeof body._id == 'string')
      return db[name].get(body._id).then(doc => toDoc(name, [doc]))

    if (body.generic)
      return queries[name].generic(body.generic, opts)

    if (body.ndc)
      return queries[name].ndc(body.ndc, opts).then(docs => toDoc(name, docs))

    if (body.authorized)
      return queries[name].authorized(body.authorized, opts).then(docs => toDoc(name, docs))

    opts.selector = body
    return db[name].find(opts).then(res => toDoc(name, res.docs.reverse()))
  },

  put(name, path, body) {
    return db[name].put(toDoc(name, body, true)).then(res => updateProps(res, body))
  },

  //Delete doesn't have a body to update
  delete(name, path, body) {
    return db[path].remove(body).then(res => updateProps(res, body))
  }
}

var remoteMethod = {

  get(name, path, body, opts) {
    return session.get().then(session => {

      opts.selector = body
      opts = Object.keys(opts).map(i => i+'='+JSON.stringify(opts[i])).join('&')

      return ajax(path+'?'+opts, 'get').then(docs => toDoc(name, docs.reverse()))
    })
  },

  put(name, path, body) {
    return ajax(path, 'put', toDoc(name, body, true)).then(res => updateProps(res, body))
  },

  //Delete usually doesn't need to update anything unless it's like transactions/verified
  delete(name, path, body) {
    return ajax(path, 'delete', body).then(res => updateProps(res, body))
  },

  //No postLocal  All post's are remote for short _ids
  post(name, path, body, opts) {
    if (Array.isArray(body)) {
      var doc = {docs:toDoc(name, body, true)}
      path += '/_bulk_docs',
      opts.timeout = 1000 * body.length //one second per record
    } else {
      var doc = toDoc(name, body, true)
    }

    return ajax(path, 'post', doc, opts).then(res => updateProps(res, body))
  }
}

var session = {
  get() {
     let AuthUser = document.cookie && document.cookie.match(/AuthUser=([^;]+)/)
     return Promise.resolve(AuthUser && JSON.parse(AuthUser[1]))
  },

  //Only sync resources after user login. https://github.com/pouchdb/pouchdb/issues/4266
  post(name, path, body, opts) {
    console.log('session post', name, path, body, opts)
    return ajax(path, 'post', body, opts).then(_ => {
      var loading = {
        resources:resources.slice(),
        progress:{update_seq:0, last_seq:0}
      }

      loading.syncing = resources.map(function(name) {
        loading.progress.update_seq += remote[name].update_seq
        return sync(name).on('change', info => {
          loading.progress[name] = info.change.last_seq
          loading.progress.last_seq = resources.reduce((a, name)=> a+(loading.progress[name] || 0), 0)
        })
        .then(function() {
          console.log('db', name, 'synced')
          loading.resources.splice(loading.resources.indexOf(name), 1)
          buildIndex(name)
        })
      })

      Promise.all(loading.syncing).then(_ => {
        for (let name of resources) sync(name, true) //this uses up a tcp connection with long-polling so wait until all db sync before going "live"
      })

      return loading
    })
  },

  //Stop database sync on logout
  //Recreate some databases on logout
  delete(name, path, body, opts) {
    return ajax(path, 'delete', body, opts).then(_ => {
      return Promise.all(resources.map(function(name) {
        //Destroying will stop these from syncing as well
        return db[name].destroy().then(function() {
          delete db[name]
          return createDatabase(name)
        })
      }))
    })
  }
}

//Deep (recursive) merge that keeps references intact to be compatiable with excludeProperties
//Note delete doesn't have a body
function updateProps(res, body) {
  for (let key in res) {
    typeof res[key] == 'object' && typeof body[key] == 'object'
      ? updateProps(res[key], body[key])
      : body[key] = body[key] || res[key]
    //answer must be in loop in case of multiple responses (_bulk_docs)
    body._rev = res._rev || res.rev  //res._rev is from remote db, res.rev is from local db
  }

  return res
}

var queries = {
  account:{
    authorized(accountId) {
      //TODO can we abstract this into a {$text:term} mango query so that we can support more than just generic
      var opts = {startkey:accountId, endkey:accountId+'\uffff', include_docs:true}
      return db.account.query('account/authorized', opts).then(res => res.rows.map(row => row.doc))
      .catch(_ => console.log('accountAuthorized Error', new Error(_).stack))
    }
  },
  drug:{
    generic(generic) {
      var tokens = generic.toLowerCase().replace('.', '\\.').split(/, |[, ]/g)
      var opts   = {startkey:tokens[0], endkey:tokens[0]+'\uffff', include_docs:true}
      return db.drug.query('drug/generic', opts).then(function(res) {
        //Use lookaheads to search for each word separately (no order)
        var regex  = RegExp('(?=.*'+tokens.join(')(?=.*')+')', 'i')

        let result = []
        for (let row of res.rows) {
          if ( ! tokens[1] || regex.test(row.doc.generic))
            result.push(row.doc)
        }

        return result
      })
    },

    ndc(ndc) {
      var term = ndc.replace(/-/g, '')

      //This is a UPC barcode ('3'+10 digit upc+checksum).
      if (term.length == 12 && term[0] == '3')
        term = term.slice(1, -1)

      //Full 11 digit NDC
      if (term.length == 11)
        return drugNdc9Find(term, 9).then(pkgCode)

      //Full 10 digit UPC
      if (term.length == 10)
        return drugUpcFind(term, 9).then(drugs => drugs.length ? drugs : drugUpcFind(term, 8)).then(pkgCode)

      //If 9 digit or >12 digit, user is likely including a 1 or 2 digit package code with an exact NDC,
      if (term.length > 8)
        return drugNdc9Find(term, 9).then(drugs => drugs.length ? drugs : drugUpcFind(term, 8)).then(pkgCode)

      //8 or less digits means we have a inexact search which could be UPC or NDC
      var upc  = db.drug.find({selector:{ upc:{$gte:term, $lt:term+'\uffff'}}, limit:200})
      var ndc9 = db.drug.find({selector:{ndc9:{$gte:term, $lt:term+'\uffff'}}, limit:200})

      return Promise.all([upc, ndc9]).then(deduplicate)

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
  }
}

function drugUpcFind(upc, len) {
  return db.drug.find({selector:{upc:upc.slice(0, len)}, limit:1}).then(res => toDoc('drug', res.docs))
}

function drugNdc9Find(ndc9, len) {
  return db.drug.find({selector:{ndc9:ndc9.slice(0, len)}, limit:1}).then(res => toDoc('drug', res.docs))
}

//Create databases on load/refresh
//Create database steps
//1. Create local
//2. Create remote
//3. Build local index
//4. Poly Fill Find
resources.forEach(createDatabase)
function createDatabase(r) {

  db[r] = new PouchDB(r, {auto_compaction:true}) //this currently recreates unsynced dbs (accounts, drugs) but seems to be working.  TODO change to just resync rather than recreate
  remote[r] = new PouchDB('http:'+BASE_URL+r)
  remote[r].info().then(info => remote[r].update_seq = info.update_seq)

  buildIndex(r)

  session.get().then(session => {
    session && setTimeout(_ => sync(r, true), 5000) //Kiah's laptop was maxing out on TCP connections befor app-bundle loaded.  Wait on _changes into static assets can load
  })
}

function sync(r, live) {
 console.log('syncing', r, 'live', live)
 return synced[r] = db[r].sync(remote[r], {live, retry:true, filter:doc => doc._id.indexOf('_design') !== 0 })
}

//Build all the type's indexes
//PouchDB.debug.enable('pouchdb:find')
//PouchDB.debug.disable('pouchdb:find')
function buildIndex(name) {

  return db[name].info().then(function(info) {

    if (name == 'drug') {
      mangoIndex('upc', 'ndc9')
      customIndex('generic', index.drugGeneric) //Unfortunately mango doesn't currently index arrays so we have to make a traditional map function
    }

    else if (name == 'account') {
      mangoIndex('state')
      customIndex('authorized', index.authorized) //Unfortunately mango doesn't currently index arrays so we have to make a traditional map function
    }

    else if (name == 'user')
      mangoIndex('email', 'account._id')

    else if (name == 'shipment')
      mangoIndex('tracking', 'account.to._id', 'account.from._id')

    function mangoIndex() {
      [].slice.call(arguments).forEach(function(field) { //need to freeze field which doesn't happen with a for..in loop
        var field = Array.isArray(field) ? field : [field]
        if (info.update_seq == 0) {
          return db[name].createIndex({index:{fields:field}}).catch(function() {
            console.log('Preparing mango index', name+'/'+field)
          })
        }

        var start  = Date.now()
        db[name].find({selector:{[field]:true}, limit:0}).then(function() {
          //console.log('Mango index', name+'/'+field, 'built in', Date.now() - start)
        })
      })
    }

    function customIndex(index, mapFn) {
      if (info.update_seq == 0) {
        var design = {_id: '_design/'+name, views:{}}
        mapFn = mapFn.toString()

        design.views[index] = {
          map:mapFn.indexOf('function') == 0
            ? mapFn
            : 'function '+mapFn
        }
        return db[name].put(design).catch(function() {
          console.log('Preparing custom index', name+'/'+index)
        })
      }

      var start = Date.now()
      return db[name].query(name+'/'+index, {limit:0}).then(function() {
        //console.log('Custom index', name+'/'+index, 'built in', Date.now() - start)
      })
    }
  })
}

var index = {
  authorized(doc) {
    for (var i in doc.authorized) {
      emit(doc.authorized[i])
    }
  },

  //TODO can we have a built-in grouping or reduce function since both the drug and inventory pages group by generic name manually right now
  drugGeneric(doc) {
    for (var i in doc.generics) {
      if ( ! doc.generics[i].name)
        log('drug generic map error for', doc)

      emit(doc.generics[i].name.toLowerCase())
    }
  }
}

addMethod('user', localMethod.get)
addMethod('user', remoteMethod.post)
addMethod('user', localMethod.put)
addMethod('user', localMethod.delete)
addMethod('user/session', session.post)
addMethod('user/session', session.delete)
addMethod('user/session', session.get)

addMethod('account', localMethod.get)
addMethod('account', remoteMethod.post)
addMethod('account', localMethod.put)
addMethod('account', localMethod.delete)
addMethod('account/authorized', remoteMethod.post)
addMethod('account/authorized', remoteMethod.delete)

addMethod('shipment', localMethod.get)
addMethod('shipment', remoteMethod.post)
addMethod('shipment', localMethod.put)
addMethod('shipment', localMethod.delete)
//TODO custom methods for pickup, shipped, received
// addMethod('shipment/attachment', 'get')
// addMethod('shipment/attachment', 'post')
// addMethod('shipment/attachment', 'delete')

addMethod('transaction', remoteMethod.get)
addMethod('transaction', remoteMethod.post)
addMethod('transaction', remoteMethod.put)
addMethod('transaction', remoteMethod.delete)
addMethod('transaction/verified', remoteMethod.post)
addMethod('transaction/verified', remoteMethod.delete)

addMethod('drug', localMethod.get)
addMethod('drug', remoteMethod.post)
addMethod('drug', remoteMethod.put) //since generic name is now preset
addMethod('drug', localMethod.delete)
