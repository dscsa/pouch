window.Db = function Db() {}

//Intention to keep syntax as close to the REST API as possible.  For example that is why we do
//this.db.users({_id:123}).session.post(password) and not this.db.users().session.post({_id:123, password:password})
var resources = ['drugs', 'accounts', 'users', 'shipments', 'transactions']
var synced    = {}
var remote    = {}
var local     = {}
var ajax      = function(opts) {
  return new Promise(function(resolve, reject) {
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
    selector = selector ? {name:session.name} : {'account._id':session.account._id}

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
    .then(function(sessions) {
      session = sessions[0]
      sessionStorage.setItem('session', JSON.stringify(session))
      return Promise.all(resources.map(function(name) {
        //Only sync resources after user login. https://github.com/pouchdb/pouchdb/issues/4266
        return remote[name].sync(local[name], {retry:true, filter})
        .then(function() {
          synced[name] = remote[name].sync(local[name], {live:true, retry:true, filter})
          //Output running list of what is left because syncing takes a while
          //Can't use original index because we are deleting items as we go
          results.session.loading.splice(results.session.loading.indexOf(name), 1)
        })
      }))
      .then(function(){return sessions[0]})
    })
  }

  results.session.remove = function() {
    if ( ! session) return Promise.resolve(true)
    sessionStorage.removeItem('session')
    return helper(users, selector, 'DELETE', 'users/:id/session')
    .then(function() {
      //Destroying will stop the rest of the dbs from syncing
      synced.accounts && synced.accounts.cancel();
      synced.drugs && synced.drugs.cancel();

      return Promise.all(['users', 'shipments', 'transactions']
      .map(function(resource) {
        return local[resource].destroy().then(function() {
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

resources.forEach(function(r) {
    db(r)
    remote[r] = new PouchDB('http://localhost:3000/'+r)

    if (sessionStorage.getItem('session'))
      synced[r] = remote[r].sync(local[r], {live:true, retry:true, filter})
})

function filter(doc) {
    return doc._id.indexOf('_design') !== 0
}

var start = performance.now()
// save drug search query since mango's $elemMatch seems to be do an in-memory search with something
// like this.db.drugs({generic:{$elemMatch:{name:{$gt:name}, strength:{$gt:strength}}}}) being ideal
// intead we get the entire drug database and put every letter of every drug as keys in an object so
// that autosuggest is O(1).  Right now the allDocs query takes ~10 secs and the indexing 0.2 secs
// the results are typically given in <10 milliseconds.

var genericSearch = {}
var ndcSearch = {}
Db.prototype.search = Db.prototype.drugs().then(function(drugs) {
    for (var i in drugs) {

      drugs[i].generic = drugs[i].generics.map(generic => generic.name+" "+generic.strength).join(', ')

      for (var j in drugs[i].generics) {
        var name = drugs[i].generics[j].name.toLowerCase()
        for (var k=3; k<=name.length;k++) {
          var key = name.slice(0, k)
          genericSearch[key] = genericSearch[key] || []
          genericSearch[key].push(drugs[i])
        }
      }

      var len = Math.max(drugs[i].ndc9.length, drugs[i].upc.length)

      for (var k=3; k<=len;k++) {
        var key1 = drugs[i].ndc9.slice(0, k)
        var key2 = drugs[i].upc.slice(0, k)

        ndcSearch[key1] = ndcSearch[key1] || []
        ndcSearch[key1].push(drugs[i])

        if (key1 != key2) { //avoid duplicates for NDC fragments
          ndcSearch[key2] = ndcSearch[key2] || []
          ndcSearch[key2].push(drugs[i])
        }
      }
    }

    function sort(a, b) {
      if (a.generic > b.generic) return 1
      if (a.generic < b.generic) return -1
    }

    for (var i in genericSearch) {
      genericSearch[i] = genericSearch[i].sort(sort)
    }
    for (var i in ndcSearch) {
      ndcSearch[i] = ndcSearch[i].sort(sort)
    }
    console.log('ndc/generic search ready', (performance.now()-start).toFixed(2))
})


Db.prototype.search.generic = function(term) {
  start = Date.now()
  var tokens  = term.split(/ (?=\d|$)/)
  var results = []
  var drugs   = genericSearch[tokens[0]] || []

  if (tokens[1]) {
    tokens[1] = RegExp('^'+tokens[1].replace('.', '\\.'), 'i')
    for (var i in drugs) {
      for (var j in drugs[i].generics) {
        if (tokens[1].test(drugs[i].generics[j].strength)) {
          results.push(drugs[i]); break
        }
      }
    }
  }
  else {
    results = Array.from(drugs)
  }
  console.log('genericSearch for', term, 'with', tokens, 'in', Date.now()-start, 'count', results.length)
  return results
}

Db.prototype.search.ndc = function(term) {
  start = Date.now()
  var drugs   = ndcSearch[term.replace('-', '')] || []
  console.log('ndcSearch for', term, 'in', Date.now()-start)
  return Array.from(drugs)
}


// local['drugs'].put({_id: '_design/drug', views: {search:{map:drugSearch.toString()}}})
// .then(function () {
//   console.log('Building drug search index.  This may take a while...')
//   return local['drugs'].query('drug/search', {limit:0}).then(console.log)
// })
// .catch(function(){})
//
//
//
// function drugSearch(doc) {
//   function reduce(prev, curr) {
//     return prev+", "+curr.name+" "+curr.strength
//   }
//   var generic  = doc.generic
//   var result   = doc.ndc9+generic.reduce(reduce, "")+" "+doc.form
//   for (var i in generic) {
//     var keys = [generic[i].name.toLowerCase(), generic[i].strength.toLowerCase()]
//     log('keys',keys)
//     emit(keys, result)
//   }
// }

// Full text version
// function drugSearch(doc) {
//   log('doc', doc)
//   var names = doc.names.concat([doc.ndc9, doc.upc])
//   var str   = doc.ndc9+" "+doc.names.join(", ")+" "+doc.form
//   for (var i in names) {
//     var name = names[i]
//     for (var j=4; j<=name.length; j++) {
//       var key = name.slice(0, j)
//       emit(key.toLowerCase(), str.split(key))
//     }
//   }
// }

//local['drugs'].createIndex({index: {fields:['generic']}}).then(console.log)
//Build all the type's indexes
//PouchDB.debug.enable('pouchdb:find')
//PouchDB.debug.disable('pouchdb:find')
function db(name) {
  local[name] = new PouchDB(name, {auto_compaction:true})
  return local[name].info().then(function(info) {
    if (info.update_seq === 0) { //info.update_seq
      var index
      if (name == 'drugs')
        index = []
      else if (name == 'accounts')
        index = [['state', '_id']]
      else if (name == 'users')
        index = ['name', 'account._id'] //account._id
      else if (name == 'shipments')
        index = ['tracking', 'account.to._id', 'account.from._id'] //to.account._id  //from.account._id
      else if (name == 'transactions')
        index = ['shipment._id']

      for (var i of index) {
        //TODO capture promises and return Promise.all()?
        local[name].createIndex({index: {fields: Array.isArray(i) ? i : [i]}}).then(console.log)
      }
    }
  })
}

function find(resource) {
  return function(selector, limit) {
    var start = performance.now()
    var opts = {include_docs:true}
    //drug _id is NDC (number) which starts before _ alphabetically
    if (resource == 'drugs')
      opts.endkey = '_design'
    else
      opts.startkey = '_design\uffff'

    if ( ! selector) {
      return local[resource].allDocs(opts).then(function(docs) {
        console.log('alldocs:', resource, 'in', (performance.now() - start).toFixed(2), 'ms')
        return docs.rows.map(function(doc) { return doc.doc }).reverse()
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
      return local[resource].search(query).then(function(doc) {
        console.log('finding', resource, JSON.stringify(query), 'in', (performance.now() - start).toFixed(2), 'ms')
        return doc.docs.reverse()
      })
      .catch(console.log)
    }

    return local[resource].find({selector, limit}).then(function(doc) {
      console.log('finding', resource, JSON.stringify({selector, limit}), 'in', (performance.now() - start).toFixed(2), 'ms')
      return doc.docs.reverse()
    })
    .catch(function(_) {
      console.log('finding', resource, JSON.stringify({selector, limit}), 'in', (performance.now() - start).toFixed(2), 'ms')
      console.log(_)
    })
  }
}

function post(resource) {
  return function(body) {
    return ajax({method:'POST', url:'http://localhost:3000/'+resource, body})
  }
}

function put(resource) {
  return function(doc) {
    return local[resource].put(doc)
    .then(function(res) {
      doc._rev = res.rev
      return doc
    })
  }
}

function query(resource) {
  return function(view, opts) {
    return local[resource].query(view, opts)
    .then(function(docs) { return docs.rows})
  }
}

function remove(resource) {
  return function(doc) {
    return local[resource].remove(doc)
  }
}

function bulkDocs(resource) {
  return function(doc) {
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
