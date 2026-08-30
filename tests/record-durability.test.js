'use strict';
// What happens when the store cannot be written or read. See §durable in the
// built script.
//
// The store is what a message's attachment list means after a reload, so a
// failed write leaves the page and the store describing different messages.
// These used to print a warning and carry on, and carrying on is what let the
// divergence go on to decide a send. Every one of them now marks, and every
// plan built on a marked record refuses.
//
// Run: node tests/record-durability.test.js

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

const said = [];
const records = [];

const names = ['markStoreUntrusted', 'markRecordUnsafe', 'recordBlocker', 'planIsReady'];
// storeUntrusted is declared inside the lifted scope rather than passed in, so
// the marks the functions make actually persist between calls the way they do
// in the script.
const body = 'var storeUntrusted = null;\n'
  + 'function overrideAtPath(index, path) {\n'
  + '  for (var i = 0; i < records.length; i++) {\n'
  + '    if (records[i].index === index && records[i].path === path) return records[i];\n'
  + '  }\n'
  + '  return null;\n'
  + '}\n'
  + names.map(extract).join('\n')
  + '\n; return { ' + names.join(', ') + ' };';
const api = new Function('records', 'say', 'LOG_IMG', body)(
  records, (level, tag, ...rest) => said.push(level + ' ' + rest.join(' ')), '[gpie]');

let failures = 0;
function it(what, fn) {
  try {
    fn();
    console.log('  ok   ' + what);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + what + '\n       ' + (err && err.message));
  }
}

function reset() {
  records.length = 0;
  records.push({ index: 0, path: '/app/conv', attachments: [], thumbs: [], blobs: [] });
  said.length = 0;
}

console.log('record durability');

it('a healthy record blocks nothing', function () {
  reset();
  assert.strictEqual(api.recordBlocker(0, '/app/conv'), null);
  assert.deepStrictEqual(said, [], 'and says nothing about it');
});

it('a record whose write failed blocks its own message and no other', function () {
  reset();
  records.push({ index: 1, path: '/app/conv', attachments: [], thumbs: [], blobs: [] });
  api.markRecordUnsafe(0, '/app/conv', 'its record could not be stored (QuotaExceededError)');
  assert.ok(/could not be stored/.test(api.recordBlocker(0, '/app/conv')), 'the message is blocked');
  assert.strictEqual(api.recordBlocker(1, '/app/conv'), null, 'its neighbour is not');
  assert.strictEqual(api.recordBlocker(0, '/app/other'), null, 'nor the same ordinal elsewhere');
});

it('the mark says which message, why, and what clears it', function () {
  reset();
  api.markRecordUnsafe(0, '/app/conv', 'its record could not be stored (QuotaExceededError)');
  assert.strictEqual(said.length, 1, 'and it is said out loud, once');
  assert.ok(said[0].startsWith('error '), 'at error level, not as a warning: ' + said[0]);
  assert.ok(/message #0 of \/app\/conv/.test(said[0]), 'names the message: ' + said[0]);
  assert.ok(/QuotaExceededError/.test(said[0]), 'names the cause: ' + said[0]);
  assert.ok(/reload the page/.test(said[0]), 'names what clears it: ' + said[0]);
});

// Last of the recordBlocker cases on purpose: the mark has no undo, so every
// test after this one would see a store that is already untrusted. That is the
// behaviour, not a limitation of the test - a document whose store went wrong
// once has no way back to trusting it, and only a reload gets one.
it('an unreadable store blocks every message, including ones with no record', function () {
  reset();
  api.markStoreUntrusted('the attachment records could not be read (InvalidStateError)');
  assert.ok(/could not be read/.test(api.recordBlocker(0, '/app/conv')));
  assert.ok(/could not be read/.test(api.recordBlocker(9, '/app/never-seen')),
    'a message with no record at all is blocked too: with nothing read back, one this '
    + 'script has resent is indistinguishable from one it never touched');
  assert.strictEqual(said.length, 1, 'said once');
  assert.ok(said[0].startsWith('error '), 'at error level: ' + said[0]);
  assert.ok(/reloaded/.test(said[0]), 'naming what clears it: ' + said[0]);

  api.markStoreUntrusted('a second failure (b)');
  assert.strictEqual(said.length, 1, 'and not again for every later failure');
  assert.ok(/could not be read/.test(api.recordBlocker(0, '/app/conv')),
    'the first reason stands: it is the one that describes what went wrong first');
});

it('a blocked plan is never ready, whatever its uploads did', function () {
  const done = { kind: 'existing', index: 0, freshAttachment: [[null, 1, 1, 'image/jpeg'], 'a.jpg', '$t'] };
  assert.strictEqual(api.planIsReady({ blocked: null, entries: [done] }), true,
    'the same plan unblocked is ready');
  assert.strictEqual(api.planIsReady({ blocked: 'its record could not be stored', entries: [done] }), false,
    'finishing the uploads does not answer a record that cannot be trusted');
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
