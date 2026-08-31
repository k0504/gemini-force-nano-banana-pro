'use strict';
// The measured send shape, locked.
//
// POSTMORTEM.md records the timing table this file exists to defend. The same
// five-image message and prompt, one difference removed at a time:
//
//   action  attachments              conversation tuple    time
//   2       mixed contrib, 9 elems   present whole         88.3s
//   null    mixed contrib, 9 elems   present whole         79.9s
//   null    all contrib, 2 elems     present whole         58.0s
//   null    all contrib, 2 elems     cleared               47.1s
//   null    all contrib, 2 elems     id kept, resume null  24.2s
//
// The last row is what the script sends. Every earlier row is a defect that has
// already shipped once: the correct shape was written, deleted three commits
// later on a misdiagnosis, and made again four versions on. Nothing failed when
// it was deleted, which is why it stayed deleted.
//
// The conversation id assertion is the one that is not about speed. Clearing
// the whole tuple takes eleven seconds off and writes the turn into a
// conversation the server opens for itself, where the user never sees it.
//
// Run: node tests/send-shape.test.js

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

const state = { refusals: [], work: {} };
const names = ['chooseSendShape', 'isEditResend', 'applyPlanTo'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';
const api = new Function('PROMPT_TUPLE', 'ATTACHMENTS', 'ACTION_INDEX', 'ACTION_EDIT_RESEND',
  'CONVERSATION_INDEX', 'RESUME_INDEX', 'work', 'attClass', 'dbg', 'attShape', 'refuseSend',
  'say', 'LOG_IMG', body)(
    0, 3, 72, 2, 2, 9,
    state.work,
    (att) => (att[0] && typeof att[0][0] === 'string' && att[0][0].indexOf('/contrib_service/') === 0
      ? (att.__stale ? 'contrib-stale' : 'contrib-live') : 'token'),
    function () { },
    (list) => (Array.isArray(list) ? list.map((a) => a[1]).join(', ') : String(list)),
    function (why) { state.refusals.push(why); return null; },
    function () { }, '[gpie]');

const CONV = 'c_00112233445566778899aabbccddeeff';

function contrib(name) {
  return [['/contrib_service/ttl_1d/' + name, 1, null, 'image/jpeg', 'uuid-' + name], name];
}

function token(name) {
  return [[null, 1, 1, 'image/jpeg'], name, '$AXzLiR' + name];
}

// An edit resend as Gemini builds one: the conversation tuple carries the id,
// the previous turn's r_ and rc_, and the resume blob that marks the send as a
// revision of an existing turn.
function editResend(attachments) {
  const inner = new Array(97).fill(null);
  inner[0] = ['prompt text', 0, null, attachments, null, null, 0, null, null, []];
  inner[2] = [CONV, 'r_deadbeef', 'rc_cafebabe', null, null, null, null, null, null,
    'RESUME-BLOB-PRESENT'];
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

console.log('send shape');

it('the action is cleared, so the send is not an edit resend', function () {
  const inner = editResend([contrib('a.jpg')]);
  assert.strictEqual(api.chooseSendShape(inner, inner[0][3], { index: 0 }), true);
  assert.strictEqual(inner[72], null, '2 is the 88.3s row');
});

it('the resume blob goes, and it is the only thing in the tuple that does', function () {
  const inner = editResend([contrib('a.jpg')]);
  api.chooseSendShape(inner, inner[0][3], { index: 0 });
  assert.strictEqual(inner[2][9], null, 'the resume blob is what costs 21.3s to first byte');
  assert.strictEqual(inner[2][0], CONV,
    'the conversation id stays: clearing the tuple files the turn under a conversation '
    + 'the server opens for itself, which the user never sees');
  assert.strictEqual(inner[2][1], 'r_deadbeef', 'the previous turn stays');
  assert.strictEqual(inner[2][2], 'rc_cafebabe', 'and its candidate');
});

it('a tuple that never carried a resume blob is left alone', function () {
  const inner = editResend([contrib('a.jpg')]);
  inner[2][9] = null;
  api.chooseSendShape(inner, inner[0][3], { index: 0 });
  assert.strictEqual(inner[2][0], CONV);
  assert.strictEqual(inner[72], null);
});

it('a list that is not all this document\'s uploads refuses, and changes nothing', function () {
  const inner = editResend([contrib('a.jpg'), token('b.jpg')]);
  assert.strictEqual(api.chooseSendShape(inner, inner[0][3], { index: 0 }), false);
  assert.strictEqual(state.refusals.length, 1, 'refused rather than sent as the 79.9s row');
  assert.strictEqual(inner[72], 2, 'the body is left as it was');
  assert.strictEqual(inner[2][9], 'RESUME-BLOB-PRESENT');
});

it('a stale contrib is not this document\'s upload either', function () {
  const stale = contrib('a.jpg');
  stale.__stale = true;
  const inner = editResend([stale]);
  assert.strictEqual(api.chooseSendShape(inner, inner[0][3], { index: 0 }), false);
  assert.strictEqual(state.refusals.length, 1);
});

it('the written attachments carry two elements, never the edit tail', function () {
  // The nine-element form belongs to an action-2 resend. A captured send once
  // showed the trailing [0] riding along on a send whose action was cleared.
  const nine = contrib('a.jpg').concat([null, null, null, null, null, null, [0]]);
  assert.strictEqual(nine.length, 9, 'the fixture is the shape being guarded against');
  const inner = editResend([nine]);
  const p = {
    index: 0, retry: false, retryFresh: false, base: [nine], originalCount: 1,
    entries: [{ kind: 'existing', index: 0, freshAttachment: nine }]
  };
  assert.strictEqual(api.applyPlanTo(inner, p), true);
  assert.strictEqual(inner[0][3][0].length, 2, 'written as two elements');
  assert.deepStrictEqual(inner[0][3][0], [nine[0], nine[1]]);
});

it('the shape is reported under the name the timing table uses', function () {
  const inner = editResend([contrib('a.jpg'), contrib('b.jpg')]);
  api.chooseSendShape(inner, inner[0][3], { index: 0 });
  assert.strictEqual(state.work.shape, 'brand-new upload shape');
  assert.strictEqual(state.work.images, 2);
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
