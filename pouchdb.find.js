      (function (f) {
        if (typeof exports === "object" && typeof module !== "undefined") {
          module.exports = f();
        } else if (typeof define === "function" && define.amd) {
          define([], f);
        } else {
          var g;if (typeof window !== "undefined") {
            g = window;
          } else if (typeof global !== "undefined") {
            g = global;
          } else if (typeof self !== "undefined") {
            g = self;
          } else {
            g = this;
          }g.pouchdbFind = f();
        }
      })(function () {
        var define, module, exports;return (function e(t, n, r) {
          function s(o, u) {
            if (!n[o]) {
              if (!t[o]) {
                var a = typeof require == "function" && require;if (!u && a) return a(o, !0);if (i) return i(o, !0);var f = new Error("Cannot find module '" + o + "'");throw (f.code = "MODULE_NOT_FOUND", f);
              }var l = n[o] = { exports: {} };t[o][0].call(l.exports, function (e) {
                var n = t[o][1][e];return s(n ? n : e);
              }, l, l.exports, e, t, n, r);
            }return n[o].exports;
          }var i = typeof require == "function" && require;for (var o = 0; o < r.length; o++) s(r[o]);return s;
        })({ 1: [function (_dereq_, module, exports) {
            'use strict';

            var upsert = _dereq_(4);
            var utils = _dereq_(5);
            var Promise = utils.Promise;

            function stringify(input) {
              if (!input) {
                return 'undefined';
              }

              switch (typeof input) {
                case 'function':
                  return input.toString();
                case 'string':
                  return input.toString();
                default:
                  return JSON.stringify(input);
              }
            }

            module.exports = function (opts) {
              var sourceDB = opts.db;
              var viewName = opts.viewName;
              var mapFun = opts.map;
              var reduceFun = opts.reduce;
              var temporary = opts.temporary;
              var pluginName = opts.pluginName;

              var viewSignature = stringify(mapFun) + stringify(reduceFun) + 'undefined';

              if (!temporary && sourceDB._cachedViews) {
                var cachedView = sourceDB._cachedViews[viewSignature];
                if (cachedView) {
                  return Promise.resolve(cachedView);
                }
              }

              return sourceDB.info().then(function (info) {

                var depDbName = info.db_name + '-mrview-' + (temporary ? 'temp' : utils.MD5(viewSignature));

                function diffFunction(doc) {
                  doc.views = doc.views || {};
                  var fullViewName = viewName;
                  if (fullViewName.indexOf('/') === -1) {
                    fullViewName = viewName + '/' + viewName;
                  }
                  var depDbs = doc.views[fullViewName] = doc.views[fullViewName] || {};

                  if (depDbs[depDbName]) {
                    return;
                  }
                  depDbs[depDbName] = true;
                  return doc;
                }
                return upsert(sourceDB, '_local/' + pluginName, diffFunction).then(function () {
                  return sourceDB.registerDependentDatabase(depDbName).then(function (res) {
                    var db = res.db;
                    db.auto_compaction = true;
                    var view = {
                      name: depDbName,
                      db: db,
                      sourceDB: sourceDB,
                      adapter: sourceDB.adapter,
                      mapFun: mapFun,
                      reduceFun: reduceFun
                    };
                    return view.db.get('_local/lastSeq')["catch"](function (err) {
                      if (err.status !== 404) {
                        throw err;
                      }
                    }).then(function (lastSeqDoc) {
                      view.seq = lastSeqDoc ? lastSeqDoc.seq : 0;
                      if (!temporary) {
                        sourceDB._cachedViews = sourceDB._cachedViews || {};
                        sourceDB._cachedViews[viewSignature] = view;
                        view.db.on('destroyed', function () {
                          delete sourceDB._cachedViews[viewSignature];
                        });
                      }
                      return view;
                    });
                  });
                });
              });
            };
          }, { "4": 4, "5": 5 }], 2: [function (_dereq_, module, exports) {
            (function (process) {
              'use strict';

              var pouchCollate = _dereq_(37);
              var TaskQueue = _dereq_(3);
              var collate = pouchCollate.collate;
              var toIndexableString = pouchCollate.toIndexableString;
              var normalizeKey = pouchCollate.normalizeKey;
              var createView = _dereq_(1);
              var log;

              if (typeof console !== 'undefined' && typeof console.log === 'function') {
                log = Function.prototype.bind.call(console.log, console);
              } else {
                log = function () {};
              }
              var utils = _dereq_(5);
              var Promise = utils.Promise;
              var persistentQueues = {};
              var tempViewQueue = new TaskQueue();
              var CHANGES_BATCH_SIZE = 50;

              function QueryParseError(message) {
                this.status = 400;
                this.name = 'query_parse_error';
                this.message = message;
                this.error = true;
                try {
                  Error.captureStackTrace(this, QueryParseError);
                } catch (e) {}
              }

              utils.inherits(QueryParseError, Error);

              function NotFoundError(message) {
                this.status = 404;
                this.name = 'not_found';
                this.message = message;
                this.error = true;
                try {
                  Error.captureStackTrace(this, NotFoundError);
                } catch (e) {}
              }

              utils.inherits(NotFoundError, Error);

              function parseViewName(name) {
                return name.indexOf('/') === -1 ? [name, name] : name.split('/');
              }

              function isGenOne(changes) {
                return changes.length === 1 && /^1-/.test(changes[0].rev);
              }

              function sortByKeyThenValue(x, y) {
                var keyCompare = collate(x.key, y.key);
                return keyCompare !== 0 ? keyCompare : collate(x.value, y.value);
              }

              function sliceResults(results, limit, skip) {
                skip = skip || 0;
                if (typeof limit === 'number') {
                  return results.slice(skip, limit + skip);
                } else if (skip > 0) {
                  return results.slice(skip);
                }
                return results;
              }

              function rowToDocId(row) {
                var val = row.value;

                var docId = val && typeof val === 'object' && val._id || row.id;
                return docId;
              }

              function tryCode(db, fun, args) {
                try {
                  return {
                    output: fun.apply(null, args)
                  };
                } catch (e) {
                  db.emit('error', e);
                  return { error: e };
                }
              }

              function checkQueryParseError(options, fun) {
                var startkeyName = options.descending ? 'endkey' : 'startkey';
                var endkeyName = options.descending ? 'startkey' : 'endkey';

                if (typeof options[startkeyName] !== 'undefined' && typeof options[endkeyName] !== 'undefined' && collate(options[startkeyName], options[endkeyName]) > 0) {
                  throw new QueryParseError('No rows can match your key range, reverse your ' + 'start_key and end_key or set {descending : true}');
                } else if (fun.reduce && options.reduce !== false) {
                  if (options.include_docs) {
                    throw new QueryParseError('{include_docs:true} is invalid for reduce');
                  } else if (options.keys && options.keys.length > 1 && !options.group && !options.group_level) {
                    throw new QueryParseError('Multi-key fetches for reduce views must use {group: true}');
                  }
                }
                if (options.group_level) {
                  if (typeof options.group_level !== 'number') {
                    throw new QueryParseError('Invalid value for integer: "' + options.group_level + '"');
                  }
                  if (options.group_level < 0) {
                    throw new QueryParseError('Invalid value for positive integer: ' + '"' + options.group_level + '"');
                  }
                }
              }

              function defaultsTo(value) {
                return function (reason) {
                  if (reason.status === 404) {
                    return value;
                  } else {
                    throw reason;
                  }
                };
              }

              function createIndexer(def) {

                var pluginName = def.name;
                var mapper = def.mapper;
                var reducer = def.reducer;
                var ddocValidator = def.ddocValidator;

                function getDocsToPersist(docId, view, docIdsToChangesAndEmits) {
                  var metaDocId = '_local/doc_' + docId;
                  var defaultMetaDoc = { _id: metaDocId, keys: [] };
                  var docData = docIdsToChangesAndEmits[docId];
                  var indexableKeysToKeyValues = docData.indexableKeysToKeyValues;
                  var changes = docData.changes;

                  function getMetaDoc() {
                    if (isGenOne(changes)) {
                      return Promise.resolve(defaultMetaDoc);
                    }
                    return view.db.get(metaDocId)["catch"](defaultsTo(defaultMetaDoc));
                  }

                  function getKeyValueDocs(metaDoc) {
                    if (!metaDoc.keys.length) {
                      return Promise.resolve({ rows: [] });
                    }
                    return view.db.allDocs({
                      keys: metaDoc.keys,
                      include_docs: true
                    });
                  }

                  function processKvDocs(metaDoc, kvDocsRes) {
                    var kvDocs = [];
                    var oldKeysMap = {};

                    for (var i = 0, len = kvDocsRes.rows.length; i < len; i++) {
                      var row = kvDocsRes.rows[i];
                      var doc = row.doc;
                      if (!doc) {
                        continue;
                      }
                      kvDocs.push(doc);
                      oldKeysMap[doc._id] = true;
                      doc._deleted = !indexableKeysToKeyValues[doc._id];
                      if (!doc._deleted) {
                        var keyValue = indexableKeysToKeyValues[doc._id];
                        if ('value' in keyValue) {
                          doc.value = keyValue.value;
                        }
                      }
                    }

                    var newKeys = Object.keys(indexableKeysToKeyValues);
                    newKeys.forEach(function (key) {
                      if (!oldKeysMap[key]) {
                        var kvDoc = {
                          _id: key
                        };
                        var keyValue = indexableKeysToKeyValues[key];
                        if ('value' in keyValue) {
                          kvDoc.value = keyValue.value;
                        }
                        kvDocs.push(kvDoc);
                      }
                    });
                    metaDoc.keys = utils.uniq(newKeys.concat(metaDoc.keys));
                    kvDocs.push(metaDoc);

                    return kvDocs;
                  }

                  return getMetaDoc().then(function (metaDoc) {
                    return getKeyValueDocs(metaDoc).then(function (kvDocsRes) {
                      return processKvDocs(metaDoc, kvDocsRes);
                    });
                  });
                }

                function saveKeyValues(view, docIdsToChangesAndEmits, seq) {
                  var seqDocId = '_local/lastSeq';
                  return view.db.get(seqDocId)["catch"](defaultsTo({ _id: seqDocId, seq: 0 })).then(function (lastSeqDoc) {
                    var docIds = Object.keys(docIdsToChangesAndEmits);
                    return Promise.all(docIds.map(function (docId) {
                      return getDocsToPersist(docId, view, docIdsToChangesAndEmits);
                    })).then(function (listOfDocsToPersist) {
                      var docsToPersist = utils.flatten(listOfDocsToPersist);
                      lastSeqDoc.seq = seq;
                      docsToPersist.push(lastSeqDoc);

                      return view.db.bulkDocs({ docs: docsToPersist });
                    });
                  });
                }

                function getQueue(view) {
                  var viewName = typeof view === 'string' ? view : view.name;
                  var queue = persistentQueues[viewName];
                  if (!queue) {
                    queue = persistentQueues[viewName] = new TaskQueue();
                  }
                  return queue;
                }

                function updateView(view) {
                  return utils.sequentialize(getQueue(view), function () {
                    return updateViewInQueue(view);
                  })();
                }

                function updateViewInQueue(view) {
                  var mapResults;
                  var doc;

                  function emit(key, value) {
                    var output = { id: doc._id, key: normalizeKey(key) };

                    if (typeof value !== 'undefined' && value !== null) {
                      output.value = normalizeKey(value);
                    }
                    mapResults.push(output);
                  }

                  var mapFun = mapper(view.mapFun, emit);

                  var currentSeq = view.seq || 0;

                  function processChange(docIdsToChangesAndEmits, seq) {
                    return function () {
                      return saveKeyValues(view, docIdsToChangesAndEmits, seq);
                    };
                  }

                  var queue = new TaskQueue();

                  return new Promise(function (resolve, reject) {

                    function complete() {
                      queue.finish().then(function () {
                        view.seq = currentSeq;
                        resolve();
                      });
                    }

                    function processNextBatch() {
                      view.sourceDB.changes({
                        conflicts: true,
                        include_docs: true,
                        style: 'all_docs',
                        since: currentSeq,
                        limit: CHANGES_BATCH_SIZE
                      }).on('complete', function (response) {
                        var results = response.results;
                        if (!results.length) {
                          return complete();
                        }
                        var docIdsToChangesAndEmits = {};
                        for (var i = 0, l = results.length; i < l; i++) {
                          var change = results[i];
                          if (change.doc._id[0] !== '_') {
                            mapResults = [];
                            doc = change.doc;

                            if (!doc._deleted) {
                              tryCode(view.sourceDB, mapFun, [doc]);
                            }
                            mapResults.sort(sortByKeyThenValue);

                            var indexableKeysToKeyValues = {};
                            var lastKey;
                            for (var j = 0, jl = mapResults.length; j < jl; j++) {
                              var obj = mapResults[j];
                              var complexKey = [obj.key, obj.id];
                              if (obj.key === lastKey) {
                                complexKey.push(j);
                              }
                              var indexableKey = toIndexableString(complexKey);
                              indexableKeysToKeyValues[indexableKey] = obj;
                              lastKey = obj.key;
                            }
                            docIdsToChangesAndEmits[change.doc._id] = {
                              indexableKeysToKeyValues: indexableKeysToKeyValues,
                              changes: change.changes
                            };
                          }
                          currentSeq = change.seq;
                        }
                        queue.add(processChange(docIdsToChangesAndEmits, currentSeq));
                        if (results.length < CHANGES_BATCH_SIZE) {
                          return complete();
                        }
                        return processNextBatch();
                      }).on('error', onError);

                      function onError(err) {
                        reject(err);
                      }
                    }

                    processNextBatch();
                  });
                }

                function reduceView(view, results, options) {
                  if (options.group_level === 0) {
                    delete options.group_level;
                  }

                  var shouldGroup = options.group || options.group_level;

                  var reduceFun = reducer(view.reduceFun);

                  var groups = [];
                  var lvl = options.group_level;
                  results.forEach(function (e) {
                    var last = groups[groups.length - 1];
                    var key = shouldGroup ? e.key : null;

                    if (shouldGroup && Array.isArray(key) && typeof lvl === 'number') {
                      key = key.length > lvl ? key.slice(0, lvl) : key;
                    }

                    if (last && collate(last.key[0][0], key) === 0) {
                      last.key.push([key, e.id]);
                      last.value.push(e.value);
                      return;
                    }
                    groups.push({ key: [[key, e.id]], value: [e.value] });
                  });
                  for (var i = 0, len = groups.length; i < len; i++) {
                    var e = groups[i];
                    var reduceTry = tryCode(view.sourceDB, reduceFun, [e.key, e.value, false]);

                    e.value = reduceTry.error ? null : reduceTry.output;
                    e.key = e.key[0][0];
                  }

                  return { rows: sliceResults(groups, options.limit, options.skip) };
                }

                function queryView(view, opts) {
                  return utils.sequentialize(getQueue(view), function () {
                    return queryViewInQueue(view, opts);
                  })();
                }

                function queryViewInQueue(view, opts) {
                  var totalRows;
                  var shouldReduce = view.reduceFun && opts.reduce !== false;
                  var skip = opts.skip || 0;
                  if (typeof opts.keys !== 'undefined' && !opts.keys.length) {
                    opts.limit = 0;
                    delete opts.keys;
                  }

                  function fetchFromView(viewOpts) {
                    viewOpts.include_docs = true;
                    return view.db.allDocs(viewOpts).then(function (res) {
                      totalRows = res.total_rows;
                      return res.rows.map(function (result) {
                        if ('value' in result.doc && typeof result.doc.value === 'object' && result.doc.value !== null) {
                          var keys = Object.keys(result.doc.value).sort();

                          var expectedKeys = ['id', 'key', 'value'];
                          if (!(keys < expectedKeys || keys > expectedKeys)) {
                            return result.doc.value;
                          }
                        }

                        var parsedKeyAndDocId = pouchCollate.parseIndexableString(result.doc._id);
                        return {
                          key: parsedKeyAndDocId[0],
                          id: parsedKeyAndDocId[1],
                          value: 'value' in result.doc ? result.doc.value : null
                        };
                      });
                    });
                  }

                  function onMapResultsReady(rows) {
                    var finalResults;
                    if (shouldReduce) {
                      finalResults = reduceView(view, rows, opts);
                    } else {
                      finalResults = {
                        total_rows: totalRows,
                        offset: skip,
                        rows: rows
                      };
                    }
                    if (opts.include_docs) {
                      var docIds = utils.uniq(rows.map(rowToDocId));

                      return view.sourceDB.allDocs({
                        keys: docIds,
                        include_docs: true,
                        conflicts: opts.conflicts,
                        attachments: opts.attachments
                      }).then(function (allDocsRes) {
                        var docIdsToDocs = {};
                        allDocsRes.rows.forEach(function (row) {
                          if (row.doc) {
                            docIdsToDocs['$' + row.id] = row.doc;
                          }
                        });
                        rows.forEach(function (row) {
                          var docId = rowToDocId(row);
                          var doc = docIdsToDocs['$' + docId];
                          if (doc) {
                            row.doc = doc;
                          }
                        });
                        return finalResults;
                      });
                    } else {
                      return finalResults;
                    }
                  }

                  var flatten = function flatten(array) {
                    return array.reduce(function (prev, cur) {
                      return prev.concat(cur);
                    });
                  };

                  if (typeof opts.keys !== 'undefined') {
                    var keys = opts.keys;
                    var fetchPromises = keys.map(function (key) {
                      var viewOpts = {
                        startkey: toIndexableString([key]),
                        endkey: toIndexableString([key, {}])
                      };
                      return fetchFromView(viewOpts);
                    });
                    return Promise.all(fetchPromises).then(flatten).then(onMapResultsReady);
                  } else {
                    var viewOpts = {
                      descending: opts.descending
                    };
                    if (typeof opts.startkey !== 'undefined') {
                      viewOpts.startkey = opts.descending ? toIndexableString([opts.startkey, {}]) : toIndexableString([opts.startkey]);
                    }
                    if (typeof opts.endkey !== 'undefined') {
                      var inclusiveEnd = opts.inclusive_end !== false;
                      if (opts.descending) {
                        inclusiveEnd = !inclusiveEnd;
                      }

                      viewOpts.endkey = toIndexableString(inclusiveEnd ? [opts.endkey, {}] : [opts.endkey]);
                    }
                    if (typeof opts.key !== 'undefined') {
                      var keyStart = toIndexableString([opts.key]);
                      var keyEnd = toIndexableString([opts.key, {}]);
                      if (viewOpts.descending) {
                        viewOpts.endkey = keyStart;
                        viewOpts.startkey = keyEnd;
                      } else {
                        viewOpts.startkey = keyStart;
                        viewOpts.endkey = keyEnd;
                      }
                    }
                    if (!shouldReduce) {
                      if (typeof opts.limit === 'number') {
                        viewOpts.limit = opts.limit;
                      }
                      viewOpts.skip = skip;
                    }
                    return fetchFromView(viewOpts).then(onMapResultsReady);
                  }
                }

                function localViewCleanup(db) {
                  return db.get('_local/' + pluginName).then(function (metaDoc) {
                    var docsToViews = {};
                    Object.keys(metaDoc.views).forEach(function (fullViewName) {
                      var parts = parseViewName(fullViewName);
                      var designDocName = '_design/' + parts[0];
                      var viewName = parts[1];
                      docsToViews[designDocName] = docsToViews[designDocName] || {};
                      docsToViews[designDocName][viewName] = true;
                    });
                    var opts = {
                      keys: Object.keys(docsToViews),
                      include_docs: true
                    };
                    return db.allDocs(opts).then(function (res) {
                      var viewsToStatus = {};
                      res.rows.forEach(function (row) {
                        var ddocName = row.key.substring(8);
                        Object.keys(docsToViews[row.key]).forEach(function (viewName) {
                          var fullViewName = ddocName + '/' + viewName;

                          if (!metaDoc.views[fullViewName]) {
                            fullViewName = viewName;
                          }
                          var viewDBNames = Object.keys(metaDoc.views[fullViewName]);

                          var statusIsGood = row.doc && row.doc.views && row.doc.views[viewName];
                          viewDBNames.forEach(function (viewDBName) {
                            viewsToStatus[viewDBName] = viewsToStatus[viewDBName] || statusIsGood;
                          });
                        });
                      });
                      var dbsToDelete = Object.keys(viewsToStatus).filter(function (viewDBName) {
                        return !viewsToStatus[viewDBName];
                      });
                      var destroyPromises = dbsToDelete.map(function (viewDBName) {
                        return utils.sequentialize(getQueue(viewDBName), function () {
                          return new db.constructor(viewDBName, db.__opts).destroy();
                        })();
                      });
                      return Promise.all(destroyPromises).then(function () {
                        return { ok: true };
                      });
                    });
                  }, defaultsTo({ ok: true }));
                }

                function queryPromised(db, fun, opts) {
                  if (typeof fun !== 'string') {
                    checkQueryParseError(opts, fun);

                    var createViewOpts = {
                      db: db,
                      viewName: 'temp_view/temp_view',
                      map: fun.map,
                      reduce: fun.reduce,
                      temporary: true,
                      pluginName: pluginName
                    };
                    tempViewQueue.add(function () {
                      return createView(createViewOpts).then(function (view) {
                        function cleanup() {
                          return view.db.destroy();
                        }
                        return utils.fin(updateView(view).then(function () {
                          return queryView(view, opts);
                        }), cleanup);
                      });
                    });
                    return tempViewQueue.finish();
                  } else {
                    var fullViewName = fun;
                    var parts = parseViewName(fullViewName);
                    var designDocName = parts[0];
                    var viewName = parts[1];
                    return db.get('_design/' + designDocName).then(function (doc) {
                      var fun = doc.views && doc.views[viewName];

                      if (!fun) {
                        throw new NotFoundError('ddoc ' + doc._id + ' has no view named ' + viewName);
                      }

                      ddocValidator(doc, viewName);
                      checkQueryParseError(opts, fun);

                      var createViewOpts = {
                        db: db,
                        viewName: fullViewName,
                        map: fun.map,
                        reduce: fun.reduce,
                        pluginName: pluginName
                      };
                      return createView(createViewOpts).then(function (view) {
                        if (opts.stale === 'ok' || opts.stale === 'update_after') {
                          if (opts.stale === 'update_after') {
                            process.nextTick(function () {
                              updateView(view);
                            });
                          }
                          return queryView(view, opts);
                        } else {
                          return updateView(view).then(function () {
                            return queryView(view, opts);
                          });
                        }
                      });
                    });
                  }
                }

                var query = function query(fun, opts, callback) {
                  var db = this;
                  if (typeof opts === 'function') {
                    callback = opts;
                    opts = {};
                  }
                  opts = utils.extend(true, {}, opts);

                  if (typeof fun === 'function') {
                    fun = { map: fun };
                  }

                  var promise = Promise.resolve().then(function () {
                    return queryPromised(db, fun, opts);
                  });
                  utils.promisedCallback(promise, callback);
                  return promise;
                };

                var viewCleanup = utils.callbackify(function () {
                  var db = this;
                  return localViewCleanup(db);
                });

                return {
                  query: query,
                  viewCleanup: viewCleanup
                };
              }

              module.exports = createIndexer;
            }).call(this, _dereq_(41));
          }, { "1": 1, "3": 3, "37": 37, "41": 41, "5": 5 }], 3: [function (_dereq_, module, exports) {
            'use strict';

            var Promise = _dereq_(5).Promise;

            function TaskQueue() {
              this.promise = new Promise(function (fulfill) {
                fulfill();
              });
            }
            TaskQueue.prototype.add = function (promiseFactory) {
              this.promise = this.promise["catch"](function () {}).then(function () {
                return promiseFactory();
              });
              return this.promise;
            };
            TaskQueue.prototype.finish = function () {
              return this.promise;
            };

            module.exports = TaskQueue;
          }, { "5": 5 }], 4: [function (_dereq_, module, exports) {
            'use strict';

            var upsert = _dereq_(40).upsert;

            module.exports = function (db, doc, diffFun) {
              return upsert.apply(db, [doc, diffFun]);
            };
          }, { "40": 40 }], 5: [function (_dereq_, module, exports) {
            (function (process, global) {
              'use strict';

              if (typeof global.Promise === 'function') {
                exports.Promise = global.Promise;
              } else {
                exports.Promise = _dereq_(26);
              }

              exports.inherits = _dereq_(22);
              exports.extend = _dereq_(39);
              var argsarray = _dereq_(17);

              exports.promisedCallback = function (promise, callback) {
                if (callback) {
                  promise.then(function (res) {
                    process.nextTick(function () {
                      callback(null, res);
                    });
                  }, function (reason) {
                    process.nextTick(function () {
                      callback(reason);
                    });
                  });
                }
                return promise;
              };

              exports.callbackify = function (fun) {
                return argsarray(function (args) {
                  var cb = args.pop();
                  var promise = fun.apply(this, args);
                  if (typeof cb === 'function') {
                    exports.promisedCallback(promise, cb);
                  }
                  return promise;
                });
              };

              exports.fin = function (promise, cb) {
                return promise.then(function (res) {
                  var promise2 = cb();
                  if (typeof promise2.then === 'function') {
                    return promise2.then(function () {
                      return res;
                    });
                  }
                  return res;
                }, function (reason) {
                  var promise2 = cb();
                  if (typeof promise2.then === 'function') {
                    return promise2.then(function () {
                      throw reason;
                    });
                  }
                  throw reason;
                });
              };

              exports.sequentialize = function (queue, promiseFactory) {
                return function () {
                  var args = arguments;
                  var that = this;
                  return queue.add(function () {
                    return promiseFactory.apply(that, args);
                  });
                };
              };

              exports.flatten = function (arrs) {
                var res = [];
                for (var i = 0, len = arrs.length; i < len; i++) {
                  res = res.concat(arrs[i]);
                }
                return res;
              };

              exports.uniq = function (arr) {
                var map = {};

                for (var i = 0, len = arr.length; i < len; i++) {
                  map['$' + arr[i]] = true;
                }

                var keys = Object.keys(map);
                var output = new Array(keys.length);

                for (i = 0, len = keys.length; i < len; i++) {
                  output[i] = keys[i].substring(1);
                }
                return output;
              };

              var crypto = _dereq_(18);
              var Md5 = _dereq_(42);

              exports.MD5 = function (string) {
                if (!process.browser) {
                  return crypto.createHash('md5').update(string).digest('hex');
                } else {
                  return Md5.hash(string);
                }
              };
            }).call(this, _dereq_(41), typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
          }, { "17": 17, "18": 18, "22": 22, "26": 26, "39": 39, "41": 41, "42": 42 }], 6: [function (_dereq_, module, exports) {
            'use strict';

            function createIndex(db, requestDef, callback) {

              db.request({
                method: 'POST',
                url: '_index',
                body: requestDef
              }, callback);
            }

            function find(db, requestDef, callback) {
              db.request({
                method: 'POST',
                url: '_find',
                body: requestDef
              }, callback);
            }

            function getIndexes(db, callback) {
              db.request({
                method: 'GET',
                url: '_index'
              }, callback);
            }

            function deleteIndex(db, indexDef, callback) {

              var ddoc = indexDef.ddoc;
              var type = indexDef.type || 'json';
              var name = indexDef.name;

              if (!ddoc) {
                return callback(null, new Error('you must provide an index\'s ddoc'));
              }

              if (!name) {
                return callback(null, new Error('you must provide an index\'s name'));
              }

              var url = '_index/' + [ddoc, type, name].map(encodeURIComponent).join('/');

              db.request({
                method: 'DELETE',
                url: url
              }, callback);
            }

            exports.createIndex = createIndex;
            exports.find = find;
            exports.getIndexes = getIndexes;
            exports.deleteIndex = deleteIndex;
          }, {}], 7: [function (_dereq_, module, exports) {
            'use strict';

            var localUtils = _dereq_(15);
            var abstractMapReduce = _dereq_(2);
            var parseField = localUtils.parseField;

            function createDeepMultiMapper(fields, emit) {
              return function (doc) {
                var toEmit = [];
                for (var i = 0, iLen = fields.length; i < iLen; i++) {
                  var parsedField = parseField(fields[i]);
                  var value = doc;
                  for (var j = 0, jLen = parsedField.length; j < jLen; j++) {
                    var key = parsedField[j];
                    value = value[key];
                    if (!value) {
                      break;
                    }
                  }
                  toEmit.push(value);
                }
                emit(toEmit);
              };
            }

            function createDeepSingleMapper(field, emit) {
              var parsedField = parseField(field);
              return function (doc) {
                var value = doc;
                for (var i = 0, len = parsedField.length; i < len; i++) {
                  var key = parsedField[i];
                  value = value[key];
                  if (!value) {
                    return;
                  }
                }
                emit(value);
              };
            }

            function createShallowSingleMapper(field, emit) {
              return function (doc) {
                emit(doc[field]);
              };
            }

            function createShallowMultiMapper(fields, emit) {
              return function (doc) {
                var toEmit = [];
                for (var i = 0, len = fields.length; i < len; i++) {
                  toEmit.push(doc[fields[i]]);
                }
                emit(toEmit);
              };
            }

            function checkShallow(fields) {
              for (var i = 0, len = fields.length; i < len; i++) {
                var field = fields[i];
                if (field.indexOf('.') !== -1) {
                  return false;
                }
              }
              return true;
            }

            function createMapper(fields, emit) {
              var isShallow = checkShallow(fields);
              var isSingle = fields.length === 1;

              if (isShallow) {
                if (isSingle) {
                  return createShallowSingleMapper(fields[0], emit);
                } else {
                  return createShallowMultiMapper(fields, emit);
                }
              } else {
                if (isSingle) {
                  return createDeepSingleMapper(fields[0], emit);
                } else {
                  return createDeepMultiMapper(fields, emit);
                }
              }
            }

            var abstractMapper = abstractMapReduce({
              name: 'indexes',
              mapper: function mapper(mapFunDef, emit) {

                var fields = Object.keys(mapFunDef.fields);

                return createMapper(fields, emit);
              },
              reducer: function reducer() {
                throw new Error('reduce not supported');
              },
              ddocValidator: function ddocValidator(ddoc, viewName) {
                var view = ddoc.views[viewName];
                if (!view.map || !view.map.fields) {
                  throw new Error('ddoc ' + ddoc._id + ' with view ' + viewName + ' doesn\'t have map.fields defined. ' + 'maybe it wasn\'t created by this plugin?');
                }
              }
            });

            module.exports = abstractMapper;
          }, { "15": 15, "2": 2 }], 8: [function (_dereq_, module, exports) {
            'use strict';

            var utils = _dereq_(16);
            var log = utils.log;

            var pouchUpsert = _dereq_(40);
            var abstractMapper = _dereq_(7);
            var localUtils = _dereq_(15);
            var validateIndex = localUtils.validateIndex;
            var massageIndexDef = localUtils.massageIndexDef;

            function upsert(db, docId, diffFun) {
              return pouchUpsert.upsert.call(db, docId, diffFun);
            }

            function createIndex(db, requestDef) {

              var originalIndexDef = utils.clone(requestDef.index);
              requestDef.index = massageIndexDef(requestDef.index);

              validateIndex(requestDef.index);

              var md5 = utils.MD5(JSON.stringify(requestDef));

              var viewName = requestDef.name || 'idx-' + md5;

              var ddocName = requestDef.ddoc || 'idx-' + md5;
              var ddocId = '_design/' + ddocName;

              var hasInvalidLanguage = false;
              var viewExists = false;

              function updateDdoc(doc) {
                if (doc._rev && doc.language !== 'query') {
                  hasInvalidLanguage = true;
                }
                doc.language = 'query';
                doc.views = doc.views || {};

                viewExists = !!doc.views[viewName];

                doc.views[viewName] = {
                  map: {
                    fields: utils.mergeObjects(requestDef.index.fields)
                  },
                  reduce: '_count',
                  options: {
                    def: originalIndexDef
                  }
                };

                return doc;
              }

              log('creating index', ddocId);

              return upsert(db, ddocId, updateDdoc).then(function () {
                if (hasInvalidLanguage) {
                  throw new Error('invalid language for ddoc with id "' + ddocId + '" (should be "query")');
                }
              }).then(function () {
                var signature = ddocName + '/' + viewName;
                return abstractMapper.query.call(db, signature, {
                  limit: 0,
                  reduce: false
                }).then(function () {
                  return {
                    id: ddocId,
                    name: viewName,
                    result: viewExists ? 'exists' : 'created'
                  };
                });
              });
            }

            module.exports = createIndex;
          }, { "15": 15, "16": 16, "40": 40, "7": 7 }], 9: [function (_dereq_, module, exports) {
            'use strict';

            var abstractMapper = _dereq_(7);

            function deleteIndex(db, index) {

              var docId = index.ddoc;

              return db.get(docId).then(function (doc) {
                return db.remove(doc);
              }).then(function () {
                return abstractMapper.viewCleanup.apply(db);
              }).then(function () {
                return { ok: true };
              });
            }

            module.exports = deleteIndex;
          }, { "7": 7 }], 10: [function (_dereq_, module, exports) {
            'use strict';

            var collate = _dereq_(37).collate;
            var localUtils = _dereq_(15);
            var getKey = localUtils.getKey;
            var getValue = localUtils.getValue;
            var parseField = localUtils.parseField;
            var utils = _dereq_(16);

            function getFieldFromDoc(doc, parsedField) {
              var value = doc;
              for (var i = 0, len = parsedField.length; i < len; i++) {
                var key = parsedField[i];
                value = value[key];
                if (!value) {
                  break;
                }
              }
              return value;
            }

            function createCriterion(userOperator, userValue, parsedField) {
              function getDocFieldCollate(doc) {
                return collate(getFieldFromDoc(doc, parsedField), userValue);
              }

              function fieldExists(doc) {
                var docFieldValue = getFieldFromDoc(doc, parsedField);
                return typeof docFieldValue !== 'undefined' && docFieldValue !== null;
              }

              function fieldIsArray(doc) {
                var docFieldValue = getFieldFromDoc(doc, parsedField);
                return fieldExists(doc) && docFieldValue instanceof Array;
              }

              function arrayContainsValue(doc) {
                var docFieldValue = getFieldFromDoc(doc, parsedField);
                return userValue.some(function (val) {
                  return docFieldValue.indexOf(val) > -1;
                });
              }

              function arrayContainsAllValues(doc) {
                var docFieldValue = getFieldFromDoc(doc, parsedField);
                return userValue.every(function (val) {
                  return docFieldValue.indexOf(val) > -1;
                });
              }

              function arraySize(doc) {
                var docFieldValue = getFieldFromDoc(doc, parsedField);
                return docFieldValue.length === userValue;
              }

              switch (userOperator) {
                case '$eq':
                  return function (doc) {
                    return fieldExists(doc) && getDocFieldCollate(doc) === 0;
                  };
                case '$lte':
                  return function (doc) {
                    return fieldExists(doc) && getDocFieldCollate(doc) <= 0;
                  };
                case '$gte':
                  return function (doc) {
                    return fieldExists(doc) && getDocFieldCollate(doc) >= 0;
                  };
                case '$lt':
                  return function (doc) {
                    return fieldExists(doc) && getDocFieldCollate(doc) < 0;
                  };
                case '$gt':
                  return function (doc) {
                    return fieldExists(doc) && getDocFieldCollate(doc) > 0;
                  };
                case '$exists':
                  return function (doc) {
                    return fieldExists(doc);
                  };
                case '$ne':
                  return function (doc) {
                    var docFieldValue = getFieldFromDoc(doc, parsedField);
                    return userValue.every(function (neValue) {
                      return collate(docFieldValue, neValue) !== 0;
                    });
                  };
                case '$in':
                  return function (doc) {
                    return fieldIsArray(doc) && arrayContainsValue(doc);
                  };
                case '$nin':
                  return function (doc) {
                    return fieldIsArray(doc) && !arrayContainsValue(doc);
                  };
                case '$size':
                  return function (doc) {
                    return fieldIsArray(doc) && arraySize(doc);
                  };
                case '$all':
                  return function (doc) {
                    return fieldIsArray(doc) && arrayContainsAllValues(doc);
                  };
              }
            }

            function createFilterRowFunction(requestDef, inMemoryFields) {

              var criteria = [];
              inMemoryFields.forEach(function (field) {
                var matcher = requestDef.selector[field];
                var parsedField = parseField(field);

                if (!matcher) {
                  return;
                }

                Object.keys(matcher).forEach(function (userOperator) {
                  var userValue = matcher[userOperator];

                  var criterion = createCriterion(userOperator, userValue, parsedField);
                  criteria.push(criterion);
                });
              });

              return function filterRowFunction(row) {
                for (var i = 0, len = criteria.length; i < len; i++) {
                  var criterion = criteria[i];
                  if (!criterion(row.doc)) {
                    return false;
                  }
                }
                return true;
              };
            }

            function createFieldSorter(sort) {

              function getFieldValuesAsArray(doc) {
                return sort.map(function (sorting) {
                  var fieldName = typeof sorting === 'string' ? sorting : getKey(sorting);
                  var parsedField = parseField(fieldName);
                  var docFieldValue = getFieldFromDoc(doc, parsedField);
                  return docFieldValue;
                });
              }

              return function (aRow, bRow) {
                var aFieldValues = getFieldValuesAsArray(aRow.doc);
                var bFieldValues = getFieldValuesAsArray(bRow.doc);
                var collation = collate(aFieldValues, bFieldValues);
                if (collation !== 0) {
                  return collation;
                }

                return utils.compare(aRow.doc._id, bRow.doc._id);
              };
            }

            function filterInMemoryFields(rows, requestDef, inMemoryFields) {

              var filter = createFilterRowFunction(requestDef, inMemoryFields);
              rows = rows.filter(filter);

              if (requestDef.sort) {
                var fieldSorter = createFieldSorter(requestDef.sort);
                rows = rows.sort(fieldSorter);
                if (typeof requestDef.sort[0] !== 'string' && getValue(requestDef.sort[0]) === 'desc') {
                  rows = rows.reverse();
                }
              }

              if ('limit' in requestDef || 'skip' in requestDef) {
                var skip = requestDef.skip || 0;
                var limit = ('limit' in requestDef ? requestDef.limit : rows.length) + skip;
                rows = rows.slice(skip, limit);
              }
              return rows;
            }

            module.exports = filterInMemoryFields;
          }, { "15": 15, "16": 16, "37": 37 }], 11: [function (_dereq_, module, exports) {
            'use strict';

            var utils = _dereq_(16);
            var getIndexes = _dereq_(13);
            var collate = _dereq_(37).collate;
            var abstractMapper = _dereq_(7);
            var planQuery = _dereq_(12);
            var localUtils = _dereq_(15);
            var filterInMemoryFields = _dereq_(10);
            var massageSelector = localUtils.massageSelector;
            var massageSort = localUtils.massageSort;
            var getValue = localUtils.getValue;
            var validateFindRequest = localUtils.validateFindRequest;
            var reverseOptions = localUtils.reverseOptions;
            var filterInclusiveStart = localUtils.filterInclusiveStart;
            var Promise = utils.Promise;

            function indexToSignature(index) {
              return index.ddoc.substring(8) + '/' + index.name;
            }

            function find(db, requestDef) {

              if (requestDef.selector) {
                requestDef.selector = massageSelector(requestDef.selector);
              }
              if (requestDef.sort) {
                requestDef.sort = massageSort(requestDef.sort);
              }

              validateFindRequest(requestDef);

              return getIndexes(db).then(function (getIndexesRes) {

                var queryPlan = planQuery(requestDef, getIndexesRes.indexes);

                var indexToUse = queryPlan.index;

                var opts = utils.extend(true, {
                  include_docs: true,
                  reduce: false
                }, queryPlan.queryOpts);

                if ('startkey' in opts && 'endkey' in opts && collate(opts.startkey, opts.endkey) > 0) {
                  return { docs: [] };
                }

                var isDescending = requestDef.sort && typeof requestDef.sort[0] !== 'string' && getValue(requestDef.sort[0]) === 'desc';

                if (isDescending) {
                  opts.descending = true;
                  opts = reverseOptions(opts);
                }

                if (!queryPlan.inMemoryFields.length) {
                  if ('limit' in requestDef) {
                    opts.limit = requestDef.limit;
                  }
                  if ('skip' in requestDef) {
                    opts.skip = requestDef.skip;
                  }
                }

                return Promise.resolve().then(function () {
                  if (indexToUse.name === '_all_docs') {
                    return db.allDocs(opts);
                  } else {
                    var signature = indexToSignature(indexToUse);
                    return abstractMapper.query.call(db, signature, opts);
                  }
                }).then(function (res) {

                  if (opts.inclusive_start === false) {
                    res.rows = filterInclusiveStart(res.rows, opts.startkey, indexToUse);
                  }

                  if (queryPlan.inMemoryFields.length) {
                    res.rows = filterInMemoryFields(res.rows, requestDef, queryPlan.inMemoryFields);
                  }

                  return {
                    docs: res.rows.map(function (row) {
                      var doc = row.doc;
                      if (requestDef.fields) {
                        return utils.pick(doc, requestDef.fields);
                      }
                      return doc;
                    })
                  };
                });
              });
            }

            module.exports = find;
          }, { "10": 10, "12": 12, "13": 13, "15": 15, "16": 16, "37": 37, "7": 7 }], 12: [function (_dereq_, module, exports) {
            'use strict';

            var utils = _dereq_(16);
            var log = utils.log;
            var localUtils = _dereq_(15);
            var getKey = localUtils.getKey;
            var getValue = localUtils.getValue;
            var getUserFields = localUtils.getUserFields;

            var COLLATE_LO = null;

            var COLLATE_HI = { "￿": {} };

            var COLLATE_LO_PLUS_1 = false;

            var COLLATE_NULL_LO = null;
            var COLLATE_NULL_HI = null;
            var COLLATE_BOOL_LO = false;
            var COLLATE_BOOL_HI = true;
            var COLLATE_NUM_LO = 0;
            var COLLATE_NUM_HI = Number.MAX_VALUE;
            var COLLATE_STR_LO = '';
            var COLLATE_STR_HI = "￿￿￿";
            var COLLATE_ARR_LO = [];
            var COLLATE_ARR_HI = [{ "￿": {} }];
            var COLLATE_OBJ_LO = {};
            var COLLATE_OBJ_HI = { "￿": {} };

            function checkFieldInIndex(index, field) {
              var indexFields = index.def.fields.map(getKey);
              for (var i = 0, len = indexFields.length; i < len; i++) {
                var indexField = indexFields[i];
                if (field === indexField) {
                  return true;
                }
              }
              return false;
            }

            function userOperatorLosesPrecision(selector, field) {
              var matcher = selector[field];
              var userOperator = getKey(matcher);

              return userOperator !== '$eq';
            }

            function sortFieldsByIndex(userFields, index) {
              var indexFields = index.def.fields.map(getKey);

              return userFields.slice().sort(function (a, b) {
                var aIdx = indexFields.indexOf(a);
                var bIdx = indexFields.indexOf(b);
                if (aIdx === -1) {
                  aIdx = Number.MAX_VALUE;
                }
                if (bIdx === -1) {
                  bIdx = Number.MAX_VALUE;
                }
                return utils.compare(aIdx, bIdx);
              });
            }

            function getBasicInMemoryFields(index, selector, userFields) {

              userFields = sortFieldsByIndex(userFields, index);

              var needToFilterInMemory = false;
              for (var i = 0, len = userFields.length; i < len; i++) {
                var field = userFields[i];
                if (needToFilterInMemory || !checkFieldInIndex(index, field)) {
                  return userFields.slice(i);
                }
                if (i < len - 1 && userOperatorLosesPrecision(selector, field)) {
                  needToFilterInMemory = true;
                }
              }
              return [];
            }

            function getInMemoryFieldsFromNe(selector) {
              var fields = [];
              Object.keys(selector).forEach(function (field) {
                var matcher = selector[field];
                Object.keys(matcher).forEach(function (operator) {
                  if (operator === '$ne') {
                    fields.push(field);
                  }
                });
              });
              return fields;
            }

            function getInMemoryFields(coreInMemoryFields, index, selector, userFields) {

              var result = utils.flatten(coreInMemoryFields, getBasicInMemoryFields(index, selector, userFields), getInMemoryFieldsFromNe(selector));

              return sortFieldsByIndex(utils.uniq(result), index);
            }

            function checkIndexFieldsMatch(indexFields, sortOrder, fields) {
              if (sortOrder) {
                var sortMatches = utils.oneArrayIsStrictSubArrayOfOther(sortOrder, indexFields);
                var selectorMatches = utils.oneArrayIsSubArrayOfOther(fields, indexFields);

                return sortMatches && selectorMatches;
              }

              return utils.oneSetIsSubArrayOfOther(fields, indexFields);
            }

            function checkFieldsLogicallySound(indexFields, selector) {
              var firstField = indexFields[0];
              var matcher = selector[firstField];

              var isInvalidNe = Object.keys(matcher).length === 1 && getKey(matcher) === '$ne';

              return !isInvalidNe;
            }

            function checkIndexMatches(index, sortOrder, fields, selector) {

              var indexFields = index.def.fields.map(getKey);

              var fieldsMatch = checkIndexFieldsMatch(indexFields, sortOrder, fields);

              if (!fieldsMatch) {
                return false;
              }

              var logicallySound = checkFieldsLogicallySound(indexFields, selector);

              return logicallySound;
            }

            function findMatchingIndexes(selector, userFields, sortOrder, indexes) {

              var res = [];
              for (var i = 0, iLen = indexes.length; i < iLen; i++) {
                var index = indexes[i];
                var indexMatches = checkIndexMatches(index, sortOrder, userFields, selector);
                if (indexMatches) {
                  res.push(index);
                }
              }
              return res;
            }

            function findBestMatchingIndex(selector, userFields, sortOrder, indexes) {

              var matchingIndexes = findMatchingIndexes(selector, userFields, sortOrder, indexes);

              if (matchingIndexes.length === 0) {
                return null;
              }
              if (matchingIndexes.length === 1) {
                return matchingIndexes[0];
              }

              var userFieldsMap = utils.arrayToObject(userFields);

              function scoreIndex(index) {
                var indexFields = index.def.fields.map(getKey);
                var score = 0;
                for (var i = 0, len = indexFields.length; i < len; i++) {
                  var indexField = indexFields[i];
                  if (userFieldsMap[indexField]) {
                    score++;
                  }
                }
                return score;
              }

              return utils.max(matchingIndexes, scoreIndex);
            }

            function getSingleFieldQueryOptsFor(userOperator, userValue) {
              switch (userOperator) {
                case '$eq':
                  return { key: userValue };
                case '$lte':
                  return { endkey: userValue };
                case '$gte':
                  return { startkey: userValue };
                case '$lt':
                  return {
                    endkey: userValue,
                    inclusive_end: false
                  };
                case '$gt':
                  return {
                    startkey: userValue,
                    inclusive_start: false
                  };
                case '$exists':
                  if (userValue) {
                    return {
                      startkey: COLLATE_LO_PLUS_1
                    };
                  }
                  return {
                    endkey: COLLATE_LO
                  };

                case '$type':
                  switch (userValue) {
                    case 'null':
                      return {
                        startkey: COLLATE_NULL_LO,
                        endkey: COLLATE_NULL_HI
                      };
                    case 'boolean':
                      return {
                        startkey: COLLATE_BOOL_LO,
                        endkey: COLLATE_BOOL_HI
                      };
                    case 'number':
                      return {
                        startkey: COLLATE_NUM_LO,
                        endkey: COLLATE_NUM_HI
                      };
                    case 'string':
                      return {
                        startkey: COLLATE_STR_LO,
                        endkey: COLLATE_STR_HI
                      };
                    case 'array':
                      return {
                        startkey: COLLATE_ARR_LO,
                        endkey: COLLATE_ARR_HI
                      };
                    case 'object':
                      return {
                        startkey: COLLATE_OBJ_LO,
                        endkey: COLLATE_OBJ_HI
                      };
                  }
              }
            }

            function getSingleFieldCoreQueryPlan(selector, index) {
              var field = getKey(index.def.fields[0]);
              var matcher = selector[field];

              var userOperators = Object.keys(matcher);

              var combinedOpts;

              for (var i = 0; i < userOperators.length; i++) {
                var userOperator = userOperators[i];
                var userValue = matcher[userOperator];

                var newQueryOpts = getSingleFieldQueryOptsFor(userOperator, userValue);
                if (combinedOpts) {
                  combinedOpts = utils.mergeObjects([combinedOpts, newQueryOpts]);
                } else {
                  combinedOpts = newQueryOpts;
                }
              }

              return {
                queryOpts: combinedOpts,

                inMemoryFields: []
              };
            }

            function getMultiFieldCoreQueryPlan(userOperator, userValue) {
              switch (userOperator) {
                case '$eq':
                  return {
                    startkey: userValue,
                    endkey: userValue
                  };
                case '$lte':
                  return {
                    endkey: userValue
                  };
                case '$gte':
                  return {
                    startkey: userValue
                  };
                case '$lt':
                  return {
                    endkey: userValue,
                    inclusive_end: false
                  };
                case '$gt':
                  return {
                    startkey: userValue,
                    inclusive_start: false
                  };
                case '$exists':
                  if (userValue) {
                    return {
                      startkey: COLLATE_LO_PLUS_1,
                      endkey: COLLATE_HI
                    };
                  } else {
                    return {
                      startkey: COLLATE_LO,
                      endkey: COLLATE_LO
                    };
                  }
              }
            }

            function getMultiFieldQueryOpts(selector, index) {

              var indexFields = index.def.fields.map(getKey);

              var inMemoryFields = [];
              var startkey = [];
              var endkey = [];
              var inclusiveStart;
              var inclusiveEnd;

              function finish(i) {

                if (inclusiveStart !== false) {
                  startkey.push(COLLATE_LO);
                }
                if (inclusiveEnd !== false) {
                  endkey.push(COLLATE_HI);
                }

                inMemoryFields = indexFields.slice(i);
              }

              for (var i = 0, len = indexFields.length; i < len; i++) {
                var indexField = indexFields[i];

                var matcher = selector[indexField];

                if (!matcher) {
                  finish(i);
                  break;
                } else if (i > 0) {
                  if ('$ne' in matcher) {
                    finish(i);
                    break;
                  }
                  var usingGtlt = '$gt' in matcher || '$gte' in matcher || '$lt' in matcher || '$lte' in matcher;
                  var previousKeys = Object.keys(selector[indexFields[i - 1]]);
                  var previousWasEq = utils.arrayEquals(previousKeys, ['$eq']);
                  var previousWasSame = utils.arrayEquals(previousKeys, Object.keys(matcher));
                  var gtltLostSpecificity = usingGtlt && !previousWasEq && !previousWasSame;
                  if (gtltLostSpecificity) {
                    finish(i);
                    break;
                  }
                }

                var userOperators = Object.keys(matcher);

                var combinedOpts = null;

                for (var j = 0; j < userOperators.length; j++) {
                  var userOperator = userOperators[j];
                  var userValue = matcher[userOperator];

                  var newOpts = getMultiFieldCoreQueryPlan(userOperator, userValue);

                  if (combinedOpts) {
                    combinedOpts = utils.mergeObjects([combinedOpts, newOpts]);
                  } else {
                    combinedOpts = newOpts;
                  }
                }

                startkey.push('startkey' in combinedOpts ? combinedOpts.startkey : COLLATE_LO);
                endkey.push('endkey' in combinedOpts ? combinedOpts.endkey : COLLATE_HI);
                if ('inclusive_start' in combinedOpts) {
                  inclusiveStart = combinedOpts.inclusive_start;
                }
                if ('inclusive_end' in combinedOpts) {
                  inclusiveEnd = combinedOpts.inclusive_end;
                }
              }

              var res = {
                startkey: startkey,
                endkey: endkey
              };

              if (typeof inclusiveStart !== 'undefined') {
                res.inclusive_start = inclusiveStart;
              }
              if (typeof inclusiveEnd !== 'undefined') {
                res.inclusive_end = inclusiveEnd;
              }

              return {
                queryOpts: res,
                inMemoryFields: inMemoryFields
              };
            }

            function getCoreQueryPlan(selector, index) {
              if (index.def.fields.length === 1) {
                return getSingleFieldCoreQueryPlan(selector, index);
              }

              return getMultiFieldQueryOpts(selector, index);
            }

            function createNoIndexFoundError(userFields, sortFields, selector) {

              if (getKey(getValue(selector)) === '$ne') {
                return new Error('couldn\'t find a usable index. try using ' + '$and with $lt/$gt instead of $ne');
              }

              var fieldsToSuggest = sortFields && sortFields.length >= userFields.length ? sortFields : userFields;

              return new Error('couldn\'t find a usable index. try creating an index on: ' + fieldsToSuggest.join(', '));
            }

            function planQuery(request, indexes) {

              log('planning query', request);

              var selector = request.selector;
              var sort = request.sort;

              var userFieldsRes = getUserFields(selector, sort);

              var userFields = userFieldsRes.fields;
              var sortOrder = userFieldsRes.sortOrder;
              var index = findBestMatchingIndex(selector, userFields, sortOrder, indexes);

              if (!index) {
                throw createNoIndexFoundError(userFields, sortOrder, selector);
              }

              var firstIndexField = index.def.fields[0];
              var firstMatcher = selector[getKey(firstIndexField)];
              if (Object.keys(firstMatcher).length === 1 && getKey(firstMatcher) === '$ne') {
                throw new Error('$ne can\'t be used here. try $gt/$lt instead');
              }

              var coreQueryPlan = getCoreQueryPlan(selector, index);
              var queryOpts = coreQueryPlan.queryOpts;
              var coreInMemoryFields = coreQueryPlan.inMemoryFields;

              var inMemoryFields = getInMemoryFields(coreInMemoryFields, index, selector, userFields);

              var res = {
                queryOpts: queryOpts,
                index: index,
                inMemoryFields: inMemoryFields
              };
              log('query plan', res);
              return res;
            }

            module.exports = planQuery;
          }, { "15": 15, "16": 16 }], 13: [function (_dereq_, module, exports) {
            'use strict';

            var utils = _dereq_(16);

            var localUtils = _dereq_(15);
            var massageIndexDef = localUtils.massageIndexDef;

            function getIndexes(db) {
              return db.allDocs({
                startkey: '_design/',
                endkey: "_design/￿",
                include_docs: true
              }).then(function (allDocsRes) {
                var res = {
                  indexes: [{
                    ddoc: null,
                    name: '_all_docs',
                    type: 'special',
                    def: {
                      fields: [{ _id: 'asc' }]
                    }
                  }]
                };

                res.indexes = utils.flatten(res.indexes, allDocsRes.rows.filter(function (row) {
                  return row.doc.language === 'query';
                }).map(function (row) {
                  var viewNames = Object.keys(row.doc.views);

                  return viewNames.map(function (viewName) {
                    var view = row.doc.views[viewName];
                    return {
                      ddoc: row.id,
                      name: viewName,
                      type: 'json',
                      def: massageIndexDef(view.options.def)
                    };
                  });
                }));

                res.indexes.sort(function (left, right) {
                  return utils.compare(left.name, right.name);
                });
                res.total_rows = res.indexes.length;
                return res;
              });
            }

            module.exports = getIndexes;
          }, { "15": 15, "16": 16 }], 14: [function (_dereq_, module, exports) {
            'use strict';

            var utils = _dereq_(16);
            var callbackify = utils.callbackify;

            exports.createIndex = callbackify(_dereq_(8));
            exports.find = callbackify(_dereq_(11));
            exports.getIndexes = callbackify(_dereq_(13));
            exports.deleteIndex = callbackify(_dereq_(9));
          }, { "11": 11, "13": 13, "16": 16, "8": 8, "9": 9 }], 15: [function (_dereq_, module, exports) {
            'use strict';

            var utils = _dereq_(16);
            var collate = _dereq_(37);

            function getKey(obj) {
              return Object.keys(obj)[0];
            }

            function getValue(obj) {
              return obj[getKey(obj)];
            }

            function getSize(obj) {
              return Object.keys(obj).length;
            }

            function objectFrom(key, value) {
              var res = {};
              res[key] = value;
              return res;
            }

            function massageSort(sort) {
              return sort && sort.map(function (sorting) {
                if (typeof sorting === 'string') {
                  var obj = {};
                  obj[sorting] = 'asc';
                  return obj;
                } else {
                  return sorting;
                }
              });
            }

            function mergeGtGte(operator, value, fieldMatchers) {
              if (typeof fieldMatchers.$eq !== 'undefined') {
                return;
              }
              if (typeof fieldMatchers.$gte !== 'undefined') {
                if (operator === '$gte') {
                  if (value > fieldMatchers.$gte) {
                    fieldMatchers.$gte = value;
                  }
                } else {
                  if (value >= fieldMatchers.$gte) {
                    delete fieldMatchers.$gte;
                    fieldMatchers.$gt = value;
                  }
                }
              } else if (typeof fieldMatchers.$gt !== 'undefined') {
                if (operator === '$gte') {
                  if (value > fieldMatchers.$gt) {
                    delete fieldMatchers.$gt;
                    fieldMatchers.$gte = value;
                  }
                } else {
                  if (value > fieldMatchers.$gt) {
                    fieldMatchers.$gt = value;
                  }
                }
              } else {
                fieldMatchers[operator] = value;
              }
            }

            function mergeLtLte(operator, value, fieldMatchers) {
              if (typeof fieldMatchers.$eq !== 'undefined') {
                return;
              }
              if (typeof fieldMatchers.$lte !== 'undefined') {
                if (operator === '$lte') {
                  if (value < fieldMatchers.$lte) {
                    fieldMatchers.$lte = value;
                  }
                } else {
                  if (value <= fieldMatchers.$lte) {
                    delete fieldMatchers.$lte;
                    fieldMatchers.$lt = value;
                  }
                }
              } else if (typeof fieldMatchers.$lt !== 'undefined') {
                if (operator === '$lte') {
                  if (value < fieldMatchers.$lt) {
                    delete fieldMatchers.$lt;
                    fieldMatchers.$lte = value;
                  }
                } else {
                  if (value < fieldMatchers.$lt) {
                    fieldMatchers.$lt = value;
                  }
                }
              } else {
                fieldMatchers[operator] = value;
              }
            }

            function mergeNe(value, fieldMatchers) {
              if (typeof fieldMatchers.$eq !== 'undefined') {
                return;
              }
              if ('$ne' in fieldMatchers) {
                fieldMatchers.$ne.push(value);
              } else {
                fieldMatchers.$ne = [value];
              }
            }

            function mergeEq(value, fieldMatchers) {
              delete fieldMatchers.$gt;
              delete fieldMatchers.$gte;
              delete fieldMatchers.$lt;
              delete fieldMatchers.$lte;
              delete fieldMatchers.$ne;
              fieldMatchers.$eq = value;
            }

            function mergeAndedSelectors(selectors) {
              var res = {};

              selectors.forEach(function (selector) {
                Object.keys(selector).forEach(function (field) {
                  var matcher = selector[field];
                  if (typeof matcher !== 'object') {
                    matcher = { $eq: matcher };
                  }
                  var fieldMatchers = res[field] = res[field] || {};
                  Object.keys(matcher).forEach(function (operator) {
                    var value = matcher[operator];

                    if (operator === '$gt' || operator === '$gte') {
                      return mergeGtGte(operator, value, fieldMatchers);
                    } else if (operator === '$lt' || operator === '$lte') {
                      return mergeLtLte(operator, value, fieldMatchers);
                    } else if (operator === '$ne') {
                      return mergeNe(value, fieldMatchers);
                    } else if (operator === '$eq') {
                      return mergeEq(value, fieldMatchers);
                    }
                    fieldMatchers[operator] = value;
                  });
                });
              });

              return res;
            }

            function massageSelector(input) {
              var result = utils.clone(input);
              var wasAnded = false;
              if ('$and' in result) {
                result = mergeAndedSelectors(result['$and']);
                wasAnded = true;
              }
              var fields = Object.keys(result);

              for (var i = 0; i < fields.length; i++) {
                var field = fields[i];
                var matcher = result[field];

                if (typeof matcher !== 'object') {
                  matcher = { $eq: matcher };
                } else if ('$ne' in matcher && !wasAnded) {
                  matcher.$ne = [matcher.$ne];
                }
                result[field] = matcher;
              }

              return result;
            }

            function massageIndexDef(indexDef) {
              indexDef.fields = indexDef.fields.map(function (field) {
                if (typeof field === 'string') {
                  var obj = {};
                  obj[field] = 'asc';
                  return obj;
                }
                return field;
              });
              return indexDef;
            }

            function getKeyFromDoc(doc, index) {
              var res = [];
              for (var i = 0; i < index.def.fields.length; i++) {
                var field = getKey(index.def.fields[i]);
                res.push(doc[field]);
              }
              return res;
            }

            function filterInclusiveStart(rows, targetValue, index) {
              var indexFields = index.def.fields;
              for (var i = 0, len = rows.length; i < len; i++) {
                var row = rows[i];

                var docKey = getKeyFromDoc(row.doc, index);
                if (indexFields.length === 1) {
                  docKey = docKey[0];
                } else {
                    while (docKey.length > targetValue.length) {
                      docKey.pop();
                    }
                  }

                if (Math.abs(collate.collate(docKey, targetValue)) > 0) {
                  break;
                }
              }
              return i > 0 ? rows.slice(i) : rows;
            }

            function reverseOptions(opts) {
              var newOpts = utils.clone(opts);
              delete newOpts.startkey;
              delete newOpts.endkey;
              delete newOpts.inclusive_start;
              delete newOpts.inclusive_end;

              if ('endkey' in opts) {
                newOpts.startkey = opts.endkey;
              }
              if ('startkey' in opts) {
                newOpts.endkey = opts.startkey;
              }
              if ('inclusive_start' in opts) {
                newOpts.inclusive_end = opts.inclusive_start;
              }
              if ('inclusive_end' in opts) {
                newOpts.inclusive_start = opts.inclusive_end;
              }
              return newOpts;
            }

            function validateIndex(index) {
              var ascFields = index.fields.filter(function (field) {
                return getValue(field) === 'asc';
              });
              if (ascFields.length !== 0 && ascFields.length !== index.fields.length) {
                throw new Error('unsupported mixed sorting');
              }
            }

            function validateFindRequest(requestDef) {
              if (typeof requestDef.selector !== 'object') {
                throw new Error('you must provide a selector when you find()');
              }
              if ('sort' in requestDef && (!requestDef.sort || !Array.isArray(requestDef.sort))) {
                throw new Error('invalid sort json - should be an array');
              }

              var selectorFields = Object.keys(requestDef.selector);
              var sortFields = requestDef.sort ? massageSort(requestDef.sort).map(getKey) : [];

              if (!utils.oneSetIsSubArrayOfOther(selectorFields, sortFields)) {
                throw new Error('conflicting sort and selector fields');
              }

              var selectors = requestDef.selector['$and'] || [requestDef.selector];
              for (var i = 0; i < selectors.length; i++) {
                var selector = selectors[i];
                var keys = Object.keys(selector);
                if (keys.length === 0) {
                  throw new Error('invalid empty selector');
                }
              }
            }

            function parseField(fieldName) {
              var fields = [];
              var current = '';
              for (var i = 0, len = fieldName.length; i < len; i++) {
                var ch = fieldName[i];
                if (ch === '.') {
                  if (i > 0 && fieldName[i - 1] === '\\') {
                    current = current.substring(0, current.length - 1) + '.';
                  } else {
                    fields.push(current);
                    current = '';
                  }
                } else {
                  current += ch;
                }
              }
              if (current) {
                fields.push(current);
              }
              return fields;
            }

            function getUserFields(selector, sort) {
              var selectorFields = Object.keys(selector);
              var sortFields = sort ? sort.map(getKey) : [];
              var userFields;
              if (selectorFields.length > sortFields.length) {
                userFields = selectorFields;
              } else {
                userFields = sortFields;
              }

              if (sortFields.length === 0) {
                return {
                  fields: userFields
                };
              }

              userFields = userFields.sort(function (left, right) {
                var leftIdx = sortFields.indexOf(left);
                if (leftIdx === -1) {
                  leftIdx = Number.MAX_VALUE;
                }
                var rightIdx = sortFields.indexOf(right);
                if (rightIdx === -1) {
                  rightIdx = Number.MAX_VALUE;
                }
                return leftIdx < rightIdx ? -1 : leftIdx > rightIdx ? 1 : 0;
              });

              return {
                fields: userFields,
                sortOrder: sort.map(getKey)
              };
            }

            module.exports = {
              getKey: getKey,
              getValue: getValue,
              getSize: getSize,
              massageSort: massageSort,
              massageSelector: massageSelector,
              validateIndex: validateIndex,
              validateFindRequest: validateFindRequest,
              reverseOptions: reverseOptions,
              filterInclusiveStart: filterInclusiveStart,
              massageIndexDef: massageIndexDef,
              parseField: parseField,
              objectFrom: objectFrom,
              getUserFields: getUserFields
            };
          }, { "16": 16, "37": 37 }], 16: [function (_dereq_, module, exports) {
            (function (process, global, Buffer) {
              'use strict';

              var PouchPromise;

              if (typeof window !== 'undefined' && window.PouchDB) {
                PouchPromise = window.PouchDB.utils.Promise;
              } else {
                PouchPromise = typeof global.Promise === 'function' ? global.Promise : _dereq_(26);
              }

              exports.once = function (fun) {
                var called = false;
                return exports.getArguments(function (args) {
                  if (called) {
                    console.trace();
                    throw new Error('once called  more than once');
                  } else {
                    called = true;
                    fun.apply(this, args);
                  }
                });
              };

              exports.getArguments = function (fun) {
                return function () {
                  var len = arguments.length;
                  var args = new Array(len);
                  var i = -1;
                  while (++i < len) {
                    args[i] = arguments[i];
                  }
                  return fun.call(this, args);
                };
              };

              exports.toPromise = function (func) {
                return exports.getArguments(function (args) {
                  var self = this;
                  var tempCB = typeof args[args.length - 1] === 'function' ? args.pop() : false;

                  var usedCB;
                  if (tempCB) {
                    usedCB = function (err, resp) {
                      process.nextTick(function () {
                        tempCB(err, resp);
                      });
                    };
                  }
                  var promise = new PouchPromise(function (fulfill, reject) {
                    try {
                      var callback = exports.once(function (err, mesg) {
                        if (err) {
                          reject(err);
                        } else {
                          fulfill(mesg);
                        }
                      });

                      args.push(callback);
                      func.apply(self, args);
                    } catch (e) {
                      reject(e);
                    }
                  });

                  if (usedCB) {
                    promise.then(function (result) {
                      usedCB(null, result);
                    }, usedCB);
                  }
                  promise.cancel = function () {
                    return this;
                  };
                  return promise;
                });
              };

              exports.inherits = _dereq_(22);
              exports.Promise = PouchPromise;

              if (!process.browser || !('atob' in global)) {
                exports.atob = function (str) {
                  var base64 = new Buffer(str, 'base64');

                  if (base64.toString('base64') !== str) {
                    throw "Cannot base64 encode full string";
                  }
                  return base64.toString('binary');
                };
              } else {
                exports.atob = function (str) {
                  return atob(str);
                };
              }

              if (!process.browser || !('btoa' in global)) {
                exports.btoa = function (str) {
                  return new Buffer(str, 'binary').toString('base64');
                };
              } else {
                exports.btoa = function (str) {
                  return btoa(str);
                };
              }

              exports.clone = function (obj) {
                return exports.extend(true, {}, obj);
              };

              exports.extend = _dereq_(39);

              exports.callbackify = function (fun) {
                return exports.getArguments(function (args) {
                  var cb = args.pop();
                  var promise = fun.apply(this, args);
                  if (typeof cb === 'function') {
                    exports.promisedCallback(promise, cb);
                  }
                  return promise;
                });
              };

              exports.promisedCallback = function (promise, callback) {
                if (callback) {
                  promise.then(function (res) {
                    process.nextTick(function () {
                      callback(null, res);
                    });
                  }, function (reason) {
                    process.nextTick(function () {
                      callback(reason);
                    });
                  });
                }
                return promise;
              };

              var crypto = _dereq_(18);
              var Md5 = _dereq_(42);

              exports.MD5 = function (string) {
                if (!process.browser) {
                  return crypto.createHash('md5').update(string).digest('hex');
                } else {
                  return Md5.hash(string);
                }
              };

              exports.flatten = exports.getArguments(function (args) {
                var res = [];
                for (var i = 0, len = args.length; i < len; i++) {
                  var subArr = args[i];
                  if (Array.isArray(subArr)) {
                    res = res.concat(exports.flatten.apply(null, subArr));
                  } else {
                    res.push(subArr);
                  }
                }
                return res;
              });

              exports.mergeObjects = function (arr) {
                var res = {};
                for (var i = 0, len = arr.length; i < len; i++) {
                  res = exports.extend(true, res, arr[i]);
                }
                return res;
              };

              exports.pick = function (obj, arr) {
                var res = {};
                for (var i = 0, len = arr.length; i < len; i++) {
                  var prop = arr[i];
                  res[prop] = obj[prop];
                }
                return res;
              };

              exports.oneArrayIsSubArrayOfOther = function (left, right) {

                for (var i = 0, len = Math.min(left.length, right.length); i < len; i++) {
                  if (left[i] !== right[i]) {
                    return false;
                  }
                }
                return true;
              };

              exports.oneArrayIsStrictSubArrayOfOther = function (left, right) {

                if (left.length > right.length) {
                  return false;
                }

                return exports.oneArrayIsSubArrayOfOther(left, right);
              };

              exports.oneSetIsSubArrayOfOther = function (left, right) {
                left = left.slice();
                for (var i = 0, len = right.length; i < len; i++) {
                  var field = right[i];
                  if (!left.length) {
                    break;
                  }
                  var leftIdx = left.indexOf(field);
                  if (leftIdx === -1) {
                    return false;
                  } else {
                    left.splice(leftIdx, 1);
                  }
                }
                return true;
              };

              exports.compare = function (left, right) {
                return left < right ? -1 : left > right ? 1 : 0;
              };

              exports.arrayToObject = function (arr) {
                var res = {};
                for (var i = 0, len = arr.length; i < len; i++) {
                  res[arr[i]] = true;
                }
                return res;
              };

              exports.max = function (arr, fun) {
                var max = null;
                var maxScore = -1;
                for (var i = 0, len = arr.length; i < len; i++) {
                  var element = arr[i];
                  var score = fun(element);
                  if (score > maxScore) {
                    maxScore = score;
                    max = element;
                  }
                }
                return max;
              };

              exports.arrayEquals = function (arr1, arr2) {
                if (arr1.length !== arr2.length) {
                  return false;
                }
                for (var i = 0, len = arr1.length; i < len; i++) {
                  if (arr1[i] !== arr2[i]) {
                    return false;
                  }
                }
                return true;
              };

              exports.uniq = function (arr) {
                var obj = {};
                for (var i = 0; i < arr.length; i++) {
                  obj['$' + arr[i]] = true;
                }
                return Object.keys(obj).map(function (key) {
                  return key.substring(1);
                });
              };

              exports.log = _dereq_(19)('pouchdb:find');
            }).call(this, _dereq_(41), typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {}, _dereq_(18).Buffer);
          }, { "18": 18, "19": 19, "22": 22, "26": 26, "39": 39, "41": 41, "42": 42 }], 17: [function (_dereq_, module, exports) {
            'use strict';

            module.exports = argsArray;

            function argsArray(fun) {
              return function () {
                var len = arguments.length;
                if (len) {
                  var args = [];
                  var i = -1;
                  while (++i < len) {
                    args[i] = arguments[i];
                  }
                  return fun.call(this, args);
                } else {
                  return fun.call(this, []);
                }
              };
            }
          }, {}], 18: [function (_dereq_, module, exports) {}, {}], 19: [function (_dereq_, module, exports) {

            exports = module.exports = _dereq_(20);
            exports.log = log;
            exports.formatArgs = formatArgs;
            exports.save = save;
            exports.load = load;
            exports.useColors = useColors;
            exports.storage = 'undefined' != typeof chrome && 'undefined' != typeof chrome.storage ? chrome.storage.local : localstorage();

            exports.colors = ['lightseagreen', 'forestgreen', 'goldenrod', 'dodgerblue', 'darkorchid', 'crimson'];

            function useColors() {
              return 'WebkitAppearance' in document.documentElement.style || window.console && (console.firebug || console.exception && console.table) || navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31;
            }

            exports.formatters.j = function (v) {
              return JSON.stringify(v);
            };

            function formatArgs() {
              var args = arguments;
              var useColors = this.useColors;

              args[0] = (useColors ? '%c' : '') + this.namespace + (useColors ? ' %c' : ' ') + args[0] + (useColors ? '%c ' : ' ') + '+' + exports.humanize(this.diff);

              if (!useColors) return args;

              var c = 'color: ' + this.color;
              args = [args[0], c, 'color: inherit'].concat(Array.prototype.slice.call(args, 1));

              var index = 0;
              var lastC = 0;
              args[0].replace(/%[a-z%]/g, function (match) {
                if ('%%' === match) return;
                index++;
                if ('%c' === match) {
                  lastC = index;
                }
              });

              args.splice(lastC, 0, c);
              return args;
            }

            function log() {
              return 'object' === typeof console && console.log && Function.prototype.apply.call(console.log, console, arguments);
            }

            function save(namespaces) {
              try {
                if (null == namespaces) {
                  exports.storage.removeItem('debug');
                } else {
                  exports.storage.debug = namespaces;
                }
              } catch (e) {}
            }

            function load() {
              var r;
              try {
                r = exports.storage.debug;
              } catch (e) {}
              return r;
            }

            exports.enable(load());

            function localstorage() {
              try {
                return window.localStorage;
              } catch (e) {}
            }
          }, { "20": 20 }], 20: [function (_dereq_, module, exports) {

            exports = module.exports = debug;
            exports.coerce = coerce;
            exports.disable = disable;
            exports.enable = enable;
            exports.enabled = enabled;
            exports.humanize = _dereq_(36);

            exports.names = [];
            exports.skips = [];

            exports.formatters = {};

            var prevColor = 0;

            var prevTime;

            function selectColor() {
              return exports.colors[prevColor++ % exports.colors.length];
            }

            function debug(namespace) {
              function disabled() {}
              disabled.enabled = false;

              function enabled() {

                var self = enabled;

                var curr = +new Date();
                var ms = curr - (prevTime || curr);
                self.diff = ms;
                self.prev = prevTime;
                self.curr = curr;
                prevTime = curr;

                if (null == self.useColors) self.useColors = exports.useColors();
                if (null == self.color && self.useColors) self.color = selectColor();

                var args = Array.prototype.slice.call(arguments);

                args[0] = exports.coerce(args[0]);

                if ('string' !== typeof args[0]) {
                  args = ['%o'].concat(args);
                }

                var index = 0;
                args[0] = args[0].replace(/%([a-z%])/g, function (match, format) {
                  if (match === '%%') return match;
                  index++;
                  var formatter = exports.formatters[format];
                  if ('function' === typeof formatter) {
                    var val = args[index];
                    match = formatter.call(self, val);

                    args.splice(index, 1);
                    index--;
                  }
                  return match;
                });

                if ('function' === typeof exports.formatArgs) {
                  args = exports.formatArgs.apply(self, args);
                }
                var logFn = enabled.log || exports.log || console.log.bind(console);
                logFn.apply(self, args);
              }
              enabled.enabled = true;

              var fn = exports.enabled(namespace) ? enabled : disabled;

              fn.namespace = namespace;

              return fn;
            }

            function enable(namespaces) {
              exports.save(namespaces);

              var split = (namespaces || '').split(/[\s,]+/);
              var len = split.length;

              for (var i = 0; i < len; i++) {
                if (!split[i]) continue;
                namespaces = split[i].replace(/\*/g, '.*?');
                if (namespaces[0] === '-') {
                  exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
                } else {
                  exports.names.push(new RegExp('^' + namespaces + '$'));
                }
              }
            }

            function disable() {
              exports.enable('');
            }

            function enabled(name) {
              var i, len;
              for (i = 0, len = exports.skips.length; i < len; i++) {
                if (exports.skips[i].test(name)) {
                  return false;
                }
              }
              for (i = 0, len = exports.names.length; i < len; i++) {
                if (exports.names[i].test(name)) {
                  return true;
                }
              }
              return false;
            }

            function coerce(val) {
              if (val instanceof Error) return val.stack || val.message;
              return val;
            }
          }, { "36": 36 }], 21: [function (_dereq_, module, exports) {
            (function (global) {
              'use strict';
              var Mutation = global.MutationObserver || global.WebKitMutationObserver;

              var scheduleDrain;

              {
                if (Mutation) {
                  var called = 0;
                  var observer = new Mutation(nextTick);
                  var element = global.document.createTextNode('');
                  observer.observe(element, {
                    characterData: true
                  });
                  scheduleDrain = function () {
                    element.data = called = ++called % 2;
                  };
                } else if (!global.setImmediate && typeof global.MessageChannel !== 'undefined') {
                  var channel = new global.MessageChannel();
                  channel.port1.onmessage = nextTick;
                  scheduleDrain = function () {
                    channel.port2.postMessage(0);
                  };
                } else if ('document' in global && 'onreadystatechange' in global.document.createElement('script')) {
                  scheduleDrain = function () {
                    var scriptEl = global.document.createElement('script');
                    scriptEl.onreadystatechange = function () {
                      nextTick();

                      scriptEl.onreadystatechange = null;
                      scriptEl.parentNode.removeChild(scriptEl);
                      scriptEl = null;
                    };
                    global.document.documentElement.appendChild(scriptEl);
                  };
                } else {
                  scheduleDrain = function () {
                    setTimeout(nextTick, 0);
                  };
                }
              }

              var draining;
              var queue = [];

              function nextTick() {
                draining = true;
                var i, oldQueue;
                var len = queue.length;
                while (len) {
                  oldQueue = queue;
                  queue = [];
                  i = -1;
                  while (++i < len) {
                    oldQueue[i]();
                  }
                  len = queue.length;
                }
                draining = false;
              }

              module.exports = immediate;
              function immediate(task) {
                if (queue.push(task) === 1 && !draining) {
                  scheduleDrain();
                }
              }
            }).call(this, typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
          }, {}], 22: [function (_dereq_, module, exports) {
            if (typeof Object.create === 'function') {
              module.exports = function inherits(ctor, superCtor) {
                ctor.super_ = superCtor;
                ctor.prototype = Object.create(superCtor.prototype, {
                  constructor: {
                    value: ctor,
                    enumerable: false,
                    writable: true,
                    configurable: true
                  }
                });
              };
            } else {
              module.exports = function inherits(ctor, superCtor) {
                ctor.super_ = superCtor;
                var TempCtor = function TempCtor() {};
                TempCtor.prototype = superCtor.prototype;
                ctor.prototype = new TempCtor();
                ctor.prototype.constructor = ctor;
              };
            }
          }, {}], 23: [function (_dereq_, module, exports) {
            'use strict';

            module.exports = INTERNAL;

            function INTERNAL() {}
          }, {}], 24: [function (_dereq_, module, exports) {
            'use strict';
            var Promise = _dereq_(27);
            var reject = _dereq_(30);
            var resolve = _dereq_(31);
            var INTERNAL = _dereq_(23);
            var handlers = _dereq_(25);
            module.exports = all;
            function all(iterable) {
              if (Object.prototype.toString.call(iterable) !== '[object Array]') {
                return reject(new TypeError('must be an array'));
              }

              var len = iterable.length;
              var called = false;
              if (!len) {
                return resolve([]);
              }

              var values = new Array(len);
              var resolved = 0;
              var i = -1;
              var promise = new Promise(INTERNAL);

              while (++i < len) {
                allResolver(iterable[i], i);
              }
              return promise;
              function allResolver(value, i) {
                resolve(value).then(resolveFromAll, function (error) {
                  if (!called) {
                    called = true;
                    handlers.reject(promise, error);
                  }
                });
                function resolveFromAll(outValue) {
                  values[i] = outValue;
                  if (++resolved === len & !called) {
                    called = true;
                    handlers.resolve(promise, values);
                  }
                }
              }
            }
          }, { "23": 23, "25": 25, "27": 27, "30": 30, "31": 31 }], 25: [function (_dereq_, module, exports) {
            'use strict';
            var tryCatch = _dereq_(34);
            var resolveThenable = _dereq_(32);
            var states = _dereq_(33);

            exports.resolve = function (self, value) {
              var result = tryCatch(getThen, value);
              if (result.status === 'error') {
                return exports.reject(self, result.value);
              }
              var thenable = result.value;

              if (thenable) {
                resolveThenable.safely(self, thenable);
              } else {
                self.state = states.FULFILLED;
                self.outcome = value;
                var i = -1;
                var len = self.queue.length;
                while (++i < len) {
                  self.queue[i].callFulfilled(value);
                }
              }
              return self;
            };
            exports.reject = function (self, error) {
              self.state = states.REJECTED;
              self.outcome = error;
              var i = -1;
              var len = self.queue.length;
              while (++i < len) {
                self.queue[i].callRejected(error);
              }
              return self;
            };

            function getThen(obj) {
              var then = obj && obj.then;
              if (obj && typeof obj === 'object' && typeof then === 'function') {
                return function appyThen() {
                  then.apply(obj, arguments);
                };
              }
            }
          }, { "32": 32, "33": 33, "34": 34 }], 26: [function (_dereq_, module, exports) {
            module.exports = exports = _dereq_(27);

            exports.resolve = _dereq_(31);
            exports.reject = _dereq_(30);
            exports.all = _dereq_(24);
            exports.race = _dereq_(29);
          }, { "24": 24, "27": 27, "29": 29, "30": 30, "31": 31 }], 27: [function (_dereq_, module, exports) {
            'use strict';

            var unwrap = _dereq_(35);
            var INTERNAL = _dereq_(23);
            var resolveThenable = _dereq_(32);
            var states = _dereq_(33);
            var QueueItem = _dereq_(28);

            module.exports = Promise;
            function Promise(resolver) {
              if (!(this instanceof Promise)) {
                return new Promise(resolver);
              }
              if (typeof resolver !== 'function') {
                throw new TypeError('resolver must be a function');
              }
              this.state = states.PENDING;
              this.queue = [];
              this.outcome = void 0;
              if (resolver !== INTERNAL) {
                resolveThenable.safely(this, resolver);
              }
            }

            Promise.prototype['catch'] = function (onRejected) {
              return this.then(null, onRejected);
            };
            Promise.prototype.then = function (onFulfilled, onRejected) {
              if (typeof onFulfilled !== 'function' && this.state === states.FULFILLED || typeof onRejected !== 'function' && this.state === states.REJECTED) {
                return this;
              }
              var promise = new Promise(INTERNAL);
              if (this.state !== states.PENDING) {
                var resolver = this.state === states.FULFILLED ? onFulfilled : onRejected;
                unwrap(promise, resolver, this.outcome);
              } else {
                this.queue.push(new QueueItem(promise, onFulfilled, onRejected));
              }

              return promise;
            };
          }, { "23": 23, "28": 28, "32": 32, "33": 33, "35": 35 }], 28: [function (_dereq_, module, exports) {
            'use strict';
            var handlers = _dereq_(25);
            var unwrap = _dereq_(35);

            module.exports = QueueItem;
            function QueueItem(promise, onFulfilled, onRejected) {
              this.promise = promise;
              if (typeof onFulfilled === 'function') {
                this.onFulfilled = onFulfilled;
                this.callFulfilled = this.otherCallFulfilled;
              }
              if (typeof onRejected === 'function') {
                this.onRejected = onRejected;
                this.callRejected = this.otherCallRejected;
              }
            }
            QueueItem.prototype.callFulfilled = function (value) {
              handlers.resolve(this.promise, value);
            };
            QueueItem.prototype.otherCallFulfilled = function (value) {
              unwrap(this.promise, this.onFulfilled, value);
            };
            QueueItem.prototype.callRejected = function (value) {
              handlers.reject(this.promise, value);
            };
            QueueItem.prototype.otherCallRejected = function (value) {
              unwrap(this.promise, this.onRejected, value);
            };
          }, { "25": 25, "35": 35 }], 29: [function (_dereq_, module, exports) {
            'use strict';
            var Promise = _dereq_(27);
            var reject = _dereq_(30);
            var resolve = _dereq_(31);
            var INTERNAL = _dereq_(23);
            var handlers = _dereq_(25);
            module.exports = race;
            function race(iterable) {
              if (Object.prototype.toString.call(iterable) !== '[object Array]') {
                return reject(new TypeError('must be an array'));
              }

              var len = iterable.length;
              var called = false;
              if (!len) {
                return resolve([]);
              }

              var i = -1;
              var promise = new Promise(INTERNAL);

              while (++i < len) {
                resolver(iterable[i]);
              }
              return promise;
              function resolver(value) {
                resolve(value).then(function (response) {
                  if (!called) {
                    called = true;
                    handlers.resolve(promise, response);
                  }
                }, function (error) {
                  if (!called) {
                    called = true;
                    handlers.reject(promise, error);
                  }
                });
              }
            }
          }, { "23": 23, "25": 25, "27": 27, "30": 30, "31": 31 }], 30: [function (_dereq_, module, exports) {
            'use strict';

            var Promise = _dereq_(27);
            var INTERNAL = _dereq_(23);
            var handlers = _dereq_(25);
            module.exports = reject;

            function reject(reason) {
              var promise = new Promise(INTERNAL);
              return handlers.reject(promise, reason);
            }
          }, { "23": 23, "25": 25, "27": 27 }], 31: [function (_dereq_, module, exports) {
            'use strict';

            var Promise = _dereq_(27);
            var INTERNAL = _dereq_(23);
            var handlers = _dereq_(25);
            module.exports = resolve;

            var FALSE = handlers.resolve(new Promise(INTERNAL), false);
            var NULL = handlers.resolve(new Promise(INTERNAL), null);
            var UNDEFINED = handlers.resolve(new Promise(INTERNAL), void 0);
            var ZERO = handlers.resolve(new Promise(INTERNAL), 0);
            var EMPTYSTRING = handlers.resolve(new Promise(INTERNAL), '');

            function resolve(value) {
              if (value) {
                if (value instanceof Promise) {
                  return value;
                }
                return handlers.resolve(new Promise(INTERNAL), value);
              }
              var valueType = typeof value;
              switch (valueType) {
                case 'boolean':
                  return FALSE;
                case 'undefined':
                  return UNDEFINED;
                case 'object':
                  return NULL;
                case 'number':
                  return ZERO;
                case 'string':
                  return EMPTYSTRING;
              }
            }
          }, { "23": 23, "25": 25, "27": 27 }], 32: [function (_dereq_, module, exports) {
            'use strict';
            var handlers = _dereq_(25);
            var tryCatch = _dereq_(34);
            function safelyResolveThenable(self, thenable) {
              var called = false;
              function onError(value) {
                if (called) {
                  return;
                }
                called = true;
                handlers.reject(self, value);
              }

              function onSuccess(value) {
                if (called) {
                  return;
                }
                called = true;
                handlers.resolve(self, value);
              }

              function tryToUnwrap() {
                thenable(onSuccess, onError);
              }

              var result = tryCatch(tryToUnwrap);
              if (result.status === 'error') {
                onError(result.value);
              }
            }
            exports.safely = safelyResolveThenable;
          }, { "25": 25, "34": 34 }], 33: [function (_dereq_, module, exports) {

            exports.REJECTED = ['REJECTED'];
            exports.FULFILLED = ['FULFILLED'];
            exports.PENDING = ['PENDING'];
          }, {}], 34: [function (_dereq_, module, exports) {
            'use strict';

            module.exports = tryCatch;

            function tryCatch(func, value) {
              var out = {};
              try {
                out.value = func(value);
                out.status = 'success';
              } catch (e) {
                out.status = 'error';
                out.value = e;
              }
              return out;
            }
          }, {}], 35: [function (_dereq_, module, exports) {
            'use strict';

            var immediate = _dereq_(21);
            var handlers = _dereq_(25);
            module.exports = unwrap;

            function unwrap(promise, func, value) {
              immediate(function () {
                var returnValue;
                try {
                  returnValue = func(value);
                } catch (e) {
                  return handlers.reject(promise, e);
                }
                if (returnValue === promise) {
                  handlers.reject(promise, new TypeError('Cannot resolve promise with itself'));
                } else {
                  handlers.resolve(promise, returnValue);
                }
              });
            }
          }, { "21": 21, "25": 25 }], 36: [function (_dereq_, module, exports) {

            var s = 1000;
            var m = s * 60;
            var h = m * 60;
            var d = h * 24;
            var y = d * 365.25;

            module.exports = function (val, options) {
              options = options || {};
              if ('string' == typeof val) return parse(val);
              return options["long"] ? long(val) : short(val);
            };

            function parse(str) {
              str = '' + str;
              if (str.length > 10000) return;
              var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str);
              if (!match) return;
              var n = parseFloat(match[1]);
              var type = (match[2] || 'ms').toLowerCase();
              switch (type) {
                case 'years':
                case 'year':
                case 'yrs':
                case 'yr':
                case 'y':
                  return n * y;
                case 'days':
                case 'day':
                case 'd':
                  return n * d;
                case 'hours':
                case 'hour':
                case 'hrs':
                case 'hr':
                case 'h':
                  return n * h;
                case 'minutes':
                case 'minute':
                case 'mins':
                case 'min':
                case 'm':
                  return n * m;
                case 'seconds':
                case 'second':
                case 'secs':
                case 'sec':
                case 's':
                  return n * s;
                case 'milliseconds':
                case 'millisecond':
                case 'msecs':
                case 'msec':
                case 'ms':
                  return n;
              }
            }

            function short(ms) {
              if (ms >= d) return Math.round(ms / d) + 'd';
              if (ms >= h) return Math.round(ms / h) + 'h';
              if (ms >= m) return Math.round(ms / m) + 'm';
              if (ms >= s) return Math.round(ms / s) + 's';
              return ms + 'ms';
            }

            function long(ms) {
              return plural(ms, d, 'day') || plural(ms, h, 'hour') || plural(ms, m, 'minute') || plural(ms, s, 'second') || ms + ' ms';
            }

            function plural(ms, n, name) {
              if (ms < n) return;
              if (ms < n * 1.5) return Math.floor(ms / n) + ' ' + name;
              return Math.ceil(ms / n) + ' ' + name + 's';
            }
          }, {}], 37: [function (_dereq_, module, exports) {
            'use strict';

            var MIN_MAGNITUDE = -324;
            var MAGNITUDE_DIGITS = 3;
            var SEP = '';

            var utils = _dereq_(38);

            exports.collate = function (a, b) {

              if (a === b) {
                return 0;
              }

              a = exports.normalizeKey(a);
              b = exports.normalizeKey(b);

              var ai = collationIndex(a);
              var bi = collationIndex(b);
              if (ai - bi !== 0) {
                return ai - bi;
              }
              if (a === null) {
                return 0;
              }
              switch (typeof a) {
                case 'number':
                  return a - b;
                case 'boolean':
                  return a === b ? 0 : a < b ? -1 : 1;
                case 'string':
                  return stringCollate(a, b);
              }
              return Array.isArray(a) ? arrayCollate(a, b) : objectCollate(a, b);
            };

            exports.normalizeKey = function (key) {
              switch (typeof key) {
                case 'undefined':
                  return null;
                case 'number':
                  if (key === Infinity || key === -Infinity || isNaN(key)) {
                    return null;
                  }
                  return key;
                case 'object':
                  var origKey = key;
                  if (Array.isArray(key)) {
                    var len = key.length;
                    key = new Array(len);
                    for (var i = 0; i < len; i++) {
                      key[i] = exports.normalizeKey(origKey[i]);
                    }
                  } else if (key instanceof Date) {
                    return key.toJSON();
                  } else if (key !== null) {
                    key = {};
                    for (var k in origKey) {
                      if (origKey.hasOwnProperty(k)) {
                        var val = origKey[k];
                        if (typeof val !== 'undefined') {
                          key[k] = exports.normalizeKey(val);
                        }
                      }
                    }
                  }
              }
              return key;
            };

            function indexify(key) {
              if (key !== null) {
                switch (typeof key) {
                  case 'boolean':
                    return key ? 1 : 0;
                  case 'number':
                    return numToIndexableString(key);
                  case 'string':
                    return key.replace(/\u0002/g, "\u0002\u0002").replace(/\u0001/g, "\u0001\u0002").replace(/\u0000/g, "\u0001\u0001");
                  case 'object':
                    var isArray = Array.isArray(key);
                    var arr = isArray ? key : Object.keys(key);
                    var i = -1;
                    var len = arr.length;
                    var result = '';
                    if (isArray) {
                      while (++i < len) {
                        result += exports.toIndexableString(arr[i]);
                      }
                    } else {
                      while (++i < len) {
                        var objKey = arr[i];
                        result += exports.toIndexableString(objKey) + exports.toIndexableString(key[objKey]);
                      }
                    }
                    return result;
                }
              }
              return '';
            }

            exports.toIndexableString = function (key) {
              var zero = "\u0000";
              key = exports.normalizeKey(key);
              return collationIndex(key) + SEP + indexify(key) + zero;
            };

            function parseNumber(str, i) {
              var originalIdx = i;
              var num;
              var zero = str[i] === '1';
              if (zero) {
                num = 0;
                i++;
              } else {
                var neg = str[i] === '0';
                i++;
                var numAsString = '';
                var magAsString = str.substring(i, i + MAGNITUDE_DIGITS);
                var magnitude = parseInt(magAsString, 10) + MIN_MAGNITUDE;
                if (neg) {
                  magnitude = -magnitude;
                }
                i += MAGNITUDE_DIGITS;
                while (true) {
                  var ch = str[i];
                  if (ch === "\u0000") {
                    break;
                  } else {
                    numAsString += ch;
                  }
                  i++;
                }
                numAsString = numAsString.split('.');
                if (numAsString.length === 1) {
                  num = parseInt(numAsString, 10);
                } else {
                  num = parseFloat(numAsString[0] + '.' + numAsString[1]);
                }
                if (neg) {
                  num = num - 10;
                }
                if (magnitude !== 0) {
                  num = parseFloat(num + 'e' + magnitude);
                }
              }
              return { num: num, length: i - originalIdx };
            }

            function pop(stack, metaStack) {
              var obj = stack.pop();

              if (metaStack.length) {
                var lastMetaElement = metaStack[metaStack.length - 1];
                if (obj === lastMetaElement.element) {
                  metaStack.pop();
                  lastMetaElement = metaStack[metaStack.length - 1];
                }
                var element = lastMetaElement.element;
                var lastElementIndex = lastMetaElement.index;
                if (Array.isArray(element)) {
                  element.push(obj);
                } else if (lastElementIndex === stack.length - 2) {
                  var key = stack.pop();
                  element[key] = obj;
                } else {
                  stack.push(obj);
                }
              }
            }

            exports.parseIndexableString = function (str) {
              var stack = [];
              var metaStack = [];
              var i = 0;

              while (true) {
                var collationIndex = str[i++];
                if (collationIndex === "\u0000") {
                  if (stack.length === 1) {
                    return stack.pop();
                  } else {
                    pop(stack, metaStack);
                    continue;
                  }
                }
                switch (collationIndex) {
                  case '1':
                    stack.push(null);
                    break;
                  case '2':
                    stack.push(str[i] === '1');
                    i++;
                    break;
                  case '3':
                    var parsedNum = parseNumber(str, i);
                    stack.push(parsedNum.num);
                    i += parsedNum.length;
                    break;
                  case '4':
                    var parsedStr = '';
                    while (true) {
                      var ch = str[i];
                      if (ch === "\u0000") {
                        break;
                      }
                      parsedStr += ch;
                      i++;
                    }

                    parsedStr = parsedStr.replace(/\u0001\u0001/g, "\u0000").replace(/\u0001\u0002/g, "\u0001").replace(/\u0002\u0002/g, "\u0002");
                    stack.push(parsedStr);
                    break;
                  case '5':
                    var arrayElement = { element: [], index: stack.length };
                    stack.push(arrayElement.element);
                    metaStack.push(arrayElement);
                    break;
                  case '6':
                    var objElement = { element: {}, index: stack.length };
                    stack.push(objElement.element);
                    metaStack.push(objElement);
                    break;
                  default:
                    throw new Error('bad collationIndex or unexpectedly reached end of input: ' + collationIndex);
                }
              }
            };

            function arrayCollate(a, b) {
              var len = Math.min(a.length, b.length);
              for (var i = 0; i < len; i++) {
                var sort = exports.collate(a[i], b[i]);
                if (sort !== 0) {
                  return sort;
                }
              }
              return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
            }
            function stringCollate(a, b) {
              return a === b ? 0 : a > b ? 1 : -1;
            }
            function objectCollate(a, b) {
              var ak = Object.keys(a),
                  bk = Object.keys(b);
              var len = Math.min(ak.length, bk.length);
              for (var i = 0; i < len; i++) {
                var sort = exports.collate(ak[i], bk[i]);
                if (sort !== 0) {
                  return sort;
                }

                sort = exports.collate(a[ak[i]], b[bk[i]]);
                if (sort !== 0) {
                  return sort;
                }
              }
              return ak.length === bk.length ? 0 : ak.length > bk.length ? 1 : -1;
            }

            function collationIndex(x) {
              var id = ['boolean', 'number', 'string', 'object'];
              var idx = id.indexOf(typeof x);

              if (~idx) {
                if (x === null) {
                  return 1;
                }
                if (Array.isArray(x)) {
                  return 5;
                }
                return idx < 3 ? idx + 2 : idx + 3;
              }
              if (Array.isArray(x)) {
                return 5;
              }
            }

            function numToIndexableString(num) {

              if (num === 0) {
                return '1';
              }

              var expFormat = num.toExponential().split(/e\+?/);
              var magnitude = parseInt(expFormat[1], 10);

              var neg = num < 0;

              var result = neg ? '0' : '2';

              var magForComparison = (neg ? -magnitude : magnitude) - MIN_MAGNITUDE;
              var magString = utils.padLeft(magForComparison.toString(), '0', MAGNITUDE_DIGITS);

              result += SEP + magString;

              var factor = Math.abs(parseFloat(expFormat[0]));
              if (neg) {
                factor = 10 - factor;
              }

              var factorStr = factor.toFixed(20);

              factorStr = factorStr.replace(/\.?0+$/, '');

              result += SEP + factorStr;

              return result;
            }
          }, { "38": 38 }], 38: [function (_dereq_, module, exports) {
            'use strict';

            function pad(str, padWith, upToLength) {
              var padding = '';
              var targetLength = upToLength - str.length;
              while (padding.length < targetLength) {
                padding += padWith;
              }
              return padding;
            }

            exports.padLeft = function (str, padWith, upToLength) {
              var padding = pad(str, padWith, upToLength);
              return padding + str;
            };

            exports.padRight = function (str, padWith, upToLength) {
              var padding = pad(str, padWith, upToLength);
              return str + padding;
            };

            exports.stringLexCompare = function (a, b) {

              var aLen = a.length;
              var bLen = b.length;

              var i;
              for (i = 0; i < aLen; i++) {
                if (i === bLen) {
                  return 1;
                }
                var aChar = a.charAt(i);
                var bChar = b.charAt(i);
                if (aChar !== bChar) {
                  return aChar < bChar ? -1 : 1;
                }
              }

              if (aLen < bLen) {
                return -1;
              }

              return 0;
            };

            exports.intToDecimalForm = function (int) {

              var isNeg = int < 0;
              var result = '';

              do {
                var remainder = isNeg ? -Math.ceil(int % 10) : Math.floor(int % 10);

                result = remainder + result;
                int = isNeg ? Math.ceil(int / 10) : Math.floor(int / 10);
              } while (int);

              if (isNeg && result !== '0') {
                result = '-' + result;
              }

              return result;
            };
          }, {}], 39: [function (_dereq_, module, exports) {
            "use strict";

            var class2type = {};

            var types = ["Boolean", "Number", "String", "Function", "Array", "Date", "RegExp", "Object", "Error"];
            for (var i = 0; i < types.length; i++) {
              var typename = types[i];
              class2type["[object " + typename + "]"] = typename.toLowerCase();
            }

            var core_toString = class2type.toString;
            var core_hasOwn = class2type.hasOwnProperty;

            function type(obj) {
              if (obj === null) {
                return String(obj);
              }
              return typeof obj === "object" || typeof obj === "function" ? class2type[core_toString.call(obj)] || "object" : typeof obj;
            }

            function isWindow(obj) {
              return obj !== null && obj === obj.window;
            }

            function isPlainObject(obj) {
              if (!obj || type(obj) !== "object" || obj.nodeType || isWindow(obj)) {
                return false;
              }

              try {
                if (obj.constructor && !core_hasOwn.call(obj, "constructor") && !core_hasOwn.call(obj.constructor.prototype, "isPrototypeOf")) {
                  return false;
                }
              } catch (e) {
                return false;
              }

              var key;
              for (key in obj) {}

              return key === undefined || core_hasOwn.call(obj, key);
            }

            function isFunction(obj) {
              return type(obj) === "function";
            }

            var isArray = Array.isArray || function (obj) {
              return type(obj) === "array";
            };

            function extend() {
              var stack = [];
              var i = -1;
              var len = arguments.length;
              var args = new Array(len);
              while (++i < len) {
                args[i] = arguments[i];
              }
              var container = {};
              stack.push({ args: args, result: { container: container, key: 'key' } });
              var next;
              while (next = stack.pop()) {
                extendInner(stack, next.args, next.result);
              }
              return container.key;
            }

            function extendInner(stack, args, result) {
              var options,
                  name,
                  src,
                  copy,
                  copyIsArray,
                  clone,
                  target = args[0] || {},
                  i = 1,
                  length = args.length,
                  deep = false,
                  numericStringRegex = /\d+/,
                  optionsIsArray;

              if (typeof target === "boolean") {
                deep = target;
                target = args[1] || {};

                i = 2;
              }

              if (typeof target !== "object" && !isFunction(target)) {
                target = {};
              }

              if (length === i) {
                target = this;
                --i;
              }

              for (; i < length; i++) {
                if ((options = args[i]) != null) {
                  optionsIsArray = isArray(options);

                  for (name in options) {
                    if (!(name in Object.prototype)) {
                      if (optionsIsArray && !numericStringRegex.test(name)) {
                        continue;
                      }

                      src = target[name];
                      copy = options[name];

                      if (target === copy) {
                        continue;
                      }

                      if (deep && copy && (isPlainObject(copy) || (copyIsArray = isArray(copy)))) {
                        if (copyIsArray) {
                          copyIsArray = false;
                          clone = src && isArray(src) ? src : [];
                        } else {
                          clone = src && isPlainObject(src) ? src : {};
                        }

                        stack.push({
                          args: [deep, clone, copy],
                          result: {
                            container: target,
                            key: name
                          }
                        });
                      } else if (copy !== undefined) {
                          if (!(isArray(options) && isFunction(copy))) {
                            target[name] = copy;
                          }
                        }
                    }
                  }
                }
              }

              result.container[result.key] = target;
            }

            module.exports = extend;
          }, {}], 40: [function (_dereq_, module, exports) {
            (function (global) {
              'use strict';

              var PouchPromise;

              if (typeof window !== 'undefined' && window.PouchDB) {
                PouchPromise = window.PouchDB.utils.Promise;
              } else {
                PouchPromise = typeof global.Promise === 'function' ? global.Promise : _dereq_(26);
              }

              function upsertInner(db, docId, diffFun) {
                return new PouchPromise(function (fulfill, reject) {
                  if (typeof docId !== 'string') {
                    return reject(new Error('doc id is required'));
                  }

                  db.get(docId, function (err, doc) {
                    if (err) {
                      if (err.status !== 404) {
                        return reject(err);
                      }
                      doc = {};
                    }

                    var docRev = doc._rev;
                    var newDoc = diffFun(doc);

                    if (!newDoc) {
                      return fulfill({ updated: false, rev: docRev });
                    }

                    newDoc._id = docId;
                    newDoc._rev = docRev;
                    fulfill(tryAndPut(db, newDoc, diffFun));
                  });
                });
              }

              function tryAndPut(db, doc, diffFun) {
                return db.put(doc).then(function (res) {
                  return {
                    updated: true,
                    rev: res.rev
                  };
                }, function (err) {
                  if (err.status !== 409) {
                    throw err;
                  }
                  return upsertInner(db, doc._id, diffFun);
                });
              }

              exports.upsert = function upsert(docId, diffFun, cb) {
                var db = this;
                var promise = upsertInner(db, docId, diffFun);
                if (typeof cb !== 'function') {
                  return promise;
                }
                promise.then(function (resp) {
                  cb(null, resp);
                }, cb);
              };

              exports.putIfNotExists = function putIfNotExists(docId, doc, cb) {
                var db = this;

                if (typeof docId !== 'string') {
                  cb = doc;
                  doc = docId;
                  docId = doc._id;
                }

                var diffFun = function diffFun(existingDoc) {
                  if (existingDoc._rev) {
                    return false;
                  }
                  return doc;
                };

                var promise = upsertInner(db, docId, diffFun);
                if (typeof cb !== 'function') {
                  return promise;
                }
                promise.then(function (resp) {
                  cb(null, resp);
                }, cb);
              };

              if (typeof window !== 'undefined' && window.PouchDB) {
                window.PouchDB.plugin(exports);
              }
            }).call(this, typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
          }, { "26": 26 }], 41: [function (_dereq_, module, exports) {

            var process = module.exports = {};
            var queue = [];
            var draining = false;

            function drainQueue() {
              if (draining) {
                return;
              }
              draining = true;
              var currentQueue;
              var len = queue.length;
              while (len) {
                currentQueue = queue;
                queue = [];
                var i = -1;
                while (++i < len) {
                  currentQueue[i]();
                }
                len = queue.length;
              }
              draining = false;
            }
            process.nextTick = function (fun) {
              queue.push(fun);
              if (!draining) {
                setTimeout(drainQueue, 0);
              }
            };

            process.title = 'browser';
            process.browser = true;
            process.env = {};
            process.argv = [];
            process.version = '';
            process.versions = {};

            function noop() {}

            process.on = noop;
            process.addListener = noop;
            process.once = noop;
            process.off = noop;
            process.removeListener = noop;
            process.removeAllListeners = noop;
            process.emit = noop;

            process.binding = function (name) {
              throw new Error('process.binding is not supported');
            };

            process.cwd = function () {
              return '/';
            };
            process.chdir = function (dir) {
              throw new Error('process.chdir is not supported');
            };
            process.umask = function () {
              return 0;
            };
          }, {}], 42: [function (_dereq_, module, exports) {

            (function (factory) {
              if (typeof exports === 'object') {
                module.exports = factory();
              } else if (typeof define === 'function' && define.amd) {
                define(factory);
              } else {
                var glob;
                try {
                  glob = window;
                } catch (e) {
                  glob = self;
                }

                glob.SparkMD5 = factory();
              }
            })(function (undefined) {

              'use strict';

              var add32 = function add32(a, b) {
                return a + b & 0xFFFFFFFF;
              },
                  cmn = function cmn(q, a, b, x, s, t) {
                a = add32(add32(a, q), add32(x, t));
                return add32(a << s | a >>> 32 - s, b);
              },
                  ff = function ff(a, b, c, d, x, s, t) {
                return cmn(b & c | ~b & d, a, b, x, s, t);
              },
                  gg = function gg(a, b, c, d, x, s, t) {
                return cmn(b & d | c & ~d, a, b, x, s, t);
              },
                  hh = function hh(a, b, c, d, x, s, t) {
                return cmn(b ^ c ^ d, a, b, x, s, t);
              },
                  ii = function ii(a, b, c, d, x, s, t) {
                return cmn(c ^ (b | ~d), a, b, x, s, t);
              },
                  md5cycle = function md5cycle(x, k) {
                var a = x[0],
                    b = x[1],
                    c = x[2],
                    d = x[3];

                a = ff(a, b, c, d, k[0], 7, -680876936);
                d = ff(d, a, b, c, k[1], 12, -389564586);
                c = ff(c, d, a, b, k[2], 17, 606105819);
                b = ff(b, c, d, a, k[3], 22, -1044525330);
                a = ff(a, b, c, d, k[4], 7, -176418897);
                d = ff(d, a, b, c, k[5], 12, 1200080426);
                c = ff(c, d, a, b, k[6], 17, -1473231341);
                b = ff(b, c, d, a, k[7], 22, -45705983);
                a = ff(a, b, c, d, k[8], 7, 1770035416);
                d = ff(d, a, b, c, k[9], 12, -1958414417);
                c = ff(c, d, a, b, k[10], 17, -42063);
                b = ff(b, c, d, a, k[11], 22, -1990404162);
                a = ff(a, b, c, d, k[12], 7, 1804603682);
                d = ff(d, a, b, c, k[13], 12, -40341101);
                c = ff(c, d, a, b, k[14], 17, -1502002290);
                b = ff(b, c, d, a, k[15], 22, 1236535329);

                a = gg(a, b, c, d, k[1], 5, -165796510);
                d = gg(d, a, b, c, k[6], 9, -1069501632);
                c = gg(c, d, a, b, k[11], 14, 643717713);
                b = gg(b, c, d, a, k[0], 20, -373897302);
                a = gg(a, b, c, d, k[5], 5, -701558691);
                d = gg(d, a, b, c, k[10], 9, 38016083);
                c = gg(c, d, a, b, k[15], 14, -660478335);
                b = gg(b, c, d, a, k[4], 20, -405537848);
                a = gg(a, b, c, d, k[9], 5, 568446438);
                d = gg(d, a, b, c, k[14], 9, -1019803690);
                c = gg(c, d, a, b, k[3], 14, -187363961);
                b = gg(b, c, d, a, k[8], 20, 1163531501);
                a = gg(a, b, c, d, k[13], 5, -1444681467);
                d = gg(d, a, b, c, k[2], 9, -51403784);
                c = gg(c, d, a, b, k[7], 14, 1735328473);
                b = gg(b, c, d, a, k[12], 20, -1926607734);

                a = hh(a, b, c, d, k[5], 4, -378558);
                d = hh(d, a, b, c, k[8], 11, -2022574463);
                c = hh(c, d, a, b, k[11], 16, 1839030562);
                b = hh(b, c, d, a, k[14], 23, -35309556);
                a = hh(a, b, c, d, k[1], 4, -1530992060);
                d = hh(d, a, b, c, k[4], 11, 1272893353);
                c = hh(c, d, a, b, k[7], 16, -155497632);
                b = hh(b, c, d, a, k[10], 23, -1094730640);
                a = hh(a, b, c, d, k[13], 4, 681279174);
                d = hh(d, a, b, c, k[0], 11, -358537222);
                c = hh(c, d, a, b, k[3], 16, -722521979);
                b = hh(b, c, d, a, k[6], 23, 76029189);
                a = hh(a, b, c, d, k[9], 4, -640364487);
                d = hh(d, a, b, c, k[12], 11, -421815835);
                c = hh(c, d, a, b, k[15], 16, 530742520);
                b = hh(b, c, d, a, k[2], 23, -995338651);

                a = ii(a, b, c, d, k[0], 6, -198630844);
                d = ii(d, a, b, c, k[7], 10, 1126891415);
                c = ii(c, d, a, b, k[14], 15, -1416354905);
                b = ii(b, c, d, a, k[5], 21, -57434055);
                a = ii(a, b, c, d, k[12], 6, 1700485571);
                d = ii(d, a, b, c, k[3], 10, -1894986606);
                c = ii(c, d, a, b, k[10], 15, -1051523);
                b = ii(b, c, d, a, k[1], 21, -2054922799);
                a = ii(a, b, c, d, k[8], 6, 1873313359);
                d = ii(d, a, b, c, k[15], 10, -30611744);
                c = ii(c, d, a, b, k[6], 15, -1560198380);
                b = ii(b, c, d, a, k[13], 21, 1309151649);
                a = ii(a, b, c, d, k[4], 6, -145523070);
                d = ii(d, a, b, c, k[11], 10, -1120210379);
                c = ii(c, d, a, b, k[2], 15, 718787259);
                b = ii(b, c, d, a, k[9], 21, -343485551);

                x[0] = add32(a, x[0]);
                x[1] = add32(b, x[1]);
                x[2] = add32(c, x[2]);
                x[3] = add32(d, x[3]);
              },
                  md5blk = function md5blk(s) {
                var md5blks = [],
                    i;

                for (i = 0; i < 64; i += 4) {
                  md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
                }
                return md5blks;
              },
                  md5blk_array = function md5blk_array(a) {
                var md5blks = [],
                    i;

                for (i = 0; i < 64; i += 4) {
                  md5blks[i >> 2] = a[i] + (a[i + 1] << 8) + (a[i + 2] << 16) + (a[i + 3] << 24);
                }
                return md5blks;
              },
                  md51 = function md51(s) {
                var n = s.length,
                    state = [1732584193, -271733879, -1732584194, 271733878],
                    i,
                    length,
                    tail,
                    tmp,
                    lo,
                    hi;

                for (i = 64; i <= n; i += 64) {
                  md5cycle(state, md5blk(s.substring(i - 64, i)));
                }
                s = s.substring(i - 64);
                length = s.length;
                tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                for (i = 0; i < length; i += 1) {
                  tail[i >> 2] |= s.charCodeAt(i) << (i % 4 << 3);
                }
                tail[i >> 2] |= 0x80 << (i % 4 << 3);
                if (i > 55) {
                  md5cycle(state, tail);
                  for (i = 0; i < 16; i += 1) {
                    tail[i] = 0;
                  }
                }

                tmp = n * 8;
                tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
                lo = parseInt(tmp[2], 16);
                hi = parseInt(tmp[1], 16) || 0;

                tail[14] = lo;
                tail[15] = hi;

                md5cycle(state, tail);
                return state;
              },
                  md51_array = function md51_array(a) {
                var n = a.length,
                    state = [1732584193, -271733879, -1732584194, 271733878],
                    i,
                    length,
                    tail,
                    tmp,
                    lo,
                    hi;

                for (i = 64; i <= n; i += 64) {
                  md5cycle(state, md5blk_array(a.subarray(i - 64, i)));
                }

                a = i - 64 < n ? a.subarray(i - 64) : new Uint8Array(0);

                length = a.length;
                tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                for (i = 0; i < length; i += 1) {
                  tail[i >> 2] |= a[i] << (i % 4 << 3);
                }

                tail[i >> 2] |= 0x80 << (i % 4 << 3);
                if (i > 55) {
                  md5cycle(state, tail);
                  for (i = 0; i < 16; i += 1) {
                    tail[i] = 0;
                  }
                }

                tmp = n * 8;
                tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
                lo = parseInt(tmp[2], 16);
                hi = parseInt(tmp[1], 16) || 0;

                tail[14] = lo;
                tail[15] = hi;

                md5cycle(state, tail);

                return state;
              },
                  hex_chr = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'],
                  rhex = function rhex(n) {
                var s = '',
                    j;
                for (j = 0; j < 4; j += 1) {
                  s += hex_chr[n >> j * 8 + 4 & 0x0F] + hex_chr[n >> j * 8 & 0x0F];
                }
                return s;
              },
                  hex = function hex(x) {
                var i;
                for (i = 0; i < x.length; i += 1) {
                  x[i] = rhex(x[i]);
                }
                return x.join('');
              },
                  md5 = function md5(s) {
                return hex(md51(s));
              },
                  SparkMD5 = function SparkMD5() {
                this.reset();
              };

              if (md5('hello') !== '5d41402abc4b2a76b9719d911017c592') {
                add32 = function (x, y) {
                  var lsw = (x & 0xFFFF) + (y & 0xFFFF),
                      msw = (x >> 16) + (y >> 16) + (lsw >> 16);
                  return msw << 16 | lsw & 0xFFFF;
                };
              }

              SparkMD5.prototype.append = function (str) {
                if (/[\u0080-\uFFFF]/.test(str)) {
                  str = unescape(encodeURIComponent(str));
                }

                this.appendBinary(str);

                return this;
              };

              SparkMD5.prototype.appendBinary = function (contents) {
                this._buff += contents;
                this._length += contents.length;

                var length = this._buff.length,
                    i;

                for (i = 64; i <= length; i += 64) {
                  md5cycle(this._state, md5blk(this._buff.substring(i - 64, i)));
                }

                this._buff = this._buff.substr(i - 64);

                return this;
              };

              SparkMD5.prototype.end = function (raw) {
                var buff = this._buff,
                    length = buff.length,
                    i,
                    tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                    ret;

                for (i = 0; i < length; i += 1) {
                  tail[i >> 2] |= buff.charCodeAt(i) << (i % 4 << 3);
                }

                this._finish(tail, length);
                ret = !!raw ? this._state : hex(this._state);

                this.reset();

                return ret;
              };

              SparkMD5.prototype._finish = function (tail, length) {
                var i = length,
                    tmp,
                    lo,
                    hi;

                tail[i >> 2] |= 0x80 << (i % 4 << 3);
                if (i > 55) {
                  md5cycle(this._state, tail);
                  for (i = 0; i < 16; i += 1) {
                    tail[i] = 0;
                  }
                }

                tmp = this._length * 8;
                tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
                lo = parseInt(tmp[2], 16);
                hi = parseInt(tmp[1], 16) || 0;

                tail[14] = lo;
                tail[15] = hi;
                md5cycle(this._state, tail);
              };

              SparkMD5.prototype.reset = function () {
                this._buff = "";
                this._length = 0;
                this._state = [1732584193, -271733879, -1732584194, 271733878];

                return this;
              };

              SparkMD5.prototype.destroy = function () {
                delete this._state;
                delete this._buff;
                delete this._length;
              };

              SparkMD5.hash = function (str, raw) {
                if (/[\u0080-\uFFFF]/.test(str)) {
                  str = unescape(encodeURIComponent(str));
                }

                var hash = md51(str);

                return !!raw ? hash : hex(hash);
              };

              SparkMD5.hashBinary = function (content, raw) {
                var hash = md51(content);

                return !!raw ? hash : hex(hash);
              };

              SparkMD5.ArrayBuffer = function () {
                this.reset();
              };

              SparkMD5.ArrayBuffer.prototype.append = function (arr) {
                var buff = this._concatArrayBuffer(this._buff, arr),
                    length = buff.length,
                    i;

                this._length += arr.byteLength;

                for (i = 64; i <= length; i += 64) {
                  md5cycle(this._state, md5blk_array(buff.subarray(i - 64, i)));
                }

                this._buff = i - 64 < length ? buff.subarray(i - 64) : new Uint8Array(0);

                return this;
              };

              SparkMD5.ArrayBuffer.prototype.end = function (raw) {
                var buff = this._buff,
                    length = buff.length,
                    tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                    i,
                    ret;

                for (i = 0; i < length; i += 1) {
                  tail[i >> 2] |= buff[i] << (i % 4 << 3);
                }

                this._finish(tail, length);
                ret = !!raw ? this._state : hex(this._state);

                this.reset();

                return ret;
              };

              SparkMD5.ArrayBuffer.prototype._finish = SparkMD5.prototype._finish;

              SparkMD5.ArrayBuffer.prototype.reset = function () {
                this._buff = new Uint8Array(0);
                this._length = 0;
                this._state = [1732584193, -271733879, -1732584194, 271733878];

                return this;
              };

              SparkMD5.ArrayBuffer.prototype.destroy = SparkMD5.prototype.destroy;

              SparkMD5.ArrayBuffer.prototype._concatArrayBuffer = function (first, second) {
                var firstLength = first.length,
                    result = new Uint8Array(firstLength + second.byteLength);

                result.set(first);
                result.set(new Uint8Array(second), firstLength);

                return result;
              };

              SparkMD5.ArrayBuffer.hash = function (arr, raw) {
                var hash = md51_array(new Uint8Array(arr));

                return !!raw ? hash : hex(hash);
              };

              return SparkMD5;
            });
          }, {}], 43: [function (_dereq_, module, exports) {
            'use strict';

            var utils = _dereq_(16);

            var httpIndexes = _dereq_(6);
            var localIndexes = _dereq_(14);

            exports.createIndex = utils.toPromise(function (requestDef, callback) {

              if (typeof callback === 'undefined') {
                callback = requestDef;
                requestDef = undefined;
              }

              if (typeof requestDef !== 'object') {
                return callback(new Error('you must provide an index to create'));
              }

              var adapter = this.type() === 'http' ? httpIndexes : localIndexes;

              adapter.createIndex(this, requestDef, callback);
            });

            exports.find = utils.toPromise(function (requestDef, callback) {

              if (typeof callback === 'undefined') {
                callback = requestDef;
                requestDef = undefined;
              }

              if (typeof requestDef !== 'object') {
                return callback(new Error('you must provide search parameters to find()'));
              }

              var adapter = this.type() === 'http' ? httpIndexes : localIndexes;

              adapter.find(this, requestDef, callback);
            });

            exports.getIndexes = utils.toPromise(function (callback) {

              var adapter = this.type() === 'http' ? httpIndexes : localIndexes;

              adapter.getIndexes(this, callback);
            });

            exports.deleteIndex = utils.toPromise(function (indexDef, callback) {

              if (typeof callback === 'undefined') {
                callback = indexDef;
                indexDef = undefined;
              }

              if (typeof indexDef !== 'object') {
                return callback(new Error('you must provide an index to delete'));
              }

              var adapter = this.type() === 'http' ? httpIndexes : localIndexes;

              adapter.deleteIndex(this, indexDef, callback);
            });

            if (typeof window !== 'undefined' && window.PouchDB) {
              window.PouchDB.plugin(exports);
            }
          }, { "14": 14, "16": 16, "6": 6 }] }, {}, [43])(43);
      });
