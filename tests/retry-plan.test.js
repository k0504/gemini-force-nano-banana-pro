'use strict';
// The retry of an older turn: what it waits for, and what it sends.
//
// A retry changes no image. It goes out with the list the message already
// holds, which the server still honours, and re-uploading those images to send
// a converted shape instead was measured at 78.2s against 6.3s. Once makePlan
// began re-uploading every existing attachment on every edit, the retry both
// waited for uploads it would not send and then sent them - planIsReady gates
// the sentinel that unlocks Update, so the wait was the whole of the delay
// between pressing the button and the resend going out.
//
// Run: node tests/retry-plan.test.js

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

const state = { refusals: [] };
const names = ['planIsReady', 'isEditResend', 'applyPlanTo'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';
const api = new Function('PROMPT_TUPLE', 'ATTACHMENTS', 'ACTION_INDEX', 'ACTION_EDIT_RESEND',
  'dbg', 'attShape', 'refuseSend', 'say', 'LOG_IMG', body)(
    0, 3, 72, 2,
    function () { },
    (list) => (Array.isArray(list) ? list.map((a) => a[1]).join(', ') : String(list)),
    function (why) { state.refusals.push(why); return null; },
    function () { }, '[gpie]');

function token(name) {
  return [[null, 1, 1, 'image/jpeg'], name, '$AXzLiR' + name];
}

// A plan as makePlan leaves one for a retry: entries positional and untouched,
// base the record's own list, and no fresh attachment anywhere because nothing
// was uploaded for it.
function retryPlan(base, opts) {
  return Object.assign({
    index: 0,
    retry: true,
    retryFresh: false,
    blocked: null,
    base: base,
    originalCount: base.length,
    entries: base.map((_, i) => ({ kind: 'existing', index: i }))
  }, opts || {});
}

function send(names) {
  const inner = new Array(97).fill(null);
  inner[0] = ['prompt text', 0, null, names.map(token), null, null, 0, null, null, []];
  inner[72] = 2;
  return inner;
}

let failures = 0;
function it(what, fn) {
  state.refusals = [];
  try {
    fn();
    console.log('  ok   ' + what);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + what + '\n       ' + (err && err.message));
  }
}

console.log('retry plan');

it('a retry is ready the moment it is made, with nothing uploaded', function () {
  assert.strictEqual(api.planIsReady(retryPlan([token('a.jpg'), token('b.jpg')])), true,
    'no entry holds a fresh attachment, and none needs to');
});

it('a retry that has to re-upload waits like any other plan', function () {
  const p = retryPlan([token('a.jpg')], { retryFresh: true });
  assert.strictEqual(api.planIsReady(p), false, 'the upload has not finished');
  p.entries[0].freshAttachment = token('a.jpg');
  assert.strictEqual(api.planIsReady(p), true, 'and it has now');
});

it('a blocked retry is never ready', function () {
  assert.strictEqual(
    api.planIsReady(retryPlan([token('a.jpg')], { blocked: 'its record could not be stored' })),
    false, 'a record in doubt is not answered by there being nothing to wait for');
});

it('an ordinary edit still waits for its uploads', function () {
  const p = retryPlan([token('a.jpg')], { retry: false });
  assert.strictEqual(api.planIsReady(p), false,
    'the retry shortcut must not let an edit send an entry it never uploaded');
});

it('a retry sends the list the message already holds', function () {
  const base = [token('a.jpg'), token('b.jpg')];
  const inner = send(['a.jpg', 'b.jpg']);
  assert.strictEqual(api.applyPlanTo(inner, retryPlan(base)), true);
  assert.deepStrictEqual(inner[0][3], base, 'the record\'s own references, unconverted');
  assert.strictEqual(inner[0][3][0].length, 3, 'a server reference keeps its three elements');
  assert.deepStrictEqual(state.refusals, []);
});

it('a retry refuses when the record and the message disagree on how many', function () {
  const p = retryPlan([token('a.jpg')]);
  p.originalCount = 2;
  assert.strictEqual(api.applyPlanTo(send(['a.jpg', 'b.jpg']), p), false);
  assert.strictEqual(state.refusals.length, 1, 'the send is refused');
  assert.ok(/1 attachments to send against the 2/.test(state.refusals[0]),
    'the refusal names both counts: ' + state.refusals[0]);
});

it('a retry leaves a send that is not the resend alone', function () {
  const inner = send(['a.jpg']);
  inner[72] = null;
  assert.strictEqual(api.applyPlanTo(inner, retryPlan([token('a.jpg')])), null,
    'null is "not this plan\'s send", which is not a refusal');
  assert.deepStrictEqual(state.refusals, []);
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
