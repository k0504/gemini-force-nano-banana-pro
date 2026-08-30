'use strict';
// Gemini's own regenerate button against the record.
//
// The shapes below are the ones a capture shows: inner[72] is the action - null
// on a first upload, 2 on an edit resend, 5 on a plain regenerate and 7 on a Pro
// regenerate - and inner[0][3] is the attachment list. A regenerate carries the
// list the page holds for the turn, which for a message this script has resent
// is the list from before that resend.
//
// Run: node tests/native-retry.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BUILT = path.join(__dirname, '..', 'gemini-imgen-enhancer.user.js');
const source = fs.readFileSync(BUILT, 'utf8');

// The built script is one IIFE, so its functions cannot be required. They are
// lifted out by name and given the scope they read from, which is what keeps
// this test measuring the shipped file rather than a copy of it.
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

function load(names, scope) {
  const keys = Object.keys(scope);
  const body = extract('isNativeRetry') + '\n' + names.map(extract).join('\n')
    + '\n; return { ' + names.concat(['isNativeRetry']).join(', ') + ' };';
  return new Function(...keys, body)(...keys.map((k) => scope[k]));
}

// What the record holds, and what the page thinks the turn holds, are separate
// arrays on purpose: the defect this covers is the two disagreeing.
const state = {
  record: null,
  lastIndex: 0,
  stale: [],
  downgrades: [],
  refusals: []
};

const api = load(['nativeRetryContribution'], {
  PROMPT_TUPLE: 0,
  ATTACHMENTS: 3,
  ACTION_INDEX: 72,
  ACTION_RETRY: 5,
  ACTION_RETRY_PRO: 7,
  dbg: function () { },
  reportDowngrade: function (what, why) { state.downgrades.push(what + ' | ' + why); },
  // The refusal channel §resend reads. Recording it is what these tests assert
  // against: the unit's job is to raise it, and rewrite() is what turns a
  // raised refusal into a request that never goes out.
  refuseSend: function (why) { state.refusals.push(why); return null; },
  attShape: function (list) { return Array.isArray(list) ? list.map((a) => a[1]).join(', ') : String(list); },
  attClass: function (att) {
    return state.stale.indexOf(att[1]) === -1 ? 'token' : 'contrib-stale';
  },
  recordAttachments: function (index) {
    return index === state.lastIndex && state.record ? state.record.slice() : null;
  },
  lastMessageIndex: function () { return state.lastIndex; }
});

function token(name) {
  return [[null, 1, 1, 'image/jpeg'], name, '$AXzLiR' + name];
}

function contrib(name) {
  return [['/contrib_service/ttl_1d/' + name, 1, null, 'image/jpeg', 'uuid-' + name], name];
}

// A StreamGenerate inner array of the length a capture shows, carrying one
// prompt tuple and one action.
function send(action, names) {
  const inner = new Array(97).fill(null);
  inner[0] = ['prompt text', 0, null, names.map(token), null, null, 0, null, null, []];
  inner[72] = action;
  return inner;
}

function reset(record, opts) {
  state.record = record;
  state.lastIndex = (opts && opts.lastIndex !== undefined) ? opts.lastIndex : 0;
  state.stale = (opts && opts.stale) || [];
  state.downgrades = [];
  state.refusals = [];
}

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

console.log('nativeRetryContribution');

// The regression this exists for. The record names the images the last edit
// actually sent; the page still names the ones it replaced.
it('writes the record over the page list on a plain regenerate', function () {
  const record = [token('kept.png'), token('swapped-in.jpg')];
  reset(record);
  const inner = send(5, ['kept.png', 'replaced.jpg']);
  const written = api.nativeRetryContribution(inner);
  assert.strictEqual(written, false, 'a written list asks for no reload');
  assert.deepStrictEqual(inner[0][3], record);
});

it('writes the record over the page list on a Pro regenerate', function () {
  const record = [token('kept.png'), token('swapped-in.jpg')];
  reset(record);
  const inner = send(7, ['kept.png', 'replaced.jpg']);
  assert.strictEqual(api.nativeRetryContribution(inner), false);
  assert.deepStrictEqual(inner[0][3], record);
});

it('sends the record\'s tuples as they stand, without reshaping them', function () {
  const record = [contrib('a.jpg')];
  reset(record);
  const inner = send(5, ['old.jpg']);
  api.nativeRetryContribution(inner);
  assert.strictEqual(inner[0][3][0].length, 2, 'a contrib tuple keeps its own length');
  assert.deepStrictEqual(inner[0][3], record);
});

it('leaves an edit resend to the plan', function () {
  reset([token('from-record.png')]);
  const inner = send(2, ['from-page.png']);
  assert.strictEqual(api.nativeRetryContribution(inner), null);
  assert.deepStrictEqual(inner[0][3].map((a) => a[1]), ['from-page.png']);
});

it('leaves a first upload alone', function () {
  reset([token('from-record.png')]);
  const inner = send(null, ['from-page.png']);
  assert.strictEqual(api.nativeRetryContribution(inner), null);
  assert.deepStrictEqual(inner[0][3].map((a) => a[1]), ['from-page.png']);
});

it('leaves the page list alone when the message has no record', function () {
  reset(null);
  const inner = send(5, ['from-page.png']);
  assert.strictEqual(api.nativeRetryContribution(inner), null);
  assert.deepStrictEqual(inner[0][3].map((a) => a[1]), ['from-page.png']);
  assert.deepStrictEqual(state.downgrades, [], 'no record is not a downgrade, it is a message this script never resent');
  assert.deepStrictEqual(state.refusals, [], 'and it is not a reason to refuse the send either');
});

// Both of the cases below used to let the request through with the list the
// page had built. That list is the one the message held before its last
// resend, so the regenerate answered images the user had already replaced.
// They refuse now: there is no correct list to write and no slower way to
// arrive at one, so nothing is sent.
it('refuses the send when the record and the regenerate disagree on length', function () {
  reset([token('one.png')]);
  const inner = send(5, ['one.png', 'two.png']);
  assert.strictEqual(api.nativeRetryContribution(inner), null);
  assert.deepStrictEqual(inner[0][3].map((a) => a[1]), ['one.png', 'two.png'],
    'the body is left as it was; the refusal is what stops it, not a rewrite');
  assert.strictEqual(state.refusals.length, 1, 'the send is refused');
  assert.ok(/1 attachments against the 2/.test(state.refusals[0]),
    'the refusal names both counts: ' + state.refusals[0]);
  assert.strictEqual(state.downgrades.length, 0, 'and it is not reported as a degraded send');
});

it('refuses the send when the record holds uploads it cannot vouch for', function () {
  reset([contrib('dead.jpg')], { stale: ['dead.jpg'] });
  const inner = send(5, ['from-page.png']);
  assert.strictEqual(api.nativeRetryContribution(inner), null);
  assert.strictEqual(state.refusals.length, 1, 'the send is refused');
  assert.ok(/reopen the message and resend it/.test(state.refusals[0]),
    'the refusal says what will clear it: ' + state.refusals[0]);
  assert.strictEqual(state.downgrades.length, 0, 'and it is not reported as a degraded send');
});

it('leaves a regenerate that carries no attachments alone', function () {
  reset([token('from-record.png')]);
  const inner = send(5, []);
  assert.strictEqual(api.nativeRetryContribution(inner), null);
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exit(failures ? 1 : 0);
