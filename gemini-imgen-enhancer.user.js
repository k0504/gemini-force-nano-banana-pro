// ==UserScript==
// @name         Gemini Imgen Enhancer
// @name:zh-TW   Gemini Imgen Enhancer
// @namespace    https://github.com/k0504/gemini-force-nano-banana-pro
// @author       k0504
// @license      MIT
// @homepageURL  https://github.com/k0504/gemini-imgen-enhancer
// @supportURL   https://github.com/k0504/gemini-imgen-enhancer/issues
// @version      3.55.0
// @description  Force Gemini image generation onto Nano Banana Pro from the first request, and edit the images attached to an existing prompt.
// @description:zh-TW  自首次請求即強制以 Nano Banana Pro 生成圖片，並可編輯既有 prompt 附加的圖片。
// @match        https://gemini.google.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @sandbox      raw
// @connect      googleusercontent.com
// @connect      google.com
// ==/UserScript==

// `@sandbox raw` runs this script in the page's own context: one window, one
// console, one fetch, one XMLHttpRequest, with the GM_ functions still
// granted. Everything this script observes is therefore what the page itself
// sees, and a request it makes shows up wherever the page's own requests do.

// §nav  Section index. Every section below opens with a line carrying its own
// §nav  tag, so `grep '§'` over this file prints the whole map with line
// §nav  numbers and jumping to one section is a single search.
//
//   §protocol   request field indices, attachment shapes, endpoints
//   §config     tunables and version
//   §trace      dbg behind a flag, info always on, attShape
//   §bodies     every outgoing send kept for field-level comparison
//   §page       WIZ_global_data recovery and small DOM helpers
//   §rpc        one call into batchexecute, and the envelope both kinds
//               of rpc answer in
//   §settings   persisted toggles and the manager menu
//   §pro        feature one: force Nano Banana Pro
//   §store      IndexedDB: the record, its image bytes, and the byte budget
//   §record     what a message's attachment list means, keyed by position,
//               and the three accessors every reader of it goes through
//   §view       drawing the record over Gemini's own carousel
//   §refresh    upgrading a record to the server's durable references
//   §upload     the three-step upload, and what counts as a contrib
//   §plan       the edit in progress
//   §freshen    turning every attachment into a contrib of this document
//   §apply      writing the plan into the outgoing prompt tuple
//   §shape      choosing the shape the resend goes out in
//   §resend     feature two, assembled: the editor's contribution to a send
//   §commit     what every rewritten send owes the record, in one place
//   §rewrite    one parse, both features, one serialise
//   §net        XHR and fetch hooks
//   §style      the injected stylesheet
//   §tiles      one thumbnail
//   §drag       reordering by pointer
//   §bar        the editor strip
//   §retry      the native regenerate, restored to older turns
//   §usage      the account's quota, and when it is worth asking for
//   §library    the library's download button, answered with the original
//   §lifecycle  detecting edit mode, scheduling passes
//   §boot       startup

