  // §store ===================================================================
  // The record outlives the page, and so do the bytes it was drawn from.
  //
  // Keeping only URLs is not enough, because all three kinds expire in their
  // own way: a blob: URL dies with the document that minted it, an lh3 URL
  // answers with a scaled copy and is not always readable under the page's CSP,
  // and a contrib path expires within the day. IndexedDB holds the images
  // themselves, so a restored record can be drawn, and a reference that has
  // gone stale is uploaded again from what is stored rather than refetched from
  // anywhere.
  //
  // What survives a reload is the store's own subject: the bytes are the first
  // source a re-upload reads from, ahead of a contrib that expires within the
  // day and a thumbnail URL that answers with a scaled copy, and the file name
  // a message was uploaded under is held nowhere else on the page. The rule the
  // record serves is stated once, above the three accessors in §record.
  // Two databases rather than two stores in one, and the reason is the upgrade
  // rather than the schema. A second store means a version bump; a version bump
  // waits on every connection an older document still holds; and a wait that is
  // never answered never settles, so one other Gemini tab left open would hang
  // not just the ledger but the records this store exists for. A new database
  // at version 1 has nothing to wait behind.
  var RECORDS = { db: 'gpie', version: 1, stores: ['overrides'], store: 'overrides' };
  // The ledger's subject is an image rather than a message, it is written on
  // pages that hold no records at all, and nothing prunes it. See §origins.
  var ORIGIN_DB = 'gpie_origins';
  var ORIGIN_STORES = ['origins', 'conversations'];
  var ORIGINS = { db: ORIGIN_DB, version: 2, stores: ORIGIN_STORES, store: 'origins' };
  // Which conversations are known to exist, and which of them the ledger has
  // already read. Separate from the images because it answers a different
  // question - what is left to sweep - and is written by a tap that never
  // parses an image at all.
  var CONVERSATIONS = { db: ORIGIN_DB, version: 2, stores: ORIGIN_STORES, store: 'conversations' };
  var dbHandles = Object.create(null);

  function openDb(where) {
    if (dbHandles[where.db]) return dbHandles[where.db];
    var handle = new Promise(function (resolve, reject) {
      var req = indexedDB.open(where.db, where.version);
      req.onupgradeneeded = function () {
        var db = req.result;
        where.stores.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'key' });
          }
        });
      };
      req.onsuccess = function () {
        var db = req.result;
        // Step aside for a future version instead of being the connection that
        // holds it out. This document keeps working from what it has already
        // read; the next open reconnects.
        db.onversionchange = function () {
          db.close();
          dbHandles[where.db] = null;
        };
        resolve(db);
      };
      // A rejection must not stay in the cache. Both failures below are of the
      // moment - a blocked open ends when the other document closes, an error
      // can be transient - but the cached promise is settled for good, so
      // leaving it there turned one blocked open into a store that answered
      // nothing for the rest of the document's life.
      function failed(err) {
        if (dbHandles[where.db] === handle) dbHandles[where.db] = null;
        reject(err);
      }
      req.onerror = function () { failed(req.error); };
      // Never silently. A blocked open looks exactly like a slow one from the
      // outside, and waiting on it forever disables every reader of the store
      // with nothing said in the console.
      req.onblocked = function () {
        failed(new Error('another document holds ' + where.db + ' open at an older version'));
      };
    });
    dbHandles[where.db] = handle;
    return handle;
  }

  function dbWrite(where, records) {
    return openDb(where).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(where.store, 'readwrite');
        var store = tx.objectStore(where.store);
        records.forEach(function (r) { store.put(r); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbDelete(where, keys) {
    return openDb(where).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(where.store, 'readwrite');
        var store = tx.objectStore(where.store);
        keys.forEach(function (k) { store.delete(k); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbReadAll(where) {
    return openDb(where).then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(where.store, 'readonly').objectStore(where.store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // A resend replaces the message it was made from and discards every turn
  // after it, so the records for those turns describe messages that no longer
  // exist. They are dropped rather than left for the budget below to find:
  // nothing will ever read them again, and the budget is a backstop for records
  // that are still about something.
  //
  // The only caller is commitSend, so this covers the resends this script
  // commits. A resend that never reaches it leaves its later records behind for
  // the budget: a retry of a message with no attachments arms no plan at all,
  // so there is no message index to drop from. An edit that changes only the
  // text of a message with no record does reach the commit - it writes no list,
  // but the server truncates behind it, and leaving before the hold was armed
  // is what left those turns' records behind as orphans.
  // The drop and the snapshot below are what makes a send reversible. Both
  // used to run while the request body was still being built, so a send that
  // never reached the server - a dropped connection, a tab closed mid-flight -
  // deleted the records of turns the server never truncated and left the record
  // for this message claiming a list that was never sent.
  var heldDrop = null;
  var heldPath = null;
  var heldRecord = null;

  // The conversation is pinned when the hold is armed rather than read again
  // when the send settles. A send that lands after the user has routed away
  // still truncated the conversation it was made in, and the records it owes
  // are that conversation's; resolving against whatever is on screen by then
  // either spares those orphans or takes another thread's records instead.
  function holdSend(index, path) {
    // -1 is indexOfHost saying the message has already left the tree, and
    // dropRecordsAfter(-1) would take every record in the conversation with
    // it. Nothing is held - including anything an earlier send left held,
    // which this send's outcome would otherwise resolve against an ordinal
    // that is not its own.
    if (typeof index !== 'number' || index < 0) {
      say('warn', LOG_IMG, 'send held with no message index, records left untouched');
      heldDrop = null;
      heldPath = null;
      heldRecord = null;
      // Said out loud, because the caller went on to write a record at that
      // same index and the warning above then described the opposite of what
      // happened. Refusing to hold and refusing to write are one decision.
      return false;
    }
    heldDrop = index;
    heldPath = path;
    heldRecord = snapshotOverride(index);
    return true;
  }

  function sendLanded() {
    var index = heldDrop;
    var path = heldPath;
    heldDrop = null;
    heldPath = null;
    heldRecord = null;
    if (index === null) return;
    // Against the pinned conversation, wherever the user is by now: the server
    // truncated that one, so its later records describe turns that no longer
    // exist whether or not it is still the conversation on screen.
    dropRecordsAfter(index, path);
  }

  function sendFailed(why) {
    if (heldDrop === null) return;
    var snap = heldRecord;
    var index = heldDrop;
    var path = heldPath;
    heldDrop = null;
    heldPath = null;
    heldRecord = null;
    // The rollback is the half that cannot be done from a pinned path:
    // restoreOverride finds its record through overrideAt and keys its delete
    // by the pathname on screen, both of which describe the conversation being
    // looked at. Rather than write this conversation's record from another
    // one's snapshot, the hold is resolved and what it cost is named.
    if (path !== location.pathname) {
      reportDowngrade('the record for message #' + index + ' is left as the send wrote it '
        + 'rather than put back',
        'the send did not go out (' + why + ') and the page moved from ' + path
        + ' to ' + location.pathname + ' before the rollback could run');
      return;
    }
    say('warn', LOG_IMG, 'the send did not go out (' + why + '); the later records are kept '
      + 'and the record for this message is put back as it was');
    restoreOverride(snap);
    schedule();
  }

  function snapshotOverride(index) {
    var o = overrideAt(index);
    if (!o) return { index: index, absent: true };
    return {
      index: index,
      absent: false,
      thumbs: o.thumbs.slice(),
      attachments: o.attachments,
      blobs: (o.blobs || []).slice()
    };
  }

  function restoreOverride(snap) {
    if (!snap) return;
    var o = overrideAt(snap.index);
    if (snap.absent) {
      if (!o) return;
      dropView(o);
      releaseThumbs(o.thumbs);
      overrides.splice(overrides.indexOf(o), 1);
      dbDelete(RECORDS, [location.pathname + '#' + snap.index]).catch(function (err) {
        say('warn', LOG_IMG, 'could not discard the record of a send that failed:', err);
      });
      return;
    }
    if (!o) return;
    releaseThumbs(o.thumbs, snap.thumbs);
    o.thumbs = snap.thumbs;
    o.attachments = snap.attachments;
    o.blobs = snap.blobs;
    dropView(o);
    persistOverrides();
  }

  // The conversation is passed in, never read off the location: this runs when
  // the send lands, which can be long after the user has routed elsewhere. The
  // stored keys are built from the doomed rows themselves, so they were never
  // wrong; the filter that chose those rows was.
  function dropRecordsAfter(index, path) {
    var doomed = overrides.filter(function (o) {
      return o.path === path && o.index > index;
    });
    if (!doomed.length) return;
    doomed.forEach(function (o) {
      dropView(o);
      releaseThumbs(o.thumbs);
      overrides.splice(overrides.indexOf(o), 1);
    });
    var keys = doomed.map(function (o) { return o.path + '#' + o.index; });
    dbg('dropRecordsAfter: message #' + index + ' of ' + path + ' resent,', keys.length,
      'later records discarded with it');
    dbDelete(RECORDS, keys).catch(function (err) {
      say('warn', LOG_IMG, 'could not discard the records after #' + index + ':', err);
    });
  }

  // Only the bytes are ever dropped, and only from a record that can still be
  // read without them. The attachment list is a few hundred bytes and is kept
  // for good; the bytes are a speed source, so a record that gives them up
  // falls back to refetching a thumbnail at full size, which is slower and
  // still correct.
  //
  // Which thumbnail was once read off the record, back when a URL was stored
  // there. None is, so the page is the source: after a reload the carousel
  // holds what the server has, healThumbs takes it back, and freshenExisting
  // fetches from there. A record whose message has left the conversation cannot
  // be healed - but neither could it be resent, and the stored URL it used to
  // be spared for would have expired by then anyway.
  function prunable(record) {
    return record && Array.isArray(record.blobs) && record.blobs.some(Boolean)
      && Array.isArray(record.thumbs) && record.thumbs.length === record.blobs.length;
  }

  function bytesOf(record) {
    var n = 0;
    (record.blobs || []).forEach(function (b) { if (b) n += b.size || 0; });
    return n;
  }

  // Which conversations the in-memory array is still carrying. Asked instead of
  // the pathname on screen because the pathname is only true for the instant it
  // is read: this runs from a route change, and every conversation visited
  // since the document opened still holds its bytes here.
  function pathHeldInMemory(path) {
    return overrides.some(function (o) { return o.path === path; });
  }

  function pruneStore() {
    return dbReadAll(RECORDS).then(function (rows) {
      var held = 0;
      rows.forEach(function (r) { held += bytesOf(r); });
      if (held <= BLOB_BUDGET) {
        dbg('pruneStore:', (held / 1048576).toFixed(1) + 'MB held, within the budget');
        return null;
      }
      // A conversation this document has open is never a candidate: its bytes
      // are held in memory as well, so the next send would write them straight
      // back.
      var evictable = rows.filter(function (r) {
        return prunable(r) && !pathHeldInMemory(r.path);
      }).sort(function (a, b) { return (a.savedAt || 0) - (b.savedAt || 0); });

      var freed = 0;
      var stripped = [];
      for (var i = 0; i < evictable.length && held - freed > BLOB_BUDGET; i++) {
        freed += bytesOf(evictable[i]);
        evictable[i].blobs = [];
        stripped.push(evictable[i]);
      }
      if (!stripped.length) {
        dbg('pruneStore:', (held / 1048576).toFixed(1) + 'MB held, nothing droppable');
        return null;
      }
      return dbWrite(RECORDS, stripped).then(function () {
        info('store: ' + (freed / 1048576).toFixed(1) + 'MB of image bytes dropped from '
          + stripped.length + ' records last touched longest ago, '
          + ((held - freed) / 1048576).toFixed(1) + 'MB kept');
      });
    }).catch(function (err) {
      say('warn', LOG_IMG, 'could not prune the stored images:', err);
    });
  }

  // §record ==================================================================
  // From the first resend onwards this record, not the request body, is what a
  // message's attachment list means.
  //
  // A message is keyed by its position in the conversation rather than by its
  // node: answering a resend destroys and rebuilds the message, so a node held
  // from before the send is detached by the time the answer arrives. The
  // position survives, because a resend replaces what follows the message and
  // leaves everything above it alone. The conversation is part of the key as
  // well, or the same position in another thread would inherit the list.
  var overrides = [];

  function hostsNow() {
    return document.querySelectorAll('div.user-query-container');
  }

  function indexOfHost(host) {
    return Array.prototype.indexOf.call(hostsNow(), host);
  }

  // The rule the record exists for, stated once: from the moment this script
  // resends a message, what the record holds outranks anything the page still
  // shows for it or still builds for it. Gemini's carousel keeps drawing the
  // attachments the message was drawn with, and the body it builds afterwards
  // carries the list from before the resend; neither is corrected by the
  // answer. Every reader of that list goes through the three below, and every
  // writer through commitSend.
  //
  // Within this document. A reload reads the message from the server, which
  // holds what the resend actually sent, so the page is correct again on its
  // own; the record is what covers a second edit made before that reload.
  function recordThumbs(index, ifNone) {
    var o = overrideAt(index);
    if (!o) return ifNone();
    // A thumb that did not survive the reload is filled from the page, which
    // holds the right image at that point: see healThumbs. Reading a record
    // with a hole in it and writing it back on the next send is what made the
    // hole permanent.
    var live = null;
    return o.thumbs.map(function (t, i) {
      if (t) return t;
      if (!live) live = ifNone() || [];
      return live[i] || '';
    });
  }

  function recordAttachments(index) {
    var o = overrideAt(index);
    return o && Array.isArray(o.attachments) ? o.attachments.slice() : null;
  }

  function recordBlobs(index) {
    var o = overrideAt(index);
    return o && Array.isArray(o.blobs) ? o.blobs.slice() : null;
  }

  function overrideAtPath(index, path) {
    for (var i = 0; i < overrides.length; i++) {
      if (overrides[i].index === index && overrides[i].path === path) {
        return overrides[i];
      }
    }
    return null;
  }

  function overrideAt(index) {
    return overrideAtPath(index, location.pathname);
  }

  // One counter for every record this document writes, rather than a count
  // kept per record. A per-record count starts at 1 for each of them, so two
  // records - one per conversation - read as the same generation, and a guard
  // comparing them lets exactly the mix-up it was written to stop straight
  // through. Monotonic here means a generation names one record's one state.
  var recordGen = 0;
  function nextGen() {
    recordGen += 1;
    return recordGen;
  }

  // A thumbnail replaced is a thumbnail nothing can reach: a blob: URL pins its
  // bytes until it is revoked, and both the refresh and a second edit of the
  // same message used to overwrite the list and leave the old URLs behind.
  // Only what this document minted is revoked - an lh3 URL is not ours - and
  // anything carried into the new list is left alone.
  function releaseThumbs(old, keep) {
    (old || []).forEach(function (url) {
      if (typeof url !== 'string' || url.indexOf('blob:') !== 0) return;
      if (keep && keep.indexOf(url) !== -1) return;
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        // Already revoked, which is the ordinary case when two paths drop the
        // same list.
      }
    });
  }

  function installOverride(index, thumbs, attachments, blobs) {
    var kept = 0;
    (blobs || []).forEach(function (b) { if (b) kept++; });
    dbg('installOverride: message #' + index + ',', thumbs.length, 'thumbs,', kept,
      'images kept, attachments =', attShape(attachments));
    if (typeof index !== 'number' || index < 0) return false;
    var existing = overrideAt(index);
    if (existing) {
      releaseThumbs(existing.thumbs, thumbs);
      existing.thumbs = thumbs;
      existing.attachments = attachments;
      existing.blobs = blobs || [];
      // A record is rewritten in place, so a deferred write holding this
      // object still holds the right object while its content has become
      // another send's. The counter is the only thing that tells those two
      // apart: a write armed against generation 3 refuses a record that has
      // since become 4. It is not persisted, because a record read back from
      // the store has no deferred write waiting on it.
      existing.gen = nextGen();
      dropView(existing);
    } else {
      overrides.push({
        path: location.pathname,
        index: index,
        thumbs: thumbs,
        attachments: attachments,
        blobs: blobs || [],
        gen: nextGen(),
        view: null
      });
    }
    persistOverrides();
    return true;
  }

  function persistOverrides() {
    // Only this conversation's records are written. The array also holds the
    // records of conversations this document merely visited before an in-page
    // navigation, and rewriting those stamped them as freshly used - which is
    // exactly what §store's least-recently-used eviction reads - and undid
    // another tab's pruning of the same rows.
    var mine = overrides.filter(function (o) { return o.path === location.pathname; });
    var records = mine.map(function (o) {
      return {
        key: o.path + '#' + o.index,
        path: o.path,
        index: o.index,
        // A thumb belongs to the document that minted it and to no other: a
        // blob: URL dies with that document, and an lh3 URL expires while
        // staying a perfectly good-looking string. Neither is stored. What
        // restores a record is the bytes beside it, or failing that the page,
        // which after a reload holds what the server has.
        thumbs: o.thumbs.map(function () { return ''; }),
        attachments: o.attachments,
        blobs: o.blobs || [],
        // Touched on every send this conversation makes, which is what §store
        // reads as least-recently-used when it has to free room.
        savedAt: Date.now()
      };
    });
    dbWrite(RECORDS, records).then(function () {
      var images = 0;
      records.forEach(function (r) {
        r.blobs.forEach(function (b) { if (b) images++; });
      });
      dbg('persistOverrides:', records.length, 'records stored with', images, 'images');
    }).catch(function (err) {
      say('warn', LOG_IMG, 'could not persist the attachment records:', err);
    });
  }

  // Every record belongs to one conversation, and only the one on screen can be
  // read, drawn or sent from. Keeping the rest costs a blob: URL per thumb that
  // nothing revokes and every byte they hold, and it is read by pathHeldInMemory
  // as "this conversation is open" - so the longer a session runs, the smaller
  // the set §store is allowed to evict, and the budget stops being a budget.
  //
  // Dropping them loses nothing: every writer persists, so what is released here
  // is already in the store and restoreOverrides reads it back on return. The
  // in-flight dbWrite holds its own snapshot and is unaffected.
  function releaseOffPath() {
    var here = location.pathname;
    for (var i = overrides.length - 1; i >= 0; i--) {
      var o = overrides[i];
      if (o.path === here) continue;
      dropView(o);
      releaseThumbs(o.thumbs, null);
      overrides.splice(i, 1);
    }
  }

  // Runs again on every route change, because the pathname it filters on is
  // whatever is on screen at the moment it is called and the landing page is
  // never the conversation. Idempotent per path: a record already in the array
  // is left where it is.
  function restoreOverrides() {
    releaseOffPath();
    return dbReadAll(RECORDS).then(function (kept) {
      var mine = kept.filter(function (r) { return r && r.path === location.pathname; });
      if (!mine.length) return;
      mine.forEach(function (r) {
        if (overrideAt(r.index)) return;
        var blobs = Array.isArray(r.blobs) ? r.blobs : [];
        overrides.push({
          path: r.path,
          index: r.index,
          // Bytes are the only thumb that survives a document. Records written
          // by an earlier version still carry lh3 URLs, and they are dropped
          // here rather than drawn: an expired one loads nothing while reading
          // as a valid source, which is what put empty boxes over a carousel
          // that was showing the right images. healThumbs fills the holes.
          thumbs: (r.thumbs || []).map(function (_, i) {
            return blobs[i] ? URL.createObjectURL(blobs[i]) : '';
          }),
          attachments: r.attachments,
          blobs: blobs,
          gen: nextGen(),
          view: null
        });
      });
      dbg('restoreOverrides:', mine.length, 'records read back for this conversation');
      schedule();
      // The read is asynchronous, so a plan built in the milliseconds before it
      // landed found no record and took the request body as its base - the
      // stale list §shape exists to avoid. A clean plan is thrown away and the
      // next scan pass builds it again off the record; a dirty one is holding
      // the user's edit, so it is kept and the cost is named instead.
      if (plan && !plan.base && overrideAt(plan.index)) {
        if (planIsDirty(plan)) {
          reportDowngrade('edit built before its record loaded, its send may carry a stale list',
            'message #' + plan.index);
        } else {
          discardPlan();
        }
      }
    }).catch(function (err) {
      // Resolving, not rethrowing: the prune chained onto this reads the store
      // for itself and has no reason to be skipped because the restore failed.
      say('warn', LOG_IMG, 'could not restore the attachment records:', err);
    });
  }

  // §view ====================================================================
  // A message keeps rendering the attachments it was drawn with; the resend does
  // not update them and neither does the answer. Rather than reloading the page
  // to resynchronise a strip of thumbnails, the display of that one message is
  // taken over: Gemini's carousel is hidden and the record is drawn in its
  // place.
  function dropView(o) {
    if (o.view && o.view.parentNode) o.view.parentNode.removeChild(o.view);
    o.view = null;
  }

  // A restored record holds a thumb only where it kept the bytes:
  // refreshOverride releases them once the server's own references are in, and
  // a retry never had any, so the rest come back empty.
  //
  // The page has those images. After a reload the carousel is what the server
  // returned, which is what this message actually carries, so it is both the
  // right thing to draw and the URL namesByThumb will match - a thumb that
  // matches nothing is why a record stays on contribs and every later resend
  // re-uploads from scratch. The heal lasts for this document alone; nothing is
  // written back, because a URL outliving the document it came from is the
  // failure this repairs.
  function healThumbs(o, host) {
    var missing = 0;
    for (var i = 0; i < o.thumbs.length; i++) if (!o.thumbs[i]) missing++;
    if (!missing) return;
    // display:none does not clear a src, so the hidden carousel still answers.
    var carousel = host.querySelector('user-query-file-carousel');
    var imgs = carousel ? carousel.querySelectorAll('img') : [];
    var healed = 0;
    for (var j = 0; j < o.thumbs.length; j++) {
      if (o.thumbs[j] || !imgs[j] || !imgs[j].src) continue;
      // Taking back a source already seen to draw nothing would heal, fail and
      // heal again without end.
      if (o.dead && o.dead[imgs[j].src]) continue;
      o.thumbs[j] = imgs[j].src;
      healed++;
    }
    if (!healed) return;
    dbg('healThumbs: message #' + o.index + ',', healed, 'of', missing,
      'thumbs read back from the page');
    dropView(o);
  }

  // Drawing over the carousel is only an improvement while every entry can be
  // drawn. One that cannot leaves a blank where the page was showing the right
  // image, so the takeover is skipped entirely and Gemini's own strip stays.
  function drawable(o) {
    if (!o.thumbs.length) return false;
    for (var i = 0; i < o.thumbs.length; i++) if (!o.thumbs[i]) return false;
    return true;
  }

  // Clicking a drawn thumbnail has to open something, and Gemini's own viewer
  // is the thing to open: it is what the rest of the app opens, it closes and
  // traps focus the way the user expects, and a strip of plain images cannot
  // imitate that for free. It is opened through the preview button of the
  // hidden carousel, which still answers a click while display is none, and
  // then the one image and the title it put on screen are replaced with the
  // record's - the state that viewer draws from is the message as it stood
  // before the resend, which is exactly what the record exists to correct.
  //
  // Verified against the live dialog: the click opens it, it holds a single
  // <img> and a single `.image-title .title`, and neither is written back by
  // change detection after being replaced.
  var VIEWER_WAIT_MS = 2500;

  function nameFor(o, index) {
    var tuple = o.attachments && o.attachments[index];
    return (tuple && typeof tuple[1] === 'string' && tuple[1]) || '';
  }

  function retitleViewer(dialog, thumb, name) {
    var img = dialog.querySelector('img');
    // The viewer is the one place the image is looked at rather than glanced
    // at, so it gets the stored original rather than the scaled copy an lh3
    // URL answers with by default.
    if (img) img.src = thumb.indexOf('http') === 0 ? thumbFullSize(thumb) : thumb;
    var title = dialog.querySelector('.image-title .title');
    if (title && name) title.textContent = name;
    return !!img;
  }

  // The dialog is Angular's and arrives a frame or several after the click.
  function whenViewerOpens(then) {
    var seen = document.querySelector('mat-dialog-container');
    var started = Date.now();
    var timer = setInterval(function () {
      var dialog = document.querySelector('mat-dialog-container');
      if (dialog && dialog !== seen) {
        clearInterval(timer);
        then(dialog);
        return;
      }
      if (Date.now() - started > VIEWER_WAIT_MS) {
        clearInterval(timer);
        dbg('viewer: no dialog appeared, the thumbnail click is left as it was');
      }
    }, 60);
  }

  function openViewer(o, index) {
    var host = hostsNow()[o.index];
    var buttons = host ? host.querySelectorAll('user-query-file-preview button') : [];
    if (!buttons.length) {
      dbg('viewer: message #' + o.index + ' has no preview button to open');
      return;
    }
    // A record can hold more images than the message was drawn with. Any of the
    // buttons opens the same viewer, and what it shows is replaced regardless.
    var button = buttons[Math.min(index, buttons.length - 1)];
    var thumb = o.thumbs[index];
    var name = nameFor(o, index);
    whenViewerOpens(function (dialog) {
      var swapped = retitleViewer(dialog, thumb, name);
      dbg('viewer: opened for message #' + o.index + ' image', index + 1,
        swapped ? 'and repointed at the record' : 'but held no image to repoint');
    });
    button.click();
  }

  function buildView(o) {
    var bar = document.createElement('div');
    bar.className = 'gpie-bar gpie-view';
    var strip = document.createElement('div');
    strip.className = 'gpie-strip';
    o.thumbs.forEach(function (thumb, index) {
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'gpie-tile gpie-open';
      tile.setAttribute('aria-label', nameFor(o, index) || ('image ' + (index + 1)));
      tile.addEventListener('click', function () { openViewer(o, index); });

      var img = document.createElement('img');
      img.className = 'gpie-thumb';
      img.src = thumb;
      img.alt = '';
      img.draggable = false;
      // Whether a thumb draws cannot be read off the string: an expired lh3 URL
      // is indistinguishable from a live one until it fails. This is where that
      // answer arrives, and dropping the thumb here is what makes drawable()'s
      // promise hold - the next pass heals it from the page, or gives the
      // carousel back.
      img.addEventListener('error', function () {
        var src = o.thumbs[index];
        if (!src) return;
        dbg('buildView: message #' + o.index + ' image ' + (index + 1)
          + ' drew nothing; dropping the thumb and syncing again');
        (o.dead || (o.dead = {}))[src] = true;
        o.thumbs[index] = '';
        dropView(o);
        schedule();
      });
      tile.appendChild(img);

      var badge = document.createElement('span');
      badge.className = 'gpie-badge';
      badge.textContent = String(index + 1);
      tile.appendChild(badge);

      strip.appendChild(tile);
    });
    bar.appendChild(strip);
    return bar;
  }

  // Runs on every mutation, because the carousel is Angular's and an inline style
  // put on it is only guaranteed to survive change detection, not a rebuild.
  function syncOverrides() {
    var hosts = null;
    for (var i = 0; i < overrides.length; i++) {
      var o = overrides[i];
      if (o.view && !o.view.isConnected) o.view = null;
      if (o.path !== location.pathname) {
        dropView(o);
        continue;
      }
      if (!hosts) hosts = hostsNow();
      var host = hosts[o.index];
      var container = host ? host.querySelector('.file-preview-container') : null;
      if (!container || host.classList.contains('edit-mode')) {
        // Edit mode draws its own strip from the same list; two would collide.
        dropView(o);
        continue;
      }
      healThumbs(o, host);
      var carousel = container.querySelector('user-query-file-carousel');
      if (!drawable(o)) {
        dbg('syncOverrides: message #' + o.index + ' has a thumb with no source, '
          + 'leaving the carousel in place');
        // A takeover that began and then lost an image has already hidden it;
        // giving up without undoing that leaves the message showing nothing.
        if (carousel && carousel.style.display === 'none') carousel.style.display = '';
        dropView(o);
        continue;
      }
      if (carousel && carousel.style.display !== 'none') carousel.style.display = 'none';
      if (!o.view || o.view.parentNode !== container) {
        dropView(o);
        o.view = buildView(o);
        container.appendChild(o.view);
      }
    }
  }

  // §refresh =================================================================
  // Upgrading a record from what was sent to the durable references the server
  // assigned. StreamGenerate's own response never carries them; the
  // conversation-load rpc does.
  //
  // Attachments in that response are 16-element tuples: [2] file name,
  // [3] thumbnail URL, [5] the $AXzLiR token, [11] mime. The list appears twice
  // per turn with identical content, and the model's generated images share the
  // shape, so counting matches across the whole tree over-collects. The one
  // parent array whose eligible children carry exactly the file names this
  // record sent is the anchor.
  //
  // This runs for any resend that kept its conversation address, which is every
  // shape §shape produces by itself. It is skipped only on the gpieStripNext
  // probe, whose send is answered from a conversation of the server's own
  // choosing: a token scoped to that conversation is not valid in this one.
  //
  // The anchor is the first parent whose eligible children carry exactly these
  // file names. In a conversation long enough for two messages to have been
  // sent with the same names, that is not necessarily the right message, and
  // the 10 in the rpc's own arguments has not been established to be anything
  // other than a page size. Both are untested past a single turn.
  function isAttTuple(n) {
    return Array.isArray(n) && n.length === 16 && typeof n[2] === 'string'
      && typeof n[5] === 'string' && n[5].indexOf('$') === 0;
  }

  // The one request that asks the server what a conversation holds. Both
  // readers below parse the same payload; only how they find their message in
  // it differs.
  //
  // Which conversation is the caller's to say when it has one pinned. Both
  // readers are armed at one moment and resolve at another, and reading the
  // location at request time answered whichever conversation the user had
  // routed to in between - a name map from the wrong thread, or an upgrade
  // aimed at a turn that is not there.
  function listConversation(label, conv) {
    // Falling back to the live read defeats the point of being handed a pinned
    // id: both callers defer across an rpc, and the conversation on screen when
    // the answer is wanted need not be the one the question was asked about.
    var id = conv;
    if (!id) {
      id = conversationId();
      if (id) {
        reportDowngrade(label + ' reads whichever conversation is on screen',
          'it was given no conversation id to pin to');
      }
    }
    if (!id) return Promise.reject(new Error('no conversation on screen'));
    return batchExecute(LIST_CONVERSATION_RPC, [id, 10, null, 1, [1], [4], null, 1], label);
  }

  // A thumbnail URL identifies one attachment, which a file name does not: the
  // same name appears on every message that was ever sent with it. The size
  // suffix is dropped so a URL read off the page matches the one the server
  // reports.
  function thumbKey(url) {
    if (typeof url !== 'string' || !url) return '';
    var cut = url.lastIndexOf('=');
    return cut > url.lastIndexOf('/') ? url.slice(0, cut) : url;
  }

  // The name an attachment was uploaded under is held by the server and nowhere
  // on the page: the rendered preview carries neither a name nor a title, and a
  // message being edited for the first time has no record to read one from.
  // Without it every existing image is re-uploaded as image-<n>.jpg, and the
  // resend makes that the name the server keeps from then on.
  function namesByThumb(conv) {
    return listConversation('namesByThumb', conv).then(function (parsed) {
      var names = {};
      (function walk(node) {
        if (!Array.isArray(node)) return;
        if (isAttTuple(node)) {
          var key = thumbKey(node[3]);
          if (key) names[key] = node[2];
          return;
        }
        node.forEach(walk);
      })(parsed);
      dbg('namesByThumb:', Object.keys(names).length, 'attachment names read back');
      return names;
    });
  }

  // How many attachments to expect is the record's own to say: the names being
  // matched are read from o.attachments, so the count has to come from the same
  // array or the two describe different lists. Passing it in let an earlier
  // send's count meet a later send's record, which could only ever fail to
  // match.
  //
  // Everything below is aimed by an ordinal within a conversation, and none of
  // it runs before 800ms after the send - seconds, once the retry below is
  // counted. By then the user may be looking at another conversation, and the
  // record at that ordinal may be a second send's, so both are pinned when the
  // upgrade is armed and refused when they no longer hold. Object identity
  // cannot stand in for the second check: installOverride rewrites a record in
  // place, so the object is still the same object after another send has
  // replaced everything in it.
  function refreshOverride(index, attempt, conv, path, gen) {
    // The ordinal counts messages in one conversation and means nothing in
    // another. Re-reading it here wrote one turn's tokens into whichever
    // record happened to sit at the same position in the thread the user had
    // routed to, and then dropped that record's bytes.
    if (location.pathname !== path) {
      reportDowngrade('reference upgrade dropped, later resends of this message stay slow',
        'the page moved from ' + path + ' to ' + location.pathname + ' before the upgrade ran');
      return;
    }
    var o = overrideAt(index);
    dbg('refreshOverride: fire, message #' + index + ', expect',
      o ? o.attachments.length : 0, 'attachments, attempt', attempt,
      '(record ' + (o ? 'found' : 'MISSING') + ')');
    if (!o) {
      reportDowngrade('reference upgrade dropped, later resends of this message stay slow',
        'message #' + index + ' has no record left to upgrade');
      return;
    }
    // One separator for both sides of the comparison. It was a space on one
    // and a NUL on the other, which could only ever match a single-attachment
    // record and left every multi-image message stuck on its contrib paths.
    var SEP = '\u0000';
    listConversation('refreshOverride', conv).then(function (parsed) {
      var wantNames = o.attachments.map(function (a) { return a[1]; }).sort().join(SEP);
      var expectedCount = o.attachments.length;
      var tuples = null;
      (function walk(node) {
        if (tuples || !Array.isArray(node)) return;
        var kids = node.filter(isAttTuple);
        if (kids.length === expectedCount) {
          var names = kids.map(function (t) { return t[2]; }).sort().join(SEP);
          if (names === wantNames) { tuples = kids; return; }
        }
        for (var i = 0; i < node.length && !tuples; i++) walk(node[i]);
      })(parsed);
      // The turn may not be committed yet when the stream ends; a short retry
      // covers that instead of silently keeping the contrib paths.
      if (!tuples) {
        dbg('refreshOverride: no list matching the record\'s file names yet');
        if (attempt < 2) {
          setTimeout(function () {
            refreshOverride(index, attempt + 1, conv, path, gen);
          }, 1500);
          return;
        }
        throw new Error('no attachment list matching the record');
      }
      // By the pinned path, never the live one. overrideAt reads
      // location.pathname, and the rpc above is long enough for the user to
      // have routed elsewhere; the ordinal then resolves to whichever record
      // sits at the same position in the conversation now on screen, and what
      // follows would write this turn's tokens into it and destroy its bytes.
      // The entry guard cannot cover this - it runs before the rpc, not after.
      if (location.pathname !== path) {
        reportDowngrade('reference upgrade dropped, later resends of this message stay slow',
          'the page moved from ' + path + ' to ' + location.pathname
          + ' while the upgrade was in flight');
        return;
      }
      var current = overrideAtPath(index, path);
      // The record this upgrade was armed for, or nothing. A second send to
      // the same message rewrote it in place while the rpc was in flight, and
      // what follows would replace that send's own list with the tokens of the
      // turn the server has just been asked about and then destroy its bytes.
      if (!current || current.gen !== gen) {
        reportDowngrade('reference upgrade dropped, later resends of this message stay slow',
          'message #' + index + ' was rewritten while the upgrade was in flight (generation '
          + gen + ' -> ' + (current ? current.gen : 'gone') + ')');
        return;
      }
      current.attachments = tuples.map(function (t) {
        return [[null, 1, 1, t[11]], t[2], t[5]];
      });
      var served = tuples.map(function (t) { return t[3]; });
      releaseThumbs(current.thumbs, served);
      current.thumbs = served;
      // This is the moment the bytes stop being the only source that is certain
      // to work. The turn is on the server under this conversation, and the
      // thumbnails just written are the server's own, which answer with the
      // original image once the size suffix is appended. Holding megabytes per
      // message from here on would buy one download on a later edit, against a
      // re-upload of the same images that has to happen either way.
      var freed = 0;
      (current.blobs || []).forEach(function (b) { if (b) freed += b.size || 0; });
      current.blobs = [];
      // A writer like any other. The retry of a send that failed after this
      // one landed is armed against the generation it reads then, not the one
      // the upgrade started from.
      current.gen = nextGen();
      dbg('refreshOverride: released', (freed / 1048576).toFixed(2) + 'MB of image bytes,',
        'the record now reads from the server references');
      persistOverrides();
      dropView(current);
      schedule();
      dbg('record upgraded to server references', tuples.length);
    }).catch(function (err) {
      // The record still holds what was sent, which stays correct, only slower
      // on the next resend. Named so the console shows why that will be.
      say('warn', LOG_IMG, 'reference refresh failed:', err);
    });
  }

