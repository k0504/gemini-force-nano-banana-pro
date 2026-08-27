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

  function planIsReady(p) {
    return p.entries.every(function (entry) {
      return entry.kind === 'existing' || entry.attachment;
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
        reportDowngrade('edit plan expired unsent, its changes are dropped',
          'message #' + plan.index);
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
    var wanted = planIsDirty(p);
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

  function fetchBytes(url) {
    if (/^(blob:|data:)/.test(url)) {
      return fetch(url).then(function (r) { return r.blob(); });
    }
    var full = thumbFullSize(url);
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

  function fallbackName(index) {
    return 'image-' + (index + 1) + '.jpg';
  }

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
    // The only branch in this file whose cost is not time. The name handed to
    // the upload becomes the name the resent message carries, so falling back
    // here renames the user's file to image-<n>.jpg on the server for good -
    // there is no later pass that puts the original back.
    if (!pending) {
      reportDowngrade('original file name lost for existing#' + entry.index
        + ', re-uploading as ' + fallbackName(entry.index)
        + ' — the server keeps that name permanently',
        'no record name and no server name for this thumbnail');
      return Promise.resolve(fallbackName(entry.index));
    }
    return pending.then(function (byThumb) {
      var found = byThumb && byThumb[thumbKey(entry.thumb)];
      if (!found) {
        dbg('freshen: existing#' + entry.index, 'the server reports no name for this thumbnail');
        reportDowngrade('original file name lost for existing#' + entry.index
          + ', re-uploading as ' + fallbackName(entry.index)
          + ' — the server keeps that name permanently',
          'no record name and no server name for this thumbnail');
      }
      return found || fallbackName(entry.index);
    });
  }

  function uploadInto(entry, bytes, name, why) {
    dbg('freshen: existing#' + entry.index, why, bytes.size + 'B');
    entry.bytes = bytes;
    return uploadFile(new File([bytes], name, { type: bytes.type || 'image/jpeg' }))
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
        return fetchBytes(entry.thumb).then(function (blob) {
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

  function freshReady(p) {
    return p.entries.every(function (entry) {
      return entry.kind === 'new' ? entry.attachment : entry.freshAttachment;
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

  // Writes the plan into the outgoing prompt tuple. null means only that this
  // send is not the one the plan was made for; true that the attachment list
  // was written, false that it was backed out of - a send that is still an edit
  // resend, and still owes the record everything §commit gives one.
  //
  // The sentinel is not this function's to strip. rewrite() takes it off every
  // send that carries it, plan or no plan, which is the only rule that also
  // covers the retry of a message with no attachments; a second strip here
  // could only ever find nothing and read as though it were doing the work.
  function applyPlanTo(inner, p, fresh) {
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
      return entry.kind === 'existing' ? (fresh && !entry.freshAttachment) : !entry.attachment;
    }).length;
    var count = Array.isArray(base) ? base.length : 0;
    if (missing) {
      say('warn', LOG_IMG, 'attachments left untouched:', missing,
        'of them have nothing to be written from');
    } else if (count !== p.originalCount) {
      say('warn', LOG_IMG, 'attachment count mismatch, attachments left untouched',
        { base: count, ui: p.originalCount });
    } else {
      tuple[ATTACHMENTS] = p.entries.map(function (entry) {
        // Two elements, the shape the page itself sends for a new upload. The
        // nine-element form belongs to an action-2 resend, and anything this
        // script uploads goes out with the action cleared, so the trailing edit
        // marker must never ride along; a captured send once showed it doing so.
        if (entry.kind !== 'existing') return [entry.attachment[0], entry.attachment[1]];
        if (fresh) return [entry.freshAttachment[0], entry.freshAttachment[1]];
        return base[entry.index];
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
  function chooseSendShape(inner, written, hasNew) {
    var allContrib = Array.isArray(written) && written.length > 0
      && written.every(function (att) { return attClass(att) === 'contrib-live'; });
    work.images = Array.isArray(written) ? written.length : 0;
    work.shape = allContrib ? 'brand-new upload shape' : 'edit resend';

    if (!allContrib) {
      // Something in the list is a server reference, or a contrib this document
      // cannot vouch for, so the send cannot take the shape above and goes out
      // as the edit resend it is. Clearing the action alone is still worth it
      // when an upload is present, that combination being the slowest thing the
      // server answers.
      if (hasNew) inner[ACTION_INDEX] = null;
      dbg('chooseSendShape: not every attachment is contrib-live, sent as an edit resend |',
        attShape(written));
      // The timing table above is what the user is paying here, so it is quoted
      // rather than described: this is the one decision in the send path whose
      // cost is a minute of waiting the user cannot account for otherwise.
      reportDowngrade('brand-new upload shape abandoned, sent as edit resend '
        + '(measured 79.9s vs 24.2s)', attShape(written));
      return;
    }

    inner[ACTION_INDEX] = null;
    var convTuple = inner[CONVERSATION_INDEX];
    var hadResume = Array.isArray(convTuple) && convTuple[RESUME_INDEX] != null
      && convTuple[RESUME_INDEX] !== '';
    if (hadResume) convTuple[RESUME_INDEX] = null;
    dbg('chooseSendShape: brand-new upload shape in this conversation,',
      hadResume ? 'resume blob dropped' : 'no resume blob to drop', '| conversation',
      (Array.isArray(convTuple) && convTuple[0]) || '(none)');
    // Nothing is returned. A shape decision reaches its readers two ways: through
    // work.shape, which report() prints, and through inner, which is rewritten
    // in place. A future shape that clears the conversation tuple must also set
    // pendingStrip the way applyStripProbe does, or §net never arms the response
    // patch and the page navigates to /app on the first chunk - a failure that
    // shows as a navigation rather than an exception, so a test that only diffs
    // the request body passes straight through it.
  }

