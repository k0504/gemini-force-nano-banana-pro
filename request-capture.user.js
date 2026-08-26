// ==UserScript==
// @name         Gemini Request Capture
// @namespace    https://github.com/k0504/gemini-imgen-enhancer
// @author       k0504
// @license      MIT
// @version      1.0.0
// @description  Records the requests a Gemini page makes and hands them over when asked. A diagnostic, independent of the enhancer script.
// @match        https://gemini.google.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @sandbox      raw
// ==/UserScript==

/*
 * Independent of gemini-imgen-enhancer.user.js by design. It shares no file,
 * no storage key and no hook with it; disabling either leaves the other
 * untouched. Install it while the shape of a call is being worked out, and
 * turn it off afterwards.
 *
 * Nothing reaches the disk on its own. Recordings live in memory and leave
 * only when asked for, through the manager's menu or through `__gpieCapture`
 * on the page - which is what a console, or a browser being driven from
 * outside, reads them with:
 *
 *   __gpieCapture.summary()        one line per recording
 *   __gpieCapture.find('jGArJ')    recordings whose endpoint or body match
 *   __gpieCapture.get(14)          one recording in full
 *   __gpieCapture.keys()           every long opaque key seen, by recording
 *   __gpieCapture.download()       all of them, as one JSON file
 *   __gpieCapture.clear()
 */

