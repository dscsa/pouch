"use strict"

//TODO create a _users db
//TODO set _users db admin role to ['user']

let admin     = {ajax:{auth:require('../../keys/dev')}}
let query     = require('pouchdb-mapreduce')
let adapter   = require('pouchdb-adapter-http')
let model     = require('./pouchdb-model.js')
let baseUrl   = 'http://localhost:5984/'
let schema    = require('./pouchdb-schema.js')(model, micro)
let PouchDB   = require('pouchdb-core').plugin(query).plugin(adapter)

schema._users = model()

for (let db in schema) {

  let resource = require('../server/'+db)

  schema[db] = resource.validate(schema[db])

  //Pouch will create this database if it does not exist
  //TODO skipSetup and then create missing databases, or
  //figure out how to remove admin options after creating db
  console.log('new db', baseUrl+db)
  exports[db] = new PouchDB.plugin(schema[db])(baseUrl+db, admin)

  for (let i in resource.views) {

    let view = resource.views[i]
    let ddoc = {
      _id:'_design/'+i,
      lists:{roles:string(resource.lists)},
      views:{},
      filters:{roles:string(resource.filter)}
    }

    ddoc.views[i] = {
      map:string(view.map || view, resource.lib),
      reduce:string(view.reduce, resource.lib)
    }

    //Get latest _rev so we can update db to new ddoc
    exports[db].get(ddoc._id).catch(err => Object())
    .then(doc => exports[db].put(Object.assign(ddoc, {_rev:doc._rev}), admin))
    .catch(err => console.log('db initialization err', db, err, err.stack))
  }
}

//
//Hoisted Helper Functions
//

//Node shim to return number of microseconds for use in _id creation
function micro() {
  return ('000'+ process.hrtime()[1]).slice(-6, -3)
}

//Spidermoney does support shorthand methods
function addFunction(fn) {
  fn = fn.toString()
  return '('+(fn.startsWith('function') ? fn : 'function '+fn)+')'
}

function string(fn, lib) {
  if ( ! fn || typeof fn == 'string') return fn

  //TODO convert arrow functions
  fn = addFunction(fn)

  //Regarding views/lib placement: http://couchdb-13.readthedocs.io/en/latest/1.1/commonjs/
  //however pouchdb doesn't support require() so we need to replace with actual functions
  //needs to be recursive so if a dependency has require that get's replaced too
  return fn.replace(/require\(["'](.*?)["']\)/g, (_, key) => '('+string(lib[key], lib)+')')
}
