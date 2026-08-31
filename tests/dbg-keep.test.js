'use strict';
// The trace buffer that outlives the tab. See §trace in the built script.
//
// The per-tab buffer in sessionStorage is replayed after a reload and is gone
// the moment the tab is closed, which is exactly when an intermittent failure
// is worth reading about: the tab holding the trace of the send that went wrong
// is usually the one already closed by the time anyone looks. This second
// buffer is written to localStorage, is never replayed, and exists only to be
// read by hand afterwards.
//
// It is a string rather than a JSON array because it is appended to on every
// traced line: parsing and re-serialising a thousand-entry array per line costs
// more than the trace is worth.
//
// Run: node tests/dbg-keep.test.js

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

const body = extract('dbgKeep') + '\n; return { dbgKeep: dbgKeep };';
const { dbgKeep } = new Function(body)();

let failures = 0;
function it(what, fn) {
  try {
    fn();
    console.log('  ok   ' + what);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + what);
    console.log('       ' + (err && err.message));
  }
}

console.log('dbg keep');

it('the first line becomes the whole buffer', () => {
  assert.strictEqual(dbgKeep(null, 'one', 100), 'one\n');
});

it('later lines are appended in order', () => {
  assert.strictEqual(dbgKeep('one\n', 'two', 100), 'one\ntwo\n');
});

it('a buffer over the cap drops its oldest lines', () => {
  const kept = dbgKeep('aaaa\nbbbb\n', 'cccc', 12);
  assert.strictEqual(kept, 'bbbb\ncccc\n');
});

it('trimming never leaves half a line at the front', () => {
  let kept = '';
  for (let i = 0; i < 400; i++) kept = dbgKeep(kept, 'line-' + i, 200);
  assert.ok(kept.length <= 200, 'buffer stayed within the cap, got ' + kept.length);
  kept.split('\n').filter(Boolean).forEach((line) => {
    assert.ok(/^line-\d+$/.test(line), 'kept a partial line: ' + JSON.stringify(line));
  });
});

it('the newest line survives even when it alone exceeds the cap', () => {
  const kept = dbgKeep('old\n', 'x'.repeat(50), 10);
  assert.strictEqual(kept, 'x'.repeat(50) + '\n');
});

console.log(failures ? failures + ' failing' : 'all passing');
process.exit(failures ? 1 : 0);
