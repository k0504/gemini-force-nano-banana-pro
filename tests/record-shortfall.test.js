'use strict';
// When the record describes more images than the page is showing. See §view in
// the built script.
//
// The two states that produce this look identical for a moment and mean
// opposite things. Immediately after a resend the page's carousel still holds
// the list from before it while the record and the server hold the new one, so
// the record is right and the page is behind. After a reload the carousel is
// what the server returned, so a record that still holds more is describing an
// image the conversation does not have - and that record can never be sent
// again, because the entry it holds has no thumbnail, no bytes and no source to
// upload from.
//
// Telling them apart is the whole of this: only the second is acted on, and
// only after the disagreement has stood long enough that a half-rendered
// carousel cannot be what is being read.
//
// Run: node tests/record-shortfall.test.js

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

function constant(name) {
  const m = new RegExp('\\n  var ' + name + ' = (\\d+);').exec(source);
  if (!m) throw new Error('not found in the built script: var ' + name);
  return Number(m[1]);
}

const GRACE = constant('SHORTFALL_GRACE_MS');
// The grace period is read out of the script rather than restated here, so a
// change to it moves these cases with it instead of leaving them asserting a
// number the code no longer uses.
const names = ['shortfallVerdict', 'armShortfallRecheck'];
const body = 'var SHORTFALL_GRACE_MS = ' + GRACE + ';\n'
  + 'var shortfallTimer = null;\n'
  + names.map(extract).join('\n')
  + '\n; return { ' + names.join(', ') + ' };';
const timers = [];
const passes = [];
const { shortfallVerdict, armShortfallRecheck } = new Function('setTimeout', 'schedule', body)(
  (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  () => passes.push(1));

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

function record(thumbs) {
  return { index: 0, path: '/app/x', thumbs: thumbs.slice() };
}

console.log('record shortfall');

it('a page showing as many images as the record holds is agreement', () => {
  const o = record(['a', 'b', 'c']);
  assert.strictEqual(shortfallVerdict(o, 3, 1000), 'ok');
});

it('a page showing more than the record holds is not this fault', () => {
  const o = record(['a']);
  assert.strictEqual(shortfallVerdict(o, 4, 1000), 'ok');
});

it('the first sight of a shortfall only starts the clock', () => {
  const o = record(['a', 'b', 'c', 'd', 'e']);
  assert.strictEqual(shortfallVerdict(o, 4, 1000), 'wait');
});

it('a shortfall inside the grace period is still a render catching up', () => {
  const o = record(['a', 'b', 'c', 'd', 'e']);
  shortfallVerdict(o, 4, 1000);
  assert.strictEqual(shortfallVerdict(o, 4, 1000 + GRACE - 1), 'wait');
});

it('a shortfall that outlasts the grace period is acted on', () => {
  const o = record(['a', 'b', 'c', 'd', 'e']);
  shortfallVerdict(o, 4, 1000);
  assert.strictEqual(shortfallVerdict(o, 4, 1000 + GRACE), 'reconcile');
});

// The case that made the grace period necessary: the carousel of a message
// that has just been resent holds the list from before the send for as long as
// Angular takes to rebuild it. Acting on that would rewrite a record that is
// right - and rewrite it to the shorter list the send had just replaced.
it('a shortfall that resolves before the grace period expires is forgotten', () => {
  const o = record(['a', 'b', 'c', 'd', 'e']);
  shortfallVerdict(o, 4, 1000);
  assert.strictEqual(shortfallVerdict(o, 5, 1500), 'ok');
  assert.strictEqual(shortfallVerdict(o, 4, 2000), 'wait',
    'the clock has to start over, not carry on from the first sighting');
});

it('a record already reconciled is not reconciled again', () => {
  const o = record(['a', 'b', 'c', 'd', 'e']);
  o.reconciled = true;
  shortfallVerdict(o, 4, 1000);
  assert.strictEqual(shortfallVerdict(o, 4, 1000 + GRACE * 10), 'held');
});

it('a record with no thumbs at all says nothing about the page', () => {
  const o = record([]);
  assert.strictEqual(shortfallVerdict(o, 0, 1000), 'ok');
});

// One outstanding timer is held in a variable shared by every case here, the
// way it is in the script. Firing it is what releases the slot, so each case
// starts by draining whatever the last one left armed.
function drain() {
  while (timers.length) timers.pop().fn();
  passes.length = 0;
}

// The defect this covers was found running the code rather than reading it. A
// pass is raised by a mutation, and the tree has stopped mutating by the time
// the first sighting is recorded, so the second sample the verdict needs to
// reach 'reconcile' never arrived: a message stayed stuck with the trace
// showing one healThumbs line and nothing after it.
it('waiting asks for the pass that will decide', () => {
  drain();
  armShortfallRecheck();
  assert.strictEqual(timers.length, 1, 'a re-sample was scheduled');
  assert.ok(timers[0].ms > GRACE, 'it lands after the grace period, not on it');
});

it('a second wait does not stack another timer', () => {
  drain();
  armShortfallRecheck();
  armShortfallRecheck();
  armShortfallRecheck();
  assert.strictEqual(timers.length, 1);
});

it('the timer raises a pass, and another can be armed after it', () => {
  drain();
  armShortfallRecheck();
  timers[0].fn();
  assert.strictEqual(passes.length, 1, 'the pass was raised');
  armShortfallRecheck();
  assert.strictEqual(timers.length, 2, 'the slot was released when the timer fired');
});

console.log(failures ? failures + ' failing' : 'all passing');
process.exit(failures ? 1 : 0);
