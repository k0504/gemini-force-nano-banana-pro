'use strict';
// Whether a held media token is worth spending a request on.
//
// Measured 2026-09-02 on a library download. A row carried over from an
// earlier sweep was answered by the download rpc in 8.7s, and the key it
// answered with was then refused by the download chain with http 400. The
// conversation read that mints a fresh row took 0.42s in the same run. So the
// held row is worth asking about only while it is young: being wrong about
// that costs one 0.42s read, and being right saves ten seconds.
//
// The library is where this decides anything. Its rows come from a sweep that
// may have run days ago, where a conversation page usually holds rows minted
// minutes earlier - the same code, the opposite odds.
//
// Run: node tests/token-freshness.test.js

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

const TTL = 30 * 60 * 1000;
const names = ['tokenIsFresh', 'tokensAreFresh', 'tokensOfTurn'];
const body = names.map(extract).join('\n') + '\n; return { ' + names.join(', ') + ' };';

let turnTokens = Object.create(null);
const api = new Function('TOKEN_TTL_MS', 'turnTokens', body)(
  TTL,
  new Proxy({}, {
    get: (_, k) => turnTokens[k],
    has: (_, k) => k in turnTokens,
    ownKeys: () => Reflect.ownKeys(turnTokens),
    getOwnPropertyDescriptor: (_, k) => Object.getOwnPropertyDescriptor(turnTokens, k)
  }));

const NOW = 1_800_000_000_000;

function row(over) {
  return Object.assign({ token: '$AXz' + 'x'.repeat(100), resp: 'r_0', slot: 0, bytes: 0 }, over);
}

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

console.log('token freshness');

ok('a row learned just now is worth asking about', () => {
  assert.strictEqual(api.tokenIsFresh(row({ learnedAt: NOW - 1000 }), NOW), true);
});

ok('a row older than the life allowed is not', () => {
  assert.strictEqual(api.tokenIsFresh(row({ learnedAt: NOW - TTL - 1 }), NOW), false);
});

ok('a row that never recorded when it was learned is never vouched for', () => {
  assert.strictEqual(api.tokenIsFresh(row(), NOW), false,
    'a row from before the learning time was kept must read as stale, not as fresh');
});

ok('one fresh row among stale ones is enough to try what is held', () => {
  assert.strictEqual(api.tokensAreFresh(
    [row({ learnedAt: NOW - TTL - 1 }), row({ learnedAt: NOW - 60000 })], NOW), true);
});

ok('a list with nothing fresh in it is not worth the request', () => {
  assert.strictEqual(api.tokensAreFresh(
    [row({ learnedAt: NOW - TTL - 1 }), row()], NOW), false);
});

ok('an empty list is not fresh, and does not throw', () => {
  assert.strictEqual(api.tokensAreFresh([], NOW), false);
  assert.strictEqual(api.tokensAreFresh(null, NOW), false);
});

console.log('token order');

ok('the row declaring the most bytes is asked first', () => {
  turnTokens = {
    'r_1#0': row({ resp: 'r_1', slot: 0, bytes: 1000, token: '$small' }),
    'r_1#1': row({ resp: 'r_1', slot: 1, bytes: 90000, token: '$large' })
  };
  assert.deepStrictEqual(api.tokensOfTurn('r_1').map((r) => r.token), ['$large', '$small']);
});

ok('where the byte counts say nothing, the longer token is asked first', () => {
  turnTokens = {
    'r_2#0': row({ resp: 'r_2', slot: 0, bytes: 0, token: '$' + 'a'.repeat(120) }),
    'r_2#1': row({ resp: 'r_2', slot: 1, bytes: 0, token: '$' + 'b'.repeat(280) })
  };
  assert.deepStrictEqual(api.tokensOfTurn('r_2').map((r) => r.token.length), [281, 121],
    'the token measured to answer ran 281 characters against a shorter one that answered nothing');
});

ok('a turn with no rows answers an empty list', () => {
  turnTokens = {};
  assert.deepStrictEqual(api.tokensOfTurn('r_3'), []);
  assert.deepStrictEqual(api.tokensOfTurn(null), []);
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
