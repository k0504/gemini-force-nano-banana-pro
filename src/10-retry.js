  // §retry ===================================================================
  // Gemini offers a regenerate only on the newest turn, so once a follow-up
  // exists an older generation cannot be re-rolled from the page. The retry
  // here is the editor's own resend with nothing changed: the message goes out
  // again as it stands and the server's own resend semantics apply - the new
  // answer replaces the old one and the turns after it are discarded. The
  // button is armed by a first press and fires on the second, because a stray
  // click must not be what discards half a conversation.
  var RETRY_STEP_MS = 4000;
  var RETRY_UPLOAD_MS = 30000;
  var RETRY_POLL_MS = 60;
  var retryPending = false;

  // The arming window. One button at a time holds it, and it lapses on its own
  // so a press left behind cannot be completed by a click made minutes later
  // with something else on screen.
  var RETRY_ARM_MS = 6000;
  var RETRY_TITLE = 'Resend this message as it stands and regenerate its answer. '
    + 'The turns after it are replaced, as with an edit.';
  var RETRY_ARMED_TITLE = 'Click again to resend. The turns after this message are discarded.';
  var armed = null;
  var armedTimer = 0;

  function disarm() {
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = 0; }
    if (!armed) return;
    armed.classList.remove('gpie-armed');
    armed.title = RETRY_TITLE;
    armed = null;
  }

  function arm(btn) {
    disarm();
    armed = btn;
    btn.classList.add('gpie-armed');
    btn.title = RETRY_ARMED_TITLE;
    info(LOG_IMG, 'retry: armed, click again within ' + (RETRY_ARM_MS / 1000) + 's to resend');
    armedTimer = setTimeout(function () {
      armedTimer = 0;
      info(LOG_IMG, 'retry: the arming lapsed, nothing was sent');
      disarm();
    }, RETRY_ARM_MS);
  }

  function waitUntil(check, timeout, then) {
    var deadline = performance.now() + timeout;
    (function poll() {
      var got = check();
      if (got) return then(got);
      if (performance.now() > deadline) return then(null);
      setTimeout(poll, RETRY_POLL_MS);
    })();
  }

  // The aria-label is localised; the icon name is not.
  function editButtonOf(host) {
    var icons = host.querySelectorAll('.luminous-actions-container mat-icon');
    for (var i = 0; i < icons.length; i++) {
      var name = icons[i].getAttribute('fonticon') || icons[i].getAttribute('data-mat-icon-name');
      if (name === 'edit') return icons[i].closest('button');
    }
    return null;
  }

  function pressUpdate(host, attempt) {
    attempt = attempt || 1;
    waitUntil(function () {
      var btn = host.querySelector('gem-button.update-button button');
      return btn && !btn.disabled ? btn : null;
    }, RETRY_STEP_MS, function (btn) {
      if (!btn) {
        retryPending = false;
        // The no-plan path arms a hold by hand before pressing. No request is
        // going out now, so that hold is abandoned here rather than left for an
        // unrelated send to claim.
        dropHold();
        say('warn', LOG_IMG, 'retry: the Update button never unlocked; press it or cancel');
        return;
      }
      dbg('retry: pressing Update, attempt', attempt);
      btn.click();
      // A synthetic click on this button is documented unreliable: Angular can
      // swallow it and reset its text baseline, dropping the button back to
      // disabled with no request fired. Success shows as edit mode gone - the
      // send destroys the node, so a detached host counts too. Anything else
      // is answered by re-shaking the sentinel and pressing again.
      waitUntil(function () {
        return !host.isConnected || !host.classList.contains('edit-mode') ? true : null;
      }, 2500, function (closed) {
        if (closed) {
          retryPending = false;
          // Edit mode going away is read as the send having departed, but it is
          // read off the DOM and edit mode can also go away without a request -
          // a Cancel that lands between two polls looks exactly like this. A
          // hold left armed here is claimed by the next unrelated send, which
          // then truncates records at an ordinal it never touched, so it is
          // discarded. Discarding it is safe in the other direction: a request
          // that did depart took the hold with it at the transport hook, so the
          // slot is already empty and this is then nothing at all.
          dropHold();
          return;
        }
        if (attempt >= 3) {
          retryPending = false;
          // As above: the presses fired no request, so a hold armed by hand for
          // this retry is discarded rather than left armed.
          dropHold();
          say('warn', LOG_IMG, 'retry: Update ignored', attempt, 'presses; press it or cancel');
          return;
        }
        var textarea = host.querySelector('textarea');
        if (textarea) {
          writeTextarea(textarea, textarea.value.split(SENTINEL).join(''));
          writeTextarea(textarea, textarea.value + SENTINEL);
        }
        pressUpdate(host, attempt + 1);
      });
    });
  }

  // The whole stretch between the press and the Update is invisible to the
  // send's own report, because none of it happens on the request. A retry that
  // feels slow is usually slow here, so the wait is stated on its own line and
  // broken into the parts it was spent on.
  function reportRetryLead(t0) {
    // The live counters, not the captured ones report() is handed: this line is
    // printed before the send exists, so there is nothing to have captured yet.
    var parts = ['retry: ready in ' + secs(performance.now() - t0)]
      .concat(workParts(work, ''));
    info(parts.join(' | '));
  }

  // Sending what the message holds is safe only while the server still honours
  // those references. A message that has never been resent carries the tokens
  // the page itself was given, which it does. A record written by a resend
  // carries contrib paths until refreshOverride upgrades them to tokens, and
  // that upgrade can fail; a contrib minted by an earlier document is expired
  // besides. Those, and only those, are re-uploaded before the retry fires.
  function retryNeedsFresh(p) {
    if (!p.base) return false;
    return p.base.some(function (att) {
      return attClass(att) === 'contrib-stale';
    });
  }

  function startRetry(host) {
    if (retryPending) return;
    if (document.querySelector('div.user-query-container.edit-mode')) {
      info('retry: close the open editor first');
      return;
    }
    var editBtn = editButtonOf(host);
    if (!editBtn) {
      say('warn', LOG_IMG, 'retry: no edit button on this message');
      return;
    }
    retryPending = true;
    var t0 = performance.now();
    dbg('retry: opening edit mode on message #' + indexOfHost(host));
    editBtn.click();
    waitUntil(function () {
      if (!host.classList.contains('edit-mode')) return null;
      var textarea = host.querySelector('textarea');
      if (!textarea) return null;
      // A message without attachments never arms a plan; the textarea is all
      // there is to wait for on that path. One that carries attachments does
      // arm one, and the plan is made by the scan pass, which the observer
      // queues after this poll can already see the textarea. Returning then
      // handed the retry a null plan, so retryNeedsFresh never ran and the
      // record's dead references went out as they stood.
      var p = plan && plan.host === host ? plan : null;
      if (!p && host.querySelector('user-query-file-preview')) return null;
      return { p: p, textarea: textarea };
    }, RETRY_STEP_MS, function (got) {
      if (!got) {
        retryPending = false;
        say('warn', LOG_IMG, 'retry: edit mode did not open, or its plan never armed');
        return;
      }
      dbg('retry: edit mode open, plan =', got.p ? '#' + got.p.index : 'none');
      if (got.p) {
        got.p.retry = true;
        // Straight to renderBar rather than a scan pass, because ensureBar
        // returns early while the toolbar is connected and the sentinel that
        // unlocks Update is applied by renderBar's syncSentinel, nowhere else.
        renderBar(got.p);
        if (retryNeedsFresh(got.p)) {
          got.p.retryFresh = true;
          info('retry: the record holds references this document cannot send, '
            + 're-uploading before the retry');
          freshenExisting(got.p);
          waitUntil(function () {
            return planIsReady(got.p) || null;
          }, RETRY_UPLOAD_MS, function (ready) {
            if (!ready) {
              // The deadline expiring is not the whole story: the send goes out
              // regardless, and what it goes out as is what the user waits for.
              say('warn', LOG_IMG, 'retry: re-upload unfinished, sending what is held'
                + ', the send cannot take the fast shape and may carry references '
                + 'the server no longer honours');
            }
            reportRetryLead(t0);
            pressUpdate(host);
          });
        } else {
          // Nothing to wait for: the references the message carries are ones
          // this document can send as they stand.
          reportRetryLead(t0);
          pressUpdate(host);
        }
      } else {
        // No plan to report dirty through, so the sentinel is written by hand;
        // rewrite() strips it with or without a plan.
        writeTextarea(got.textarea, got.textarea.value + SENTINEL);
        // And the hold by hand with it. Whether the records this resend
        // discards are dealt with was answered by "does a plan exist", which
        // the editor decides for its own unrelated reason - a message with no
        // attachment and no preview container gets no plan at all, so a retry
        // of one truncated the thread on the server and left every later
        // record behind for syncOverrides to draw over whichever messages take
        // those ordinals next. The server truncates on the resend, not on the
        // toolbar being drawn.
        holdSend(indexOfHost(host), location.pathname);
        reportRetryLead(t0);
        pressUpdate(host);
      }
    });
  }

  // The native regenerate control, replicated: Gemini renders its own only on
  // the newest turn, so an older turn gets a clone of that rendered node -
  // the scoped style attributes ride along, so it is pixel-identical - wired
  // to the retry above instead of the menu Angular would have opened. The
  // message the click retries is resolved at click time, because Angular may
  // have rebuilt the turn since the button was placed.
  function makeRetryButton(template) {
    var wrap = template.cloneNode(true);
    wrap.classList.add('gpie-retry');
    var gem = wrap.querySelector('gem-icon-button');
    if (gem) {
      gem.removeAttribute('aria-haspopup');
      gem.removeAttribute('aria-expanded');
      gem.removeAttribute('aria-controls');
      gem.removeAttribute('data-test-id');
    }
    var btn = wrap.querySelector('button');
    if (btn) {
      btn.title = RETRY_TITLE;
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        // The clone is removed while any message is open for editing, so this
        // answers only the press that beats the next scan pass to it - and the
        // press that lands on a clone Angular has kept in a row it rebuilt.
        // Either way the retry would open edit mode on a message already open
        // for editing, which throws the edit being made away.
        if (document.querySelector('div.user-query-container.edit-mode')) {
          disarm();
          say('warn', LOG_IMG, 'retry: refused - a message is open for editing');
          return;
        }
        var turn = wrap.closest('.conversation-container');
        var host = turn && turn.querySelector('div.user-query-container');
        if (!host) return;
        // Armed by the first press, fired by the second. What this button does
        // is discard every turn after the message, so a stray click - and the
        // clone sits where the page's own controls are - must not be what
        // spends half a conversation.
        if (armed === btn) {
          disarm();
          startRetry(host);
          return;
        }
        arm(btn);
      });
    }
    return wrap;
  }

  // Placed where the native one would be, first in the response's action row,
  // on every turn that lacks one. A rebuild that drops the clone is answered
  // by the next scan pass putting it back.
  function ensureRetryButtons() {
    var native = document.querySelector('regenerate-button');
    var template = native && native.parentElement;
    if (!template) return;
    var actions = document.querySelectorAll('message-actions');
    for (var i = 0; i < actions.length; i++) {
      var bar = actions[i].querySelector('.buttons-container-v2');
      var turn = actions[i].closest('.conversation-container');
      if (!bar || !turn) continue;
      if (bar.querySelector('regenerate-button') || bar.querySelector('.gpie-retry')) continue;
      if (!turn.querySelector('div.user-query-container')) continue;
      // At the slot the native one occupies in its own row, read off the
      // template, so the row reads identically on every turn.
      var slot = Array.prototype.indexOf.call(template.parentElement.children, template);
      bar.insertBefore(makeRetryButton(template), bar.children[slot] || null);
    }
  }

  function removeRetryButtons() {
    var stale = document.querySelectorAll('.gpie-retry');
    // The armed button is one of these when the page rebuilds the row, and a
    // reference to a node no longer in the tree cannot be disarmed by a click.
    if (armed && !document.contains(armed)) disarm();
    for (var i = 0; i < stale.length; i++) {
      if (armed && stale[i].contains(armed)) disarm();
      stale[i].remove();
    }
  }

