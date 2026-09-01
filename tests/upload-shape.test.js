'use strict';
// The upload protocol as the server answers it today.
//
// It used to be three steps: start, push the bytes, then exchange the
// contrib_service path for a uuid at ProcessFile. The uuid went into the
// attachment meta as a fifth element, and the send would not take an
// attachment without it.
//
// On 2026-09-02 that stopped: ProcessFile answers a file metadata record with
// no uuid anywhere in it, and a capture of what the page itself sends shows
// four elements in the meta and no ProcessFile call at all. The contrib path
// from step 2 goes straight into the send.
//
//   measured  [["/contrib_service/ttl_1d/...", 1, null, "image/png"], "name"]
//   before    [["/contrib_service/ttl_1d/...", 1, null, "image/png", uuid], "name"]
//
// Two assertions, and the second is the one that would have caught the
// breakage: the meta shape can be written correctly while a dead third request
// still runs and still throws.
//
// Run: node tests/upload-shape.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BUILT = path.join(__dirname, '..', 'gemini-imgen-enhancer.user.js');
const source = fs.readFileSync(BUILT, 'utf8');

function extract(name) {
  const at = source.indexOf('\n  function ' + name + '(');
  if (at === -1) throw new Error('not found in the built script: ' + name);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return source.slice(at + 1, j + 1);
    }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const CONTRIB = '/contrib_service/ttl_1d/abc123_Ad6Osdcz';
const UPLOAD_TARGET = 'https://push.clients6.google.com/upload/resumable/xyz';

const calls = [];
const contribsThisDocument = {};

function stubFetch(url, init) {
  calls.push({ url: url, headers: (init && init.headers) || {} });
  if (calls.length === 1) {
    return Promise.resolve({
      status: 200,
      headers: { get: function (h) { return h === 'x-goog-upload-url' ? UPLOAD_TARGET : null; } }
    });
  }
  if (calls.length === 2) {
    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(CONTRIB + '\n'); } });
  }
  // Recorded rather than refused, so a run that still makes this request fails
  // on the assertion that names it instead of on an opaque rejection.
  return Promise.resolve({ status: 200, text: function () { return Promise.resolve(''); } });
}

// Stubbed as the real one behaves: an rpc of its own, answering a uuid. If the
// step is still being made, this records the third request and hands back the
// fifth meta element, and both assertions below fail on it.
function stubProcessFile(contrib, name, mime) {
  return stubFetch('https://gemini.google.com/_/BardChatUi/data/'
    + 'assistant.lamda.BardFrontendService/ProcessFile').then(function () {
    return 'uuid-' + name;
  });
}

const body = extract('uploadFile') + '\n; return { uploadFile: uploadFile };';
const api = new Function('fetch', 'UPLOAD_ENDPOINT', 'CONTRIB_PREFIX', 'WIZ_KEYS', 'sniffed',
  'wiz', 'dbg', 'dbgT', 'noteUploadStart', 'noteUploadEnd', 'contribsThisDocument',
  'processFile', body)(
    stubFetch,
    'https://push.clients6.google.com/upload/',
    '/contrib_service/',
    { pctx: 'Ylro7b', pushId: 'qKIAYe' },
    { 'x-client-pctx': 'PCTX', 'push-id': 'PUSHID' },
    function () { return null; },
    function () { },
    function () { return function () { }; },
    function () { },
    function () { },
    contribsThisDocument,
    stubProcessFile);

const file = { name: 'probe.png', size: 110, type: 'image/png' };

let failures = 0;
function ok(what, fn) {
  try {
    fn();
    console.log('  ok  ', what);
  } catch (e) {
    failures++;
    console.log('  FAIL', what, '\n       ', e.message);
  }
}

console.log('upload shape');

api.uploadFile(file).then(function (att) {
  ok('the attachment carries the contrib path and no uuid', function () {
    assert.deepStrictEqual(att[0], [CONTRIB, 1, null, 'image/png'],
      'the meta is four elements, ending at the mime type');
    assert.strictEqual(att[1], 'probe.png');
  });

  ok('the upload is two requests, with no ProcessFile exchange', function () {
    assert.strictEqual(calls.length, 2,
      'a third request means the dead ProcessFile step is still being made');
    assert.strictEqual(calls[0].url, 'https://push.clients6.google.com/upload/');
    assert.strictEqual(calls[1].url, UPLOAD_TARGET);
  });

  ok('the contrib path is noted as this document\'s own', function () {
    assert.ok(contribsThisDocument[CONTRIB] > 0);
  });
}, function (err) {
  failures++;
  console.log('  FAIL uploadFile rejected\n        ' + err.message);
}).then(function () {
  console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
  process.exitCode = failures ? 1 : 0;
});
