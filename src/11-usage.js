  // §usage ===================================================================
  // The account's quota, drawn over the line under the composer that says
  // Gemini can make mistakes. That line is the only strip of the chat window
  // always on screen whose content nothing else depends on.
  //
  // Reading the quota is one rpc that takes no arguments, and §protocol holds
  // what its answer means. What is decided here is when to ask. The numbers
  // move only when a generation lands, so every trigger below is either that
  // event, a moment the held numbers are known to have expired, or a slow poll
  // for what happened in another tab.
  var USAGE_FLOOR_MS = 5000;
  var USAGE_POLL_MS = 5 * 60 * 1000;
  var USAGE_FRESH_MS = 60 * 1000;
  var USAGE_SETTLE_MS = 5000;
  var USAGE_RECHECK_MS = 15000;
  var USAGE_RESET_GRACE_MS = 3000;
  var USAGE_FAIL_MS = 60 * 1000;
  var USAGE_FAIL_MAX_MS = 10 * 60 * 1000;

  var usage = {
    windows: null,   // by kind, so the answer's own order never matters
    readAt: 0,
    lastTry: 0,
    backoff: 0,      // raised by a failure, cleared by a read that lands
    inFlight: null,
    resetTimer: null,
    line: null,
    parts: null,
    button: null,
    drawn: null      // what the line last had written into it
  };

  function usedFraction(kind) {
    var w = usage.windows && usage.windows[kind];
    return w && typeof w.used === 'number' ? w.used : null;
  }

  // Answers whether the payload was recognised. An answer whose shape has
  // moved parses to an empty object, and an empty object is truthy: adopted, it
  // would clear the backoff, draw `Current - | Weekly -` for good, and keep
  // Gemini's own line hidden behind it by the rule that keys off ours being
  // present - a blank the user cannot tell from a quota the server declines to
  // report. Nothing is written unless at least one window came back with a
  // number in it.
  // One owner for "is there a number here worth showing". Adoption counted a
  // window as readable on either field being present while the line that draws
  // it needs `used` specifically, so a payload carrying only `remaining` was
  // adopted, stamped as read, and cleared the backoff - and then drew a bare
  // dash, having already hidden Gemini's own disclaimer to make room for it.
  function windowIsDrawable(w) {
    return !!w && typeof w.used === 'number';
  }

  function adoptUsage(payload) {
    var list = Array.isArray(payload) && Array.isArray(payload[1]) ? payload[1] : [];
    var next = {};
    var readable = 0;
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!Array.isArray(w)) continue;
      var stamp = Array.isArray(w[3]) && Array.isArray(w[3][0]) ? w[3][0][0] : null;
      var win = {
        remaining: typeof w[0] === 'number' ? w[0] : null,
        used: typeof w[1] === 'number' ? w[1] : null,
        resetAt: typeof stamp === 'number' ? stamp * 1000 : null
      };
      if (windowIsDrawable(win)) readable++;
      next[w[2]] = win;
    }
    if (!readable) return false;
    usage.windows = next;
    usage.readAt = Date.now();
    usage.backoff = 0;
    dbg('usage:', partText('current', USAGE_CURRENT), '|', partText('weekly', USAGE_WEEKLY));
    armResetRead();
    return true;
  }

  // A session that has expired would otherwise be asked on every trigger and
  // refused every time. Both failures raise it: a read that could not be made
  // and a read whose answer could not be understood are the same to the next
  // trigger.
  function raiseUsageBackoff() {
    usage.backoff = Math.min(usage.backoff ? usage.backoff * 2 : USAGE_FAIL_MS,
      USAGE_FAIL_MAX_MS);
    return Math.round(usage.backoff / 1000) + 's';
  }

  var usageShapeSeen = false;

  // Every trigger comes through here, so the floor between two calls, the one
  // request in flight and the backoff after a failure are stated once. force
  // skips the floor, for the moments the numbers are known to have changed. It
  // does not skip the visibility check: a tab nobody is looking at has nothing
  // to draw, and reads again when it is looked at.
  function readUsage(reason, force) {
    if (!usageDisplay) return Promise.resolve(null);
    if (usage.inFlight) return usage.inFlight;
    if (document.visibilityState === 'hidden') return Promise.resolve(null);
    var floor = usage.backoff || USAGE_FLOOR_MS;
    if (!force && Date.now() - usage.lastTry < floor) return Promise.resolve(null);
    usage.lastTry = Date.now();
    dbg('usage: reading,', reason);
    usage.inFlight = batchExecute(USAGE_RPC, [], 'usage').then(function (payload) {
      usage.inFlight = null;
      if (!adoptUsage(payload)) {
        // The read did not land, so it is treated as one that did not: the
        // held numbers stay as they are, and with none held the line is never
        // made and Gemini's own text stays where it is.
        var again = raiseUsageBackoff();
        if (!usageShapeSeen) {
          usageShapeSeen = true;
          say('warn', LOG_IMG, 'usage payload shape unrecognized, the quota line is left undrawn');
        }
        dbg('usage: no window read out of the answer | next read no sooner than', again);
        schedule();
        return null;
      }
      // A scan pass rather than a redraw: the line is made by that pass, and
      // on a page nothing else is mutating there would otherwise be no pass to
      // make it.
      schedule();
      return payload;
    }, function (err) {
      usage.inFlight = null;
      var again = raiseUsageBackoff();
      dbg('usage: read failed:', String((err && err.message) || err),
        '| next read no sooner than', again);
      schedule();
      return null;
    });
    // The button says a read is under way, so it has to be redrawn as one
    // starts rather than only when it lands.
    renderUsage();
    return usage.inFlight;
  }

  // The one change that happens without anything being sent. A read scheduled
  // for it costs a single request and is the difference between the line
  // correcting itself as the window turns over and sitting on a spent quota
  // until the next poll.
  function armResetRead() {
    if (usage.resetTimer) clearTimeout(usage.resetTimer);
    usage.resetTimer = null;
    var soonest = null;
    var now = Date.now();
    for (var kind in usage.windows) {
      var at = usage.windows[kind].resetAt;
      if (at && at > now && (soonest === null || at < soonest)) soonest = at;
    }
    if (soonest === null) return;
    usage.resetTimer = setTimeout(function () {
      usage.resetTimer = null;
      readUsage('window reset', true);
    }, soonest - now + USAGE_RESET_GRACE_MS);
  }

  // Drawn rather than set in the icon font Gemini renders its own controls
  // with: that font is named by its own stylesheet, and a control of ours that
  // silently falls back to the literal word refresh is worse than one that
  // does not match the page's icon set exactly.
  var REFRESH_PATH = 'M12 5V2L8 6l4 4V7c2.76 0 5 2.24 5 5 0 .85-.21 1.65-.58 2.35'
    + 'l1.46 1.46A6.94 6.94 0 0 0 19 12c0-3.87-3.13-7-7-7zm0 12c-2.76 0-5-2.24-5-5 '
    + '0-.85.21-1.65.58-2.35L6.12 8.19A6.94 6.94 0 0 0 5 12c0 3.87 3.13 7 7 7v3l4-4'
    + '-4-4v3z';

  function makeRefreshButton() {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'gpie-usage-refresh';
    button.title = 'Read the usage again';
    button.setAttribute('aria-label', 'Read the usage again');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', REFRESH_PATH);
    svg.appendChild(path);
    button.appendChild(svg);
    button.addEventListener('click', function () { readUsage('refresh button', true); });
    return button;
  }

  function clock(ms) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function grouped(n) {
    var s = String(n);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ',';
      out += s.charAt(i);
    }
    return out;
  }

  // A window whose reset has gone by is not merely old, it is wrong: the
  // server has started a fresh one and every number held for it belongs to the
  // window that ended.
  function partText(label, kind) {
    var w = usage.windows && usage.windows[kind];
    if (!windowIsDrawable(w)) return label + ' -';
    if (w.resetAt && Date.now() >= w.resetAt) return label + ' -';
    var text = label + ' ' + (w.used * 100).toFixed(1) + '%';
    if (w.remaining !== null) text += ' · ' + grouped(w.remaining) + ' left';
    if (w.resetAt) text += ' · resets ' + clock(w.resetAt);
    return text;
  }

  function renderUsage() {
    if (!usage.line) return;
    var current = partText('Current', USAGE_CURRENT);
    var weekly = partText('Weekly', USAGE_WEEKLY);
    var stale = usage.backoff > 0;
    var busy = usage.inFlight !== null;
    var drawn = [current, weekly, stale ? 'stale' : 'fresh', busy ? 'busy' : 'idle',
      usage.readAt].join('|');
    // Writing on every scan pass would be a mutation on every scan pass, and
    // the observer that schedules those passes sees every one of them.
    if (drawn === usage.drawn) return;
    usage.drawn = drawn;
    usage.parts[0].textContent = current;
    usage.parts[1].textContent = weekly;
    usage.line.title = usage.readAt ? 'Read at ' + clock(usage.readAt) : '';
    if (stale) usage.line.classList.add('gpie-usage-stale');
    else usage.line.classList.remove('gpie-usage-stale');
    if (busy) usage.button.classList.add('gpie-usage-busy');
    else usage.button.classList.remove('gpie-usage-busy');
  }

  // Called from every scan pass. The anchor comes and goes with the composer
  // and Angular rebuilds it on its own account, so what is checked is that the
  // line is still a child of the anchor on screen, not that one was made once.
  //
  // Gemini's own text is hidden by a rule that keys off this line being
  // present, so until the first read lands nothing is drawn and the page reads
  // exactly as it did before. That is also what a session which cannot reach
  // the rpc is left with.
  function ensureUsageLine() {
    if (!usageDisplay) return;
    var box = document.querySelector('hallucination-disclaimer div.capabilities-disclaimer');
    if (!box) {
      usage.line = null;
      usage.drawn = null;
      return;
    }
    if (!usage.windows) {
      readUsage('first paint');
      return;
    }
    if (!usage.line || usage.line.parentNode !== box) {
      usage.line = document.createElement('p');
      usage.line.className = 'gds-body-s desktop-spacing gpie-usage';
      usage.parts = [document.createElement('span'), document.createElement('span')];
      usage.parts[0].className = 'gpie-usage-part';
      usage.parts[1].className = 'gpie-usage-part';
      usage.button = makeRefreshButton();
      usage.line.appendChild(usage.parts[0]);
      usage.line.appendChild(usage.parts[1]);
      usage.line.appendChild(usage.button);
      usage.drawn = null;
      box.appendChild(usage.line);
    }
    renderUsage();
  }

  // Removing a node of our own is not the case the traps section warns about:
  // what makes Angular rebuild a strip is losing a node it manages, and
  // Gemini's own line is only ever hidden.
  function detachUsageLine() {
    if (usage.line && usage.line.parentNode) usage.line.parentNode.removeChild(usage.line);
    usage.line = null;
    usage.parts = null;
    usage.button = null;
    usage.drawn = null;
  }

  // The server has not necessarily accounted for a turn by the time its stream
  // closes, so the read waits. If it comes back with the fraction the send
  // started from, one later read covers an accounting lag longer than that
  // wait. Two reads per generation at most, either way.
  function noteGenerationFinished() {
    if (!usageDisplay) return;
    var before = usedFraction(USAGE_CURRENT);
    setTimeout(function () {
      readUsage('generation finished', true).then(function () {
        if (before === null || usedFraction(USAGE_CURRENT) !== before) return;
        setTimeout(function () {
          readUsage('generation still unaccounted for', true);
        }, USAGE_RECHECK_MS);
      });
    }, USAGE_SETTLE_MS);
  }

  function startUsageWatch() {
    setInterval(function () { readUsage('poll'); }, USAGE_POLL_MS);
    // Returning to the tab is when a held number is most likely to be read as
    // a current one.
    function wake() {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - usage.readAt > USAGE_FRESH_MS) readUsage('tab looked at');
    }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    readUsage('start');
  }