(function () {
  'use strict';

  // Nothing is filtered: every request either transport carries is recorded,
  // whatever its host, method or content type. The one bound is a quota per
  // endpoint, so a page that polls one call cannot crowd out the call being
  // looked for.
  //
  // Five rather than two, which is what the library list cost to learn: its
  // endpoint answers the first two calls empty and delivers on the third, so a
  // quota of two records the silence and discards the answer.
  var PER_ENDPOINT = 5;

  // Every batchexecute call shares one path, so the path alone would spend a
  // whole quota on whichever RPC happened to fire first.
  function endpointOf(url) {
    var raw = String(url);
    if (raw.indexOf('://') === -1 && raw.charAt(0) !== '/') return raw;
    var full;
    try {
      full = new URL(raw, location.href);
    } catch (e) {
      return raw;
    }
    var rpc = full.searchParams.get('rpcids');
    return full.origin + full.pathname + (rpc ? '?rpcids=' + rpc : '');
  }

  // A body that is not text is named rather than serialised: what matters is
  // that the call carried one, not what its bytes were.
  function bodyOf(body) {
    if (typeof body === 'string') return body;
    if (body === null || body === undefined) return null;
    var name = body.constructor && body.constructor.name;
    return '[' + (name || typeof body) + ']';
  }

  var records = [];
  var counts = Object.create(null);

  function open(transport, method, url, body) {
    var endpoint = endpointOf(url);
    var taken = counts[endpoint] || 0;
    if (taken >= PER_ENDPOINT) return null;
    counts[endpoint] = taken + 1;
    var rec = {
      seq: records.length + 1,
      at: new Date().toISOString(),
      transport: transport,
      method: String(method || 'GET').toUpperCase(),
      endpoint: endpoint,
      nth: taken + 1,
      url: String(url),
      page: location.href,
      requestBody: bodyOf(body),
      status: null,
      contentType: null,
      responseBody: null
    };
    records.push(rec);
    return rec;
  }

  function close(rec, status, type, body) {
    if (!rec || rec.status !== null) return;
    rec.status = status;
    rec.contentType = type || null;
    rec.responseBody = typeof body === 'string' ? body : null;
  }

  // §hooks -------------------------------------------------------------------
  // XMLHttpRequest.prototype is shared with the page, so patching it here
  // reaches the page's own calls. `window` is not: under a userscript manager
  // a manager that keeps a script apart from the page hands it a window of its own
  // of its own, and patching only that one catches nothing the page does. The
  // page's window is reached through unsafeWindow, and both are taken.

  var xhrOpen = XMLHttpRequest.prototype.open;
  var xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__capMethod = method;
    this.__capUrl = url;
    return xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var rec = open('xhr', xhr.__capMethod, xhr.__capUrl, body);
    if (rec) {
      xhr.addEventListener('load', function () {
        var text = null;
        try {
          var kind = xhr.responseType;
          if (!kind || kind === 'text') text = xhr.responseText;
          else if (kind === 'json') text = JSON.stringify(xhr.response);
        } catch (e) {
          // A response this transport will not hand over as text is kept with
          // its status alone.
        }
        var type = null;
        try {
          type = xhr.getResponseHeader('content-type');
        } catch (e) {
          type = null;
        }
        close(rec, xhr.status, type, text);
      });
      xhr.addEventListener('error', function () { close(rec, 0, null, null); });
      xhr.addEventListener('abort', function () { close(rec, 0, null, null); });
    }
    return xhrSend.apply(this, arguments);
  };

  function hookFetch(scope) {
    if (!scope) return;
    var native = scope.fetch;
    if (typeof native !== 'function') return;
    scope.fetch = function (input, init) {
      var url = '';
      var method = 'GET';
      var body = null;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        method = (init && init.method) || (input && input.method) || 'GET';
        body = init ? init.body : null;
      } catch (e) {
        // A request whose shape cannot be read still goes out untouched.
      }
      var rec = open('fetch', method, url, body);
      var promise = native.apply(this, arguments);
      if (!rec) return promise;
      return promise.then(function (res) {
        var type = null;
        try {
          type = res.headers && res.headers.get('content-type');
        } catch (e) {
          type = null;
        }
        // Cloned before it is read: the page is handed the original, and its
        // body has to still be unread when it gets there.
        try {
          res.clone().text().then(function (text) {
            close(rec, res.status, type, text);
          }, function () {
            close(rec, res.status, type, null);
          });
        } catch (e) {
          close(rec, res.status, type, null);
        }
        return res;
      }, function (err) {
        close(rec, 0, null, null);
        throw err;
      });
    };
  }

  hookFetch(window);
  if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow !== window) {
    hookFetch(unsafeWindow);
  }

  // §readout -----------------------------------------------------------------

  var LONG_KEY = /[A-Za-z0-9_-]{300,}/g;

  function short(rec) {
    return rec.seq + '  ' + rec.transport + '  ' + rec.method + '  '
      + (rec.status === null ? 'pending' : rec.status)
      + '  req=' + (rec.requestBody === null ? 0 : rec.requestBody.length)
      + '  res=' + (rec.responseBody === null ? 'none' : rec.responseBody.length)
      + '  ' + rec.endpoint;
  }

  var api = {
    get records() { return records; },
    count: function () { return records.length; },
    summary: function () { return records.map(short); },
    get: function (seq) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].seq === seq) return records[i];
      }
      return null;
    },
    find: function (needle) {
      var want = String(needle).toLowerCase();
      return records.filter(function (r) {
        return (r.endpoint + ' ' + r.url + ' ' + (r.requestBody || '') + ' '
          + (r.responseBody || '')).toLowerCase().indexOf(want) !== -1;
      }).map(short);
    },
    // What a recording is usually read for: the long opaque strings a download
    // chain is seeded with, and which recording each of them came from.
    keys: function () {
      var out = [];
      records.forEach(function (r) {
        var found = (r.responseBody || '').match(LONG_KEY);
        if (!found) return;
        var seen = Object.create(null);
        found.forEach(function (k) {
          if (seen[k]) return;
          seen[k] = true;
          out.push({ seq: r.seq, endpoint: r.endpoint, length: k.length, tail: k.slice(-8) });
        });
      });
      return out;
    },
    clear: function () {
      records = [];
      counts = Object.create(null);
      return 'cleared';
    },
    // The only thing here that writes to disk, and only when it is called.
    download: function (name) {
      var text = JSON.stringify({
        writtenAt: new Date().toISOString(),
        page: location.href,
        perEndpoint: PER_ENDPOINT,
        endpoints: Object.keys(counts).length,
        count: records.length,
        records: records
      }, null, 2);
      var href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      var a = document.createElement('a');
      a.href = href;
      a.download = name || ('gemini-capture-' + Date.now() + '.json');
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(function () {
        a.remove();
        URL.revokeObjectURL(href);
      }, 4000);
      return records.length + ' recordings written';
    }
  };

  try {
    (typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window).__gpieCapture = api;
  } catch (e) {
    window.__gpieCapture = api;
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Capture: download recordings', function () {
      console.log('[capture]', api.download());
    });
    GM_registerMenuCommand('Capture: summary to console', function () {
      console.log('[capture] ' + records.length + ' recordings across '
        + Object.keys(counts).length + ' endpoints');
      api.summary().forEach(function (line) { console.log('[capture] ' + line); });
    });
    GM_registerMenuCommand('Capture: clear', function () {
      console.log('[capture]', api.clear());
    });
  }
})();
