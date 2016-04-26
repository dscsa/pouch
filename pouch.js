window.Db = function Db() {}

//Intention to keep syntax as close to the REST API as possible.  For example that is why we do
//this.db.users({_id:123}).session.post(password) and not this.db.users().session.post({_id:123, password:password})
var resources = ['drugs', 'accounts', 'users', 'shipments', 'transactions']
var synced    = {}
var remote    = {}
var local     = {}
var loading   = []

//Because put is async, new session or account _revs are unlikely to be saved in session storage when a page reloads
//for this reason we have to fetch them again onload just in case the page was reloaded by the user.
var _session   = JSON.parse(sessionStorage.getItem('session') || "null")
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
  var userDefault    = _session && {name:_session.name}
  var accountDefault = _session && _session.account && {'account._id':_session.account._id}

  var results = {
    then(a,b) {
      return users(selector || accountDefault).then(a,b)
    },
    catch(a) {
      return users(selector || accountDefault).catch(a)
    },
    //WARNING unlike other methods this one is syncronous
    session() {
      return _session
    }
  }


  results.session.post = function(password) {
    _session = {loading:resources.slice()}
    return helper(users, selector || userDefault, 'POST', 'users/:id/session', password)
    .then(function(sessions) {
      for (var i in sessions[0])
        _session[i]  = sessions[0][i]

      saveSession()
      return Promise.all(resources.map(function(name) {
        //Only sync resources after user login. https://github.com/pouchdb/pouchdb/issues/4266

        var q = remote[name].sync(local[name], {retry:true, filter})
        .then(function() {
          synced[name] = remote[name].sync(local[name], {live:true, retry:true, filter})
          //Output running list of what is left because syncing takes a while
          //Can't use original index because we are deleting items as we go
          _session.loading.splice(_session.loading.indexOf(name), 1)
        })

        return name != 'drugs' && q
      }))
      .then(buildIndex)
      .then(function(){return _session})
    })
  }

  results.session.remove = function() {
    if ( ! _session) return Promise.resolve(true)
    _session = null
    sessionStorage.removeItem('session')
    return helper(users, selector || userDefault, 'DELETE', 'users/:id/session')
    .then(function() {
      //Destroying will stop the rest of the dbs from syncing
      synced.accounts && synced.accounts.cancel();
      synced.drugs && synced.drugs.cancel();

      return Promise.all(['users', 'shipments', 'transactions']
      .map(function(resource) {
        return local[resource].destroy().then(function() {
            return db(resource)
        })
      }))
    })
  }

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
Db.prototype.transactions = function(selector, limit) {
  var results = {
    then(a,b) {
      return transactions(selector, limit).then(a,b)
    },
    catch(a) {
      return transactions(selector, limit).catch(a)
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
        console.log('unauthorizing')
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

      var start   = Date.now()

      if(selector && selector.generic) {
        //TODO can we abstract this into a {$text:term} mango query so that we can support more than just generic
        var tokens = selector.generic.toLowerCase().replace('.', '\\.').split(/, |[, ]/g)
        var opts   = {startkey:tokens[0], endkey:tokens[0]+'\uffff'}
        return Db.prototype.drugs.query('drug/generic', opts)
        .then(function(drugs) {
          if (tokens[1]) {
            var results = []
            //Use lookaheads to search for each word separately (no order)
            var regex   = RegExp('(?=.*'+tokens.join(')(?=.*')+')', 'i')
            for (var i in drugs) {
              drugs[i].value.generic = genericName(drugs[i].value)
              if (regex.test(drugs[i].value.generic)) {
                results.push(drugs[i].value)
              }
            }
            //console.log(results.length, 'results for', tokens, 'in', Date.now()-start)
            return results
          }
          else {
            //console.log(drugs.length, 'results for', tokens, 'in', Date.now()-start)
            return drugs.map(function(drug) {
              drug.value.generic = genericName(drug.value)
              return drug.value
            })
          }
        })
        .then(a, b)
      }

      if(selector && selector.ndc) {
        var term = selector.ndc.replace('-', '')
        var ndc9 = drugs({$and:[{ndc9:{$gte:term}}, {ndc9:{$lt:term+'\uffff'}}]}, 200)
        var upc  = drugs({$and:[{upc:{$gte:term}}, {upc:{$lt:term+'\uffff'}}]}, 200)
        return Promise.all([ndc9, upc]).then(function(results) {
          if ( ! results[0]) return
          //Filter out where upc is not 9 because to avoid duplicates upc search
          return results[0]
            .filter(function(drug) { return drug.upc.length != 9})
            .concat(results[1])
            .map(function(drug) {
              drug.generic = genericName(drug)
              return drug
            })
        }).then(a,b)
      }

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

    if (_session) {
      synced[r] = remote[r].sync(local[r], {live:true, retry:true, filter})
      if(r == 'drugs') buildIndex()
    }
})

function buildIndex() {
  var start = Date.now()
  console.log('Ensuring Search Index is Built!')

  //Don't actually return anything because we want session to complete and this to continue in background
  Promise.all([Db.prototype.drugs({ndc:'DUMMY'}, 0), local.drugs.query('drug/generic', {limit:0})])
  .then(function() {
    _session.loading.splice(0)
    console.log(_session.loading)
    saveSession()
    console.log('Search Index Ready', Date.now() - start)
  })
}

function filter(doc) {
    return doc._id.indexOf('_design') !== 0
}

function genericSearch(doc) {
  for (var i in doc.generics) {
    if ( ! doc.generics[i].name)
      log('generic map error for', doc)

    emit(doc.generics[i].name.toLowerCase(), doc)
  }
}

//Build all the type's indexes
//PouchDB.debug.enable('pouchdb:find')
//PouchDB.debug.disable('pouchdb:find')
function db(name) {
  local[name] = new PouchDB(name, {auto_compaction:true})
  return local[name].info().then(function(info) {
    if (info.update_seq == 0) {
      var index
      if (name == 'drugs') {
        index = ['upc', 'ndc9']

        //Unfortunately mango doesn't index arrays so we have to make a traditional map function
        local.drugs.put({_id: '_design/drug', views:{
          generic:{map:genericSearch.toString()}
        }})
        .catch(function(e){
          console.trace(e)
        })
      }
      else if (name == 'accounts')
        index = ['state', ['state', '_id']]
      else if (name == 'users')
        index = ['name', 'account._id'] //account._id
      else if (name == 'shipments')
        index = ['tracking', 'account.to._id', 'account.from._id'] //to.account._id  //from.account._id
      else if (name == 'transactions')
        index = ['shipment._id', ['shipment._id', 'createdAt'], ['shipment._id', 'verifiedAt']]

      for (var i of index) {
        //TODO capture promises and return Promise.all()?
        local[name].createIndex({index: {fields: Array.isArray(i) ? i : [i]}})
        .then(function() {
          console.log('Index built', i, _)
        })
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
    //console.trace('finding', resource, limit, JSON.stringify({selector, limit}))
    return local[resource].find({selector, limit})
    .then(function(doc) {
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
  return function(doc) {
    return ajax({method:'POST', url:'http://localhost:3000/'+resource, body:doc})
    .then(res => {
      doc._id  = res._id
      doc._rev = res._rev
      return res
    })
  }
}

function put(resource) {
  return function(doc) {
    if (resource == 'drugs')
      delete doc.generic

    return local[resource].put(doc)
    .then(function(res) {
      doc._rev = res.rev
      //Do we need to update the current session data too?
      if (doc._id == _session._id) {
        var account = _session.account
        _session = doc
        _session.account = account
        saveSession()
      }

      if (doc._id == _session.account._id) {
        _session.account = doc
        saveSession()
      }

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
    for (var doc of docs || []) {
      all.push(ajax({
        method:method,
        url:'//localhost:3000/'+url.replace(':id', doc._id.replace('org.couchdb.user:', '')),
        body:body,
        json:true
      }))
    }
    return Promise.all(all)
  }
}

function genericName(drug) {
  return drug.generics.map(function(g) { return g.name+" "+g.strength}).join(', ')+' '+drug.form
}

function methods(resource) {
  Db.prototype[resource].post          = post(resource)
  Db.prototype[resource].put           = put(resource)
  Db.prototype[resource].bulkDocs      = bulkDocs(resource)
  Db.prototype[resource].query         = query(resource)
  Db.prototype[resource].remove        = remove(resource)
  return find(resource)
}

function saveSession() {
  sessionStorage.setItem('session', JSON.stringify(_session))
}
