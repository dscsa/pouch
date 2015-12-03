window.Db = function Db() {}

//Intention to keep syntax as close to the REST API as possible.  For example that is why we do
//this.db.users({_id:123}).session.post(password) and not this.db.users().session.post({_id:123, password:password})
var resources = ['drugs', 'accounts', 'users', 'shipments', 'transactions']
var synced    = {}
var remote    = {}
var local     = {}
var ajax      = function(opts) {
  return new Promise((resolve, reject) => {
    PouchDB.ajax(opts, function(err, res) {
      if (err) reject(err)
      else resolve(res)
    })
  })
}


//User Resource Endpoint
// get('/users', users.list, {strict:true})        //TODO only show logged in account's users
// post('/users', users.post)                      //TODO only create user for logged in account
// all('/users/:id', users.doc)                    //TODO only get, modify, & delete user for logged in account
// post('/users/:id/email', users.email)           //TODO only get, modify, & delete user for logged in account
// post('/users/:id/session', users.session.post)  //Login
// del('/users/:id/session', users.session.delete) //Logout
Db.prototype.users = function(selector) {
  var session = JSON.parse(sessionStorage.getItem('session') || "null")

  if (session && typeof selector != 'object')
    selector = selector ? {name:session.name} : {account:session.account._id}

  var results = {
    then(a,b) {
      return users(selector).then(a,b)
    },
    catch(a) {
      return users(selector).catch(a)
    },
    //WARNING unlike other methods this one is syncronous
    session() {
      return session
    }
  }

  results.session.post = function(password) {
    return helper(users, selector, 'POST', 'users/:id/session', password)
    .then(sessions => {
      session = sessions[0]
      sessionStorage.setItem('session', JSON.stringify(session))
      return Promise.all(resources.map(name => {
        //Only sync resources after user login. https://github.com/pouchdb/pouchdb/issues/4266
        return remote[name].sync(local[name], {retry:true, filter})
        .then(_ => {
          synced[name] = remote[name].sync(local[name], {live:true, retry:true, filter})
          //Output running list of what is left because syncing takes a while
          //Can't use original index because we are deleting items as we go
          results.session.loading.splice(results.session.loading.indexOf(name), 1)
        })
      }))
      .then(_ => sessions[0])
    })
  }

  results.session.remove = function() {
    if ( ! session) return Promise.resolve(true)
    sessionStorage.removeItem('session')
    return helper(users, selector, 'DELETE', 'users/:id/session')
    .then(_ => {
      //Destroying will stop the rest of the dbs from syncing
      synced.accounts && synced.accounts.cancel();
      synced.drugs && synced.drugs.cancel();

      return Promise.all(['users', 'shipments', 'transactions']
      .map(resource => {
        return local[resource].destroy().then(_ => {
            results.session.loading.push(resources)
            return db(resource)
        })
      }))
    })
  }

  results.session.loading = Object.assign([], resources)

  return results
}
var users = methods('users')

//Transaction Resource Endpoint
// get('/transactions', transactions.list, {strict:true})          //List all docs in resource. Strict means no trailing slash
// post('/transactions', transactions.post)                        //Create new record in DB with short uuid
// all('/transactions/:id', transactions.doc)                      //TODO replace this with a show function. Allow user to get, modify, & delete docs
// get('/transactions/:id/history', transactions.history)          //Resursively retrieve transaction's history
// post('/transactions/:id/captured', transactions.captured.post)  //New transaction created in inventory, available for further transactions
// del('/transactions/:id/captured', transactions.captured.delete) //New transaction removed from inventory, cannot be done if item has further transaction
Db.prototype.transactions = function(selector) {
  var results = {
    then(a,b) {
      return transactions(selector).then(a,b)
    },
    catch(a) {
      return transactions(selector).catch(a)
    },
    history() {
      return helper(transactions, selector, 'GET', 'transactions/:id/history')
    },
    captured:{
      post() {
        return helper(transactions, selector, 'POST', 'transactions/:id/captured')
      },
      remove() {
        return helper(transactions, selector, 'DELETE', 'transactions/:id/captured')
      }
    }
  }

  return results
}
var transactions = methods('transactions')

