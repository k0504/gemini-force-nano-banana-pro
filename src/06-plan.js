  // §plan ====================================================================
  // What the attachment array should look like after the resend. Entries are
  // positional, so an existing entry only stores the index it came from and the
  // payload value is read at send time.
  var plan = null;

  function makePlan(host) {
    // A send's preparation begins here, not at the request, so the cost
    // counters start over with the plan rather than with the send.
    resetWork();
    var container = directChild(host, 'file-preview-container');
    // Taken while the message is certainly still in the tree, because the send
    // that consumes this plan is what destroys the node.
    var index = indexOfHost(host);
    var thumbs = recordThumbs(index, function () {
      return (container
        ? Array.prototype.slice.call(container.querySelectorAll('user-query-file-preview'))
        : []).map(function (preview) {
          var img = preview.querySelector('img');
          return img ? img.src : '';
        });
    });
    var base = recordAttachments(index);
    var baseBlobs = recordBlobs(index);
    // Asked as edit mode opens, so a message that cannot be resent says so
    // while the user is still deciding rather than on the press. See §durable
    // for what puts a record in this state; none of it is repairable from here.
    var blocked = recordBlocker(index, location.pathname);
    if (blocked) {
      say('error', LOG_IMG, 'message #' + index + ' cannot be resent: ' + blocked);
    }
    var entries = thumbs.map(function (thumb, i) {
      return { kind: 'existing', index: i, thumb: thumb };
    });
    dbg('makePlan: message #' + index + ',', thumbs.length, 'attachments, base =',
      base ? 'record (' + attShape(base) + ')' : 'request body (no record)');
    var p = {
      host: host,
      container: container,
      index: index,
      // Which conversation this plan's entries came from. The name lookup it
      // arms below resolves an rpc later, and asking the location by then
      // answered whichever thread the user had routed to: a name map from
      // another conversation misses every thumbnail, and a miss is a permanent
      // rename to image-<n>.jpg.
      conv: conversationId(),
      // And the pathname beside it, because a record is keyed by pathname while
      // an rpc is asked by conversation id, and the two are not interchangeable.
      // Anything judging this plan after an await needs to know which thread it
      // belongs to rather than which one is on screen by then.
      path: location.pathname,
      base: base,
      baseBlobs: baseBlobs,
      blocked: blocked,
      originalCount: thumbs.length,
      originalThumbs: thumbs.slice(),
      entries: entries,
      armedAt: null,
      sentinelApplied: false
    };
    // Unconditionally, and as early as edit mode opens, because §shape can only
    // take the fast route when every attachment written is a contrib this
    // document minted - see the timing table there. Which entries actually cost
    // an upload is freshenExisting's to decide: one that already holds a live
    // contrib of ours is reused where it stands.
    //
    // This was once gated on the base holding a contrib that had gone stale,
    // which read the case backwards. §refresh upgrades a record's contribs to
    // the server's own durable references, and a server reference is not a
    // contrib tuple at all, so the gate saw nothing stale, nothing was
    // re-uploaded, and applyPlanTo wrote the reference straight back - the
    // nine-element shape the timing table measures at 79.9s against 24.2s. The
    // regression therefore arrived on its own, one record upgrade after the
    // shape work landed, which is what made it read as the fix coming undone.
    freshenExisting(p);
    return p;
  }

  function planIsDirty(p) {
    if (!p) return false;
    // A retry changes nothing, but reporting dirty is what routes its send
    // through the plan pipeline - the fast shape, the record, the refresh -
    // and what makes the scan pass apply the sentinel that unlocks Update.
    if (p.retry) return true;
    if (p.entries.length !== p.originalCount) return true;
    for (var i = 0; i < p.entries.length; i++) {
      if (p.entries[i].kind !== 'existing' || p.entries[i].index !== i) return true;
    }
    return false;
  }

  // Every entry, existing ones included. An existing entry reaches the server as
  // an upload this document made or not at all: there is no second source to
  // write it from, and the list the page built in its place carries the server's
  // own references, which is the shape measured at 79.9s against 24.2s.
  //
  // This gates the Update button rather than the send, so the wait is spent
  // before the press instead of inside the answer. The re-uploads start when
  // edit mode opens, so by the time anything has been changed they are usually
  // already done.
  function planIsReady(p) {
    // A record that cannot be trusted is not made ready by finishing the
    // uploads: what the list would be written from is the thing in doubt.
    if (p.blocked) return false;
    return p.entries.every(function (entry) {
      return entry.kind === 'existing' ? entry.freshAttachment : entry.attachment;
    });
  }

  function activePlan() {
    if (!plan) return null;
    if (plan.armedAt !== null && Date.now() - plan.armedAt > PLAN_TTL_MS) {
      // A dirty plan that expires takes the user's edit with it, and the send
      // that reads this getter a moment later goes out without it, so the loss
      // is reported. A clean one is the ordinary editor closed with Escape:
      // nothing was staged, the next send is usually an unrelated composer
      // message, and a warning there would name a loss that never happened.
      if (planIsDirty(plan)) {
        // The user's staged edit, gone. Nothing incorrect is sent by it - the
        // plan simply stops existing - but what was staged is not recoverable,
        // so it is said at error level rather than dressed up as a cost.
        say('error', LOG_IMG, 'the edit staged on message #' + plan.index
          + ' expired unsent and its changes are dropped');
      } else {
        dbg('activePlan: plan #' + plan.index + ' expired unsent with nothing staged');
      }
      plan = null;
      return null;
    }
    return plan;
  }

  function textareaOf(p) {
    return p.host && p.host.isConnected ? p.host.querySelector('textarea') : null;
  }

  // Angular only notices a value that arrives through the native setter followed
  // by an input event; assigning textarea.value directly leaves its model stale.
  function writeTextarea(textarea, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // The plan's own flag decides this, never a scan of the current text: a
  // sentinel left behind by an earlier run would otherwise look like one this
  // plan had already applied, so no value change would be dispatched and
  // Gemini's Update button would stay disabled with no way to unlock it.
  function syncSentinel(p) {
    var textarea = textareaOf(p);
    if (!textarea) return;
    var wanted = planIsDirty(p) && planIsReady(p);
    if (wanted === p.sentinelApplied) return;
    dbg('syncSentinel:', wanted ? 'appending zero-width space to textarea' : 'removing zero-width space from textarea');
    writeTextarea(textarea, wanted
      ? textarea.value + SENTINEL
      : textarea.value.split(SENTINEL).join(''));
    p.sentinelApplied = wanted;
  }

  function discardPlan() {
    if (plan) dbg('discardPlan: message #' + plan.index);
    // Nothing was committed, so the thumbnails the strip minted for added files
    // have no reader left. A send takes the other path, where the record keeps
    // them.
    if (plan) releaseEntries(plan.entries);
    if (plan && plan.sentinelApplied) {
      var textarea = textareaOf(plan);
      if (textarea) writeTextarea(textarea, textarea.value.split(SENTINEL).join(''));
    }
    plan = null;
    teardownEditorUi();
  }

  // §freshen =================================================================
  // Every image the resend will carry has to be a contrib uploaded by this
  // document, because that is the only attachment form a brand-new upload send
  // contains. The sources are tried in order of how much can go wrong with
  // them: the bytes in the record cannot expire or be blocked, a contrib minted
  // in this document is already the right shape, and refetching a thumbnail is
  // the last resort because lh3 answers with a scaled copy and the page's CSP
  // blocks blob: URLs outright.
  //
  // This starts in the background the moment a plan first gains a new image, so
  // that the send itself stays synchronous.
  function thumbFullSize(url) {
    // A size suffix asks for a scaled copy and s0 asks for the stored original.
    // Most of these URLs carry no suffix at all and redirect to an s512 copy,
    // so the suffix has to be appended rather than replaced; replacing alone
    // sent 512px thumbnails as the reference images. Where the suffix ends is
    // thumbKey's to know, in §refresh, which drops it for the same reason.
    return thumbKey(url) + '=s0';
  }

  // The source is checked before the request is made and the bytes after it
  // answers, and the two checks are deliberately on opposite sides of the
  // transport fallback below: a response that arrived and is not an image is
  // not a transport failure, and routing it into GM_xmlhttpRequest would ask
  // the same address a second time and verify nothing about either answer.
  function fetchBytes(url, what) {
    mustBeImageSource(url, what);
    var got = /^(blob:|data:)/.test(url)
      ? fetch(url).then(function (r) { return r.blob(); })
      : fetchOverNetwork(thumbFullSize(url));
    return got.then(function (blob) {
      return mustBeImageBytes(blob, what + ' fetched from ' + String(url).slice(0, 80))
        .then(function () { return blob; });
    });
  }

  function fetchOverNetwork(full) {
    return fetch(full, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.blob();
    }).catch(function (err) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        throw new Error('cors blocked and GM_xmlhttpRequest not granted; '
          + 'update the dev loader to the current header (' + err + ')');
      }
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: 'GET',
          url: full,
          responseType: 'blob',
          onload: function (r) {
            if (r.status === 200) resolve(r.response);
            else reject(new Error('GM http ' + r.status));
          },
          onerror: function () { reject(new Error('GM network error')); }
        });
      });
    });
  }

  // fallbackName is gone on purpose. It answered a missing name with
  // image-<n>.jpg, and the name handed to an upload is the name the server
  // keeps from then on, so the one branch in this file whose cost was not time
  // was quietly destroying the user's file names. A name that cannot be
  // established stops the entry instead: see serverName.

  // Asked for at most once per plan, and only when the plan has no record to
  // read names from. Opening edit mode and closing it again asks for nothing.
  function planNames(p) {
    if (p.names) return p.names;
    if (p.base) return null;
    var reachable = p.entries.some(function (entry) {
      return typeof entry.thumb === 'string' && entry.thumb.indexOf('http') === 0;
    });
    if (!reachable) return null;
    p.names = namesByThumb(p.conv).catch(function (err) {
      dbg('planNames: names unavailable, falling back to image-<n>.jpg (' + err + ')');
      return null;
    });
    return p.names;
  }

  function serverName(p, entry) {
    var known = p.base && p.base[entry.index];
    if (known && typeof known[1] === 'string' && known[1]) return Promise.resolve(known[1]);
    var pending = planNames(p);
    // The name handed to the upload becomes the name the resent message carries
    // from then on, and no later pass puts the original back. So this is a
    // stop, not a report: the entry gets no fresh attachment, planIsReady stays
    // false, and Update never unlocks - the user keeps a message whose files
    // still have their own names instead of a resend that renamed them.
    //
    // Rejected rather than thrown: the caller invokes this directly rather than
    // from inside a then, so a synchronous throw would escape the per-entry
    // catch in freshenExisting and take the whole plan's freshen pass with it.
    if (!pending) {
      return Promise.reject(new Error('existing#' + entry.index
        + ': no record name, and no thumbnail this conversation can be asked about, '
        + 'so the original file name cannot be established'));
    }
    return pending.then(function (byThumb) {
      var found = byThumb && byThumb[thumbKey(entry.thumb)];
      if (!found) {
        throw new Error('existing#' + entry.index
          + ': the server reports no name for this thumbnail, so the original file '
          + 'name cannot be established');
      }
      return found;
    });
  }

  // Where every byte source in this pipeline meets the server: a refetched
  // thumbnail, a file the user dropped, and bytes read back out of the store
  // all arrive here. The mime goes out as what the bytes are, never as
  // blob.type, which is only what whoever produced them said they were - and
  // the entry adopts the bytes only once they have passed, so a bad set is not
  // kept to be re-sent on the next edit without a fetch.
  function uploadInto(entry, bytes, name, why) {
    return mustBeImageBytes(bytes, 'existing#' + entry.index + ' (' + name + ')')
      .then(function (mime) {
        dbg('freshen: existing#' + entry.index, why, bytes.size + 'B', mime);
        entry.bytes = bytes;
        return uploadFile(new File([bytes], name, { type: mime }));
      })
      .then(function (tuple) {
        entry.freshAttachment = tuple;
        dbg('freshen: existing#' + entry.index, 'fresh contrib ready');
      }).catch(function (err) {
        entry.freshPending = false;
        // Kept so the send that gives up on this entry can say which of the two
        // it is looking at: an upload still running is worth waiting for, one
        // that failed never becomes fast and the wait is spent for nothing.
        entry.freshError = String(err);
        say('warn', LOG_IMG, 'freshen failed for existing#' + entry.index + ':', err);
      });
  }

  function freshenExisting(p) {
    // Nothing is uploaded for a plan that cannot be sent. The re-uploads exist
    // to make the press fast, and this plan has no press to be fast for.
    if (p.blocked) {
      dbg('freshen: message #' + p.index + ' is blocked, nothing is uploaded -', p.blocked);
      return;
    }
    p.entries.forEach(function (entry) {
      if (entry.kind !== 'existing' || entry.freshAttachment || entry.freshPending) return;
      entry.freshPending = true;

      var known = p.base && p.base[entry.index];

      serverName(p, entry).then(function (name) {
        // Ahead of the bytes, not behind them. A live contrib of ours is
        // already the shape the send wants, so uploading over it buys nothing
        // and costs a round trip per image on every edit - which is now every
        // edit, since this runs unconditionally.
        if (attClass(known) === 'contrib-live') {
          entry.freshAttachment = known;
          dbg('freshen: existing#' + entry.index, 'contrib from this document, reused as-is');
          return null;
        }

        var bytes = entry.bytes || (p.baseBlobs && p.baseBlobs[entry.index]) || null;
        if (bytes) return uploadInto(entry, bytes, name, 'uploading from the record,');

        dbg('freshen: existing#' + entry.index, 'no bytes held, refetching from',
          String(entry.thumb).slice(0, 60));
        noteFetchStart();
        return fetchBytes(entry.thumb, 'existing#' + entry.index).then(function (blob) {
          noteFetchEnd();
          return uploadInto(entry, blob, name, 'refetched,');
        });
      }).catch(function (err) {
        entry.freshPending = false;
        entry.freshError = String(err);
        say('warn', LOG_IMG, 'freshen failed for existing#' + entry.index + ':', err);
      });
    });
  }

  // §apply ===================================================================
  // Whether the send being built is the resend of an edited message. Asked in
  // two places - before the list is written, and by the §resend route that owes
  // the record a truncation hold even when it has no list to write - so the
  // comparison itself lives in one, and the two cannot drift into disagreeing
  // about which sends a plan speaks for.
  function isEditResend(inner) {
    return inner[ACTION_INDEX] === ACTION_EDIT_RESEND;
  }

  // Gemini's own regenerate, plain or Pro. Both are answered the same way and
  // by the same reader, so the two values are compared in one place: see
  // §native-retry.
  function isNativeRetry(inner) {
    var action = inner[ACTION_INDEX];
    return action === ACTION_RETRY || action === ACTION_RETRY_PRO;
  }

  // Writes the plan into the outgoing prompt tuple. null means only that this
  // send is not the one the plan was made for; true that the attachment list
  // was written, false that it was backed out of - a send that is still an edit
  // resend, and still owes the record everything §commit gives one.
  //
  // The sentinel is not this function's to strip. rewrite() takes it off every
  // send that carries it, plan or no plan, which is the only rule that also
  // covers the retry of a message with no attachments; a second strip here
  // could only ever find nothing and read as though it were doing the work.
  function applyPlanTo(inner, p) {
    if (!isEditResend(inner)) {
      dbg('applyPlanTo: action is', JSON.stringify(inner[ACTION_INDEX]), '(not edit resend 2), skip');
      return null;
    }

    var tuple = inner[PROMPT_TUPLE];
    var listWritten = false;

    // The body's own list is what this message holds only while it has never
    // been resent; after that the record is, and the body carries the stale one.
    var base = p.base || tuple[ATTACHMENTS];
    dbg('applyPlanTo: body carries', attShape(tuple[ATTACHMENTS]));
    dbg('applyPlanTo: base =', p.base ? 'record' : 'body', '(' + attShape(base) + ')');
    dbg('applyPlanTo: plan wants', p.entries.map(function (e) {
      return e.kind === 'existing' ? 'existing#' + e.index : 'new:' + e.name;
    }).join(', '));

    // What the list will be written from has to exist first. The count below
    // compares the base against the plan's original length, which says nothing
    // about an entry added since, and a new entry whose upload failed carries
    // no attachment at all.
    var missing = p.entries.filter(function (entry) {
      return entry.kind === 'existing' ? !entry.freshAttachment : !entry.attachment;
    }).length;
    var count = Array.isArray(base) ? base.length : 0;
    // Both of these used to leave the list untouched and let the send go. What
    // it went with was the page's list - the images from before this message
    // was last resent - so neither was leaving anything untouched: they were
    // replacing the user's images with older ones. There is no correct list to
    // write in either case, so there is nothing to send.
    if (missing) {
      refuseSend(missing + ' of the attachments for message #' + p.index
        + ' have nothing to be written from');
    } else if (count !== p.originalCount) {
      refuseSend('the record for message #' + p.index + ' holds ' + count
        + ' attachments against the ' + p.originalCount + ' the editor opened with, '
        + 'so which list to write cannot be established');
    } else {
      tuple[ATTACHMENTS] = p.entries.map(function (entry) {
        // Two elements, the shape the page itself sends for a new upload. The
        // nine-element form belongs to an action-2 resend, and anything this
        // script uploads goes out with the action cleared, so the trailing edit
        // marker must never ride along; a captured send once showed it doing so.
        if (entry.kind !== 'existing') return [entry.attachment[0], entry.attachment[1]];
        return [entry.freshAttachment[0], entry.freshAttachment[1]];
      });
      listWritten = true;
      dbg('applyPlanTo: wrote', attShape(tuple[ATTACHMENTS]));
    }

    return listWritten;
  }

  // §shape ===================================================================
  // Which shape the resend goes out in. Measured on one five-image message with
  // one prompt, removing a single difference at a time:
  //
  //   action  attachments              conversation tuple    time
  //   2       mixed contrib, 9 elems   present whole         88.3s
  //   null    mixed contrib, 9 elems   present whole         79.9s
  //   null    all contrib, 2 elems     present whole         58.0s
  //   null    all contrib, 2 elems     cleared               47.1s
  //   null    all contrib, 2 elems     cleared (native)      28.0s
  //   null    all contrib, 2 elems     id kept, resume null  24.2s
  //
  // The last row is the one this sends, and it is the fastest of them: the cost
  // the earlier rows were paying to the tuple was the resume blob alone, not
  // the address. Clearing the whole tuple hid that, because it took both.
  //
  // Clearing the whole tuple is the one that cannot be afforded. The server
  // then answers from a conversation of its own, and while §net keeps that off
  // the screen and §store keeps the record, the turn is written to the other
  // conversation and this one never receives it: a reload reads this
  // conversation from the server and gets the message as it was before the
  // edit. The generated image is not lost, it is filed under the conversation
  // that produced it, which is not the one being looked at.
  //
  // So the id stays and only the resume blob at inner[2][9] goes. That blob is
  // what is added to the tuple when a message is edited in place, and it is the
  // element that makes the server treat the send as a revision of an existing
  // turn rather than a new one; a native send inside an existing conversation
  // carries the other elements and not this one. Dropping it alone answers in
  // 2.0s to first byte, against 21.3s for the same send with it left in.
  // Answers whether the send may go out. hasNew is gone with the route that
  // read it: it decided how much of the fast shape was still worth applying to
  // a list that could not have all of it, and there is no such list any more.
  function chooseSendShape(inner, written, p) {
    var allContrib = Array.isArray(written) && written.length > 0
      && written.every(function (att) { return attClass(att) === 'contrib-live'; });
    work.images = Array.isArray(written) ? written.length : 0;
    work.shape = allContrib ? 'brand-new upload shape' : 'edit resend';

    if (!allContrib) {
      // Unreachable by construction, and refused rather than sent because of
      // it. freshenExisting re-uploads every existing entry that is not already
      // a live contrib of this document, planIsReady holds Update closed until
      // each one has its fresh attachment, and applyPlanTo writes the list from
      // those and nothing else - so a list arriving here with anything else in
      // it means one of those three stopped holding.
      //
      // This used to send it as an edit resend instead: correct, and 79.9s
      // against 24.2s. A slow path that exists is a slow path that gets taken,
      // and one taken silently is indistinguishable from the fast one until the
      // user is a minute into waiting. There is no reason to keep a route to a
      // state that cannot legitimately occur.
      refuseSend('the attachment list for message #' + p.index + ' is not all uploads this '
        + 'document made, which the editor should have made impossible: ' + attShape(written));
      return false;
    }

    inner[ACTION_INDEX] = null;
    var convTuple = inner[CONVERSATION_INDEX];
    var hadResume = Array.isArray(convTuple) && convTuple[RESUME_INDEX] != null
      && convTuple[RESUME_INDEX] !== '';
    if (hadResume) convTuple[RESUME_INDEX] = null;
    dbg('chooseSendShape: brand-new upload shape in this conversation,',
      hadResume ? 'resume blob dropped' : 'no resume blob to drop', '| conversation',
      (Array.isArray(convTuple) && convTuple[0]) || '(none)');
    // True is only "this send may go out": the shape itself reaches its readers
    // two other ways, through work.shape, which report() prints, and through
    // inner, which is rewritten in place. A future shape that clears the
    // conversation tuple must also set pendingStrip the way applyStripProbe
    // does, or §net never arms the response patch and the page navigates to
    // /app on the first chunk - a failure that shows as a navigation rather
    // than an exception, so a test that only diffs the request body passes
    // straight through it.
    return true;
  }

