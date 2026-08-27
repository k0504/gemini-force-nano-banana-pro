  // §resend ==================================================================
  // A send this script declines to write, on a message whose resend still
  // discards every turn after it. The list goes out as the page built it; the
  // records for the discarded turns go with them either way, so the commit is
  // owed whether or not anything was written. Leaving before it is what left
  // them behind as orphans for syncOverrides to draw over unrelated messages.
  //
  // Only when the send really is the resend: a plan left idling while the user
  // types into the composer would otherwise arm a truncation hold against a
  // message that send never touched.
  function backOut(inner, p, why) {
    if (!isEditResend(inner)) {
      dbg('editorContribution: backing out -', why, '- and this send is not the resend');
      return null;
    }
    reportDowngrade('the attachment list goes out as the page built it, and the turns after '
      + 'this message are discarded with their records', why);
    commitSend(p, inner[PROMPT_TUPLE][ATTACHMENTS], false);
    plan = null;
    teardownEditorUi();
    return null;
  }

  function editorContribution(inner) {
    if (!imageEditor) return null;
    var p = activePlan();
    if (!p) { dbg('editorContribution: no active plan, leaving attachments alone'); return null; }

    var dirty = planIsDirty(p);
    dbg('editorContribution: plan #' + p.index + ', dirty =', dirty + ', record =', !!p.base);

    // A retry changes no image, so nothing below it applies: the attachments go
    // out as the references they already are - the record's if it has one,
    // since the body Gemini builds for a message it has resent is the one from
    // before that resend, otherwise the page's own. The upload-and-convert path
    // exists to carry images the server has never seen; on a retry it uploads
    // what the server already holds and asks it to treat the send as a first
    // one. Measured against the native regenerate of the same message: 78.2s
    // for the converted shape, 6.3s for the native, which keeps its references.
    //
    // A retry whose references this document cannot use is the exception: it
    // has re-uploaded them by now, so it falls through to the path below and
    // takes the converted shape, which is the right one for a list of contribs.
    if (p.retry && !p.retryFresh) {
      // The same gate the route below has. A plan left behind by an editor that
      // was closed with Escape rather than Cancel survives with its host, and
      // the retry reuses it: an entry whose upload failed has no attachment to
      // write, and applyPlanTo dereferenced it.
      if (!planIsReady(p)) {
        return backOut(inner, p, 'an upload on the plan for this message never finished');
      }
      var kept = applyPlanTo(inner, p, false);
      // The same reading of that return as the route below: null means this
      // send is not the one the plan was made for, so it is left alone.
      if (kept === null) return null;
      dbg('editorContribution: retry, attachments left as they stand',
        kept ? '(written from the record)' : '(as the page built them)');
      var reload = commitSend(p, inner[PROMPT_TUPLE][ATTACHMENTS], kept);
      plan = null;
      teardownEditorUi();
      return reload;
    }
    // An unchanged list still has to be written when the message carries a
    // record, because the body Gemini builds is the one from before the resend
    // that produced it. With no record and no change there is no list worth
    // writing - but the send is still a resend of an edited message, the server
    // still discards every turn after it, and the records for those turns still
    // have to go with them. Leaving before the commit is what left them behind
    // as orphans for syncOverrides to draw over unrelated messages.
    //
    // Only for a send that is actually the resend, though: a plan left idling
    // while the user types into the composer would otherwise arm a truncation
    // hold against a message that send never touched.
    if (!dirty && !p.base) {
      if (!isEditResend(inner)) {
        dbg('editorContribution: nothing staged and no record, and this send is not the resend');
        return null;
      }
      dbg('editorContribution: nothing to write, the body goes as it stands and the record is held');
      commitSend(p, inner[PROMPT_TUPLE][ATTACHMENTS], false);
      plan = null;
      teardownEditorUi();
      return null;
    }
    if (dirty && !planIsReady(p)) {
      return backOut(inner, p, 'an upload staged in this edit has not finished');
    }

    var hasNew = p.entries.some(function (entry) { return entry.kind === 'new'; });
    var fresh = freshReady(p);
    if (!fresh) {
      dbg('editorContribution: re-uploads not finished, the record\'s own references are sent');
      // Naming the entries, because the two ways to arrive here want opposite
      // things from the user: an upload still running means the next send of
      // the same message is fast, one that failed means this plan never will
      // be and the image wants replacing by hand.
      reportDowngrade('re-uploads unfinished, the record\'s own references are sent '
        + 'instead (measured 79.9s vs 24.2s)',
        p.entries.filter(function (entry) {
          return entry.kind === 'existing' && !entry.freshAttachment;
        }).map(function (entry) {
          return 'existing#' + entry.index + ' '
            + (entry.freshError ? 'failed: ' + entry.freshError : 'still uploading');
        }).join(', '));
    }

    var listWritten = applyPlanTo(inner, p, fresh);
    if (listWritten === null) return null;

    if (listWritten) {
      dbg(dirty ? 'attachments rewritten' : 'attachments restored',
        p.originalCount, '->', p.entries.length);
      // Only a list this script wrote can be reshaped; the one the page built
      // is left in the shape the page chose for it.
      chooseSendShape(inner, inner[PROMPT_TUPLE][ATTACHMENTS], hasNew);
    }
    // Outside the gate, like the retry route: a send that backed out of the
    // list is still an edit resend, and still discards the turns after this
    // one. commitSend is what reads the verdict.
    var reload = commitSend(p, inner[PROMPT_TUPLE][ATTACHMENTS], listWritten);

    plan = null;
    // The plan is spent, so the toolbar has nothing left to describe. Clearing
    // it here also puts Gemini's own carousel back, which the record re-hides in
    // the same pass; leaving it hidden would blank a message the request failed
    // to change.
    teardownEditorUi();
    return reload;
  }

  // §commit ==================================================================
  // What the record means is §record's to say. What a send owes it is here:
  // every send this script rewrites owes the record the same three things -
  // discard the turns this send replaced, write what was actually sent, and
  // schedule the upgrade to the server's durable references.
  //
  // They are done here and nowhere else. Splitting them across the routes a
  // send can take is what dropped images: each route remembered a different
  // part of the list, and a retry - which changes nothing, and so looked like
  // it owed nothing - skipped the upgrade that every later send reads from.
  function commitSend(p, written, listWritten) {
    // Held, not done. The server discards the turns after this one when the
    // send lands, so the records that describe them are discarded then too -
    // and a send that never reached it truncated nothing, so there is nothing
    // to discard. §store resolves the hold on the send's outcome, and the
    // record written below is restored to what it was if that outcome is a
    // failure. Unconditional, and ahead of the verdict below: a send that
    // backed out of the list, or never had one to write, is still a resend and
    // the server truncates behind it just the same.
    // The conversation goes with it. §store resolves the hold when the
    // response lands, which is long enough for a route change to have made the
    // pathname on screen someone else's.
    // Refusing to hold and refusing to write are one decision: without a hold
    // there is no ordinal this send's outcome can be resolved against, and a
    // record written at that same ordinal is one nothing will ever put back.
    if (!holdSend(p.index, location.pathname)) return false;

    // Either applyPlanTo backed out or there was never a list to write, so the
    // only one to hand is the one the page built, which need not be as long as
    // the thumbs and blobs beside it. A record whose three arrays disagree is
    // worse than the one already on file: prunable() requires thumbs and blobs
    // to match, nameFor() indexes attachments by the thumb's index, and
    // refreshOverride() counts one array and names the other.
    if (!listWritten) {
      dbg('commitSend: the list was not written, the record is left as it stands');
      return false;
    }

    // Bytes already held outrank nothing at all: an entry that was not
    // re-uploaded still has its image in the record, and dropping it there
    // would cost a refetch on the next send that needs one.
    var blobs = p.entries.map(function (entry) {
      if (entry.bytes) return entry.bytes;
      if (entry.kind === 'existing' && p.baseBlobs) return p.baseBlobs[entry.index] || null;
      return null;
    });

    var stored = installOverride(
      p.index,
      p.entries.map(function (entry) { return entry.thumb; }),
      written,
      blobs
    );

    // Whether a stripped send owes a refresh is decided in armSendOutcome, which
    // returns on result.strip before it ever reads result.refresh. Guarding it
    // here as well would state the same rule in a second place, and only one of
    // the two would be reached.
    if (stored) {
      // Everything the upgrade will be aimed by, read here rather than there.
      // It runs 800ms after the response at the earliest, by which time the
      // pathname is whatever the user routed to and the record at this ordinal
      // may belong to a later send; the generation is the one installOverride
      // has just written, and it is what tells that later send's record from
      // this one when both are the same object.
      var justStored = overrideAt(p.index);
      pendingRefresh = {
        index: p.index,
        path: location.pathname,
        conv: conversationId(),
        gen: justStored ? justStored.gen : 0
      };
    }
    // Reloading is the fallback for a record that could not be kept: without
    // one, the message on screen is the one from before this send.
    return !stored;
  }

  // §rewrite =================================================================
  // Set by editorContribution when the record it installed should be upgraded
  // to server references once the resend's response has landed.
  var pendingRefresh = null;
  // Set when the send's conversation tuple was cleared: the real conversation
  // id the streamed response must keep showing.
  var pendingStrip = null;

  // The conversation tuple decides which turn a regenerate is aimed at, so
  // comparing one send against another means comparing this. Values are cut
  // short: the prefix and the length are what tell two ids apart, and the whole
  // id in a log is of no use to anyone.
  function tupleShape(t) {
    if (!Array.isArray(t)) return String(t);
    var out = [];
    for (var i = 0; i < t.length; i++) {
      var v = t[i];
      if (v == null || v === '') continue;
      if (typeof v === 'string') {
        out.push(i + ':' + v.slice(0, 10) + (v.length > 10 ? '…(' + v.length + ')' : ''));
      } else if (Array.isArray(v)) {
        out.push(i + ':array[' + v.length + ']');
      } else {
        out.push(i + ':' + JSON.stringify(v).slice(0, 20));
      }
    }
    return '[' + out.join(' ') + ']';
  }

  // Every index the send actually carries, in one line. A regenerate names its
  // target somewhere, and the only way to find where is to diff a send that has
  // a target against one that does not.
  function innerShape(inner) {
    if (!Array.isArray(inner)) return String(inner);
    var out = [];
    for (var i = 0; i < inner.length; i++) {
      var v = inner[i];
      if (v == null || v === '') continue;
      if (typeof v === 'string') {
        out.push(i + ':"' + v.slice(0, 12) + (v.length > 12 ? '…(' + v.length + ')' : '') + '"');
      } else if (Array.isArray(v)) {
        out.push(i + ':' + tupleShape(v));
      } else {
        out.push(i + ':' + JSON.stringify(v).slice(0, 24));
      }
    }
    return out.join(' ');
  }

  // Returns { body, reload, refresh, strip }; body is the original string when
  // nothing applied.
  function rewrite(url, body) {
    var unchanged = { body: body, reload: false, refresh: null, strip: null };
    if (typeof url !== 'string' || url.indexOf('StreamGenerate') === -1) return unchanged;
    dbg('rewrite: StreamGenerate intercepted, body', typeof body === 'string' ? body.length + ' chars' : typeof body);
    if (typeof body !== 'string') return unchanged;
    if (!forcePro && !imageEditor) { dbg('rewrite: both features off, pass through'); return unchanged; }

    try {
      var doneParse = dbgT('rewrite: parse');
      var params = new URLSearchParams(body);
      var freq = params.get('f.req');
      if (!freq) { dbg('rewrite: no f.req in body, pass through'); return unchanged; }

      var outer = JSON.parse(freq);
      var inner = JSON.parse(outer[1]);
      doneParse();
      if (!Array.isArray(inner) || !Array.isArray(inner[PROMPT_TUPLE])) {
        dbg('rewrite: inner shape unexpected, pass through');
        return unchanged;
      }
      dbg('rewrite: action =', JSON.stringify(inner[ACTION_INDEX])
        + ', prompt "' + String(inner[PROMPT_TUPLE][PROMPT_TEXT]).slice(0, 40) + '"'
        + ', attachments =', attShape(inner[PROMPT_TUPLE][ATTACHMENTS]));
      dbg('rewrite: conversation =', tupleShape(inner[CONVERSATION_INDEX]));
      dbg('rewrite: inner =', innerShape(inner));
      dbg('rewrite: query =', Array.prototype.join.call(
        Array.from(new URLSearchParams(url.split('?')[1] || '').keys()), ','));

      var changed = false;
      var reload = false;
      pendingRefresh = null;
      pendingStrip = null;

      // The sentinel must never reach the server, plan or no plan: a retry of
      // a message without attachments unlocks Update with no plan armed, so
      // the strip cannot live only in applyPlanTo.
      var promptText = inner[PROMPT_TUPLE][PROMPT_TEXT];
      if (typeof promptText === 'string' && promptText.indexOf(SENTINEL) !== -1) {
        inner[PROMPT_TUPLE][PROMPT_TEXT] = promptText.split(SENTINEL).join('');
        changed = true;
        dbg('rewrite: sentinel stripped from prompt text');
      }

      if (forcePro && applyProMarker(inner)) {
        dbg('nbpro: marker injected');
        changed = true;
      }

      var attachmentsChanged = editorContribution(inner);
      if (attachmentsChanged !== null) {
        changed = true;
        reload = attachmentsChanged;
      }

      if (applyStripProbe(inner)) changed = true;

      if (!changed) { dbg('rewrite: nothing changed, original body sent'); return unchanged; }

      var doneSer = dbgT('rewrite: serialise');
      outer[1] = JSON.stringify(inner);
      params.set('f.req', JSON.stringify(outer));
      var newBody = params.toString();
      doneSer();
      dbg('rewrite: reload =', reload + ', refresh =', JSON.stringify(pendingRefresh));
      return { body: newBody, reload: reload, refresh: pendingRefresh, strip: pendingStrip };
    } catch (e) {
      say('warn', LOG_PRO, 'rewrite skipped:', e);
      return unchanged;
    }
  }

  // `sessionStorage.gpieStripNext = '1'` in the console makes the next send go
  // out with the conversation tuple cleared, so the whole path can be measured
  // with a plain text turn instead of an image edit.
  function applyStripProbe(inner) {
    var armed = false;
    try { armed = sessionStorage.getItem('gpieStripNext') === '1'; } catch (e) { }
    if (!armed || pendingStrip) return false;
    try { sessionStorage.removeItem('gpieStripNext'); } catch (e) { }
    var tuple = inner[CONVERSATION_INDEX];
    var conv = Array.isArray(tuple) && typeof tuple[0] === 'string' && tuple[0] ? tuple[0] : null;
    if (!conv) return false;
    inner[CONVERSATION_INDEX] = ['', '', '', null, null, null, null, null, null, ''];
    pendingStrip = conv;
    dbg('rewrite: gpieStripNext flag, conversation tuple cleared, was', conv);
    return true;
  }

  // §net =====================================================================
  // With the conversation tuple cleared the server answers from a conversation
  // of its own. Its id is the same length as the real one, so swapping it
  // inside the streamed text leaves every chunk-length prefix valid; without
  // the swap the page navigates away to /app the moment the first chunk
  // arrives.
  function armResponsePatch(xhr, shownConv) {
    var natText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get;
    var natResp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response').get;
    var answered = null;
    function patched(raw) {
      if (typeof raw !== 'string' || !raw) return raw;
      if (!answered) {
        var m = raw.match(/c_[0-9a-f]{16}/);
        if (m && m[0] !== shownConv) {
          answered = m[0];
          dbg('strip: answered from', answered + ', shown as', shownConv);
        }
      }
      return answered ? raw.split(answered).join(shownConv) : raw;
    }
    Object.defineProperty(xhr, 'responseText', {
      configurable: true,
      get: function () { return patched(natText.call(xhr)); }
    });
    Object.defineProperty(xhr, 'response', {
      configurable: true,
      get: function () { return patched(natResp.call(xhr)); }
    });
  }

  // Reloading is the fallback for a message whose display cannot be taken over,
  // never the normal way of bringing the view back in line. Waiting for the
  // request to finish keeps it from cutting the streamed answer short.
  function scheduleReload() {
    say('log', LOG_IMG, 'resend finished, reloading to resync the view');
    setTimeout(function () { location.reload(); }, 400);
  }

  // One line per send. The attachment half is present only when the editor
  // contributed to it, so an ordinary typed message reports just its own cost
  // and stays comparable with a resend of the same prompt.
  function report(w, tail) {
    var parts = [];
    // The gate stays here rather than inside workParts: a send the editor
    // backed out of has no shape, and its counters describe uploads that are
    // not in the payload.
    if (w.shape) {
      parts.push(w.images + ' images, ' + w.shape);
      parts = parts.concat(workParts(w, ' before the send'));
    }
    parts.push(tail);
    info('send: ' + parts.join(' | '));
  }

  function traceStream(xhr, w) {
    var t0 = Date.now();
    var firstByteAt = null;
    var lastByteAt = null;
    var chunks = 0;
    xhr.addEventListener('progress', function () {
      chunks++;
      lastByteAt = Date.now();
      if (firstByteAt === null) {
        firstByteAt = lastByteAt;
        dbg('xhr: first byte after', ((firstByteAt - t0) / 1000).toFixed(1) + 's');
      }
    });
    xhr.addEventListener('load', function () {
      var end = Date.now();
      dbg('xhr: StreamGenerate closed, status', xhr.status + ',',
        (xhr.responseText || '').length, 'chars,', chunks, 'chunks |',
        'first byte', firstByteAt ? ((firstByteAt - t0) / 1000).toFixed(1) + 's' : 'never',
        '| streaming', firstByteAt ? ((lastByteAt - firstByteAt) / 1000).toFixed(1) + 's' : '-',
        '| tail-to-close', lastByteAt ? ((end - lastByteAt) / 1000).toFixed(1) + 's' : '-',
        '| total', ((end - t0) / 1000).toFixed(1) + 's');
      report(w, 'first byte ' + (firstByteAt ? secs(firstByteAt - t0) : 'never')
        + ' | total ' + secs(end - t0));
      // A status the server refused with is not a truncation either.
      if (xhr.status >= 200 && xhr.status < 300) sendLanded();
      else sendFailed('http ' + xhr.status);
      noteGenerationFinished();
    });
    xhr.addEventListener('error', function () {
      dbg('xhr: StreamGenerate errored after', ((Date.now() - t0) / 1000).toFixed(1) + 's');
      report(w, 'failed after ' + secs(Date.now() - t0));
      sendFailed('the request errored');
    });
    xhr.addEventListener('abort', function () {
      dbg('xhr: StreamGenerate aborted after', ((Date.now() - t0) / 1000).toFixed(1) + 's');
      report(w, 'aborted after ' + secs(Date.now() - t0));
      sendFailed('the request was aborted');
    });
  }

  // What a rewritten send owes once it is on its way, in one place. Both
  // transports route here; the fetch hook carried a shortened copy of this that
  // skipped the response patch and treated every send that was not a reload as
  // one due a refresh.
  //
  //   strip    the conversation tuple was cleared, so the streamed response has
  //            to be patched, and a reload would fetch a conversation that does
  //            not hold this turn
  //   reload   the record could not be kept, so the page is resynchronised
  //   refresh  the record is due its upgrade to the server's own references
  //
  // whenDone runs its callback after the response lands, however the transport
  // reports that.
  function armSendOutcome(result, xhr, whenDone) {
    if (result.strip) {
      if (xhr) armResponsePatch(xhr, result.strip);
      else dbg('outcome: no response patch on the fetch path, the send is left alone');
      if (result.reload) {
        dbg('outcome: display takeover failed, but a reload would drop this turn, so it is skipped');
      }
      return;
    }
    if (result.reload) {
      whenDone(scheduleReload);
      return;
    }
    if (result.refresh) {
      var refresh = result.refresh;
      dbg('outcome: reference refresh armed for message #' + refresh.index);
      whenDone(function () {
        // After the stream closes the turn is on the server, so its durable
        // references can be fetched; the delay leaves room for the commit.
        setTimeout(function () {
          refreshOverride(refresh.index, 0, refresh.conv, refresh.path, refresh.gen);
        }, 800);
      });
    }
  }

  var xhrOpen = XMLHttpRequest.prototype.open;
  var xhrSend = XMLHttpRequest.prototype.send;
  var xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gemUrl = url;
    return xhrOpen.apply(this, arguments);
  };

  // The upload path needs headers the page mints for itself. Taking them off a
  // live request keeps working even when the WIZ_global_data key names change.
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      var key = String(name).toLowerCase();
      if (key === 'x-client-pctx' || key === 'push-id') sniffed[key] = value;
    } catch (e) {
      // Header sniffing must never break the request it rode in on.
    }
    return xhrSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    rememberToken(body);
    // §library keeps the conversation-load request so it can replay one later.
    noteLibraryRpc(this.__gemUrl, body);
    // §origins reads the answers this page gets wherever they go by.
    tapRpcXhr(this, this.__gemUrl);
    var result = rewrite(this.__gemUrl, body);
    if (typeof this.__gemUrl === 'string' && this.__gemUrl.indexOf('StreamGenerate') !== -1) {
      dbg('xhr: sending StreamGenerate, body', result.body === body ? 'untouched' : 'rewritten');
      keepBody(this.__gemUrl, result.body, result.body !== body);
      traceStream(this, takeWork());
    }

    var xhr = this;
    armSendOutcome(result, xhr, function (then) {
      xhr.addEventListener('load', then);
    });
    return xhrSend.call(this, result.body);
  };

  // fetch is hooked as well so a future migration off XHR does not silently
  // break either feature. There is no response patch on this path, so a send
  // that cleared its conversation tuple is left alone after it goes out.
  //
  // Both windows are patched, and the page's is the one that matters. With
  // A manager that keeps a script apart from the page hands it a `window` of
  // its own: patching that one catches this script's own calls and not a
  // single one of the page's. XMLHttpRequest.prototype is shared with the
  // page, which is why the hook above saw everything while this one saw
  // nothing at all. `@sandbox raw` in the header settles it - the two windows
  // are one - and both are still patched so a manager that ignores the
  // directive is covered.
  var fetchSendSeen = false;

  // One owner for "did the server turn this send down". It decides two separate
  // consequences - whether the records roll back, and whether the reload, the
  // reference refresh and the cost line run - and those consequences sat behind
  // two copies of the same comparison inside one function. A later allowance on
  // one copy alone (a 3xx, a 204) would roll a send's records back while still
  // arming a refresh for it, or land them while treating the send as refused.
  function serverRefused(res) {
    return !!res && (res.status < 200 || res.status >= 300);
  }

  function hookFetch(scope) {
    var nativeFetch = scope && scope.fetch;
    if (typeof nativeFetch !== 'function') return;
    scope.fetch = function (input, init) {
      var result = null;
      var url = '';
      // Read before init is replaced below, which is what makes the two bodies
      // equal from that point on.
      var touched = false;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        if (init && typeof init.body === 'string') {
          rememberToken(init.body);
          noteLibraryRpc(url, init.body);
          result = rewrite(url, init.body);
          touched = result.body !== init.body;
          if (touched) init = Object.assign({}, init, { body: result.body });
        }
      } catch (e) {
        say('warn', LOG_PRO, 'fetch hook skipped:', e);
      }
      var promise = tapRpcFetch(url, nativeFetch.call(this, input, init));
      // Nothing on this path traces the stream, so a send is settled on its own
      // response. Only a send: any other fetch resolving first would settle a
      // hold that belongs to the request still in flight.
      var sent = null;
      var t0 = 0;
      if (result && url.indexOf('StreamGenerate') !== -1) {
        // Everything the XHR branch owes a send it is about to make, minus the
        // stream trace this transport cannot give. The counters have to be
        // taken here whether or not anything reads them: left where they are,
        // they describe this send's uploads to whichever plan opens next. And
        // the cost line is the number every §shape decision is measured
        // against, so a migration off XHR must not be what silences it.
        sent = takeWork();
        t0 = Date.now();
        keepBody(url, result.body, touched);
        if (!fetchSendSeen) {
          fetchSendSeen = true;
          say('warn', LOG_IMG, 'StreamGenerate went out over fetch — stream tracing does not'
            + ' cover this transport, timings are per-request only');
        }
        promise = promise.then(function (res) {
          if (serverRefused(res)) sendFailed('http ' + res.status);
          else sendLanded();
          return res;
        }, function (err) {
          sendFailed('the fetch failed');
          throw err;
        });
      }
      if (!result) return promise;
      var then = null;
      armSendOutcome(result, null, function (fn) { then = fn; });
      if (!sent && !then) return promise;
      return promise.then(function (res) {
        // A resolved response is not a made turn. Reloading on a refusal
        // resynchronises the view onto a turn that is not there, and a
        // reference refresh armed against one can only fail, so a send the
        // server turned down is owed neither.
        if (serverRefused(res)) {
          say('warn', LOG_IMG, 'send: the server refused it, status ' + res.status
            + ' — no reload and no reference refresh follow');
          return res;
        }
        // Nothing here sees the first byte, so the one span this transport can
        // report is the whole request.
        if (sent) {
          report(sent, 'first byte unavailable on this transport'
            + ' | total ' + secs(Date.now() - t0));
        }
        if (then) then();
        if (sent) noteGenerationFinished();
        return res;
      });
    };
  }

  hookFetch(window);
  if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow !== window) {
    hookFetch(unsafeWindow);
  }