(function () {
  'use strict';

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
  // Gemini's own regenerate button, plain and Pro. Neither carries a turn
  // identifier, so the server regenerates the conversation's last turn - see
  // §native-retry, which is the only reader of these.
  var ACTION_RETRY = 5;
  var ACTION_RETRY_PRO = 7;

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
  var VERSION = '3.55.0';

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

  // reportDowngrade is gone. It was the channel through which a branch that
  // gave up the fast shape, sent the page's attachment list in place of the
  // record's, or renamed a user's file announced what it had just charged
  // them - and having somewhere respectable to announce it is what made each
  // of those branches look like a decision rather than a defect. Every one of
  // them is now a refusal: see §guard for what a value has to be, §durable for
  // what a record has to be, and §resend for the send that does not go out
  // when either fails. What remains after that is either an error the user has
  // to act on, which is said at error level, or a step worth tracing, which is
  // dbg's.

  // §guard ===================================================================
  // What a value has to satisfy before anything downstream may read it. These
  // throw. A value that fails one of them is not a slower version of the right
  // value, it is the wrong value, and reporting it while carrying on is what
  // this section exists to end: see §record's rule that the record, not the
  // page, is what a message's attachment list means, and the failure that made
  // it necessary - a thumbnail address that had become same-origin was fetched,
  // answered 200 with Gemini's own HTML shell, passed the only test there was
  // (response.ok) and reached the server declared as image/jpeg.
  //
  // Content-Type is what the other end says. The leading bytes are what the
  // file is, so that is what is asked.

  var IMAGE_SIGNATURES = [
    { kind: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
    { kind: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
    { kind: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }
  ];

  // RIFF....WEBP. The four bytes at offset 8 are what separate it from every
  // other RIFF container, so both ends of the header are compared.
  function isWebpHead(head) {
    return head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
      && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  }

  function imageMimeOf(head) {
    for (var i = 0; i < IMAGE_SIGNATURES.length; i++) {
      var sig = IMAGE_SIGNATURES[i];
      var hit = true;
      for (var j = 0; j < sig.bytes.length; j++) {
        if (head[j] !== sig.bytes[j]) { hit = false; break; }
      }
      if (hit) return sig.kind;
    }
    return isWebpHead(head) ? 'image/webp' : null;
  }

  // The header as something a reader can act on. `<!doctype html` names the
  // failure outright, where "not an image" alone leaves the next person to
  // fetch the URL by hand to find out what came back.
  function describeHead(head) {
    var text = '';
    for (var i = 0; i < head.length && i < 16; i++) {
      var c = head[i];
      text += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : '.';
    }
    return JSON.stringify(text);
  }

  // Resolves with the mime the bytes actually are. Every caller writing an
  // upload takes the mime from here rather than from blob.type, which carries
  // whatever the response was labelled.
  function mustBeImageBytes(blob, what) {
    if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') {
      return Promise.reject(new Error(what + ': no bytes at all, got ' + typeof blob));
    }
    if (!blob.size) return Promise.reject(new Error(what + ': zero bytes'));
    return blob.slice(0, 16).arrayBuffer().then(function (buf) {
      var head = new Uint8Array(buf);
      var mime = imageMimeOf(head);
      if (!mime) {
        throw new Error(what + ': not an image - ' + blob.size + ' bytes labelled '
          + (blob.type || 'nothing') + ', starting ' + describeHead(head));
      }
      return mime;
    });
  }

  // Where an image may be read from. lh3 is where every thumbnail Gemini
  // renders lives; blob: and data: are this document's own mints. A
  // same-origin address is never one: /app/<anything> answers 200 with the
  // application shell, so appending a size suffix to one produces a perfectly
  // valid-looking 840KB response that is not an image.
  function mustBeImageSource(url, what) {
    if (typeof url !== 'string' || !url) {
      throw new Error(what + ': no source address to read the image from');
    }
    if (/^(blob:|data:)/.test(url)) return url;
    if (!/^https:\/\/lh3\.(googleusercontent|google)\.com\//.test(url)) {
      throw new Error(what + ': ' + url.slice(0, 80)
        + ' is not an lh3 image address, nothing may be read from it');
    }
    return url;
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

  // An envelope whose payload is null is the call being answered and turned
  // down, which is not the same as an answer carrying no envelope at all: a
  // refusal names a request the server will not take, while a missing envelope
  // is a session or a route that never reached the rpc. Read as 'no payload'
  // the two are one failure, and the one that means "the body being sent is
  // wrong" is the one worth naming.
  //
  //   [["wrb.fr","c8o8Fe",null,null,null,[3,null,[["....BardErrorInfo",[1003]]]],"generic"]
  function wrbRefusal(text, rpcId) {
    var head = '[["wrb.fr",' + (rpcId ? '"' + rpcId + '"' : 'null') + ',null';
    if (text.indexOf(head) === -1) return null;
    var code = /BardErrorInfo",\[(\d+)\]/.exec(text);
    return (rpcId || 'ProcessFile') + ' answered, refusing the request'
      + (code ? ' (error ' + code[1] + ')' : '');
  }

  function wrbPayload(text, rpcId) {
    var all = wrbPayloads(text, rpcId);
    if (!all.length) {
      var refused = wrbRefusal(text, rpcId);
      if (refused) throw new Error(refused);
      // A 200 holding no envelope says nothing on its own, and what the body
      // does say is the only account of why. Without it the failure reads the
      // same whatever the cause: a rotated shape and a signed-out session both
      // answer 'no payload'.
      throw new Error('no ' + (rpcId || 'ProcessFile') + ' payload; the answer was '
        + text.length + ' chars: ' + text.replace(/\s+/g, ' ').slice(0, 200));
    }
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

  // §settings ================================================================
  var STORE_PRO = 'forceNbPro';
  var STORE_IMG = 'promptImageEditor';
  var STORE_USAGE = 'usageDisplay';

  var hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  var forcePro = hasGM ? GM_getValue(STORE_PRO, true) : true;
  var imageEditor = hasGM ? GM_getValue(STORE_IMG, true) : true;
  var usageDisplay = hasGM ? GM_getValue(STORE_USAGE, true) : true;

  // The menu caption is the only status indicator a userscript has, so it
  // carries the current value and is re-rendered on every toggle.
  var menuIds = [];

  function renderMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (typeof GM_unregisterMenuCommand === 'function') {
      menuIds.forEach(function (id) { GM_unregisterMenuCommand(id); });
    }
    menuIds = [
      GM_registerMenuCommand('Force Nano Banana Pro: ' + (forcePro ? 'ON' : 'OFF'), function () {
        forcePro = !forcePro;
        if (hasGM) GM_setValue(STORE_PRO, forcePro);
        renderMenu();
        say('log', LOG_PRO, 'force =', forcePro ? 'ON' : 'OFF', '(applies to the next request)');
      }),
      GM_registerMenuCommand('Prompt Image Editor: ' + (imageEditor ? 'ON' : 'OFF'), function () {
        imageEditor = !imageEditor;
        if (hasGM) GM_setValue(STORE_IMG, imageEditor);
        if (!imageEditor) discardPlan();
        renderMenu();
        schedule();
      }),
      GM_registerMenuCommand('Usage Display: ' + (usageDisplay ? 'ON' : 'OFF'), function () {
        usageDisplay = !usageDisplay;
        if (hasGM) GM_setValue(STORE_USAGE, usageDisplay);
        // Turning it back on reads at once rather than waiting for the poll,
        // and turning it off drops the line, which brings Gemini's own text
        // back with it.
        if (usageDisplay) readUsage('menu toggle', true);
        else detachUsageLine();
        renderMenu();
        schedule();
      }),
      // An action rather than a toggle. It issues one request per conversation,
      // which is a thing to be asked for rather than to happen on a page visit.
      GM_registerMenuCommand('Sweep Original Keys', function () {
        sweepOrigins();
      }),
      GM_registerMenuCommand('Debug Trace: ' + (debugTrace ? 'ON' : 'OFF'), function () {
        debugTrace = !debugTrace;
        if (hasGM) GM_setValue(STORE_DBG, debugTrace);
        renderMenu();
        info('debug trace =', debugTrace ? 'ON' : 'OFF');
      })
    ];
  }

  // §pro =====================================================================
  function applyProMarker(inner) {
    var tuple = inner[PROMPT_TUPLE];
    dbg('applyProMarker: before =', JSON.stringify(tuple[MODEL_MARKER]));
    while (tuple.length <= MODEL_MARKER) tuple.push(null);
    tuple[MODEL_MARKER] = PRO_MARKER;
    dbg('applyProMarker: wrote', JSON.stringify(PRO_MARKER));
    return true;
  }

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
  var inflightSend = null;
  // The snapshots of sends that have departed but not yet settled. Each is
  // settled only by its own request's outcome, and heldThumbs reads it so a
  // route-change release cannot revoke a URL a rollback may still write back.
  var departedSends = [];

  // An abandoned hold still owns the thumb URLs installOverride displaced
  // without revoking, so discarding the hold has to discharge that duty,
  // keeping any URL the record still shows.
  function dropHold() {
    var snap = inflightSend;
    inflightSend = null;
    if (!snap || snap.absent) return;
    var o = overrideAtPath(snap.index, snap.path);
    releaseThumbs(snap.thumbs, o ? o.thumbs : null);
  }

  // Called by the transport hooks at the moment a StreamGenerate departs, so a
  // send settles its own snapshot and never one armed for a different send.
  function claimInflightSend() {
    var snap = inflightSend;
    inflightSend = null;
    if (snap) departedSends.push(snap);
    return snap;
  }

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
      dropHold();
      // Said out loud, because the caller went on to write a record at that
      // same index and the warning above then described the opposite of what
      // happened. Refusing to hold and refusing to write are one decision.
      return false;
    }
    // A hold still sitting unclaimed here was abandoned by a send that never
    // departed, and its release duty is discharged before it is overwritten.
    dropHold();
    inflightSend = snapshotOverride(index, path);
    return true;
  }

  function sendLanded(sent) {
    if (!sent) return;
    var at = departedSends.indexOf(sent);
    if (at !== -1) departedSends.splice(at, 1);
    // Against the pinned conversation, wherever the user is by now: the server
    // truncated that one, so its later records describe turns that no longer
    // exist whether or not it is still the conversation on screen.
    dropRecordsAfter(sent.index, sent.path);
    // The landed send made the pre-send thumbs unreachable, so the snapshot's
    // URLs are revoked here, keeping any URL the record still shows.
    if (!sent.absent) {
      var o = overrideAtPath(sent.index, sent.path);
      releaseThumbs(sent.thumbs, o ? o.thumbs : null);
    }
  }

  function sendFailed(sent, why) {
    if (!sent) return;
    var at = departedSends.indexOf(sent);
    if (at !== -1) departedSends.splice(at, 1);
    say('warn', LOG_IMG, 'the send did not go out (' + why + '); the later records are kept '
      + 'and the record for this message is put back as it was');
    restoreOverride(sent);
    schedule();
  }

  function snapshotOverride(index, path) {
    var o = overrideAtPath(index, path);
    if (!o) return { index: index, path: path, absent: true };
    return {
      index: index,
      path: path,
      absent: false,
      thumbs: o.thumbs.slice(),
      attachments: o.attachments,
      blobs: (o.blobs || []).slice()
    };
  }

  function restoreOverride(snap) {
    if (!snap) return;
    var o = overrideAtPath(snap.index, snap.path);
    if (snap.absent) {
      // The row goes whether or not the array still holds a copy of it. The
      // send wrote the row, and a route change afterwards releases the array
      // but not the store; keying the delete off the array would leave the row
      // behind for good, while the failure was already reported as rolled back.
      // The key is the snapshot's own, so no record is needed to build it.
      if (o) {
        dropView(o);
        releaseThumbs(o.thumbs);
        overrides.splice(overrides.indexOf(o), 1);
      }
      dbDelete(RECORDS, [snap.path + '#' + snap.index]).catch(function (err) {
        // The row describes a list that was never sent. Left on file it is what
        // the next edit of that message reads as the message's own.
        markRecordUnsafe(snap.index, snap.path,
          'the record of a send that never departed could not be discarded (' + err + ')');
      });
      return;
    }
    // The record can be gone from the array while its row is still in the
    // store: the send wrote the row through installOverride/persistOverrides,
    // and a route change afterwards released the array's copy of it. The row is
    // put back rather than skipped, or the rollback would leave the store
    // holding a list that was never sent. It is put back in the store alone and
    // never pushed into the array: the array holds the conversation on screen,
    // and a record absent from it belongs to one that is not.
    if (!o) {
      rollbackStoredRecord(snap);
      return;
    }
    releaseThumbs(o.thumbs, snap.thumbs);
    o.thumbs = snap.thumbs;
    o.attachments = snap.attachments;
    o.blobs = snap.blobs;
    // A writer like any other. Left unbumped, a record put back after a failed
    // send still read as the generation that send installed, so an upgrade the
    // same send armed passed its guard and went on to overwrite the rollback.
    o.gen = nextGen();
    dropView(o);
    persistOverrides(snap.path);
  }

  // Asked of the store rather than assumed, because a record missing from the
  // array means one of two opposite things. Either a route change released the
  // array's copy and the row is still on file, in which case the rollback owes
  // it the list the send replaced; or a send at an earlier ordinal truncated
  // this turn away and took the row with it, in which case putting one back
  // resurrects a record for a turn the server no longer has - which the next
  // visit then draws over whichever message has taken that ordinal.
  function rollbackStoredRecord(snap) {
    dbReadAll(RECORDS).then(function (rows) {
      var row = null;
      rows.forEach(function (r) {
        if (r && r.path === snap.path && r.index === snap.index) row = r;
      });
      if (!row) {
        dbg('restoreOverride: nothing on file at #' + snap.index + ' of ' + snap.path
          + ', the turn was truncated away, nothing put back');
        return null;
      }
      // Hydrated in the meantime, so the array holds the record again and its
      // own writer owns the row; a second write of the same key from here would
      // race it with a list read before that hydration.
      if (overrideAtPath(snap.index, snap.path)) return null;
      // Thumbs are stored empty by persistOverrides, and the same holds for a
      // row written from a snapshot: a blob: URL dies with the document that
      // minted it, and the bytes beside it are what restores the record.
      row.thumbs = snap.thumbs.map(function () { return ''; });
      row.attachments = snap.attachments;
      row.blobs = snap.blobs;
      row.savedAt = Date.now();
      return dbWrite(RECORDS, [row]);
    }).catch(function (err) {
      // The rollback is what makes a failed send leave nothing behind. Without
      // it the store holds the list that send would have written, and the send
      // never happened.
      markRecordUnsafe(snap.index, snap.path,
        'the record of a send that never departed could not be put back (' + err + ')');
    });
    // The array does not take these URLs over, and the snapshot left
    // departedSends before this ran, so nothing else is left to free them.
    releaseThumbs(snap.thumbs);
  }

  // The conversation is passed in, never read off the location: this runs when
  // the send lands, which can be long after the user has routed elsewhere.
  //
  // The store decides which rows go, not the in-memory array. The array holds
  // only what this document has written or read back, so a row left by an
  // earlier document - or by another tab - is in the store and not in the
  // array, an empty filter over the array reads as "nothing to discard", and
  // the records of turns the server has just thrown away survive for good.
  // Nothing else deletes a record row, so there is no later pass to catch them;
  // they come back on the next visit and are drawn over whichever messages now
  // occupy those ordinals.
  //
  // The array is still cleaned, because what is on screen has to stop showing
  // the discarded turns, but it is cleaned as a consequence rather than as the
  // source of truth.
  function dropRecordsAfter(index, path) {
    overrides.filter(function (o) {
      return o.path === path && o.index > index;
    }).forEach(function (o) {
      dropView(o);
      releaseThumbs(o.thumbs);
      overrides.splice(overrides.indexOf(o), 1);
    });

    return dbReadAll(RECORDS).then(function (rows) {
      var keys = rows.filter(function (r) {
        return r && r.path === path && r.index > index;
      }).map(function (r) { return r.path + '#' + r.index; });
      if (!keys.length) {
        dbg('dropRecordsAfter: message #' + index + ' of ' + path
          + ' resent, no later records were on file');
        return null;
      }
      dbg('dropRecordsAfter: message #' + index + ' of ' + path + ' resent,', keys.length,
        'later records discarded with it');
      return dbDelete(RECORDS, keys);
    }).catch(function (err) {
      // What survives a failure here is a record describing a turn the server
      // no longer has, and the next visit draws it over whichever message has
      // taken that ordinal. Which message that will be is not knowable from
      // here, so the doubt is over the store as a whole rather than over any
      // one row.
      markStoreUntrusted('the records of turns discarded by a resend of message #' + index
        + ' of ' + path + ' are still on file (' + err + ')');
      say('warn', LOG_IMG, 'could not discard the records after #' + index
        + ' of ' + path + ':', err);
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
      // The one write failure in this file that leaves nothing describing
      // anything false: pruning only frees space, so a failed prune means the
      // store stays larger than its budget and every record still says exactly
      // what it said before. Nothing is marked, because nothing is in doubt.
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

  // §durable =================================================================
  // The store is what a message's attachment list means after a reload. A write
  // that failed therefore leaves the page and the store describing different
  // messages, and the next edit is built from whichever one it happens to read.
  //
  // These failures used to print a warning and carry on. Carrying on is the
  // part that was wrong: nothing downstream repairs a record that was never
  // written, so the warning described a divergence that then went on to decide
  // a send. What is marked here refuses instead - every plan built on it, and
  // every plan at all while the store itself is in doubt. A reload rebuilds
  // from the server, which is the one source that was never in question.
  //
  // Both marks live in memory only, and deliberately so: they exist because
  // writing to the store failed, so the store is the one place they cannot be
  // kept.
  var storeUntrusted = null;

  function markStoreUntrusted(why) {
    if (storeUntrusted) return;
    storeUntrusted = why;
    say('error', LOG_IMG, 'the attachment records are no longer trustworthy: ' + why
      + ' — no message can be resent from this page until it is reloaded');
  }

  function markRecordUnsafe(index, path, why) {
    var o = overrideAtPath(index, path);
    if (o) o.unsafe = why;
    say('error', LOG_IMG, 'message #' + index + ' of ' + path + ' cannot be resent: ' + why
      + ' — reload the page to rebuild it from the server');
  }

  // What stops a plan before it is built, or null. Read by §plan when edit mode
  // opens, so the refusal arrives while the user is still deciding rather than
  // on the press.
  function recordBlocker(index, path) {
    if (storeUntrusted) return storeUntrusted;
    var o = overrideAtPath(index, path);
    return o && o.unsafe ? o.unsafe : null;
  }

  function hostsNow() {
    return document.querySelectorAll('div.user-query-container');
  }

  function indexOfHost(host) {
    return Array.prototype.indexOf.call(hostsNow(), host);
  }

  // Which message a native regenerate speaks for. That request carries no turn
  // identifier at all - see §native-retry - so the server takes the
  // conversation's last turn, and the record at this ordinal is the only one
  // such a send can be written from. -1 when the conversation is not on screen,
  // which its caller reads as "no record".
  function lastMessageIndex() {
    return hostsNow().length - 1;
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
  // bytes until it is revoked, and the refresh used to overwrite the list and
  // leave the old URLs behind. What installOverride displaces is released not
  // there but when the send settles - sendLanded revokes the snapshot's URLs,
  // a failure writes them back - so nothing revokes a URL a rollback still
  // needs. Only what this document minted is revoked - an lh3 URL is not
  // ours - and anything carried into the new list is left alone.
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

  function installOverride(index, path, thumbs, attachments, blobs) {
    var kept = 0;
    (blobs || []).forEach(function (b) { if (b) kept++; });
    dbg('installOverride: message #' + index + ',', thumbs.length, 'thumbs,', kept,
      'images kept, attachments =', attShape(attachments));
    if (typeof index !== 'number' || index < 0) return false;
    var existing = overrideAtPath(index, path);
    if (existing) {
      // The displaced URLs are not revoked here. installOverride's only caller
      // is commitSend, which armed holdSend for this same (index, path) a
      // moment earlier, so inflightSend.thumbs holds them - revoking them here
      // killed the very strings a failed send's rollback writes back. The
      // release happens when the send settles.
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
        path: path,
        index: index,
        thumbs: thumbs,
        attachments: attachments,
        blobs: blobs || [],
        gen: nextGen(),
        view: null
      });
    }
    persistOverrides(path);
    return true;
  }

  function persistOverrides(path) {
    // Only the passed conversation's records are written. The array also holds
    // the records of conversations this document merely visited before an
    // in-page navigation, and rewriting those stamped them as freshly used -
    // which is exactly what §store's least-recently-used eviction reads - and
    // undid another tab's pruning of the same rows.
    var mine = overrides.filter(function (o) { return o.path === path; });
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
      // Each record this write was carrying, by name. The send itself already
      // went out and was correct; what failed is the part that makes it mean
      // anything after a reload, so it is the next edit of these messages that
      // has to stop, not this one.
      records.forEach(function (r) {
        markRecordUnsafe(r.index, r.path, 'its record could not be stored (' + err + ')');
      });
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
      // Every url except the ones a held send is still able to put back. The
      // rollback writes the snapshot's strings into the record as they stand,
      // and a revoked blob: url is still a non-empty string, so it passes the
      // drawable test and hangs an image that loads nothing over a carousel
      // that was showing the right thing. The mint outlives this release only
      // while a send is in flight against it.
      releaseThumbs(o.thumbs, heldThumbs(o));
      overrides.splice(i, 1);
    }
  }

  // The thumbs a send could still put back, or nothing: answered for the hold
  // that has not departed yet and for every send that has departed and not yet
  // settled. Read from the snapshots rather than from the record, because the
  // record is what the send has already overwritten. This is what makes
  // releasing the cache safe while a send is in flight, and why sendFailed's
  // rollback can still write live URLs into the record after the route changed.
  function heldThumbs(o) {
    var kept = null;
    function take(snap) {
      if (!snap || snap.absent) return;
      if (snap.path !== o.path || snap.index !== o.index) return;
      kept = (kept || []).concat(snap.thumbs);
    }
    take(inflightSend);
    for (var i = 0; i < departedSends.length; i++) take(departedSends[i]);
    return kept;
  }

  // Runs again on every route change, because the pathname it filters on is
  // whatever is on screen at the moment it is called and the landing page is
  // never the conversation. Idempotent per path: a record already in the array
  // is left where it is.
  //
  // The store is the durable source of truth for which file backs a slot; the
  // array is a cache of the conversation on screen. It is released here
  // synchronously and refilled from the store asynchronously, which is what
  // guarantees that a returning visit reads the store's current rows - another
  // tab's writes and its deletions included - instead of a stale resident copy,
  // and that no record of the conversation being entered is resident during the
  // first scan pass after the pathname flips.
  function restoreOverrides() {
    releaseOffPath();
    return dbReadAll(RECORDS).then(function (kept) {
      var mine = kept.filter(function (r) { return r && r.path === location.pathname; });
      if (!mine.length) return;
      mine.forEach(function (r) {
        if (overrideAtPath(r.index, r.path)) return;
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
      // the user's edit, so it is kept - but it is kept blocked. Naming the
      // cost and leaving it to send was the same trade every other route in
      // this file used to make: the send would have gone out with the list from
      // before this message was last resent, and the report would have said so
      // after the fact. Blocked, the press refuses and reopening the editor
      // rebuilds the plan off the record, which is a few seconds against a
      // resend that silently used the wrong images.
      //
      // Judged against the plan's own conversation, not the one on screen. This
      // block runs after a store read, so it runs after a route change too, and
      // an ordinal matched against the wrong thread named an unrelated message
      // in an always-on report - on the ordinary act of clicking another
      // conversation in the sidebar. A report the user learns to ignore is
      // worse than none.
      if (plan && plan.path === location.pathname && !plan.base
        && overrideAtPath(plan.index, plan.path)) {
        if (planIsDirty(plan)) {
          plan.blocked = 'this edit was built before the message\'s record had loaded, so the '
            + 'list it would send is the one from before the last resend — close the editor '
            + 'and reopen it';
          say('error', LOG_IMG, 'message #' + plan.index + ' of ' + plan.path
            + ' cannot be resent: ' + plan.blocked);
        } else {
          discardPlan();
        }
      }
    }).catch(function (err) {
      // Resolving, not rethrowing: the prune chained onto this reads the store
      // for itself and has no reason to be skipped because the restore failed.
      //
      // But nothing may be resent after it. With no records read, every message
      // this script has resent looks to the editor like one it never touched,
      // so its plan would be built from the page's list - the images from
      // before that resend.
      markStoreUntrusted('the attachment records could not be read (' + err + ')');
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
    // No live read stands in for a missing pin. Asking whichever conversation
    // happens to be on screen answers a question nobody asked: for namesByThumb
    // that is a name map from another thread, every thumbnail missing from it,
    // and a permanent rename for each; for refreshOverride it is an upgrade
    // aimed at a turn that is not there. Both are worse than not answering.
    if (!conv) {
      return Promise.reject(new Error(label
        + ' was given no conversation id to pin to, and the one on screen is not it'));
    }
    return batchExecute(LIST_CONVERSATION_RPC, [conv, 10, null, 1, [1], [4], null, 1], label);
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
    var o = overrideAtPath(index, path);
    dbg('refreshOverride: fire, message #' + index + ', expect',
      o ? o.attachments.length : 0, 'attachments, attempt', attempt,
      '(record ' + (o ? 'found' : 'MISSING') + ')');
    if (!o) {
      // Not a loss and not a degradation: with no record there is nothing that
      // could be upgraded and nothing that will be resent from one. It was
      // reported as a cost the user was paying, which it never was.
      dbg('refreshOverride: message #' + index + ' has no record left to upgrade');
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
      var current = overrideAtPath(index, path);
      // The record this upgrade was armed for, or nothing. A second send to
      // the same message rewrote it in place while the rpc was in flight, and
      // what follows would replace that send's own list with the tokens of the
      // turn the server has just been asked about and then destroy its bytes.
      if (!current || current.gen !== gen) {
        // The guard doing its job, not a cost: a second send rewrote this
        // record while the rpc was out, and what stands is that send's own
        // list. Upgrading it here would replace it with the tokens of the turn
        // the server was asked about and then destroy its bytes.
        dbg('refreshOverride: message #' + index + ' was rewritten while the upgrade was in '
          + 'flight (generation ' + gen + ' -> ' + (current ? current.gen : 'gone') + ')');
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
      persistOverrides(path);
      dropView(current);
      schedule();
      dbg('record upgraded to server references', tuples.length);
    }).catch(function (err) {
      // The record still holds what was sent, which stays correct, only slower
      // on the next resend. Named so the console shows why that will be.
      say('warn', LOG_IMG, 'reference refresh failed:', err);
    });
  }

  // §upload ==================================================================
  // Three steps, then the result is referenced as a form B attachment.
  //   1. start a resumable upload, the response header carries the upload URL
  //   2. push the bytes, the response body is the contrib_service path
  //   3. ProcessFile exchanges that path for the uuid the prompt tuple needs
  //
  // Contrib paths minted here are noted, because one read back out of the
  // record was minted by an earlier document and carries that document's
  // remaining time to live; it is not assumed to still resolve.
  //
  // The mint time is what is kept, not a bare yes. The server measures ttl_1d
  // from the mint, not from the document, so a tab left open overnight was
  // vouching for paths the server had already collected.
  var contribsThisDocument = {};
  // Well inside the day the server allows, and past any editing session.
  var CONTRIB_TTL_MS = 20 * 60 * 60 * 1000;

  function contribIsOurs(path) {
    var at = path && contribsThisDocument[path];
    return !!at && (Date.now() - at) < CONTRIB_TTL_MS;
  }

  function isContribTuple(t) {
    return Array.isArray(t) && Array.isArray(t[0]) && typeof t[0][0] === 'string'
      && t[0][0].indexOf(CONTRIB_PREFIX) === 0;
  }

  // The only answer to "what is this attachment". The question used to be asked
  // in four places that disagreed: §shape gated on the prefix alone, so a
  // contrib minted by a dead document passed; §freshen and §retry each asked
  // the prefix and the mint separately; and the console label asked the prefix
  // without even the Array.isArray guard. A line an operator read could
  // therefore contradict the gate that made the decision, which is how a live
  // fix read as a reverted one. Both predicates above stay private to this file
  // so the disagreement cannot come back.
  //   contrib-live   this document minted it and is still inside CONTRIB_TTL_MS
  //   contrib-stale  a contrib path, but not one this document can vouch for
  //   token          the server reference §refresh writes back into a record
  //   other          anything else, a native prompt tuple included
  function attClass(t) {
    if (isContribTuple(t)) return contribIsOurs(t[0][0]) ? 'contrib-live' : 'contrib-stale';
    if (Array.isArray(t) && t.length >= 3 && typeof t[2] === 'string') return 'token';
    return 'other';
  }

  function uploadFile(file) {
    var mime = file.type || 'image/jpeg';
    var startHeaders = {
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Tenant-Id': 'bard-storage'
    };
    var pctx = sniffed['x-client-pctx'] || wiz(WIZ_KEYS.pctx);
    var pushId = sniffed['push-id'] || wiz(WIZ_KEYS.pushId);
    // Both are mandatory. Sending the request without them answers a bare 400
    // that reads as a server-side refusal, so the real cause is named here.
    if (!pctx || !pushId) {
      return Promise.reject(new Error('page context unavailable (X-Client-Pctx '
        + (pctx ? 'ok' : 'missing') + ', Push-ID ' + (pushId ? 'ok' : 'missing')
        + '), reload the page'));
    }
    startHeaders['X-Client-Pctx'] = pctx;
    startHeaders['Push-ID'] = pushId;

    dbg('upload step 1: start,', file.name, file.size + 'B,', mime,
      '(pctx ' + (sniffed['x-client-pctx'] ? 'sniffed' : 'wiz') + ', pushId '
      + (sniffed['push-id'] ? 'sniffed' : 'wiz') + ')');
    var doneStep1 = dbgT('upload step 1');
    var doneStep2 = null;
    var doneStep3 = null;
    noteUploadStart();
    return fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: startHeaders,
      body: 'File name: ' + file.name
    }).then(function (res) {
      var target = res.headers.get('x-goog-upload-url');
      doneStep1('status', res.status + ',', 'target', target ? 'received' : 'MISSING');
      if (!target) throw new Error('upload init returned no target (status ' + res.status + ')');
      doneStep2 = dbgT('upload step 2');
      return fetch(target, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Goog-Upload-Command': 'upload, finalize',
          'X-Goog-Upload-Offset': '0',
          'X-Tenant-Id': 'bard-storage'
        },
        body: file
      });
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var contrib = String(text).trim();
      doneStep2('contrib', contrib.slice(0, 50) + '...');
      if (contrib.indexOf(CONTRIB_PREFIX) !== 0) throw new Error('upload returned no contrib path');
      doneStep3 = dbgT('upload step 3');
      return processFile(contrib, file.name, mime).then(function (uuid) {
        doneStep3('uuid', uuid, '-> form B tuple ready');
        noteUploadEnd();
        contribsThisDocument[contrib] = Date.now();
        // Nine elements with the [0] tail, which is what an edit resend
        // carries. §apply trims it to two for a send that takes the brand-new
        // upload shape.
        return [[contrib, 1, null, mime, uuid], file.name,
          null, null, null, null, null, null, [0]];
      });
    });
  }

  function processFile(contrib, name, mime) {
    var hl = locale();
    var inner = JSON.stringify([[[contrib, null, 1, mime], name], null, 1, [hl]]);
    // A dedicated path rather than batchexecute: the rpc is named by the
    // address, so the envelope it answers in carries a null where a
    // batchexecute answer would name it.
    return rpcPost(PROCESS_FILE_PATH + '?' + rpcQuery(),
      JSON.stringify([null, inner]), null, 'ProcessFile').then(function (parsed) {
      var uuid = parsed && parsed[3] && parsed[3][0];
      if (!uuid) throw new Error('ProcessFile returned no uuid');
      return uuid;
    });
  }

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

  // §resend ==================================================================
  // Set by any route that finds it cannot write a correct attachment list, and
  // read by rewrite(), which then refuses the request outright instead of
  // returning a body.
  var pendingRefusal = null;

  // A send this script cannot write correctly does not go out.
  //
  // This used to let the request through with the list the page had built. That
  // list is the one the message held before its last resend - §record exists to
  // state exactly that - so letting it through does not degrade the send, it
  // sends the user's older images in place of the ones on screen, silently and
  // irreversibly. There is no slower-but-correct version of this to fall back
  // to, so there is nothing to fall back to.
  //
  // Nothing is committed and no record is discarded: the send is not made, so
  // the server truncates nothing and there are no later turns to account for.
  // The plan and the editor are left standing too - the usual cause is a press
  // that beat the upload, and the next press a few seconds later succeeds.
  function refuseSend(why) {
    pendingRefusal = why;
    say('error', LOG_IMG, 'send refused, nothing was sent: ' + why);
    return null;
  }

  // The one shape a refused rewrite answers with. The original body travels
  // back with it so nothing downstream has to special-case a missing one; no
  // transport reads it, because every transport checks `refuse` first.
  function refusalResult(body) {
    return { body: body, reload: false, refresh: null, strip: null, refuse: pendingRefusal };
  }

  // Only when the send really is the resend: a plan left idling while the user
  // types into the composer describes a message this send never touched, so it
  // has no standing to refuse it.
  function backOut(inner, p, why) {
    if (!isEditResend(inner)) {
      dbg('editorContribution: backing out -', why, '- and this send is not the resend');
      return null;
    }
    return refuseSend(why);
  }

  // §native-retry ============================================================
  // Gemini's own regenerate button. It is the one send that carries an
  // attachment list this script holds a record for and has no plan to write it
  // from, and it was reaching the server untouched.
  //
  // §retry clones itself only onto turns whose action row has no native button,
  // so the latest turn - the only turn that button is rendered on - is served by
  // the page's own control. The list that control builds is the one the message
  // held before the resend that produced it, which is the rule §record exists to
  // state: from the first resend onwards the record, not the request body, is
  // what a message's attachment list means. A regenerate pressed after an edit
  // therefore generated against the images the edit had just replaced, and
  // filed that list back onto the turn, so the next edit read it back as the
  // message's own and the divergence outlived the press.
  //
  // The record's tuples go out as they stand: no freshen, no reshape. The
  // server already holds these references, and §retry measured the converted
  // shape at 78.2s against 6.3s for leaving them alone.
  //
  // Nothing is committed. A regenerate replaces the answer to the last turn, so
  // there are no later turns to discard, and the list written here is the
  // record's own - there is nothing new to record and nothing to roll back.
  function nativeRetryContribution(inner) {
    if (!isNativeRetry(inner)) return null;

    var tuple = inner[PROMPT_TUPLE];
    var body = tuple[ATTACHMENTS];
    if (!Array.isArray(body) || !body.length) {
      dbg('nativeRetry: the regenerate carries no attachments, nothing to correct');
      return null;
    }

    var index = lastMessageIndex();
    var base = index < 0 ? null : recordAttachments(index);
    // Not a downgrade. A message this script has never resent is described by
    // the page correctly, and that is most of them.
    if (!base) {
      dbg('nativeRetry: message #' + index + ' has no record, the page\'s own list stands');
      return null;
    }
    if (base.length !== body.length) {
      return refuseSend('the record for message #' + index + ' holds ' + base.length
        + ' attachments against the ' + body.length + ' this regenerate carries, so which '
        + 'images it would generate from cannot be established');
    }
    // An upload the server has already collected fails the send outright, and
    // there is no plan here to re-upload it from: this runs inside
    // XMLHttpRequest.send and an upload is three round trips. What used to
    // happen here was to let the page's list stand because it resolves - but
    // what it resolves to is the images from before this message was last
    // resent, so the regenerate answered a message the user is no longer
    // looking at. Refused instead: reopen the message and resend it, which
    // re-uploads the images and leaves references this document can vouch for.
    var stale = base.filter(function (att) {
      return attClass(att) === 'contrib-stale';
    }).length;
    if (stale) {
      return refuseSend(stale + ' of the record\'s attachments for message #' + index
        + ' are uploads this document cannot vouch for; reopen the message and resend it '
        + 'before regenerating');
    }

    tuple[ATTACHMENTS] = base;
    dbg('nativeRetry: message #' + index + ', attachments written from the record |',
      attShape(base));
    // False rather than true: a list was written, and no reload is owed for it.
    return false;
  }

  function editorContribution(inner) {
    if (!imageEditor) return null;
    // Ahead of the plan, and never through it. A regenerate is the page's own
    // control, so an editor left open on some other message must neither decide
    // what it sends nor be spent by it - activePlan is a getter that expires
    // what it reads.
    if (isNativeRetry(inner)) return nativeRetryContribution(inner);
    var p = activePlan();
    if (!p) { dbg('editorContribution: no active plan, leaving attachments alone'); return null; }

    var dirty = planIsDirty(p);
    dbg('editorContribution: plan #' + p.index + ', dirty =', dirty + ', record =', !!p.base);

    // Ahead of every route below, including the retry's. What those routes
    // write the list from is the record, and this is the case where the record
    // is the thing in doubt - see §durable. Its own message is used rather than
    // the not-ready gate's, which would report uploads that are not the reason.
    if (p.blocked) return backOut(inner, p, p.blocked);

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
      var kept = applyPlanTo(inner, p);
      // The same reading of that return as the route below: null means this
      // send is not the one the plan was made for, so it is left alone, and
      // false means applyPlanTo has refused it.
      if (kept === null) return null;
      if (!kept) return null;
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
    // One gate, dirty or not. An existing entry reaches the server as an upload
    // this document made or not at all, so a plan that is not ready has nothing
    // to write the list from - and the list the page built in its place carries
    // the server's own references, the shape measured at 79.9s against 24.2s.
    // Update stays locked until this holds, so arriving here means the press beat
    // the lock; the entries are named because the two ways to get here want
    // opposite things from the user - an upload still running means the next
    // press is fast, one that failed means this plan never will be and the image
    // wants replacing by hand.
    if (!planIsReady(p)) {
      return backOut(inner, p, 'the uploads for this edit have not finished: '
        + p.entries.filter(function (entry) {
          return entry.kind === 'existing' ? !entry.freshAttachment : !entry.attachment;
        }).map(function (entry) {
          return (entry.kind === 'existing' ? 'existing#' + entry.index : 'new:' + entry.name)
            + ' ' + (entry.freshError ? 'failed: ' + entry.freshError : 'still uploading');
        }).join(', '));
    }

    var listWritten = applyPlanTo(inner, p);
    if (listWritten === null) return null;
    // False is no longer a send that goes out with the page's list; applyPlanTo
    // has refused it, and rewrite() reads that. Nothing is committed, because
    // nothing departs and the server discards no turns.
    if (!listWritten) return null;

    dbg(dirty ? 'attachments rewritten' : 'attachments restored',
      p.originalCount, '->', p.entries.length);
    if (!chooseSendShape(inner, inner[PROMPT_TUPLE][ATTACHMENTS], p)) return null;

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
    if (!holdSend(p.index, p.path)) return false;

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
      p.path,
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
      //
      // The conversation comes from the plan, pinned when the plan was built,
      // rather than from whatever is on screen at the moment of the send.
      var justStored = overrideAtPath(p.index, p.path);
      pendingRefresh = {
        index: p.index,
        path: p.path,
        conv: p.conv,
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
    var unchanged = { body: body, reload: false, refresh: null, strip: null, refuse: null };
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
      pendingRefusal = null;

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
      // Ahead of everything else this function still had to do. A refusal is
      // not a body, so nothing below it - the shape probe, the serialise, the
      // hold the transport would claim - has anything to act on.
      if (pendingRefusal) return refusalResult(body);
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
      // A send with a plan armed against it is one this script owes an
      // attachment list, and passing it through unwritten sends the list the
      // page built - the images from before this message was last resent. That
      // is the loss, not a degraded version of avoiding it, so it is refused.
      //
      // Everything else does go through. A composer message has no image state
      // at stake, and refusing every send because the body format moved would
      // take Gemini away from the user entirely to protect a message that has
      // nothing to protect. `plan` is read directly rather than through
      // activePlan(), which expires what it reads: this is an error path and
      // must not be the thing that discards the user's staged edit.
      if (plan) {
        refuseSend('the request body could not be read, and this message has an edit staged '
          + 'that would otherwise be sent as the page built it (' + e + ')');
        return refusalResult(body);
      }
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

  function traceStream(xhr, w, sent) {
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
      if (serverRefused(xhr)) sendFailed(sent, 'http ' + xhr.status);
      else sendLanded(sent);
      noteGenerationFinished();
    });
    xhr.addEventListener('error', function () {
      dbg('xhr: StreamGenerate errored after', ((Date.now() - t0) / 1000).toFixed(1) + 's');
      report(w, 'failed after ' + secs(Date.now() - t0));
      sendFailed(sent, 'the request errored');
    });
    // An abort is the local end hanging up, not the send failing. The request
    // left this document long before - the body carries references, not bytes -
    // so the server has it, is generating against it, and bills for it whether
    // or not anything here is still listening. What the record describes is
    // what this message was sent with, so the turn is settled as made: the list
    // stands and the records after it go, exactly as on a response received.
    // Routing away mid-generation is what raises this, and rolling the record
    // back there left the message on screen holding images no record explained.
    xhr.addEventListener('abort', function () {
      dbg('xhr: StreamGenerate aborted after', ((Date.now() - t0) / 1000).toFixed(1) + 's,',
        'settled as made - the server has the request either way');
      report(w, 'aborted after ' + secs(Date.now() - t0) + ' (the turn was still made)');
      sendLanded(sent);
      // The generation runs on regardless, so the allowance it spends is read
      // back on this path too.
      noteGenerationFinished();
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
  var xhrAbort = XMLHttpRequest.prototype.abort;

  // Routing to another conversation makes the application abort the generation
  // it left behind, and the server then has no one listening for the rest of a
  // turn it is already billing for. The request is left running instead: the
  // application has stopped reading it either way, and what running on buys is
  // the server finishing the turn and filing it, so returning to the
  // conversation shows the images rather than a turn that stopped halfway.
  //
  // Only the abort that follows a route change is ignored. Stopping a
  // generation from the page's own control happens in the conversation that
  // owns it, so an abort raised while the pathname is still the one the send
  // went out on is passed through untouched - the user asked for that one.
  //
  // Compared against the pathname the request itself went out on rather than a
  // remembered "previous" one: a second route change while the first request is
  // still running would make any single remembered value name the wrong page.
  XMLHttpRequest.prototype.abort = function () {
    if (this.__gpieStreamPath && this.readyState !== 4
      && location.pathname !== this.__gpieStreamPath) {
      dbg('xhr: abort of a StreamGenerate ignored, the page routed from',
        this.__gpieStreamPath, 'to', location.pathname,
        '- the turn is left to finish on the server');
      return;
    }
    return xhrAbort.apply(this, arguments);
  };

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
    // Before anything that would record this send as having departed. Throwing
    // is what tells the page the request did not happen: swallowing the refusal
    // and returning would leave it waiting for an answer that is never coming,
    // and calling through would send the very list the refusal exists to stop.
    // The reason is already on the console, from refuseSend.
    if (result.refuse) throw new Error('[gpie] send refused: ' + result.refuse);
    if (typeof this.__gemUrl === 'string' && this.__gemUrl.indexOf('StreamGenerate') !== -1) {
      dbg('xhr: sending StreamGenerate, body', result.body === body ? 'untouched' : 'rewritten');
      keepBody(this.__gemUrl, result.body, result.body !== body);
      // Read here, at the send, so the abort hook above compares against the
      // conversation this request was made in and not against wherever the
      // page has got to by the time the abort arrives.
      this.__gpieStreamPath = location.pathname;
      // This runs after rewrite() above, so a hold armed by commitSend inside it
      // is claimed by the very request that carries the send.
      traceStream(this, takeWork(), claimInflightSend());
    }

    var xhr = this;
    armSendOutcome(result, xhr, function (then) {
      xhr.addEventListener('load', function () {
        // 'load' fires for a refusal as readily as for an answer. A resolved
        // response is not a made turn: reloading on one resynchronises the view
        // onto a turn that is not there, and a reference upgrade armed against
        // one can only fail. The fetch path stated this rule and this one, the
        // transport actually in use, did not follow it.
        if (serverRefused(xhr)) {
          say('warn', LOG_IMG, 'send: the server refused it, status ' + xhr.status
            + ' - no reload and no reference refresh follow');
          return;
        }
        then();
      });
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

  // One owner for "did the server turn this send down", across both transports.
  // It decides two separate consequences - whether the records roll back, and
  // whether the reload, the reference refresh and the cost line run - and those
  // consequences sat behind three copies of the comparison: two inside hookFetch
  // and one in traceStream, which is the path that actually runs. The XHR route
  // never asked the second question at all and armed its outcome on any
  // completed response. A later allowance on one copy alone (a 3xx, a 204) rolls
  // a send's records back while still arming a refresh for it.
  //
  // Takes anything carrying a status: a Response and an XMLHttpRequest both do.
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
      // Outside the try, or the throw below would be caught by the handler
      // meant for the rewrite itself and the refused send would go out anyway.
      if (result && result.refuse) throw new Error('[gpie] send refused: ' + result.refuse);
      var promise = tapRpcFetch(url, nativeFetch.call(this, input, init));
      // Nothing on this path traces the stream, so a send is settled on its own
      // response. Only a send: any other fetch resolving first would settle a
      // hold that belongs to the request still in flight.
      var sent = null;
      var hold = null;
      var t0 = 0;
      if (result && url.indexOf('StreamGenerate') !== -1) {
        // Everything the XHR branch owes a send it is about to make, minus the
        // stream trace this transport cannot give. The counters have to be
        // taken here whether or not anything reads them: left where they are,
        // they describe this send's uploads to whichever plan opens next. And
        // the cost line is the number every §shape decision is measured
        // against, so a migration off XHR must not be what silences it.
        sent = takeWork();
        // The snapshot leaves the slot with the request that carries it, so the
        // settle below resolves this send's own hold and no other's.
        hold = claimInflightSend();
        t0 = Date.now();
        keepBody(url, result.body, touched);
        if (!fetchSendSeen) {
          fetchSendSeen = true;
          say('warn', LOG_IMG, 'StreamGenerate went out over fetch — stream tracing does not'
            + ' cover this transport, timings are per-request only');
        }
        promise = promise.then(function (res) {
          if (serverRefused(res)) sendFailed(hold, 'http ' + res.status);
          else sendLanded(hold);
          return res;
        }, function (err) {
          // An abort is the local end hanging up on a request the server
          // already has, so the turn was made and is settled as made; anything
          // else is the request not having gone out at all.
          if (err && err.name === 'AbortError') {
            dbg('fetch: StreamGenerate aborted after', ((Date.now() - t0) / 1000).toFixed(1)
              + 's, settled as made - the server has the request either way');
            sendLanded(hold);
            noteGenerationFinished();
          } else {
            sendFailed(hold, 'the fetch failed');
          }
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

  // §style ===================================================================
  var STYLE = [
    // Shrink to the thumbnails and hug the end of the column. The attachment
    // container is only as wide as its images while the message is read, but
    // spans the whole column in edit mode; a strip left where a block lands
    // would sit clear of the prompt bubble with a gap after the last control.
    '.gpie-bar{margin:6px 0 2px;margin-inline-start:auto;width:fit-content;',
    'max-width:100%;font:13px/1.45 system-ui,sans-serif}',
    '.gpie-strip{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.gpie-tile{position:relative;width:84px;height:84px;flex:0 0 auto;cursor:grab;',
    'touch-action:none;user-select:none;-webkit-user-select:none}',
    '.gpie-tile.gpie-dragging{cursor:grabbing;z-index:5;opacity:.9;',
    'filter:drop-shadow(0 4px 10px rgba(0,0,0,.45))}',
    '.gpie-thumb{width:100%;height:100%;object-fit:cover;border-radius:8px;display:block;',
    'pointer-events:none;-webkit-user-drag:none;background:rgba(128,128,128,.2);',
    'border:1px solid rgba(128,128,128,.3)}',
    // The library card's mark. A dot rather than a glyph: it sits over a
    // thumbnail whose colours are unknown, so it carries its own ring instead
    // of relying on contrast with whatever is behind it.
    '.gpie-origin-dot{position:absolute;top:6px;right:6px;width:9px;height:9px;',
    'border-radius:50%;background:#34a853;box-shadow:0 0 0 2px rgba(0,0,0,.45);',
    'pointer-events:none;z-index:3;}',
    // The sweep runs for half a minute against a page that shows nothing while
    // it does, and the menu command that starts it read as doing nothing at
    // all. This is where it says otherwise.
    // The armed retry reads as a warning until it is pressed again or the
    // window lapses; nothing else on the row changes colour.
    '.gpie-retry .gpie-armed,.gpie-retry button.gpie-armed{outline:2px solid #e5a50a;',
    'outline-offset:2px;border-radius:50%}',
    '.gpie-progress{position:fixed;right:16px;bottom:16px;z-index:2147483000;',
    'max-width:320px;padding:9px 13px;border-radius:10px;',
    'background:rgba(32,33,36,.94);color:#e8eaed;border:1px solid rgba(255,255,255,.14);',
    'font:13px/1.5 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);',
    'pointer-events:none;white-space:pre-line}',
    '.gpie-progress.gpie-done{background:rgba(24,74,42,.94);border-color:rgba(52,168,83,.5)}',
    '.gpie-badge{position:absolute;top:4px;left:4px;background:rgba(0,0,0,.7);color:#fff;',
    'border-radius:6px;padding:0 5px;font-size:11px;line-height:16px;pointer-events:none}',
    '.gpie-state{position:absolute;left:4px;right:4px;bottom:4px;text-align:center;',
    'background:rgba(0,0,0,.7);color:#fff;border-radius:6px;font-size:11px;line-height:16px;',
    'pointer-events:none}',
    '.gpie-del{position:absolute;top:3px;right:3px;width:20px;height:20px;padding:0;',
    'display:flex;align-items:center;justify-content:center;border-radius:50%;',
    'border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.72);color:#fff;',
    'font-size:14px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s}',
    '.gpie-tile:hover .gpie-del,.gpie-del:focus-visible{opacity:1}',
    '.gpie-del:hover{background:#d93025}',
    '.gpie-tile.gpie-dragging .gpie-del{opacity:0}',
    '@media (hover:none){.gpie-del{opacity:1}}',
    '.gpie-view .gpie-tile{cursor:zoom-in;padding:0;border:0;background:transparent;',
    'display:block;font:inherit;color:inherit}',
    '.gpie-view .gpie-tile:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}',
    '.gpie-reason{position:absolute;top:100%;left:0;margin-top:4px;width:220px;',
    'padding:4px 6px;border-radius:6px;background:#d93025;color:#fff;font-size:11px;',
    'line-height:1.35;z-index:6;pointer-events:none}',
    '.gpie-add{width:84px;height:84px;flex:0 0 auto;border-radius:8px;',
    'border:1px dashed rgba(128,128,128,.55);background:transparent;color:inherit;',
    'font-size:24px;line-height:1;opacity:.65;cursor:pointer;display:flex;',
    'align-items:center;justify-content:center}',
    '.gpie-add:hover{opacity:1;background:rgba(128,128,128,.12)}',
    '.gpie-add.gpie-drop{opacity:1;border-style:solid;border-color:#1a73e8;',
    'background:rgba(26,115,232,.18)}',
    '.gpie-reset{flex:0 0 auto;height:84px;box-sizing:border-box;padding:0 14px;',
    'font-size:12px;cursor:pointer;border-radius:8px;',
    'border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}',
    '.gpie-reset:hover{background:rgba(128,128,128,.2)}',
    // The usage line stands in for Gemini's own disclaimer. Hiding that one is
    // keyed off ours being present, so a page the usage read never reached
    // keeps its original text and dropping ours restores it with nothing to
    // undo. Two classes and two types outrank .gds-body-s.desktop-spacing,
    // which is where the line gets its type from.
    'div.capabilities-disclaimer:has(>p.gpie-usage)>p:not(.gpie-usage){display:none}',
    // The line itself is not a control: the numbers on it are worth selecting
    // and copying, and the refresh button is where the click belongs.
    'div.capabilities-disclaimer>p.gpie-usage{cursor:default}',
    '.gpie-usage-refresh{display:inline-flex;align-items:center;justify-content:center;',
    'width:20px;height:20px;padding:0;margin-inline-start:2px;vertical-align:middle;',
    'border:0;border-radius:50%;background:transparent;color:inherit;opacity:.55;',
    'cursor:pointer}',
    '.gpie-usage-refresh:hover{opacity:1;background:rgba(128,128,128,.18)}',
    '.gpie-usage-refresh:focus-visible{outline:2px solid #1a73e8;outline-offset:1px}',
    '.gpie-usage-refresh>svg{width:14px;height:14px;display:block}',
    '.gpie-usage-refresh.gpie-usage-busy{opacity:1}',
    '.gpie-usage-refresh.gpie-usage-busy>svg{animation:gpie-spin .7s linear infinite}',
    '@keyframes gpie-spin{to{transform:rotate(360deg)}}',
    // Inline-block parts centred by the strip's own text-align, rather than a
    // flex row, so the line does not have to win a display declaration off
    // Gemini's own rule for that paragraph.
    '.gpie-usage-part{display:inline-block;white-space:nowrap;margin:0 14px}',
    '.gpie-usage-stale{opacity:.55}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('gpie-style')) return;
    var style = document.createElement('style');
    style.id = 'gpie-style';
    // Lets a live page report which build it is running, which a userscript
    // manager holding a stale installed copy otherwise makes unanswerable.
    style.setAttribute('data-version', VERSION);
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  // §tiles ===================================================================
  // The injected toolbar and the carousel it hides are owned here rather than
  // by the plan. A plan is dropped the moment its rewrite is applied, and both
  // of these nodes outlive edit mode, so hanging them off the plan loses the
  // only reference to them and leaves the message rendered with no images.
  var toolbar = null;
  // Which plan the toolbar was built for. Without it a toolbar left connected
  // by another message answers for this one.
  var toolbarPlan = null;
  var hiddenCarousel = null;
  var fileInput = null;

  function button(label, title, onClick, className) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.textContent = label;
    el.title = title;
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
    return el;
  }

  function makeTile(p, entry, index) {
    var tile = document.createElement('div');
    tile.className = 'gpie-tile';
    tile.title = 'Drag to reorder';
    tile.gpieEntry = entry;

    var thumb = document.createElement('img');
    thumb.className = 'gpie-thumb';
    thumb.src = entry.thumb;
    thumb.alt = '';
    thumb.draggable = false;
    if (entry.state === 'uploading') thumb.style.opacity = '.45';
    if (entry.state === 'failed') thumb.style.filter = 'grayscale(1)';
    tile.appendChild(thumb);

    var badge = document.createElement('span');
    badge.className = 'gpie-badge';
    badge.textContent = String(index + 1);
    tile.appendChild(badge);

    if (entry.state === 'uploading' || entry.state === 'failed') {
      var state = document.createElement('span');
      state.className = 'gpie-state';
      state.textContent = entry.state === 'failed' ? 'Failed' : 'Uploading';
      tile.appendChild(state);
    }
    // A failure has to say why on the tile itself. The console line is the only
    // other place it appears, and it is not somewhere a user is looking.
    if (entry.state === 'failed' && entry.error) {
      tile.title = 'Upload failed: ' + entry.error;
      var reason = document.createElement('div');
      reason.className = 'gpie-reason';
      reason.textContent = entry.error;
      tile.appendChild(reason);
    }

    // The position is resolved when the button is pressed rather than captured
    // here, because a drag reorders the tiles without a re-render.
    tile.appendChild(button('×', 'Remove', function () {
      removeEntry(p, entry);
    }, 'gpie-del'));

    return tile;
  }

  // A thumbnail this file minted with createObjectURL pins the file's bytes
  // until it is revoked, and an entry dropped from the strip is the last
  // reference to it. An existing entry's thumbnail belongs to the page or to
  // §store, which revokes its own; only what was minted in addFile is released.
  function releaseEntry(entry) {
    if (!entry || entry.kind !== 'new' || !entry.thumb) return;
    if (String(entry.thumb).indexOf('blob:') !== 0) return;
    try {
      URL.revokeObjectURL(entry.thumb);
    } catch (e) {
      // A URL already revoked is not an error worth reporting.
    }
    entry.thumb = '';
  }

  function releaseEntries(entries) {
    (entries || []).forEach(releaseEntry);
  }

  function removeEntry(p, entry) {
    var index = p.entries.indexOf(entry);
    if (index === -1) return;
    p.entries.splice(index, 1);
    releaseEntry(entry);
    renderBar(p);
  }

  function resetEntries(p) {
    releaseEntries(p.entries);
    p.entries = p.originalThumbs.map(function (thumb, index) {
      return { kind: 'existing', index: index, thumb: thumb };
    });
    renderBar(p);
  }

  function pickFiles(p) {
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
    }
    fileInput.onchange = function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';
      files.forEach(function (file) { addFile(p, file); });
    };
    fileInput.click();
  }

  function imageFilesOf(dataTransfer) {
    var files = dataTransfer && dataTransfer.files
      ? Array.prototype.slice.call(dataTransfer.files)
      : [];
    return files.filter(function (file) {
      return file.type && file.type.indexOf('image/') === 0;
    });
  }

  // Gemini watches the document for dragged files and takes them into the
  // composer as a new message. A drag aimed at the add tile therefore has to be
  // claimed before it reaches those listeners, which means handling it here in
  // the capture phase rather than on the tile: stopping propagation from the
  // document would cut off the tile's own handlers as well. Registered while the
  // document is still parsing so this listener precedes the application's.
  function onDocumentDrag(ev) {
    var target = ev.target;
    var tile = target && target.closest ? target.closest('.gpie-add') : null;
    if (!tile || !plan) return;

    ev.preventDefault();
    ev.stopPropagation();

    if (ev.type === 'drop') {
      tile.classList.remove('gpie-drop');
      imageFilesOf(ev.dataTransfer).forEach(function (file) { addFile(plan, file); });
      return;
    }
    if (ev.type === 'dragleave') {
      tile.classList.remove('gpie-drop');
      return;
    }
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    tile.classList.add('gpie-drop');
  }

  function addFile(p, file) {
    var entry = {
      kind: 'new',
      thumb: URL.createObjectURL(file),
      attachment: null,
      bytes: file,
      name: file.name,
      state: 'uploading'
    };
    p.entries.push(entry);
    renderBar(p);
    // The existing images start becoming contribs now, so that by the time
    // Update is pressed the send can take the shape §shape aims for.
    freshenExisting(p);

    uploadFile(file).then(function (attachment) {
      entry.attachment = attachment;
      entry.state = 'ready';
    }).catch(function (err) {
      say('warn', LOG_IMG, 'upload failed:', err);
      entry.state = 'failed';
      entry.error = String((err && err.message) || err);
    }).then(function () {
      if (plan === p) renderBar(p);
    });
  }

  // §drag ====================================================================
  // Pointer events, not the HTML5 drag API: a dragstart raised inside the page
  // makes Gemini put up its own file-drop overlay, and that API has nothing to
  // offer touch input. The pointer is captured on the strip rather than on the
  // tile, because reinserting a tile to reorder it releases a capture the tile
  // itself holds.
  var drag = null;
  // A render asked for while a drag held the strip, to be made once it ends.
  var renderHeld = false;

  function tilesOf(strip) {
    return Array.prototype.slice.call(strip.querySelectorAll('.gpie-tile'));
  }

  function renumber(strip) {
    tilesOf(strip).forEach(function (tile, index) {
      var badge = tile.querySelector('.gpie-badge');
      if (badge) badge.textContent = String(index + 1);
    });
  }

  // Offset from the tile's own layout slot rather than from the grab point, so
  // the tile stays under the pointer across the reorders it triggers.
  function follow(x, y) {
    drag.tile.style.transform = '';
    var rect = drag.tile.getBoundingClientRect();
    drag.tile.style.transform = 'translate(' + (x - rect.left - drag.grabX) + 'px,'
      + (y - rect.top - drag.grabY) + 'px)';
  }

  // The first tile the pointer sits ahead of in reading order; null means the
  // end. Rows are compared before columns, so a wrapped strip stays in order.
  function dropAnchor(x, y) {
    var others = tilesOf(drag.strip).filter(function (tile) { return tile !== drag.tile; });
    for (var i = 0; i < others.length; i++) {
      var rect = others[i].getBoundingClientRect();
      if (y < rect.top || (y <= rect.bottom && x < rect.left + rect.width / 2)) return others[i];
    }
    return null;
  }

  function beginDrag(ev, ctx) {
    // One at a time. A second finger landing on another tile used to overwrite
    // the single slot, so the first tile stayed lifted with nothing to put it
    // back and the release of the second pointer reordered against the first
    // one's strip.
    if (drag) return;
    var rect = ctx.tile.getBoundingClientRect();
    drag = {
      plan: ctx.plan,
      strip: ctx.strip,
      tile: ctx.tile,
      tail: ctx.tail,
      pointerId: ev.pointerId,
      grabX: ev.clientX - rect.left,
      grabY: ev.clientY - rect.top,
      startX: ev.clientX,
      startY: ev.clientY,
      active: false
    };
    try {
      ctx.strip.setPointerCapture(ev.pointerId);
    } catch (e) {
      // Capture only serves to keep the drag alive past the strip's edges.
    }
  }

  function onDragMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      // A press that never travels is a click on the tile, not a drag.
      if (Math.abs(ev.clientX - drag.startX) < 4 && Math.abs(ev.clientY - drag.startY) < 4) return;
      drag.active = true;
      drag.tile.classList.add('gpie-dragging');
    }
    ev.preventDefault();
    var anchor = dropAnchor(ev.clientX, ev.clientY) || drag.tail;
    if (anchor !== drag.tile.nextSibling) {
      drag.strip.insertBefore(drag.tile, anchor);
      renumber(drag.strip);
    }
    follow(ev.clientX, ev.clientY);
  }

  function endDrag(ev) {
    if (!drag || (ev && ev.pointerId !== drag.pointerId)) return;
    var d = drag;
    drag = null;
    try {
      d.strip.releasePointerCapture(d.pointerId);
    } catch (e) {
      // Already released, which is the ordinary case on pointerup.
    }
    d.tile.style.transform = '';
    d.tile.classList.remove('gpie-dragging');
    if (!d.active) {
      if (renderHeld) {
        renderHeld = false;
        renderBar(d.plan);
      }
      return;
    }
    renderHeld = false;
    // The DOM holds the order the user just arranged; the entries follow it.
    d.plan.entries = tilesOf(d.strip).map(function (tile) { return tile.gpieEntry; });
    renderBar(d.plan);
  }

  // §bar =====================================================================
  function renderBar(p) {
    if (!toolbar) return;
    // An upload finishing mid-drag used to wipe the strip and with it the tile
    // under the finger: the pointer capture went with the node, the drag was
    // never ended, and the order the user was arranging was lost. The render is
    // held until the drag lets go.
    if (drag) {
      renderHeld = true;
      return;
    }
    syncSentinel(p);
    toolbar.textContent = '';

    var strip = document.createElement('div');
    strip.className = 'gpie-strip';
    p.entries.forEach(function (entry, index) {
      strip.appendChild(makeTile(p, entry, index));
    });

    var add = button('+', 'Add an image, by dropping a file here or by picking one', function () {
      pickFiles(p);
    }, 'gpie-add');
    strip.appendChild(add);

    if (planIsDirty(p)) {
      strip.appendChild(button('Reset', 'Restore the original attachments', function () {
        resetEntries(p);
      }, 'gpie-reset'));
    }

    strip.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      var tile = ev.target && ev.target.closest ? ev.target.closest('.gpie-tile') : null;
      if (!tile || !strip.contains(tile) || ev.target.closest('.gpie-del')) return;
      // Suppresses the native image drag and the selection the press would start.
      ev.preventDefault();
      ev.stopPropagation();
      beginDrag(ev, { plan: p, strip: strip, tile: tile, tail: add });
    });
    strip.addEventListener('pointermove', onDragMove);
    strip.addEventListener('pointerup', endDrag);
    strip.addEventListener('pointercancel', endDrag);
    strip.addEventListener('lostpointercapture', endDrag);

    toolbar.appendChild(strip);
  }

  function ensureBar(p) {
    // Connected is not enough: the toolbar of a message whose edit mode was
    // left open elsewhere on the page is also connected, and returning on it
    // left the new plan describing itself through the old message's strip.
    if (toolbar && toolbar.isConnected && toolbarPlan === p) return;
    if (toolbar) teardownEditorUi();

    toolbarPlan = p;
    toolbar = document.createElement('div');
    toolbar.className = 'gpie-bar';
    // Clicks inside the toolbar must not reach the editor behind it.
    toolbar.addEventListener('click', function (ev) { ev.stopPropagation(); });

    if (p.container && p.container.isConnected) {
      p.container.insertAdjacentElement('afterend', toolbar);
    } else {
      p.host.insertBefore(toolbar, p.host.firstChild);
    }
    renderBar(p);

    // The original carousel cannot show a deletion or a reorder, so it is hidden
    // and the strip above becomes the only view of what will be sent. Only the
    // inline style is touched; no node Angular owns is added or removed.
    if (p.container) {
      var carousel = p.container.querySelector('user-query-file-carousel');
      if (carousel) {
        carousel.style.display = 'none';
        hiddenCarousel = carousel;
      }
    }
  }

  // Leaving edit mode destroys neither of these: Gemini keeps the carousel node
  // that was hidden above, and the toolbar sits next to it rather than inside the
  // part of the tree that goes away. Both have to be undone by hand.
  function teardownEditorUi() {
    if (hiddenCarousel) {
      hiddenCarousel.style.display = '';
      hiddenCarousel = null;
    }
    if (toolbar && toolbar.parentNode) toolbar.parentNode.removeChild(toolbar);
    toolbar = null;
    toolbarPlan = null;
  }

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

  // §lifecycle ===============================================================
  // The application routes without reloading, so the pathname changing is the
  // only sign a different page is on screen. Read from the scan pass rather
  // than from history: a route change rebuilds the view, so a pass is already
  // on its way, and nothing of the page's own has to be wrapped.
  var lastPath = location.pathname;
  function watchRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    // A hold still unclaimed at a route change belongs to a send that never
    // departed - the only way one survives to here is the retry arming by hand
    // and the Update press failing - and it must not be claimed by the next
    // unrelated send. A hold armed inside rewrite is claimed synchronously
    // within the same XMLHttpRequest.send call and is never visible here.
    dropHold();
    // Everything a conversation owns is read here rather than at document
    // start, where the pathname is /app and belongs to no conversation at all.
    // The prune is chained rather than fired alongside so it sees the records
    // this restore has just claimed, and it is what keeps a session that never
    // reloads from growing the store without bound: persistOverrides writes on
    // every send, and nothing else checks the budget.
    restoreOverrides().then(pruneStore);
    if (lastPath.indexOf('/library') !== 0) return;
    // Behind the page's own listing, which is what keeps the replayed template
    // current. Shorter than the wait at boot: by now a template is held - the
    // library page issues a listing whenever it opens, and it is persisted -
    // so this waits on the request being current, not on there being one.
    setTimeout(indexLibrary, 1500);
  }

  function scan() {
    watchRoute();
    // Ahead of the editor's own gate: the usage line is not part of that
    // feature and is drawn whether or not it is switched on.
    ensureUsageLine();
    // The library mark belongs to neither feature's gate: it reports what this
    // script knows about an image, on a page where no editing happens.
    markLibraryCards();
    markConversationImages();
    if (!imageEditor) {
      discardPlan();
      removeRetryButtons();
      return;
    }
    var host = document.querySelector('div.user-query-container.edit-mode');
    // Not while a message is open for editing. The retry rewrites the message
    // it is pressed on, which is what edit mode is already doing by hand, and
    // the clone sits in the row the page's own controls are in - close enough
    // to the editor's own toolbar for a stray press to throw the edit away.
    // The button is put back by the pass that follows the edit closing.
    if (host) removeRetryButtons(); else ensureRetryButtons();
    if (!host) {
      teardownEditorUi();
      syncOverrides();
      // Update tears the editor down in the same tick it fires the request, so
      // the plan is armed rather than dropped and expires on its own.
      if (plan && plan.armedAt === null) plan.armedAt = Date.now();
      return;
    }
    if (!plan || plan.host !== host) {
      plan = makePlan(host);
      if (plan.originalCount === 0 && !plan.container) {
        // Nothing to edit and no anchor to hang the toolbar on.
        plan = null;
        return;
      }
    }
    plan.armedAt = null;
    syncOverrides();
    ensureBar(plan);
  }

  // Gemini writes the model it actually used into this node. Logging it turns
  // "did the injection work" into an observation instead of a guess.
  function logModelLines() {
    var nodes = document.querySelectorAll('[data-test-id="model-line"]:not([data-nbpro-seen])');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('data-nbpro-seen', '1');
      say('log', LOG_PRO, 'model-line:', (nodes[i].textContent || '').trim().replace(/\s+/g, ' '));
    }
  }

  // A timer rather than an animation frame: a background tab never paints, so a
  // requestAnimationFrame callback would sit unfired and hold the guard flag,
  // stalling every later mutation until the tab is looked at again.
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      try {
        var t0 = performance.now();
        logModelLines();
        scan();
        var cost = performance.now() - t0;
        // Logging every pass would flood the console; a pass this slow is the
        // only kind worth seeing.
        if (cost > 8) dbg('scan pass took', cost.toFixed(1) + 'ms');
      } catch (e) {
        say('warn', LOG_IMG, 'scan failed:', e);
      }
    }, 0);
  }

  // §boot ====================================================================
  function start() {
    injectStyle();
    installLibraryHook();
    loadOrigins();
    // After the page has issued a listing of its own: the replay borrows that
    // request as its template, and there is none to borrow at document start.
    setTimeout(indexLibrary, 4000);
    startUsageWatch();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    // Cancel throws the edit away, so the plan goes with it - and so does an
    // armed but undeparted hold, which no send is coming to claim.
    document.addEventListener('click', function (ev) {
      var target = ev.target;
      if (target && target.closest && target.closest('gem-button.cancel-button')) {
        discardPlan();
        dropHold();
      }
    }, true);
    schedule();
  }

  renderMenu();
  // The same pair watchRoute runs, for the one case it cannot see: a document
  // opened straight onto a conversation, where no pathname change follows.
  restoreOverrides().then(pruneStore);

  // Ahead of the application's own listeners, which is the point.
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (type) {
    document.addEventListener(type, onDocumentDrag, true);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // §library =================================================================
  // The library page hands out the wrong copy. A card renders the preview key
  // of its image, its download button seeds lh3's download chain with that
  // same key, and a chain seeded with the preview key ends in the 1264x848
  // file however the request is phrased. The two keys share only the fixed
  // `ACRwja` prefix, so the original's seed cannot be derived from the
  // preview's.
  //
  // The original's own seed key is not minted, it is listed. A conversation
  // load answers with both copies of an image side by side under one parent,
  // each declaring its pixels and its byte count, and the original is simply
  // the larger: 2528x1696 against the preview's 1264x848. A chain seeded with
  // that key ends in the full file, which is what a conversation's own
  // lightbox does - `gg/<original>=d-I` and two pointers later, six megabytes.
  //
  //   card -> preview key -> conversation id -> conversation load
  //        -> the larger of the two copies under the same parent
  //        -> lh3 download chain -> the file
  //
  // Only an image the conversation still lists can be reached this way. An
  // image edited since is dropped from the conversation while the library
  // keeps its card, and for those the original is not offered anywhere.
  //
  // Neither answer is parsed by index. Their shape is Gemini's and changes
  // without notice, so each is walked as a tree and read by what the values
  // look like: an lh3 URL or a bare key, a token, a triple of numbers.

  var CONV_LOAD_RPC = 'hNvQHb';
  var LIBRARY_LIST_RPC = 'jGArJ';
  var STORE_CONV_FREQ = 'gpie_conv_freq';
  var STORE_LIST_FREQ = 'gpie_list_freq';

  // Ids are sixteen hex digits behind a prefix that says what they name: a
  // conversation, a response, a candidate. Only a conversation id is a
  // conversation load's subject, and the library page issues loads of its own
  // naming a candidate instead, so the prefix is read and not the digits alone.

  // Neither call is composed, both are replayed. Their payload shapes are
  // Gemini's and undocumented, so the page's own last request of each kind is
  // kept and the one value that identifies the target swapped inside it - the
  // conversation id for the load, the token for the key. Both are persisted
  // because the library page sends neither of its own: the templates have to
  // survive the visit to the conversation that produced them.
  var freqCache = Object.create(null);

  function storedFreq(store) {
    if (freqCache[store] !== undefined) return freqCache[store];
    try {
      freqCache[store] = (typeof GM_getValue === 'function' && GM_getValue(store, '')) || '';
    } catch (e) {
      freqCache[store] = '';
    }
    return freqCache[store];
  }

  // Which templates this script holds, on the style node. Whether a download
  // elsewhere can work at all is decided by these, and a console line is gone
  // the moment the page is looked at from outside it.
  function noteTemplates() {
    var node = document.getElementById('gpie-style');
    if (!node) return;
    node.setAttribute('data-templates',
      'conversation=' + (storedFreq(STORE_CONV_FREQ) ? 'held' : 'none')
      + ' listing=' + (storedFreq(STORE_LIST_FREQ) ? 'held' : 'none'));
  }

  function keepFreq(store, freq) {
    if (freqCache[store] === freq) return false;
    freqCache[store] = freq;
    try {
      if (typeof GM_setValue === 'function') GM_setValue(store, freq);
    } catch (e) {
      // A template that cannot be persisted still serves this page.
    }
    return true;
  }

  function loadConvFreq() {
    return storedFreq(STORE_CONV_FREQ);
  }

  // Called from §net for every request that goes by, in both transports.
  function noteLibraryRpc(url, body) {
    if (typeof url !== 'string' || typeof body !== 'string') return;
    var m = /f\.req=([^&]*)/.exec(body);
    if (!m) return;
    var freq = decodeURIComponent(m[1].replace(/\+/g, '%20'));

    // The listing the library page pages through. Its body is
    // [[flags], count, cursor] - the count and the cursor are both swapped when
    // §origins replays it, which is how the whole library is read without
    // scrolling a grid that positions itself by transform and answers no
    // scrollTop at all.
    if (url.indexOf('rpcids=' + LIBRARY_LIST_RPC) !== -1) {
      if (keepFreq(STORE_LIST_FREQ, freq)) {
        dbg('library: listing template captured,', freq.length, 'chars');
      }
      return;
    }

    // The download request is not kept. It is composed from the ledger for the
    // image being asked for - see §library:token - and a body kept from one
    // image names that image's address, which is the one field the server reads
    // and refuses when it disagrees with the token beside it.

    if (url.indexOf('rpcids=' + CONV_LOAD_RPC) === -1) return;
    // A conversation id is what gets swapped in, so a request that does not
    // name one in the position the swap writes to is no use as a template. The
    // library page sends loads of this same shape naming a candidate; keeping
    // one of those leaves its prefix behind, and the replay then asks for
    // `rc_<conversation>`, which the server answers with nothing at all.
    if (!convIdIn(freq)) return;
    if (keepFreq(STORE_CONV_FREQ, freq)) {
      dbg('library: conversation-load template captured,', freq.length, 'chars');
    }
  }

  // The envelope is [[[rpc, "<inner json>", null, "generic"]]] and the
  // conversation id is the inner array's first element. Reaching it through
  // JSON.parse is the only way that holds: in the text the id sits inside a
  // quoted payload, so its own quotes are escaped, and a pattern written for
  // plain quotes matches nothing. One written for the escaped form matches the
  // first request and then silently stops matching the moment the encoding
  // shifts - which is what happened here, and every conversation load for it
  // asked for whichever id the template already carried.
  function innerOf(freq) {
    var outer = JSON.parse(freq);
    return { outer: outer, inner: JSON.parse(outer[0][0][1]) };
  }

  function convIdIn(freq) {
    var parsed;
    try {
      parsed = innerOf(freq);
    } catch (err) {
      return null;
    }
    var head = parsed.inner[0];
    return typeof head === 'string' && /^c_[0-9a-f]{16}$/.test(head) ? head.slice(2) : null;
  }

  // §library:read ------------------------------------------------------------
  // What the conversation answer is read for, in the terms the values
  // themselves carry rather than the positions they sit at.

  function lhKey(url) {
    if (typeof url !== 'string') return null;
    var at = url.indexOf('googleusercontent.com/gg/');
    if (at === -1) return null;
    var key = url.slice(at + 'googleusercontent.com/gg/'.length);
    // A size suffix is a request parameter, not part of the identity.
    var cut = key.search(/[=?#]/);
    return cut === -1 ? key : key.slice(0, cut);
  }

  // A key is not always spelled as a URL in the answer - it also stands as a
  // bare string, several hundred characters under the shared prefix.
  function bareKey(s) {
    return /^ACRwja[A-Za-z0-9_-]{200,}$/.test(s) ? s : null;
  }

  // Every image entry declares its own pixels and byte count, the preview and
  // the original alike, and the triple sits directly on the entry. Reading it
  // from descendants as well would mark every ancestor of an image as an image
  // too, which is what once made a whole answer look like nothing but previews.
  function sizeOf(node) {
    if (!Array.isArray(node)) return null;
    for (var i = 0; i < node.length; i++) {
      var v = node[i];
      if (Array.isArray(v) && v.length === 3
        && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number'
        && v[0] > 0 && v[1] > 0 && v[2] > 1000) return v;
    }
    return null;
  }

  // Every image entry in the order the answer lists them. An entry is the
  // smallest array holding one image key - as an lh3 URL or as a bare string -
  // which is the level the token, the size triple and the media type sit at
  // too.
  // The parent is carried along because it is what tells one image's copies
  // from another's: an answer lists the preview and the original of the same
  // image as neighbours under one parent, and lists other images elsewhere.
  // The turn is carried down as well. A conversation page draws its generated
  // images from blob: URLs and puts no key on them at all, so the only thing
  // naming one there is the turn it belongs to and its place in it - see
  // §origins:turn.
  //
  // A turn does not name itself among its own strings. It opens with a header
  // tuple holding the conversation id and the response id, and the images sit
  // in later siblings of that header, not beneath it:
  //
  //   turn ── [0] header  [c_<hex>, r_<hex>]
  //        ├─ [2] the user's message   ── its uploaded images
  //        └─ [3] the model's response ── its generated images
  //
  // So the node to attribute is the one whose own child holds the id, and the
  // id governs that node's whole subtree. Reading the id from a node's own
  // strings instead - which is what this did first - attributes the header and
  // nothing else, and every image comes out belonging to no turn at all.
  function imageEntries(node, out, parent, resp) {
    out = out || [];
    if (!Array.isArray(node)) return out;
    var mine = null;
    var here = resp || null;
    for (var r = 0; r < node.length && here === (resp || null); r++) {
      var header = node[r];
      if (!Array.isArray(header)) continue;
      for (var h = 0; h < header.length; h++) {
        if (typeof header[h] === 'string' && /^r_[0-9a-f]{16}$/.test(header[h])) {
          here = header[h];
          break;
        }
      }
    }
    for (var i = 0; i < node.length; i++) {
      var v = node[i];
      if (typeof v === 'string') {
        var key = lhKey(v) || bareKey(v);
        if (key && !mine) mine = key;
      } else if (Array.isArray(v)) {
        imageEntries(v, out, node, here);
      }
    }
    if (mine) out.push({ key: mine, size: sizeOf(node), parent: parent || null, resp: here });
    return out;
  }

  // §library:token -----------------------------------------------------------
  // The route the lightbox's own download takes, and the only one that reaches
  // the original for an image the answer lists just once. `c8o8Fe` is handed
  // the image's media token together with the turn it sits in, and answers with
  // a key whose `=s0` is the original - measured 1696x2528 and 1792x2400
  // against previews of 848x1264 and 896x1200, in two conversations where the
  // doubling rule below found no pair at all and reported the image as beyond
  // reach.
  //
  // Nothing has to be captured from a click: the token and both ids are in the
  // conversation answer already. An image entry carries two tokens, and they
  // are not interchangeable - the one at index 3 answers, the one at index 4
  // answers nothing, measured on both conversations.
  var DOWNLOAD_RPC = 'c8o8Fe';

  function tokenEntries(payload) {
    var out = [];
    (function walk(node, resp, rc) {
      if (!Array.isArray(node)) return;
      var here = resp;
      var cand = rc;
      // The ids sit in a header tuple that is a child of the node they govern,
      // not among the node's own strings - the same shape §library:read reads
      // the turn from. Looking only at this node's strings finds the header and
      // nothing else, and every token comes out belonging to no turn.
      for (var i = 0; i < node.length; i++) {
        var v = node[i];
        if (typeof v === 'string') {
          if (/^r_[0-9a-f]{16}$/.test(v)) here = v;
          else if (/^rc_[0-9a-f]{16}$/.test(v)) cand = v;
        } else if (Array.isArray(v)) {
          for (var h = 0; h < v.length; h++) {
            if (typeof v[h] !== 'string') continue;
            if (/^r_[0-9a-f]{16}$/.test(v[h])) here = here || v[h];
            else if (/^rc_[0-9a-f]{16}$/.test(v[h])) cand = cand || v[h];
          }
        }
      }
      var token = Array.isArray(node[3]) && typeof node[3][5] === 'string'
        && node[3][5].charAt(0) === '$' ? node[3][5] : null;
      if (token && here && cand) {
        // The node's own byte count comes along: an image is listed twice, the
        // preview and the original, and only the original's token is answered
        // for by the download rpc. Without this the preview's token was sent
        // and the rpc returned an envelope with nothing in it.
        var size = sizeOf(node);
        out.push({ token: token, resp: here, rc: cand, bytes: size ? size[2] : 0 });
      }
      for (var j = 0; j < node.length; j++) walk(node[j], here, cand);
    })(payload, null, null);

    // The same entry is listed more than once, and a turn numbers its images in
    // the order they first appear.
    var seen = Object.create(null);
    var slots = Object.create(null);
    var rows = [];
    out.forEach(function (row) {
      if (seen[row.token]) return;
      seen[row.token] = true;
      slots[row.resp] = slots[row.resp] === undefined ? 0 : slots[row.resp] + 1;
      row.slot = slots[row.resp];
      rows.push(row);
    });
    return rows;
  }

  // The request the lightbox sends, reduced to the part of it that names the
  // image.
  //
  //   POST /_/BardChatUi/data/batchexecute
  //        ?rpcids=c8o8Fe&source-path=/app/<conv>&bl=..&f.sid=..&hl=..&_reqid=..&rt=c
  //   f.req=<urlencoded [[["c8o8Fe","<inner>",null,"generic"]]]>&at=<csrf>&
  //
  // The page sends more than this: beside the token it carries the image's
  // googleusercontent address, the prompt that made it and the model that ran,
  // which is why its body runs past a thousand characters where this one is
  // under five hundred. Measured field by field against the page's own body
  // (2026-08-29), the server reads exactly one of the extra fields and only
  // when it is there: the address. Left out, the call is answered; carrying an
  // address that belongs to another image, it is refused with
  // `BardErrorInfo [1003]`.
  //
  // That is what makes this composed rather than replayed. A body kept from one
  // image cannot serve another - its address would have to be swapped along
  // with the token, and the address is the one value the ledger has no copy of.
  function originalByToken(row, conv) {
    var inner = [
      [[null, null, null, [null, null, null, null, null, row.token]],
        null, null, null, null, null, null, null, null, null],
      [row.resp, row.rc, 'c_' + conv, null, null],
      1, 0, 1
    ];
    var freq = JSON.stringify([[[DOWNLOAD_RPC, JSON.stringify(inner), null, 'generic']]]);
    return rpcPost(rpcUrl(DOWNLOAD_RPC, conv), freq, DOWNLOAD_RPC, 'original by token')
      .then(function (payload) {
        var url = payload && payload[0];
        if (typeof url !== 'string' || url.indexOf('googleusercontent') === -1) {
          throw new Error('the download rpc named no image');
        }
        // The key out of it. The chain is seeded with the key, not with the
        // url the answer spells it into.
        return lhKey(url);
      });
  }

  // §library:resolve ---------------------------------------------------------

  function rpcUrl(rpcid, conv) {
    return BATCH_EXECUTE_PATH
      + '?rpcids=' + rpcid
      + '&source-path=' + encodeURIComponent('/app/' + conv)
      + '&' + rpcQuery();
  }

  // A page of the library listing. The template is replayed with its own two
  // variables changed: how many cards to answer with, and where to carry on
  // from. An empty cursor asks for the first page.
  // The two variables are reached through the structure rather than matched in
  // the text. The body is [[["jGArJ", "<inner json>", null, "generic"]]] and
  // the inner array is [[flags], count, cursor], so parsing twice and assigning
  // to two positions is exact. The patterns this replaces were matching escaped
  // text inside a quoted payload and had no way to report a miss: a template
  // they failed to change was replayed unchanged, which asked for the same
  // first page over and over and looked like the request itself was at fault.
  function loadLibraryPage(cursor, count) {
    var freq = storedFreq(STORE_LIST_FREQ);
    if (!freq) {
      return Promise.reject(new Error('no listing template yet; open the library once'));
    }
    var swapped;
    try {
      var outer = JSON.parse(freq);
      var inner = JSON.parse(outer[0][0][1]);
      inner[1] = count;
      inner[2] = cursor;
      outer[0][0][1] = JSON.stringify(inner);
      swapped = JSON.stringify(outer);
    } catch (err) {
      return Promise.reject(new Error('the listing template does not parse: ' + err.message));
    }
    return rpcPost(rpcUrl(LIBRARY_LIST_RPC, ''), swapped, LIBRARY_LIST_RPC, 'library listing');
  }

  function loadConversation(conv) {
    var freq = storedFreq(STORE_CONV_FREQ);
    if (!freq) {
      return Promise.reject(new Error('no conversation-load template yet; '
        + 'open any conversation once and the library learns how to ask'));
    }
    var swapped;
    try {
      var parsed = innerOf(freq);
      parsed.inner[0] = 'c_' + conv;
      parsed.outer[0][0][1] = JSON.stringify(parsed.inner);
      swapped = JSON.stringify(parsed.outer);
    } catch (err) {
      return Promise.reject(new Error('the conversation-load template does not parse: '
        + err.message));
    }
    return rpcPost(rpcUrl(CONV_LOAD_RPC, conv), swapped, CONV_LOAD_RPC, 'library origin')
      .then(function (payload) {
        // The answer names the conversation it is. A load that comes back
        // naming a different one is the substitution having failed, and reading
        // it would file another conversation's images under this one - which is
        // how a sweep of 292 ids read the same conversation 292 times and
        // reported nothing wrong. It is an error, not a result.
        var named = conversationIn(payload);
        if (named && named !== conv) {
          throw new Error('asked for ' + conv.slice(-6) + ' and the answer names '
            + named.slice(-6) + '; the template is not being substituted');
        }
        return payload;
      });
  }

  // §library:save ------------------------------------------------------------
  // lh3 does not answer a cross-origin fetch from this document, so the bytes
  // come through GM_xmlhttpRequest, which the header grants for exactly this.

  // Generous against a six megabyte original on a slow line, and far short of
  // the forever that a missing deadline means.
  var GET_TIMEOUT_MS = 90000;

  function gmGet(url, type) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest not granted'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: type,
        // Without one, ontimeout below can never fire: a stalled connection
        // leaves the promise pending, the button marked busy for good, and
        // every later click on it silently swallowed.
        timeout: GET_TIMEOUT_MS,
        onload: function (r) {
          if (r.status === 200) resolve(r.response);
          else reject(new Error('http ' + r.status));
        },
        onerror: function () { reject(new Error('network error')); },
        ontimeout: function () { reject(new Error('timed out')); }
      });
    });
  }

  // The download is a chain, not a request: `gg/<seed>=d-I` answers a
  // text/plain body holding the next URL, that one answers another, and only
  // the last answers the file. Each hop is followed until the body stops
  // being text.
  //
  // Pointers are followed to the host they name. The middle hop names
  // lh3.google.com, and rewriting it onto googleusercontent.com - which the
  // header's @connect used to be the only reason for - answers with a further
  // pointer rather than the file, on and on past any hop limit. The header
  // grants lh3.google.com instead, and the chain is walked as served.
  // Where the chain starts. The key is the seed and `=d-I` is what asks for the
  // file rather than a rendering of it.
  function seedUrl(key) {
    return 'https://lh3.googleusercontent.com/gg/' + key + '=d-I?alr=yes';
  }

  function followChain(url, hops) {
    return gmGet(url, 'blob').then(function (blob) {
      if (!blob || blob.type.indexOf('text/') !== 0) return blob;
      if (hops <= 0) throw new Error('the pointer chain did not end');
      return blob.text().then(function (text) {
        var next = text.trim();
        if (next.indexOf('https://') !== 0) {
          throw new Error('unexpected answer inside the pointer chain');
        }
        return followChain(next, hops - 1);
      });
    });
  }

  function saveBlob(blob, name) {
    var href = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
      URL.revokeObjectURL(href);
    }, 4000);
  }

  // The chain answers with whatever the image actually is, and the measured
  // original came back a JPEG. The name follows the type rather than asserting
  // png over it.
  function saveName(id, type) {
    var ext = 'img';
    if (/jpeg|jpg/.test(type || '')) ext = 'jpg';
    else if (/webp/.test(type || '')) ext = 'webp';
    else if (/png/.test(type || '')) ext = 'png';
    return 'gemini-' + id.slice(-12).replace(/[^A-Za-z0-9]/g, '') + '.' + ext;
  }

  // §library:click -----------------------------------------------------------
  // The button is Gemini's and its handler downloads the preview. Taking the
  // click in the capture phase is what leaves room to answer with the original
  // instead; the native download is only allowed through when the original
  // cannot be reached, so a failure here costs the smaller file, not nothing.

  var busy = Object.create(null);

  function previewKeyNear(el) {
    var node = el;
    for (var up = 0; node && up < 8; up++) {
      var img = node.querySelector && node.querySelector('img[src*="googleusercontent.com/gg/"]');
      if (img) {
        var key = lhKey(img.src);
        if (key) return key;
      }
      node = node.parentElement;
    }
    var dialog = document.querySelector('mat-dialog-container img[src*="googleusercontent.com/gg/"]');
    return dialog ? lhKey(dialog.src) : null;
  }

  // The page names the conversation on the button itself. Gemini tags its
  // logged controls with a `jslog` attribute, and the download button's carries
  // a BardVeMetadataKey naming the response, the conversation and the candidate
  // the image belongs to:
  //
  //   jslog="185865;track:...;BardVeMetadataKey:[["r_<hex>","c_<hex>",null,...]]"
  //
  // Only the `c_` entry is read. The click resolves to the outer custom
  // element while the attribute sits on the native button inside it, so the
  // element's own subtree is read first; the walk up the ancestors after it
  // covers a future move of the attribute up the tree. Ancestors are never
  // searched downward - high enough up, a descendant lookup would reach the
  // other cards and answer with some other image's conversation.
  function conversationTag(node) {
    var tag = node.getAttribute && node.getAttribute('jslog');
    var m = tag && /"c_([0-9a-f]{16})"/.exec(tag);
    return m ? m[1] : null;
  }

  function conversationNear(el) {
    var conv = conversationTag(el);
    if (conv) return conv;
    var tagged = el.querySelector && el.querySelector('[jslog*="c_"]');
    if (tagged) {
      conv = conversationTag(tagged);
      if (conv) return conv;
    }
    var node = el.parentElement;
    for (var up = 0; node && up < 8; up++) {
      conv = conversationTag(node);
      if (conv) return conv;
      node = node.parentElement;
    }
    return null;
  }

  // Every way the page offers to download a generated image, on both pages.
  // Three of them, and not one delivers the original: the control on the image,
  // the entry in the message's own menu, and the library card's button. The
  // control's label reads as the original-size download; taking that label at
  // its word is why this took the library page alone for as long as it did.
  var DOWNLOAD_BUTTONS = [
    'download-generated-image-button',
    '[data-test-id="download-generated-image-button"]',
    '[data-test-id="image-download-button"]'
  ].join(', ');

  // A conversation page names its conversation in its own address, which is the
  // one thing the library page has nothing to read.
  function conversationHere() {
    var found = /^\/app\/([0-9a-f]{16})/.exec(location.pathname);
    return found ? found[1] : null;
  }

  // Which image a click is about, answered differently on each page because the
  // two carry different things.
  //
  // A library card draws the image itself, so its key is on the element. A
  // conversation draws its generated images from blob: URLs and puts no key
  // anywhere near them; walking up from the button there reaches the message's
  // uploaded reference images, and seeding the chain with one of those hands
  // back a reference image in place of the generated one. What a conversation
  // does carry is the turn and the image's place in it, which is the other way
  // the ledger is indexed.
  function singleImageOf(button) {
    if (!button.closest('gem-menu, .cdk-overlay-pane')) return button.closest('single-image');
    // A menu entry opens in an overlay parented to the document, so walking up
    // from it reaches the overlay and never the message. What it belongs to is
    // the message marked as having a menu open.
    var owner = document.querySelector('message-actions.has-open-menu');
    var host = owner && owner.closest('.conversation-container');
    var images = host ? host.querySelectorAll('single-image') : [];
    // Which of several the entry means is stated nowhere on it, and answering
    // with the wrong image is worse than answering with a smaller copy of the
    // right one.
    if (images.length !== 1) {
      if (images.length) {
        dbg('download: the menu belongs to a message holding', images.length,
          'images and does not say which; leaving it to Gemini');
      }
      return null;
    }
    return images[0];
  }

  // The message menu opens in an overlay of its own, so nothing above the
  // button reaches the image. What names the message is the action row the menu
  // was opened from, and the turn around it holds the images.
  function menuHost() {
    var bar = document.querySelector('message-actions.has-open-menu');
    var turn = bar && bar.closest ? bar.closest('.conversation-container') : null;
    var hosts = turn ? turn.querySelectorAll('single-image[data-image-attachment-index]') : [];
    if (!hosts.length) return null;
    if (hosts.length > 1) {
      say('warn', LOG_IMG, 'download: the menu names no image and this turn holds '
        + hosts.length + '; the first is taken');
    }
    return hosts[0];
  }

  // Which image the lightbox is showing. The overlay it opens in holds no image
  // node of the message, so what names it is the image that was pressed to open
  // it, recorded on the way through.
  var lastImage = null;

  function noteImagePress(ev) {
    var host = ev.target && ev.target.closest
      ? ev.target.closest('single-image[data-image-attachment-index]') : null;
    if (host) lastImage = host;
  }

  function targetOf(button) {
    if (location.pathname.indexOf('/library') === 0) {
      var key = previewKeyNear(button);
      return key ? { id: key, key: key } : null;
    }
    var host = singleImageOf(button) || menuHost() || lastImage;
    if (!host || !host.isConnected) return null;
    var named = /"(r_[0-9a-f]{16})"/.exec(host.getAttribute('jslog') || '');
    var slot = parseInt(host.getAttribute('data-image-attachment-index'), 10);
    if (!named || isNaN(slot)) {
      dbg('download: this image names neither its turn nor its place in it');
      return null;
    }
    return { id: named[1] + '#' + slot, resp: named[1], slot: slot };
  }

  // The outcome of the last download, on the style node beside the ledger's
  // own counts. A console line is gone the moment the page is looked at from
  // outside it; this is readable at any time, by anyone, including a browser
  // being driven.
  function noteDownload(text) {
    var node = document.getElementById('gpie-style');
    if (node) node.setAttribute('data-download', text);
  }


  // The same question the mark answers: is there a media token for this image.
  // Nothing else is a reason to take a button.
  function downloadable(target, button) {
    if (target.resp) return !!tokenForTurn(target.resp, target.slot);
    var card = target.key ? cardOrigin(target.key) : null;
    if (!card || !card.resp) return false;
    if (cardsOfTurn(card.resp) > 1) return false;
    return !!tokenForTurn(card.resp, 0);
  }

  function onDownloadClick(ev) {
    var button = ev.target && ev.target.closest && ev.target.closest(DOWNLOAD_BUTTONS);
    if (!button) return;

    // Only an image this script can answer for. The mark on the page says which
    // ones those are, and it says it by the same rule this reads: a media token
    // on record. An image without one is the page's to download as it always
    // did - taking those buttons too left them delivering nothing at all.
    var target = targetOf(button);
    if (!target || !downloadable(target, button)) {
      dbg('download: unmarked image, left to the page');
      return;
    }

    // From here the page's own handler never runs. A button that sometimes
    // hands over one file and sometimes another is the thing this replaces.
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    if (busy[target.id]) return;
    busy[target.id] = true;
    info('download: fetching the original of ' + target.id.slice(-8));
    noteDownload('asking for ' + target.id.slice(-8));

    // There is one route and it is the lightbox's own: the image's media token
    // goes to the download rpc, the url that answers is walked to the file. No
    // other route exists here. A key chain seeded from the ledger, from a
    // conversation load or from the card itself reaches a file by a different
    // road, and a mark on this page promises this road.
    var card = target.key ? cardOrigin(target.key) : null;
    var conv = conversationNear(button) || conversationHere() || (card && card.conv);
    // A card names its turn but not which image in it, so it is answered for
    // only where that turn left one image in the library.
    var cardIsPlain = !!(card && card.resp && cardsOfTurn(card.resp) === 1);

    // Every token this turn has, the largest first. They are all the same
    // route; which of them the rpc answers for is what differs.
    function tokensNow() {
      if (target.resp) {
        var here = tokenForTurn(target.resp, target.slot);
        var all = tokensOfTurn(target.resp);
        if (here && all.indexOf(here) === -1) all.unshift(here);
        return all;
      }
      return cardIsPlain ? tokensOfTurn(card.resp) : [];
    }

    // One token, all the way to the bytes. The rpc and the chain are one
    // attempt, not two stages: a token the rpc answers for can still hand back
    // a key the chain refuses with a 400, and stopping at the rpc's answer left
    // that token's failure standing for the image while another token on the
    // same turn would have delivered the file. Measured on a turn whose ledger
    // rows had gone stale: the first token was refused outright, the second was
    // answered with a key the chain would not serve.
    function byToken(row) {
      return originalByToken(row, row.conv || conv).then(function (key) {
        noteDownload('the rpc answered, walking the download chain');
        // The chain the lightbox walks, seeded the way the lightbox seeds it.
        // Each hop's body is the next url and is used as it stands.
        return followChain(seedUrl(key), 4);
      });
    }

    function tryInTurn(tokens, i) {
      if (i >= tokens.length) {
        return Promise.reject(new Error(tokens.length
          ? 'none of the ' + tokens.length + ' token(s) this image has reached the file'
          : 'no token for this image'));
      }
      return byToken(tokens[i]).catch(function (err) {
        if (i + 1 >= tokens.length) throw err;
        dbg('download: token ' + (i + 1) + ' of ' + tokens.length
          + ' did not reach the file (' + err.message + '), the next is tried');
        return tryInTurn(tokens, i + 1);
      });
    }

    // A conversation reached by a full page load arrives inside the document
    // rather than over an rpc, so §origins never sees it and the ledger keeps
    // whatever an earlier sweep left. Those rows outlive the tokens they name,
    // and a stale row is indistinguishable from a live one until it is spent.
    // The reload is therefore the answer to a failure, not a precondition: the
    // held rows are tried first because they usually work, and the conversation
    // is asked for only once they have not.
    function refreshed(tried) {
      if (!conv) return Promise.reject(new Error('nothing names this image\'s conversation'));
      noteDownload('the held tokens did not answer, reloading the conversation');
      return loadConversation(conv).then(function (payload) {
        rememberOrigins(payload, 'a load made for this download');
        var late = tokensNow().filter(function (row) { return tried.indexOf(row.token) === -1; });
        if (!late.length) throw new Error('the conversation lists no token this image has not already spent');
        info('download: the conversation answered with ' + late.length + ' token(s) not tried yet');
        return tryInTurn(late, 0);
      });
    }

    var held = tokensNow();
    noteDownload(held.length + ' token(s) held, asking the download rpc');
    tryInTurn(held, 0).catch(function (err) {
      dbg('download: the held tokens did not reach the file (' + err.message + ')');
      return refreshed(held.map(function (row) { return row.token; }));
    }).then(function (blob) {
      noteDownload('fetched ' + blob.size + ' bytes, saving');
      saveBlob(blob, saveName(target.id, blob.type));
      info('download: saved the original from the download rpc, '
        + Math.round(blob.size / 1024) + ' KB');
      noteDownload('saved ' + blob.size + ' bytes of ' + target.id.slice(-8));
    }).catch(function (err) {
      say('warn', LOG_IMG, 'download: the original could not be fetched (' + err.message
        + '); nothing was saved, and nothing else was tried');
      noteDownload('failed: ' + err.message);
    }).then(function () {
      delete busy[target.id];
    });
  }

  // §library:mark ------------------------------------------------------------
  // Which cards this script can answer for is invisible on the page: every card
  // draws a preview, and whether the original behind it is reachable only shows
  // after a download has already run. The mark says so beforehand.
  //
  // Read fresh on every pass rather than trusted from the last one. The grid is
  // Angular's and is rebuilt freely, and the ledger fills in the background, so
  // a card can become answerable without anything about the card changing.
  // A card's key is not the key the conversation used. Measured on one image
  // three ways: the listing draws the card from `ACRwjavaE-_a...`, while the
  // conversation that made it lists `ACRwjasdpmZb...` beside its original
  // `ACRwjauXOvKL...`. Three renditions, one image, and a lookup by key alone
  // reports the card as unknown while the original sits in the ledger under a
  // key the card never carries.
  //
  // What the two do share is the turn. The listing names every card's response
  // id - §origins keeps that index - and the ledger is written by turn as well
  // as by key, which is the same identity the download already falls back to.
  function markableCard(key) {
    var card = cardOrigin(key);
    if (!card || !card.resp) return false;
    // More than one card names this turn, so which of its images this card
    // shows cannot be told, and the mark would promise the wrong one.
    if (cardsOfTurn(card.resp) > 1) return false;
    // The token and nothing else. A key on file reaches the image by the road
    // this page no longer takes, so marking on one would promise a download
    // that cannot be made.
    return !!tokenForTurn(card.resp, 0);
  }

  function markLibraryCards() {
    if (location.pathname.indexOf('/library') !== 0) return;
    var imgs = document.querySelectorAll(
      'div.library-item-card > img[src*="googleusercontent.com/gg/"]');
    for (var i = 0; i < imgs.length; i++) {
      var card = imgs[i].parentElement;
      if (!card) continue;
      var known = markableCard(lhKey(imgs[i].src));
      var dot = card.querySelector(':scope > .gpie-origin-dot');
      if (known === !!dot) continue;
      if (!known) {
        dot.remove();
        continue;
      }
      // The card positions nothing of its own, so the corner has to be made
      // before anything can sit in it.
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      dot = document.createElement('span');
      dot.className = 'gpie-origin-dot';
      dot.title = 'the original of this image is on record';
      card.appendChild(dot);
    }
  }

  // The same mark on a conversation page. An image there renders from a blob:
  // URL and carries no key at all, so what is looked up is the turn and the
  // slot within it - the same identity the download takes - rather than a key.
  // Without this the mark existed only where images are listed and not where
  // they are made, which reads as the mark being broken.
  function markConversationImages() {
    if (location.pathname.indexOf('/app/') !== 0) return;
    var hosts = document.querySelectorAll('single-image[data-image-attachment-index]');
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      var named = /"(r_[0-9a-f]{16})"/.exec(host.getAttribute('jslog') || '');
      var slot = parseInt(host.getAttribute('data-image-attachment-index'), 10);
      var known = !!(named && !isNaN(slot) && tokenForTurn(named[1], slot));
      var dot = host.querySelector(':scope > .gpie-origin-dot');
      if (known === !!dot) continue;
      if (!known) {
        dot.remove();
        continue;
      }
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      dot = document.createElement('span');
      dot.className = 'gpie-origin-dot';
      dot.title = 'the original of this image is on record';
      host.appendChild(dot);
    }
  }

  function installLibraryHook() {
    document.addEventListener('click', noteImagePress, true);
    document.addEventListener('click', onDownloadClick, true);
    // After the style node exists, which is what the report is written on.
    setTimeout(noteTemplates, 0);
  }
  // §origins =================================================================
  // A library card is not enough to download the image it shows. The card
  // carries a rendition of its own, measured to be a third key again - neither
  // the conversation's preview nor its original - and it is capped at the
  // preview's pixels however the request is phrased: `=s0`, `=d` and `=s4096`
  // all answer 848x1264 where the original is 1696x2528. The original has to
  // come from the conversation.
  //
  // Two things there reach it, and only one of them reaches most images.
  //
  // The pair. An answer that lists both copies declares each one's pixels, and
  // the original is exactly twice the preview - see §origins:read. This is free
  // to use afterwards and answers nothing for an image the answer lists once,
  // which measured as 26 turns out of 189 conversations.
  //
  // The token. Every image the answer lists carries a media token, and the
  // download rpc trades that token for the original - see §library:token. It
  // costs one request at the moment of the download and it answers for every
  // image the conversation still lists: 178 turns of the same 189.
  //
  // Both are written down as answers go by rather than asked for at the moment
  // of the download, because by then the answer may no longer exist. Edit an
  // image once and the version it replaced is dropped from the conversation
  // while the library keeps its card, and from then on nothing - no pair, no
  // token, no route at all - reaches that original. Those cards are not marked
  // and cannot be.

  // Read once at startup and answered from memory afterwards. The library draws
  // its mark on every scan pass, and a store read per card per pass would be
  // paid for on a page that holds hundreds of them.
  var origins = Object.create(null);
  // The same ledger read the other way. A conversation page has no key to look
  // an image up by, only the turn it sits in and its place in that turn.
  var byTurn = Object.create(null);
  // The media token a turn's image carries, which §library hands to the
  // download rpc to be given the original. Kept beside the pairs rather than in
  // place of them: a pair answers without a request, a token costs one.
  var turnTokens = Object.create(null);
  // The same tokens under the turn alone. §library draws its mark on every scan
  // pass and a library page holds hundreds of cards, so the lookup a card makes
  // has to be a hash read rather than a walk over every token held.
  var tokenByResp = Object.create(null);
  // Every conversation this browser has been told exists, and when the ledger
  // last read it. The sweep's work list is the ones with no readAt.
  var knownConvs = Object.create(null);
  // A library card names its own conversation and its own turn. Neither is on
  // the card in the grid - its jslog is a metadata key of nothing but nulls -
  // but both are in the listing answer that put it there, alongside the key of
  // the copy it displays. That makes the listing a card-to-conversation index,
  // which is what lets a download on a card the ledger has never seen resolve
  // in one request instead of failing or sweeping.
  //
  // Memory only. It costs a fourteen-second harvest to refill and is worth less
  // than the upgrade hazard a third object store would carry.
  var cardConv = Object.create(null);

  function turnSlot(resp, slot) {
    return resp + '#' + slot;
  }

  // The ledger's size as an attribute, which survives where a log line does
  // not: it answers "is the ledger filling" for a page opened long after the
  // lines scrolled past, and for a driver that attached after load. §log now
  // writes to the page's console as well, so this is a second view of the same
  // thing rather than the only one.
  // #gpie-style already carries data-version for the same reason.
  // Three numbers: keys held, turns indexed, and conversations answered out of
  // ids still worth asking about. A candidate that answered nothing is counted
  // in neither - it is not a conversation and will not be asked again.
  function convTally() {
    var answered = 0;
    var pending = 0;
    for (var id in knownConvs) {
      if (!readInThisGeneration(knownConvs[id])) pending++;
      else if (knownConvs[id].kind === 'conversation') answered++;
    }
    return answered + 'of' + (answered + pending);
  }

  // What the page can see of a run that would otherwise be silent. One node,
  // reused: a sweep reports into it while it works and leaves the outcome
  // there, and a run started by hand is answered the moment it is asked for.
  var progressHide = 0;

  function progress(text, done) {
    var node = document.getElementById('gpie-progress');
    if (!node) {
      node = document.createElement('div');
      node.id = 'gpie-progress';
      node.className = 'gpie-progress';
      (document.body || document.documentElement).appendChild(node);
    }
    node.className = 'gpie-progress' + (done ? ' gpie-done' : '');
    node.textContent = text;
    if (progressHide) clearTimeout(progressHide);
    progressHide = done ? setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 8000) : 0;
  }

  function noteLedgerSize() {
    var node = document.getElementById('gpie-style');
    if (!node) return;
    node.setAttribute('data-origins', Object.keys(origins).length
      + '/' + Object.keys(byTurn).length
      + '/' + convTally());
  }

  // `origins` is initialised when this part runs, which is after §boot's own
  // top-level statements. Every reader below is reached from a timer or an
  // event, long after the whole script has run, but the guard costs one token
  // and removes the question.
  function originalFor(key) {
    var known = key && origins && origins[key];
    return known ? known.original : null;
  }

  // A turn's images are numbered by the page from what it renders, and the
  // answer's own ordering does not always agree - one measured turn carried two
  // tokens where the page shows one image. An exact slot is preferred and the
  // turn's longest token is the fallback: the token that answers is 281
  // characters where the one that answers nothing is shorter, measured on both
  // conversations read while this was written.
  function tokenForTurn(resp, slot) {
    if (!resp || !turnTokens) return null;
    return turnTokens[turnSlot(resp, slot)] || tokenByResp[resp] || null;
  }

  // Both indexes are written together, and the turn's index keeps the longest
  // token it has been shown.
  function holdToken(row) {
    if (!row || !row.token || !row.resp) return;
    turnTokens[turnSlot(row.resp, row.slot)] = row;
    var best = tokenByResp[row.resp];
    if (!best || row.token.length > best.token.length) tokenByResp[row.resp] = row;
  }

  // A library card names the turn it came from but not which image in it, so a
  // turn whose images are several is ambiguous: answering with slot 0 hands
  // back another image under this card's name, which §library holds to be worse
  // than answering with a smaller copy.
  //
  // What counts the images is the listing, not the ledger. A single image is
  // listed twice in a conversation answer - the preview and the original, each
  // with a token of its own - so counting token rows called every turn
  // ambiguous and took every mark on the page down with it. The library draws
  // one card per image, so the cards that name a turn are its images.
  var cardsPerTurn = Object.create(null);

  // Every token recorded for a turn, the one whose node declared the most bytes
  // first. An image is listed twice and only the original's token is answered
  // for by the download rpc, so the order is what makes the first ask the right
  // one; rows stored before the byte count was kept sort last and are tried in
  // the order they were read.
  function tokensOfTurn(resp) {
    if (!resp) return [];
    var prefix = resp + '#';
    var rows = [];
    for (var at in turnTokens) {
      if (at.indexOf(prefix) === 0) rows.push(turnTokens[at]);
    }
    rows.sort(function (a, b) { return (b.bytes || 0) - (a.bytes || 0); });
    return rows;
  }

  function cardsOfTurn(resp) {
    return (resp && cardsPerTurn[resp]) || 0;
  }

  function originalForTurn(resp, slot) {
    var known = resp && byTurn && byTurn[turnSlot(resp, slot)];
    return known ? known.original : null;
  }

  function loadOrigins() {
    return dbReadAll(ORIGINS).then(function (rows) {
      rows.forEach(function (row) {
        if (!row || !row.key) return;
        if (row.token) {
          holdToken(row);
          return;
        }
        origins[row.key] = row;
        if (row.resp && typeof row.slot === 'number') byTurn[turnSlot(row.resp, row.slot)] = row;
      });
      noteLedgerSize();
      dbg('origins:', rows.length, 'keys read back from the ledger');
      // Cards already drawn were drawn against an empty ledger.
      if (rows.length) schedule();
    }).then(function () {
      return dbReadAll(CONVERSATIONS).then(function (rows) {
        rows.forEach(function (row) {
          if (row && row.key) knownConvs[row.key] = row;
        });
        noteLedgerSize();
        dbg('origins:', rows.length, 'ids read back,', convTally(), 'conversations answered');
      });
    }).catch(function (err) {
      say('warn', LOG_IMG, 'the origin ledger could not be read:', err);
    });
  }

  // §origins:convs -----------------------------------------------------------
  // A sweep needs a work list and neither page carries one. A library card
  // names no conversation at all, and a sidebar entry keeps its id in Angular's
  // own state rather than in an href or an attribute.
  //
  // The answers do carry it. Rather than identify which rpc lists the sidebar -
  // it is served once at page load, before anything outside this script could
  // be watching - every batchexecute answer is scanned for conversation ids and
  // whatever it names is remembered. An answer naming none costs one regular
  // expression over a body already in memory.
  function remember(ids, kind) {
    var fresh = [];
    ids.forEach(function (id) {
      if (knownConvs[id]) return;
      knownConvs[id] = { key: id, readAt: 0, kind: kind };
      fresh.push(knownConvs[id]);
    });
    if (!fresh.length) return 0;
    noteLedgerSize();
    dbWrite(CONVERSATIONS, fresh).catch(function (err) {
      say('warn', LOG_IMG, 'the conversation list could not be written:', err);
    });
    return fresh.length;
  }

  // The ids sit quoted inside a quoted payload, so their quotes arrive escaped
  // and a pattern anchored on a plain quote matches nothing - which is why a
  // library page full of them once contributed none. Matching the id itself
  // sidesteps the quoting; the one thing to exclude is rc_, which ends in the
  // same sixteen digits behind a different prefix.
  function noteConversationIds(text) {
    var found = text.match(/(^|[^r])c_[0-9a-f]{16}/g);
    if (!found) return;
    var added = remember(found.map(function (hit) {
      return hit.slice(hit.indexOf('c_') + 2);
    }), 'conversation');
    if (added) dbg('origins:', added, 'conversations named by an answer');
  }

  // The sidebar's own list is not fetched, it is baked into the page, and its
  // ids are written bare - no c_ in front of them anywhere in the document.
  // Bare sixteen hex digits is not a shape that tells a conversation from a
  // response or a candidate, and the page holds ninety of them against
  // The bare hex ids scattered through the page used to be collected here and
  // fed to the sweep as candidates, on the reasoning that the server would rule
  // out the ones that name nothing. It did, at a request each: one run reported
  // ninety-four conversations found and two keys learned. The library listing
  // names conversations exactly, so the guessing is gone and the sweep's work
  // list is what the listing said.

  // A conversation is read by a particular version of the reader. Until 3.23.0
  // the reader substituted nothing and every load answered with whichever
  // conversation the stored template already named, so a mark left by an older
  // generation records that an id was asked for, not that it was read. Stamping
  // the generation is what lets those marks be retired instead of trusted; the
  // alternative was telling every install to clear its ledger by hand. The
  // stamp moves again whenever the reader changes what it can extract: 3 is the
  // doubling rule, which pairs answers the parent rule discarded; 4 is the media
  // token, which reaches originals the doubling rule never paired at all.
  var SWEEP_GENERATION = 4;

  function readInThisGeneration(row) {
    return !!(row && row.readAt && row.generation === SWEEP_GENERATION);
  }

  function markConversationRead(conv) {
    if (!conv) return;
    var row = knownConvs[conv] || (knownConvs[conv] = { key: conv, readAt: 0 });
    row.readAt = Date.now();
    row.generation = SWEEP_GENERATION;
    noteLedgerSize();
    dbWrite(CONVERSATIONS, [row]).catch(function () {
      // A mark that cannot be stored costs one repeated read, nothing worse.
    });
  }

  // The answer says which conversation it is - the turn's header tuple opens
  // with the conversation id - so nothing has to be threaded in from a caller.
  function conversationIn(payload) {
    var found = /"c_([0-9a-f]{16})"/.exec(JSON.stringify(payload));
    return found ? found[1] : null;
  }

  // §origins:read ------------------------------------------------------------

  // An answer lists an image's two copies, each declaring [width, height,
  // bytes], and the original is exactly twice the preview in both directions.
  // Measured without exception: 896x1200 beside 1792x2400, 1264x848 beside
  // 2528x1696. That doubling is what identifies a pair.
  //
  // Sharing a parent was the first rule and it does not hold. A parent collects
  // whatever the answer nests together, which measured as groups of one, two,
  // four and five across fifteen conversations - the four uploaded reference
  // images and the preview under one parent, the original alone under another.
  // Requiring a parent of exactly two entries then threw away the pair the
  // answer plainly contained: nine groups of fifty-six paired, and a library of
  // 1,283 images ended with seven originals on record.
  //
  // The uploads cannot be mistaken for a pair under the doubling rule - a
  // measured turn carried 299x299, 768x1024, 1090x1090 and 848x1264, no one of
  // them twice another - which is what the parent rule was guarding against.
  //
  // An answer also lists the same entry more than once, so entries are reduced
  // to one per key before anything is matched.
  function pairsIn(payload) {
    var seen = Object.create(null);
    var entries = [];
    imageEntries(payload).forEach(function (entry) {
      if (!entry.size || seen[entry.key]) return;
      seen[entry.key] = true;
      entries.push(entry);
    });

    // A turn at a time, so two images generated in one turn cannot pair across
    // turns, and so the slot numbering runs in the order the answer lists them.
    var turns = [];
    var byResp = Object.create(null);
    entries.forEach(function (entry) {
      var resp = entry.resp || '';
      if (!byResp[resp]) {
        byResp[resp] = [];
        turns.push(resp);
      }
      byResp[resp].push(entry);
    });

    var pairs = [];
    turns.forEach(function (resp) {
      var group = byResp[resp];
      var taken = Object.create(null);
      var slot = -1;
      group.forEach(function (small) {
        var big = null;
        for (var i = 0; i < group.length && !big; i++) {
          var other = group[i];
          if (other === small || taken[other.key]) continue;
          if (other.size[0] !== small.size[0] * 2) continue;
          if (other.size[1] !== small.size[1] * 2) continue;
          if (other.size[2] <= small.size[2]) continue;
          big = other;
        }
        if (!big) return;
        taken[big.key] = true;
        taken[small.key] = true;
        slot++;
        [small, big].forEach(function (entry) {
          pairs.push({
            key: entry.key,
            original: big.key,
            resp: resp || null,
            slot: resp ? slot : null,
            w: big.size[0],
            h: big.size[1],
            bytes: big.size[2]
          });
        });
      });
    });
    return pairs;
  }

  function rememberOrigins(payload, where) {
    var pairs;
    try {
      pairs = pairsIn(payload);
    } catch (err) {
      dbg('origins: the answer could not be read (' + err.message + ')');
      return;
    }
    rememberTokens(payload);
    if (!pairs.length) return;

    var now = Date.now();
    var fresh = 0;
    pairs.forEach(function (pair) {
      if (!origins[pair.key]) fresh++;
      pair.seenAt = now;
      origins[pair.key] = pair;
      if (pair.resp && typeof pair.slot === 'number') {
        byTurn[turnSlot(pair.resp, pair.slot)] = pair;
      }
    });
    noteLedgerSize();
    dbWrite(ORIGINS, pairs).then(function () {
      dbg('origins: ' + where + ' contributed', pairs.length, 'keys,', fresh, 'of them new');
      // A mark can be drawn now that could not be a moment ago.
      if (fresh) schedule();
    }).catch(function (err) {
      say('warn', LOG_IMG, 'the origin ledger could not be written:', err);
    });
  }

  // Stored under a key of their own so one ledger holds both without either
  // shadowing the other; a token row is never an image key and never answers a
  // lookup by one.
  function rememberTokens(payload) {
    var conv = conversationIn(payload);
    if (!conv) return;
    var rows;
    try {
      rows = tokenEntries(payload);
    } catch (err) {
      dbg('origins: the tokens could not be read (' + err.message + ')');
      return;
    }
    var fresh = [];
    rows.forEach(function (row) {
      var at = turnSlot(row.resp, row.slot);
      if (turnTokens[at] && turnTokens[at].token === row.token) return;
      row.key = 'tok:' + at;
      row.conv = conv;
      holdToken(row);
      fresh.push(row);
    });
    if (!fresh.length) return;
    noteLedgerSize();
    dbWrite(ORIGINS, fresh).then(function () {
      dbg('origins:', fresh.length, 'tokens recorded');
      schedule();
    }).catch(function (err) {
      say('warn', LOG_IMG, 'the tokens could not be written:', err);
    });
  }

  function noteConversationText(text, where) {
    if (typeof text !== 'string' || !text) return;
    noteConversationIds(text);
    if (where.indexOf('generation') !== -1) {
      // Read for its tokens, not marked as read: this is one turn and the
      // sweep still has the rest of the conversation to walk.
      wrbPayloads(text, null).forEach(function (chunk) {
        rememberOrigins(chunk, where);
      });
      return;
    }
    if (where.indexOf('conversation load') === -1) {
      // A listing answer indexes cards; it carries no pairs.
      try {
        noteCardConversations(wrbPayload(text, LIBRARY_LIST_RPC));
      } catch (err) {
        // Most answers on that address are not listings.
      }
      return;
    }
    var payload;
    try {
      payload = wrbPayload(text, CONV_LOAD_RPC);
    } catch (err) {
      // Not every answer on that address carries a payload this can read - a
      // failed load answers a short envelope with nothing in it.
      return;
    }
    markConversationRead(conversationIn(payload));
    rememberOrigins(payload, where);
  }

  // Each card is one entry: a URL holding the key of the copy the grid shows,
  // and the two ids that say where it came from. The card's key is a preview -
  // measured at half the original in both directions, 896x1200 against
  // 1792x2400 - so the listing names the image without ever naming its original.
  function noteCardConversations(payload, standing) {
    var cards = payload && Array.isArray(payload[0]) ? payload[0] : null;
    if (!cards) return 0;
    var added = 0;
    cards.forEach(function (card) {
      if (!Array.isArray(card)) return;
      var text = JSON.stringify(card);
      var url = /googleusercontent\.com\/gg\/[A-Za-z0-9_-]+/.exec(text);
      var conv = /(^|[^r])c_([0-9a-f]{16})/.exec(text);
      if (!url || !conv) return;
      var key = lhKey(url[0]);
      if (!key) return;
      if (cardConv[key]) {
        if (standing && cardConv[key].resp) standing[cardConv[key].resp] = true;
        return;
      }
      var resp = /r_[0-9a-f]{16}/.exec(text);
      if (resp && standing) standing[resp[0]] = true;
      cardConv[key] = { conv: conv[2], resp: resp ? resp[0] : null };
      // One card per image, so this counts the images the turn still has here.
      if (resp) cardsPerTurn[resp[0]] = (cardsPerTurn[resp[0]] || 0) + 1;
      added++;
    });
    return added;
  }

  // A token is worth keeping only while the card it belongs to is still in the
  // library. Delete an image there and the ledger would otherwise hold its
  // token for good: nothing prunes, and no card is ever drawn for it again, so
  // the row is dead the moment the card goes.
  //
  // Reconciled against the listing rather than hooked onto the delete, which
  // makes it answer for a deletion made in another tab, on another machine, or
  // before this script was installed - and costs nothing beyond the harvest the
  // library page already runs.
  //
  // Only against a listing read to its end. A harvest that stopped early has
  // seen some of the library, and pruning against that would throw away tokens
  // for cards it simply never reached.
  function pruneVanished(standing) {
    var gone = [];
    for (var at in turnTokens) {
      var row = turnTokens[at];
      if (standing[row.resp]) continue;
      gone.push(row);
    }
    if (!gone.length) return 0;
    gone.forEach(function (row) {
      delete turnTokens[turnSlot(row.resp, row.slot)];
      // By the turn, not by identity. The second index keeps the longest token
      // a turn has been shown, which is often a different row object from the
      // one being pruned, and comparing the two left that turn answering with a
      // token whose card the listing no longer names.
      delete tokenByResp[row.resp];
    });
    dbDelete(ORIGINS, gone.map(function (row) { return row.key; })).catch(function (err) {
      say('warn', LOG_IMG, 'the vanished tokens could not be dropped:', err);
    });
    noteLedgerSize();
    schedule();
    return gone.length;
  }

  // What the library page knows about one of its own cards. Read by §library
  // when a download lands on a card whose original is not in the ledger.
  function cardOrigin(key) {
    return (key && cardConv[key]) || null;
  }

  // §origins:tap -------------------------------------------------------------
  // The answer is read where it already goes by. A conversation load runs to
  // megabytes and this script has no business asking for one the page was not
  // going to make anyway; both transports are tapped for the same reason §net
  // hooks both, so a migration off either does not silently empty the ledger.

  // Two things are read, from different sets of answers. The pairs come from a
  // conversation load alone; the conversation ids come from any answer that
  // happens to name one, because the answer listing them all is served before
  // this script could ask for it.
  function whatToRead(url) {
    if (typeof url !== 'string') return null;
    // A generation answers with the turn it has just written, in the shape a
    // conversation load answers with the whole thread. Reading it is what puts
    // an image on record while it is being looked at, rather than on whatever
    // later load happens to walk past it.
    if (url.indexOf('StreamGenerate') !== -1) return 'generation';
    if (url.indexOf('batchexecute') === -1) return null;
    return url.indexOf('rpcids=' + CONV_LOAD_RPC) !== -1 ? 'conversation load' : 'answer';
  }

  function tapRpcXhr(xhr, url) {
    var kind = whatToRead(url);
    if (!kind) return;
    xhr.addEventListener('load', function () {
      try {
        noteConversationText(xhr.responseText, 'an xhr ' + kind);
      } catch (err) {
        // Reading the answer must never break the request it rode in on.
      }
    });
  }

  function tapRpcFetch(url, promise) {
    var kind = whatToRead(url);
    if (!kind) return promise;
    return promise.then(function (res) {
      try {
        // The page's own copy of the body is left untouched; the clone is this
        // script's to consume.
        res.clone().text().then(function (text) {
          noteConversationText(text, 'a fetch ' + kind);
        }, function () {
          // A body that cannot be read teaches nothing.
        });
      } catch (err) {
        // Cloning fails on a body already consumed elsewhere.
      }
      return res;
    });
  }


  // §origins:sweep -----------------------------------------------------------
  // The ledger fills as conversations are opened, which leaves a newly
  // installed script marking almost nothing while the library shows every image
  // ever generated. The sweep reads the conversations that have been learned of
  // but never read, so the marks mean something before every thread has been
  // walked by hand.
  //
  // From the menu rather than a page visit: it is this script issuing requests
  // the page was not going to make, one per conversation, which is a thing to
  // be asked for. They go one at a time with a pause, and a conversation
  // already read is skipped, so a second run costs one pass over an empty list.
  var sweeping = false;
  var harvested = false;
  // `harvested` is set before the harvest starts, so it says a harvest has been
  // asked for, not that one has finished. What has to wait on the requests
  // themselves - the sweep, whose 189 conversation loads on top of a listing
  // replay is the traffic that met Google's interstitial - waits on this.
  var harvesting = false;
  var afterHarvest = [];

  // The work list comes off the library's listing rpc, replayed rather than
  // scrolled for. Neither the cards nor a lightbox is touched.
  //
  // Scrolling was the first attempt and it cannot be done from here. The grid
  // positions itself by transform: under a real wheel it pages happily while
  // not one ancestor's scrollTop changes, so there is no element for a script
  // to move, and an untrusted wheel event moves nothing. Measured, the grid sat
  // on its first thirty cards through every combination of scrollTop,
  // scrollIntoView and dispatched wheels.
  //
  // The listing itself has no such problem. Its body is [[flags], count,
  // cursor]; the answer ends with the cursor for the page after it, and carries
  // the conversation ids of the cards it just described. Asking for page after
  // page reads the whole library in a handful of requests.
  // Measured on a library of 1,283 images: thirteen pages, eight seconds, 180
  // conversations named. A hundred at a time is what makes that hold - the
  // page asks for far fewer, and the listing answers whatever it is asked for.
  var PAGE_SIZE = 100;
  var MAX_PAGES = 60;

  function harvestLibrary(then) {
    harvesting = true;
    var known = Object.keys(knownConvs).length;
    var pages = 0;
    var cards = 0;
    var indexed = 0;
    var cursor = '';
    // Every turn the listing still names, gathered as the pages go by.
    var standing = Object.create(null);
    info('origins: reading the library listing');
    progress('Reading the library listing...');

    function next() {
      if (pages >= MAX_PAGES) {
        done('the listing did not run out');
        return;
      }
      loadLibraryPage(cursor, PAGE_SIZE).then(function (payload) {
        pages++;
        // The answer is [the cards, the cursor for the page after them]. The
        // last page carries no cursor, and that absence is the only
        // end-of-listing signal there is.
        var items = Array.isArray(payload[0]) ? payload[0] : [];
        var carry = typeof payload[1] === 'string' ? payload[1] : '';
        cards += items.length;
        progress('Reading the library listing: page ' + pages + ', ' + cards + ' cards');
        noteConversationIds(JSON.stringify(payload));
        indexed += noteCardConversations(payload, standing);
        // The absence of a cursor is the only end-of-listing signal, and the
        // label matters beyond bookkeeping: 'read to the end' is what lets the
        // prune delete tokens. A listing that repeats its cursor or answers an
        // empty page while still carrying one has stopped making progress, not
        // ended, and pruning against it would drop the tokens of every card on
        // the pages it never reached.
        if (!carry) {
          done('read to the end');
          return;
        }
        if (carry === cursor || !items.length) {
          done('the listing stopped making progress at page ' + pages);
          return;
        }
        cursor = carry;
        setTimeout(next, 200);
      }, function (err) {
        done('the listing stopped answering (' + err.message + ')');
      });
    }

    function done(why) {
      // Also on the style node, for the same reason the ledger's size is:
      // a harvest that stopped early and one that found nothing read the same
      // to anyone who was not watching the console while it ran.
      var named = Object.keys(knownConvs).length - known;
      var dropped = why === 'read to the end' ? pruneVanished(standing) : 0;
      var told = pages + ' pages, ' + cards + ' cards, ' + indexed + ' indexed, '
        + named + ' named, ' + dropped + ' dropped, ' + why;
      var node = document.getElementById('gpie-style');
      if (node) node.setAttribute('data-harvest', told);
      info('origins: ' + told);
      progress('Listing read: ' + cards + ' cards, ' + indexed + ' indexed'
        + (dropped ? ', ' + dropped + ' stale tokens dropped' : ''), true);
      harvesting = false;
      var waiting = afterHarvest;
      afterHarvest = [];
      then();
      waiting.forEach(function (fn) { fn(); });
    }

    next();
  }

  // The listing is what says which card belongs to which conversation, and the
  // page asks for thirty cards at a time. A card the grid has never reached is
  // a card no mark can be drawn on, so the listing is read to its end as soon
  // as a library page opens rather than waiting for a scroll that may never
  // come. Measured at thirteen requests and eight seconds against 1,283 cards.
  //
  // Only the index is built here. Nothing is fetched per conversation, which is
  // what makes this cheap enough to run unasked; filling the ledger itself is
  // still the sweep's job and still asked for from the menu.
  //
  // Once per visit, not once per page load. Every mark is drawn from this
  // index, and an image made after it was built is absent from it, so a load
  // that read the listing before that image existed marks nothing for it. The
  // application never reloads on its own, so nothing rebuilt the index either,
  // and the mark stayed missing until the page was reloaded by hand - which is
  // indistinguishable from the mark being broken.
  //
  // The interval is against a library entered and left repeatedly: thirteen
  // requests and a progress panel per visit, for an index that cannot have
  // moved in between. Making an image and coming back takes longer than this.
  var INDEX_MIN_GAP = 60000;
  var indexedAt = 0;

  function indexLibrary() {
    if (location.pathname.indexOf('/library') !== 0) return;
    // `harvested` no longer serves as this guard, since it now says a harvest
    // has happened at some point rather than that one is under way.
    if (harvesting) return;
    if (harvested && Date.now() - indexedAt < INDEX_MIN_GAP) return;
    harvested = true;
    indexedAt = Date.now();
    // The index alone, which is thirteen requests. The sweep that follows it is
    // one request per conversation and stays on the menu: running 189 of them
    // unasked, twelve abreast, on top of the replay is what put this browser in
    // front of Google's interstitial while this was being measured.
    harvestLibrary(schedule);
  }

  function sweepOrigins() {
    if (harvesting) {
      // The library page starts its own harvest four seconds after it opens,
      // and the menu is reachable throughout. Both at once is the listing
      // replay and the sweep sharing a window, which is what to avoid.
      if (afterHarvest.indexOf(sweepOrigins) === -1) afterHarvest.push(sweepOrigins);
      info('origins: the library listing is still being read - the sweep follows it');
      progress('Reading the library listing first...');
      return;
    }
    if (sweeping) {
      info('origins: the sweep is already running');
      progress('The sweep is already running');
      return;
    }
    // The library is the one page that can say which conversations matter, so
    // it is read first and the sweep follows on what it found.
    if (location.pathname.indexOf('/library') === 0 && !harvested) {
      harvested = true;
      indexedAt = Date.now();
      // The harvest is an optimisation, not a precondition: the ids it looks
      // for also arrive on their own, from every listing answer the page makes.
      // So it is given a deadline and the sweep runs either way, rather than a
      // listing that stops answering taking the sweep down with it.
      //
      // Two minutes, against a measured eight seconds. The first deadline here
      // was twenty seconds, which cut a working harvest off in the middle of
      // its thirteen pages and was then read as the replay having hung.
      var moved = false;
      var carryOn = function () {
        if (moved) return;
        moved = true;
        sweepOrigins();
      };
      setTimeout(function () {
        if (moved) return;
        var node = document.getElementById('gpie-style');
        if (node) node.setAttribute('data-harvest', 'timed out, sweeping anyway');
        // The harvest is given up on here, so the sweep that follows is not
        // sent back to wait on it. A listing that answers later finds nothing
        // queued and simply finishes.
        harvesting = false;
        carryOn();
      }, 120000);
      harvestLibrary(carryOn);
      return;
    }
    var pending = [];
    for (var id in knownConvs) {
      if (!readInThisGeneration(knownConvs[id])) pending.push(id);
    }
    if (!pending.length) {
      info('origins: nothing left to try - ' + convTally() + ' conversations answered');
      progress('Nothing left to sweep (' + convTally() + ')', true);
      return;
    }

    sweeping = true;
    var before = Object.keys(origins).length;
    var total = pending.length;
    var read = 0;
    var silent = 0;
    progress('Sweeping for originals: 0 / ' + total);
    info('origins: sweeping ' + pending.length + ' ids not tried yet - most of them '
      + 'will not be conversations, which is how they get ruled out');

    // Twelve at a time rather than one every 400ms. Sequential and polite is
    // what a background sweep wants; a sweep asked for by hand is waited on,
    // and 187 conversations at two and a half seconds each is seven minutes of
    // waiting for work that finishes in half a minute when it runs abreast.
    var WORKERS = 12;
    var running = 0;
    var stopped = false;

    function finish() {
      sweeping = false;
      info('origins: ' + read + ' were conversations, ' + silent + ' were not, ledger '
        + before + ' -> ' + Object.keys(origins).length + ' keys');
      progress('Sweep finished: ' + read + ' conversations read, ledger '
        + before + ' -> ' + Object.keys(origins).length + ' keys', true);
      schedule();
    }

    function next() {
      if (stopped) return;
      if (!pending.length) {
        if (!running) finish();
        return;
      }
      var conv = pending.shift();
      running++;
      loadConversation(conv).then(function (payload) {
        if (!conversationIn(payload)) {
          silent++;
          markConversationRead(conv);
          return;
        }
        read++;
        knownConvs[conv].kind = 'conversation';
        rememberOrigins(payload, 'the sweep');
      }, function (err) {
        // A template that will not substitute is not this id being
        // unanswerable - it is every id being unanswerable, and marking them
        // read would quietly empty the work list while learning nothing.
        if (/not being substituted|does not parse|no conversation-load template/.test(err.message)) {
          stopped = true;
          sweeping = false;
          pending.length = 0;
          say('error', LOG_IMG, 'origins: the sweep stopped - ' + err.message);
          info('origins: the sweep stopped after ' + read + ' conversations - ' + err.message);
          progress('The sweep stopped: ' + err.message, true);
          return;
        }
        silent++;
        markConversationRead(conv);
        dbg('origins: ..' + conv.slice(-6) + ' answered nothing (' + err.message + ')');
      }).then(function () {
        running--;
        progress('Sweeping for originals: ' + (read + silent) + ' / ' + total
          + ', ' + read + ' were conversations');
        if (stopped) return;
        if (!pending.length && !running) {
          finish();
          return;
        }
        next();
      });
    }

    for (var w = 0; w < WORKERS && pending.length; w++) next();
  }
})();