//Account Resource Endpoint
// get('/accounts', accounts.list, {strict:true})              //List all docs in resource. Strict means no trailing slash
// post('/accounts', accounts.post)                            //Create new record in DB with short uuid
// all('/accounts/:id', accounts.doc)                          //Allow user to get, modify, & delete docs
// post('/accounts/:id/email', accounts.email)                 //Allow user to get, modify, & delete docs
// post('/accounts/:id/authorized', accounts.authorized.post)  //Allow user to get, modify, & delete docs
// del('/accounts/:id/authorized', accounts.authorized.delete) //Allow user to get, modify, & delete docs
Db.prototype.accounts = function(selector) {
  var results = {
    then(a,b) {
      return accounts(selector).then(a,b)
    },
    catch(a) {
      return accounts(selector).catch(a)
    },
    authorized:{
      post() {
        console.log('authorizing')
        return helper(accounts, selector, 'POST', 'accounts/:id/authorized')
      },
      remove() {
        return helper(accounts, selector, 'DELETE', 'accounts/:id/authorized')
      }
    }
  }

  return results
}
var accounts = methods('accounts')

//Shipment Resource Endpoint
// get('/shipments', shipments.list, {strict:true})          //List all docs in resource. TODO "find" functionality in querystring
// post('/shipments', shipments.post)                        // TODO label=fedex creates label, maybe track=true/false eventually
// all('/shipments/:id', shipments.doc)                      // Allow user to get, modify, & delete docs
// post('/shipments/:id/shipped', shipments.shipped)         // TODO add shipped_at date and change status to shipped
// post('/shipments/:id/received', shipments.received)       // TODO add recieved_at date and change status to received
// post('/shipments/:id/pickup', shipments.pickup.post)      // add pickup_at date. Allow webhook filtering based on query string ?description=tracker.updated&result.status=delivered.
// del('/shipments/:id/pickup', shipments.pickup.delete)     // delete pickup_at date
// get('/shipments/:id/manifest', shipments.manifest.get)    // pdf options?  if not exists then create, rather than an explicit POST method
// del('/shipments/:id/manifest', shipments.manifest.delete) // delete an old manifest
Db.prototype.shipments = function(selector) {
  var results = {
    then(a,b) {
      return shipments(selector).then(a,b)
    },
    catch(a) {
      return shipments(selector).catch(a)
    },
    shipped:{
      post() {
        throw Error('not implemented')
      }
    },
    received:{
      post() {
        throw Error('not implemented')
      }
    },
    pickup:{
      post() {
        throw Error('not implemented')
      },
      remove() {
        throw Error('not implemented')
      }
    },
    attachment:function(arg) {
      if (typeof arg == 'string')
        return local['shipments'].getAttachment(selector._id, arg)
      console.log('saving attachment', selector._id, arg._id, arg._rev, arg, arg.type)
      return local['shipments']
      .putAttachment(selector._id, arg._id, arg._rev, arg, arg.type)
    }
  }

  return results
}
var shipments = methods('shipments')

// get('/drugs', drugs.list, {strict:true})
// post('/drugs', drugs.post)               //Create new record in DB with short uuid
// all('/drugs/:id', drugs.doc)             //TODO should PUT be admin only?
Db.prototype.drugs = function(selector, limit) {
  var results = {
    then(a,b) {
      return drugs(selector, limit).then(a,b)
    },
    catch(a) {
      return drugs(selector, limit).catch(a)
    }
  }

  return results
}
var drugs = methods('drugs')

resources.forEach(r => {
    db(r)
    remote[r] = new PouchDB('http://localhost:3000/'+r)

    if (sessionStorage.getItem('session'))
      synced[r] = remote[r].sync(local[r], {live:true, retry:true, filter})
})

// save it
local['drugs'].put({_id: '_design/drug', views: {search:{map:drugSearch.toString()}}})
.then(function () {
  console.log('Building drug search index.  This may take a while...')
  return local['drugs'].query('drug/search', {limit:0}).then(console.log)
})
.catch(function(){})

