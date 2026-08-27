  // §protocol ================================================================
  //
  // A Gemini request body carries exactly two fields: f.req and at (CSRF).
  //   f.req = JSON.stringify([null, JSON.stringify(inner)])
  //   inner is a positional array; inner[0] is the prompt tuple.
  //
  //   inner[0][0]  prompt text
  //   inner[0][3]  attachments, in the order the prompt calls image 1 / 2 / 3
  //   inner[0][9]  image model selector
  //   inner[2]     conversation tuple: [0] c_<id>, [1] r_<id> of the previous
  //                turn, [2] rc_<id>, [9] a resume blob present only on an edit
  //                resend
  //   inner[72]    action: null first send, 2 edit resend,
  //                5 plain regenerate, 7 Pro regenerate
  //
  // Attachments come in two shapes and may be mixed inside one array:
  //   form A (already on the message)  [[null,1,1,mime], name, "<long token>"]
  //   form B (uploaded this document)  [[contribPath,1,null,mime,uuid], name,
  //                                     null,null,null,null,null,null,[0]]
  //
  // A brand-new upload send carries form B in two elements, without that tail.
  // The tail belongs to an edit resend, and the two must not be mixed: see
  // §shape for what the server charges for each difference.
  //
  // Both features rewrite the same request, so the body is parsed and
  // serialised once and each feature edits the shared inner array in place.
  var PROMPT_TUPLE = 0;
  var PROMPT_TEXT = 0;
  var ATTACHMENTS = 3;
  var MODEL_MARKER = 9;
  var CONVERSATION_INDEX = 2;
  // Inside the conversation tuple. Present only on an edit resend, and the one
  // element of that tuple that marks the send as one: see §shape.
  var RESUME_INDEX = 9;
  var ACTION_INDEX = 72;
  var ACTION_EDIT_RESEND = 2;

  // Verified against a three-way diff of first pass / plain retry / Pro retry.
  // The trailing 1 is the switch: 0 selects Nano Banana 2, 1 selects Pro.
  var PRO_MARKER = [null, null, null, null, null, null, [null, [1]]];

  var UPLOAD_ENDPOINT = 'https://push.clients6.google.com/upload/';
  var PROCESS_FILE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/ProcessFile';
  var BATCH_EXECUTE_PATH = '/_/BardChatUi/data/batchexecute';
  var LIST_CONVERSATION_RPC = 'hNvQHb';

  // The quota read behind the /usage page. It takes no arguments and answers
  //   [tier, windows, flag]
  // where each window is
  //   [remaining, usedFraction, kind, [[epochSeconds, nanos]]]
  // kind 1 being the rolling window that page labels current usage and kind 2
  // the weekly cap. remaining is in the same opaque units the cap is counted
  // in: the weekly window came back as 7484 remaining against a fraction of
  // 0.8453027, and the total the /usage page's own indicator rpc reports for
  // that window, 48384, is what those two multiply back out to.
  //
  // The two windows are not in a fixed order - one session answered kind 1
  // first and then kind 2 first - so §usage keys them by kind and never by
  // position.
  var USAGE_RPC = 'jSf9Qc';
  var USAGE_CURRENT = 1;
  var USAGE_WEEKLY = 2;
  var CONTRIB_PREFIX = '/contrib_service/';

  // WIZ_global_data keys the page exposes. They are obfuscated build symbols, so
  // values sniffed off live requests take precedence and these are the fallback.
  var WIZ_KEYS = { pctx: 'Ylro7b', pushId: 'qKIAYe', at: 'SNlM0e', bl: 'cfb2h', sid: 'FdrFJe' };

  // §config ==================================================================
  var VERSION = '3.49.0';

  // Gemini keeps its own Update button disabled until the prompt text differs
  // from what the message already holds, so an image-only change cannot be
  // submitted through it. Appending a zero-width space is enough to satisfy that
  // check, and the character is stripped back out of the payload on the way out,
  // so the prompt that reaches the server is byte for byte the original one.
  var SENTINEL = String.fromCharCode(0x200B);

  // A plan survives the moment edit mode closes, because the update click tears
  // the editor down and fires the request in the same tick. The window is only
  // wide enough to cover that hand-off.
  var PLAN_TTL_MS = 15000;

  // How much of the stored image bytes is kept. Nothing expires on a clock:
  // dropping bytes only makes the next resend slower, so there is no reason to
  // drop any while there is room. Past this, the least recently touched
  // conversations give theirs up. See §store.
  var BLOB_BUDGET = 50 * 1024 * 1024;

  var LOG_PRO = '[nbpro]';
  var LOG_IMG = '[gpie]';

  // §trace ===================================================================
  // Two levels, and the difference between them is the point of this section.
  //
  //   dbg()   step-by-step trace of everything the script intercepts and
  //           writes, several hundred lines per send. Off by default, turned on
  //           from the manager menu, and only worth reading while a change to
  //           the send shape is being made. Every line is also kept in
  //           sessionStorage, because a reload wipes the console and some of
  //           what is worth reading happens immediately before one; the kept
  //           lines are replayed on the next start so nothing is lost.
  //
  //   info()  the one line printed per send whether or not the trace is on:
  //           what the send cost. That is the number §shape is measured
  //           against, so it is never behind the flag.
  var DBG_STORE = 'gpieDbgLog';
  var STORE_DBG = 'gpieDebugTrace';
  var debugTrace = typeof GM_getValue === 'function'
    ? GM_getValue(STORE_DBG, false) : false;

  // The console this script writes to is the page's own, which is where an
  // cannot read it: from a browser driven from outside, a script that logged
  // and one that never ran looked the same, and that cost more time than any
  // bug it was hiding. `unsafeWindow` is granted in the header, so every line
  // this script writes goes to the page's console instead - the one an
  // inspector, a driver and the user are all already looking at.
  var pageConsole = (function () {
    try {
      var w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (w && w.console && typeof w.console.log === 'function') return w.console;
    } catch (e) {
      // A manager that does not hand the page over leaves this one as it is.
    }
    return console;
  })();

  function say(level) {
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      (pageConsole[level] || pageConsole.log).apply(pageConsole, args);
    } catch (e) {
      (console[level] || console.log).apply(console, args);
    }
  }

  function dbg() {
    if (!debugTrace) return;
    var line = Array.prototype.map.call(arguments, function (a) {
      return typeof a === 'string' ? a : JSON.stringify(a);
    }).join(' ');
    var stamp = new Date().toISOString().slice(11, 23);
    say('log', '[gpie:dbg]', stamp, line);
    try {
      var kept = JSON.parse(sessionStorage.getItem(DBG_STORE) || '[]');
      kept.push(stamp + ' ' + line);
      while (kept.length > 300) kept.shift();
      sessionStorage.setItem(DBG_STORE, JSON.stringify(kept));
    } catch (e) {
      // Storage full or unavailable; the live console line already went out.
    }
  }

  function replayDbg() {
    try {
      // Lines kept while the trace was on are dropped rather than replayed once
      // it is off, so turning it off takes effect on the very next reload.
      if (!debugTrace) { sessionStorage.removeItem(DBG_STORE); return; }
      var kept = JSON.parse(sessionStorage.getItem(DBG_STORE) || '[]');
      if (!kept.length) return;
      sessionStorage.removeItem(DBG_STORE);
      say('log', '[gpie:dbg] ---- replaying ' + kept.length + ' lines logged before the reload ----');
      kept.forEach(function (line) { say('log', '[gpie:dbg]', line); });
      say('log', '[gpie:dbg] ---- end of replay ----');
    } catch (e) {
      // Nothing to replay.
    }
  }
  replayDbg();

  // dbgT('label') marks a step's start; the returned function logs its cost.
  function dbgT(label) {
    var t0 = performance.now();
    return function () {
      var args = [label, 'took', (performance.now() - t0).toFixed(1) + 'ms'];
      dbg.apply(null, args.concat(Array.prototype.slice.call(arguments)));
    };
  }

  // What one send cost, in the three parts that can be told apart: the bytes
  // refetched for images the record has no copy of, the uploads those bytes and
  // any added file are turned into, and the time the server spends answering
  // the request. Only the last is the send itself; the first two are spent
  // before it exists, which is why a send can report a fast total and still
  // have felt slow. Reset when a plan opens and again once its send has been
  // reported.
  var work;

  function resetWork() {
    work = { images: 0, shape: null, uploads: 0, upStart: 0, upEnd: 0,
      refetches: 0, fetchStart: 0, fetchEnd: 0 };
  }
  resetWork();

  function noteUploadStart() {
    if (!work.upStart) work.upStart = performance.now();
  }

  function noteUploadEnd() {
    work.uploads++;
    work.upEnd = performance.now();
  }

  // The refetches run alongside each other, so the span is first start to last
  // finish rather than the sum of them.
  function noteFetchStart() {
    if (!work.fetchStart) work.fetchStart = performance.now();
  }

  function noteFetchEnd() {
    work.refetches++;
    work.fetchEnd = performance.now();
  }

  // Handing the counters to the send that is going out, so the answer is
  // reported against them however long it takes. Tearing the editor down opens
  // a fresh plan before the answer lands, and that plan would otherwise have
  // cleared the counters the answer was supposed to be described by.
  function takeWork() {
    var taken = work;
    resetWork();
    return taken;
  }

  function secs(ms) {
    return (ms / 1000).toFixed(1) + 's';
  }

  // The two lines that report a send - the send's own and the retry's lead-in -
  // read the same counters, so which counters exist and how they are phrased is
  // settled here. The tail is a parameter because only the send line can say
  // when the uploads happened relative to it.
  function workParts(w, uploadTail) {
    var parts = [];
    if (w.refetches) {
      parts.push(w.refetches + ' refetched in ' + secs(w.fetchEnd - w.fetchStart));
    }
    if (w.uploads) {
      parts.push(w.uploads + ' uploaded in ' + secs(w.upEnd - w.upStart) + (uploadTail || ''));
    }
    return parts;
  }

  function info() {
    say.apply(null, ['log', LOG_IMG].concat(Array.prototype.slice.call(arguments)));
  }

  // The channel every abandonment reports through. A branch that gives up the
  // fast shape, throws a dirty plan away or renames a user's file charges the
  // user something they never asked for - 55s, or a file name the server then
  // keeps - and dbg() is off by default, so a branch that reports only there
  // reports to nobody. Both halves are the point: `what` is the cost paid,
  // `why` is the condition that failed, and a report missing either one leaves
  // the next reader guessing which of the two it was.
  function reportDowngrade(what, why) {
    say('warn', LOG_IMG, 'degraded: ' + what + ' — ' + why);
  }

  // Reads an attachment list as `kind[length]:name`, which is enough to tell at
  // a glance whether a send is in the shape §shape is aiming for. The kind is
  // asked of attClass in §upload, the same call the gates make, so the line
  // printed here cannot say a list was contrib while the gate that read it saw
  // otherwise. attClass is declared further down the concatenated file, which
  // is safe: function declarations hoist over the whole shared scope.
  function attShape(list) {
    if (!Array.isArray(list)) return String(list);
    return list.map(function (a) {
      if (!Array.isArray(a)) return '?';
      return attClass(a) + '[' + a.length + ']:' + a[1];
    }).join(', ');
  }

  // §bodies ==================================================================
  // Every outgoing StreamGenerate body is kept verbatim so a rewritten send can
  // be compared field by field against a native one from the same page. This is
  // how the differences in §shape were found and how the next one will be.
  var BODY_STORE = 'gpieBodyLog';

  function keepBody(url, body, touched) {
    try {
      var kept = JSON.parse(sessionStorage.getItem(BODY_STORE) || '[]');
      kept.push({
        at: new Date().toISOString().slice(11, 23),
        touched: !!touched,
        url: String(url),
        body: String(body)
      });
      while (kept.length > 6) kept.shift();
      sessionStorage.setItem(BODY_STORE, JSON.stringify(kept));
      dbg('keepBody: outgoing StreamGenerate stored,', kept.length, 'kept,', touched ? 'rewritten' : 'native');
    } catch (e) {
      // Capture is best-effort; the send itself is never held up.
    }
  }

  // __gpBodies() in the console prints each kept send's decoded inner payload.
  (function exposeBodyDump() {
    var target = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    target.__gpBodies = function () {
      var kept = [];
      try {
        kept = JSON.parse(sessionStorage.getItem(BODY_STORE) || '[]');
      } catch (e) { /* nothing kept */ }
      kept.forEach(function (entry, i) {
        var text = entry.body;
        try {
          text = JSON.stringify(JSON.parse(JSON.parse(new URLSearchParams(entry.body).get('f.req'))[1]));
        } catch (e) { /* undecodable; the raw body still prints */ }
        say('log', '[gpie:body] #' + i, entry.at, entry.touched ? 'REWRITTEN' : 'NATIVE', entry.url);
        say('log', text);
      });
      return kept.length + ' bodies kept';
    };
  })();

  // §page ====================================================================
  // WIZ_global_data belongs to the page's own window, and every value the upload
  // needs comes out of it. A userscript that runs apart from the page sees a window
  // that does not always reach the page's globals, so the object is recovered
  // from the inline script that defines it whenever neither window carries it.
  var wizCache = null;
  var sniffed = {};

  function matchBrace(text, start) {
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return i;
    }
    return -1;
  }

  function scrapeWiz() {
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length; i++) {
      var text = scripts[i].textContent;
      var at = text.indexOf('WIZ_global_data');
      if (at === -1) continue;
      var start = text.indexOf('{', at);
      if (start === -1) continue;
      var end = matchBrace(text, start);
      if (end === -1) continue;
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e) {
        // Not the object literal being looked for; keep scanning.
      }
    }
    return null;
  }

  function wizObject() {
    var live = null;
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.WIZ_global_data) {
        live = unsafeWindow.WIZ_global_data;
      }
    } catch (e) {
      // No unsafeWindow under this manager; the page window is tried next.
    }
    if (!live) {
      try {
        live = window.WIZ_global_data || null;
      } catch (e) {
        live = null;
      }
    }
    if (live) return live;
    if (!wizCache) wizCache = scrapeWiz();
    return wizCache;
  }

  function wiz(key) {
    try {
      var data = wizObject();
      return data && typeof data[key] === 'string' ? data[key] : null;
    } catch (e) {
      return null;
    }
  }

  function locale() {
    return document.documentElement.getAttribute('lang') || 'en';
  }

  function directChild(parent, className) {
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i].classList.contains(className)) return parent.children[i];
    }
    return null;
  }

  function reqId() {
    return 100000 + Math.floor(Math.random() * 900000);
  }

  function conversationId() {
    var m = location.pathname.match(/\/app\/([0-9a-f]+)/);
    return m ? 'c_' + m[1] : null;
  }

  function rememberToken(body) {
    if (typeof body !== 'string' || body.indexOf('at=') === -1) return;
    try {
      var at = new URLSearchParams(body).get('at');
      if (at) sniffed.at = at;
    } catch (e) {
      // Not a form body; nothing to remember.
    }
  }

  // §rpc =====================================================================
  // Gemini answers two kinds of rpc call, and they differ in less than they
  // look. Both post a form of f.req plus the CSRF token to a path under
  // /_/BardChatUi/data/, both carry the same five query keys, and both answer
  // a length-prefixed stream of envelopes whose payload is a JSON document
  // escaped into a JSON string. What differs is the address: batchexecute
  // names its rpc in the query and echoes that name back in the envelope,
  // while a dedicated path such as ProcessFile carries a null in that slot.
  //
  // The payload is passed as a value and serialised here. The wire format
  // nests it as a string inside another JSON document, and doing that at each
  // call site is where the quoting goes wrong.
  //
  // An answer can carry more than one envelope: a generation is streamed as a
  // run of them, and which one holds the finished turn is not fixed, so every
  // one of them is handed back rather than the first.
  // The first drop of each rpc is worth a line; the rest are not. A generation
  // is streamed as a run of envelopes, so an answer that routinely carries one
  // odd chunk would print a line per turn on a channel that is never off.
  var wrbDropSeen = {};

  function noteWrbDrops(rpcId, dropped, chars) {
    var key = rpcId || 'ProcessFile';
    var line = key + ': ' + dropped + ' envelope(s) unreadable and dropped (response '
      + chars + ' chars)';
    if (wrbDropSeen[key]) { dbg('wrb: ' + line); return; }
    wrbDropSeen[key] = true;
    say('warn', LOG_IMG, line);
  }

  function wrbPayloads(text, rpcId) {
    var head = '[["wrb.fr",' + (rpcId ? '"' + rpcId + '"' : 'null') + ',"';
    var out = [];
    var dropped = 0;
    var at = text.indexOf(head);
    while (at !== -1) {
      // The payload is a JSON string inside the envelope, so it ends at the
      // first quote that is not escaped; walking it beats a regular expression
      // over a document that runs to megabytes.
      var from = at + head.length;
      var to = from;
      while (to < text.length && text.charAt(to) !== '"') {
        to += text.charAt(to) === '\\' ? 2 : 1;
      }
      try {
        out.push(JSON.parse(JSON.parse('"' + text.slice(from, to) + '"')));
      } catch (e) {
        // A chunk that does not parse teaches nothing; the next one may. It is
        // still counted: five subsystems read the length of this array, and to
        // every one of them a response of three envelopes and one of six with
        // three unreadable look exactly alike.
        dropped++;
      }
      at = text.indexOf(head, to);
    }
    if (dropped) noteWrbDrops(rpcId, dropped, text.length);
    return out;
  }

  function wrbPayload(text, rpcId) {
    var all = wrbPayloads(text, rpcId);
    if (!all.length) throw new Error('no ' + (rpcId || 'ProcessFile') + ' payload');
    return all[0];
  }

  function rpcQuery() {
    return 'bl=' + encodeURIComponent(wiz(WIZ_KEYS.bl) || '')
      + '&f.sid=' + encodeURIComponent(wiz(WIZ_KEYS.sid) || '')
      + '&hl=' + encodeURIComponent(locale())
      + '&_reqid=' + reqId()
      + '&rt=c';
  }

  // The token is sniffed off a live request first, because a page open long
  // enough for the one in WIZ_global_data to have been rotated still sends the
  // current one on every request of its own.
  function rpcBody(freq) {
    var at = sniffed.at || wiz(WIZ_KEYS.at) || '';
    return 'f.req=' + encodeURIComponent(freq) + '&at=' + encodeURIComponent(at) + '&';
  }

  // The same figure §library's gmGet is given, for the same reason: generous
  // against the megabytes a conversation load answers with on a slow line, and
  // far short of the forever a missing deadline means. Forever is not an
  // abstraction here - a request that never settles holds §usage's inFlight and
  // §origins' harvesting flag for the life of the document, and every trigger
  // that would have reset them is refused while they are held.
  var RPC_TIMEOUT_MS = 90000;

  function rpcPost(url, freq, rpcId, label) {
    var doneFetch = dbgT((label || rpcId || 'rpc') + ': rpc round-trip');
    var request = fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1'
      },
      body: rpcBody(freq)
    }).then(function (res) {
      return res.text().then(function (text) {
        // A refusal and a verification page both answer a body holding no
        // envelope at all, and 'no <rpcid> payload' names neither which of the
        // two it was nor that the server said anything about it. The status is
        // the whole of that answer, so it is not thrown away here.
        if (!res.ok) {
          throw new Error((rpcId || 'ProcessFile') + ' answered http ' + res.status
            + ' (' + text.length + ' chars)');
        }
        return text;
      });
    }).then(function (text) {
      doneFetch(text.length, 'chars');
      return wrbPayload(text, rpcId);
    });
    var timer = null;
    var deadline = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        reject(new Error((rpcId || 'ProcessFile') + ' did not answer within '
          + (RPC_TIMEOUT_MS / 1000) + 's'));
      }, RPC_TIMEOUT_MS);
    });
    return Promise.race([request, deadline]).then(function (payload) {
      clearTimeout(timer);
      return payload;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function batchExecute(rpcId, payload, label) {
    var url = BATCH_EXECUTE_PATH
      + '?rpcids=' + rpcId
      + '&source-path=' + encodeURIComponent(location.pathname)
      + '&' + rpcQuery();
    return rpcPost(url, JSON.stringify([[[rpcId, JSON.stringify(payload), null, 'generic']]]),
      rpcId, label);
  }

