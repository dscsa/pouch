"use strict"

//TODO Authenticate users and replicate dbs on login

//Browser Dependencies
//<script src="./pouch-universal"></script>
//<script src="./pouch-model"></script>
//<script src="./pouch-schema"></script>
let methods = {
  user:{
    session:{
      get() {
        let AuthUser = document.cookie && document.cookie.match(/AuthUser=([^;]+)/)
        return Promise.resolve(AuthUser && JSON.parse(AuthUser[1]))
      },

      //db.user.session.post(email, password)
      post(body) {
        return this.get().then(session => {
          if (session) return session //we are already logged in
          body.phone = formatPhone(body.phone)
          return local.ajax({url:'user/session', method:'post', body})
        })
        .then(_ => {
          console.log('session.post', _)
          let loading = {
            resources:Object.keys(schema),       //display a list of what is being worked on
            progress:{update_seq:0, last_seq:0}  //allow for a progress bar
          }

          //Give an array of promises that we can do Promise.all() to determine when done
          loading.syncing = loading.resources.map(db => {
            loading.progress.update_seq += remote[db].update_seq
            return sync(db).on('change', info => {
              console.log('pouch sync change event')
              loading.progress[db] = info.last_seq || info.change.last_seq
              loading.progress.last_seq = loading.resources.reduce((a, db)=> a+(loading.progress[db] || 0), 0)
            })
            .then(_ => {
              console.log('db', db, 'synced')
              //Since we are deleting out of order the original index will not work
              loading.resources.splice(loading.resources.indexOf(db), 1)
            })
          })

          //live syncing uses up a tcp connection with long-polling so wait until all db sync before going "live"
          Promise.all(loading.syncing).then(_ => {
            for (let db of loading.resources) sync(db, true)
          })

          return loading
        })
      },

      //db.user.session.delete(email)
      delete() {
        return local.ajax({url:'user/session', method:'delete'}).then(_ => {
          return Promise.all(Object.keys(schema).map(db => { //Destroying will stop these from syncing as well
            return local[db].destroy().then(_ => delete local[db], createLocalDb(name))
          }))
        })
      }
    }
  },

  account:{
    authorized:{
      post(body) {
        return local.ajax({url:'account/authorized', method:'post', body:JSON.stringify(body)})
      },
      delete(body) {
        return local.ajax({url:'account/authorized', method:'delete', body:JSON.stringify(body)})
      }
    }
  }
}

let schema = pouchSchema(pouchModel, micro, methods)
let remote = {}
let local  = {
  ajax(opts) {
    opts.url = 'http://localhost:80/'+opts.url
    return new Promise((resolve, reject) => {
      return remote.user._ajax(opts, (err, body) => {
        err ? reject(err) : resolve(body)
      })
    })
  }
}

//TODO transactions is remote
for (let db in schema) {
  remote[db] = createRemoteDb(db)
   local[db] = createLocalDb(db)
}

function createRemoteDb(name) {
  if (name == 'transaction') //transaction db is remote only so we need validation here
    PouchDB.plugin(schema[name])

  return new PouchDB('http://localhost/'+name)
}

function createLocalDb(name) {

  if (name == 'transaction') //transaction db is remote only
    return remote[name]

  let db = new PouchDB.plugin(schema[name])(name)
  db.replicate.to(remote[name], {live:true, retry:true})

  setTimeout(_ => {
    local.user.session.get().then(session => session && sync(name, true))
  }, 5000) //Kiah's laptop was maxing out on TCP connections befor app-bundle loaded.  Wait on _changes into static assets can load

  return db
}
//Browser shim to return number of microseconds for use in _id creation
function micro() {
  return (window.performance.timing.navigationStart*1000 + window.performance.now()*1000).toString().slice(-3)
}

function sync(db, live) {
  //Change property doesn't seem to work if we switch remote and local positions
  return local[db].replicate.from(remote[db], {live, retry:true})
}

function formatPhone(phone) {
  return phone.replace(/[-.() ]/g, '')
}

window.pouchdbClient = local