function filter(doc) {
    return doc._id.indexOf('_design') !== 0
}

function drugSearch(doc) {
  log('doc', doc)
  var names = doc.names.concat([doc.ndc9, doc.upc])
  var str   = doc.ndc9+" "+doc.names.join(", ")+" "+doc.form
  for (var i in names) {
    var name = names[i]
    for (var j=4; j<=name.length; j++) {
      var key = name.slice(0, j)
      emit(key.toLowerCase(), str.split(key))
    }
  }
}

//Build all the type's indexes
//PouchDB.debug.enable('pouchdb:find')
//PouchDB.debug.disable('pouchdb:find')
function db(name) {
  local[name] = new PouchDB(name, {auto_compaction:true})
  return local[name].info().then(info => {
    if (info.update_seq === 0) { //info.update_seq
      var index
      if (name == 'drugs')
        index = []
      else if (name == 'accounts')
        index = ['state']
      else if (name == 'users')
        index = ['name', 'account']
      else if (name == 'shipments')
        index = ['tracking', 'to.account', 'from.account']
      else if (name == 'transactions')
        index = ['shipment']

      for (var i of index) {
        //TODO capture promises and return Promise.all()?
        local[name].createIndex({index: {fields: Array.isArray(i) ? i : [i]}}).then(console.log)
      }
    }
  })
}

function find(resource) {
  return (selector, limit) => {
    console.log(selector, limit)
    var start = performance.now()
    var opts = {include_docs:true}
    //drug _id is NDC (number) which starts before _ alphabetically
    if (resource == 'drugs')
      opts.endkey = '_design'
    else
      opts.startkey = '_design\uffff'

    if ( ! selector) {
      return local[resource].allDocs(opts).then(docs => {
        console.log('docs', docs)
        console.log('alldocs:', resource, 'in', (performance.now() - start).toFixed(2), 'ms')
        return docs.rows.map(doc => doc.doc).reverse()
      })
    }

    if (limit) {
      console.log('limit', limit)
      var query = {
        query: selector,
        fields: ['name'],
        include_docs: true,
        highlighting: true
      }
      return local[resource].search(query).then(doc => {
        console.log('finding', resource, JSON.stringify(query), 'in', (performance.now() - start).toFixed(2), 'ms')
        return doc.docs.reverse()
      })
      .catch(console.log)
    }

    return local[resource].find({selector, limit}).then(doc => {
      console.log('finding', resource, JSON.stringify({selector, limit}), 'in', (performance.now() - start).toFixed(2), 'ms')
      return doc.docs.reverse()
    })
    .catch(_ => {
      console.log('finding', resource, JSON.stringify({selector, limit}), 'in', (performance.now() - start).toFixed(2), 'ms')
      console.log(_)
    })
  }
}

function post(resource) {
  return body => {
    return ajax({method:'POST', url:'http://localhost:3000/'+resource, body})
  }
}

function put(resource) {
  return doc => {
    return local[resource].put(doc)
    .then(res => {
      doc._rev = res.rev
      return doc
    })
  }
}

function query(resource) {
  return (view, opts) => {
    return local[resource].query(view, opts)
    .then(docs => docs.rows)
  }
}

function remove(resource) {
  return doc => {
    return local[resource].remove(doc)
  }
}

function bulkDocs(resource) {
  return doc => {
    return local[resource].bulkDocs(doc)
  }
}

function helper(find, selector, method, url, body) {

  return selector._id ? all([selector]) : find(selector).then(all)

  function all(docs) {
    var all = []
    for (var doc of docs)
    all.push(ajax({
      method:method,
      url:'//localhost:3000/'+url.replace(':id', doc._id.replace('org.couchdb.user:', '')),
      body:body,
      json:!!body
    }))
    return Promise.all(all)
  }
}

function methods(resource) {
  Db.prototype[resource].post          = post(resource)
  Db.prototype[resource].put           = put(resource)
  Db.prototype[resource].bulkDocs      = bulkDocs(resource)
  Db.prototype[resource].query         = query(resource)
  Db.prototype[resource].remove        = remove(resource)
  return find(resource)
}
