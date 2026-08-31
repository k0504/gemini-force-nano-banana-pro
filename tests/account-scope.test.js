'use strict';
// What a second signed-in account does to this script. See §page and §origins
// in the built script.
//
// Every address the application serves gains a `/u/<n>` segment once a second
// account is signed in, and every path check here used to anchor on the bare
// form: `'/u/0/library'.indexOf('/library')` is 4, not 0, so the marks were
// never drawn and the listing was never read. Measured against two accounts on
// one browser, where `/library` and `/u/0/library` are served the same account
// and `/u/1/library` another.
//
// The ledger is one store for the origin, so both accounts write into it, and
// the prune deletes whatever the listing it just read does not name. It is
// scoped to the account that read that listing, or it answers "the other
// account's images are gone" and drops tokens no later listing can put back.
//
// Run: node tests/account-scope.test.js

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

// The lifted scope. `location` and the WIZ reader belong to the page, and the
// ledger's two indexes are declared here rather than passed in so the prune
// removes from them the way it does in the script.
const names = ['appPath', 'accountHere', 'freqKey', 'turnSlot', 'adoptListed', 'pruneVanished'];
const deleted = [];
const written = [];
const body = 'var location = { pathname: "/" };\n'
  + 'var wizValues = {};\n'
  + 'var WIZ_KEYS = { acct: "oPEP7c" };\n'
  + 'function wiz(k) { return wizValues[k]; }\n'
  + 'var turnTokens = Object.create(null);\n'
  + 'var tokenByResp = Object.create(null);\n'
  + 'var ORIGINS = {};\n'
  + 'function dbDelete(where, keys) { deleted.push.apply(deleted, keys); return Promise.resolve(); }\n'
  + 'function dbWrite(where, rows) { written.push.apply(written, rows); return Promise.resolve(); }\n'
  + 'function noteLedgerSize() {}\n'
  + 'function schedule() {}\n'
  + 'function dbg() {}\n'
  + names.map(extract).join('\n')
  + '\n; return { ' + names.join(', ') + ', location: location, wizValues: wizValues,'
  + ' turnTokens: turnTokens, tokenByResp: tokenByResp };';
const api = new Function('deleted', 'written', 'say', 'LOG_IMG', body)(
  deleted, written, function () {}, '[gpie]');

function at(pathname) { api.location.pathname = pathname; }

console.log('account scope');

// §page --------------------------------------------------------------------

it('the account segment is read through, on every page it can appear on', function () {
  at('/u/0/library');
  assert.strictEqual(api.appPath(), '/library', 'the library of the first account');
  at('/u/1/library');
  assert.strictEqual(api.appPath(), '/library', 'and of the second');
  at('/u/12/app/0123456789abcdef');
  assert.strictEqual(api.appPath(), '/app/0123456789abcdef', 'a conversation, two-digit index');
});

it('an address without the segment is left alone', function () {
  at('/library');
  assert.strictEqual(api.appPath(), '/library');
  at('/app/0123456789abcdef');
  assert.strictEqual(api.appPath(), '/app/0123456789abcdef');
});

it('only that segment is read through, not anything shaped like it', function () {
  at('/user/settings');
  assert.strictEqual(api.appPath(), '/user/settings', '/user is not /u/<n>');
  at('/u/x/library');
  assert.strictEqual(api.appPath(), '/u/x/library', 'the index is digits or it is not one');
  at('/us/1/library');
  assert.strictEqual(api.appPath(), '/us/1/library');
});

it('the segment alone is the root, not the empty string', function () {
  at('/u/0');
  assert.strictEqual(api.appPath(), '/', 'an empty pathname would match nothing and equal nothing');
});

it('a stored path is read through the same way, so records outlive the switch', function () {
  at('/app/0123456789abcdef');
  assert.strictEqual(api.appPath('/u/1/app/0123456789abcdef'), '/app/0123456789abcdef',
    'a record written while the prefixed address was on screen still names this conversation');
  assert.strictEqual(api.appPath('/u/1/app/0123456789abcdef'), api.appPath(),
    'which is what makes it match');
});

// §origins:account ---------------------------------------------------------

it('the account is the signed-in one, not the position in the switcher', function () {
  at('/u/1/library');
  api.wizValues.oPEP7c = 'someone@example.com';
  const first = api.accountHere();
  at('/library');
  assert.strictEqual(api.accountHere(), first,
    'the same account reached by two addresses is one account');
  api.wizValues.oPEP7c = 'other@example.net';
  assert.notStrictEqual(api.accountHere(), first, 'a different account is a different one');
});

it('the account never appears in the ledger in the clear', function () {
  at('/library');
  api.wizValues.oPEP7c = 'someone@example.com';
  assert.strictEqual(api.accountHere().indexOf('someone@example.com'), -1,
    'the address itself is not what is written: ' + api.accountHere());
  assert.strictEqual(api.accountHere().indexOf('@'), -1, 'nor any part of it');
});

it('without the page datum the address answers, and the bare form is the first account', function () {
  delete api.wizValues.oPEP7c;
  at('/u/1/library');
  assert.strictEqual(api.accountHere(), 'u:1');
  at('/library');
  assert.strictEqual(api.accountHere(), 'u:0',
    'measured: /library and /u/0/library are served the same account');
  at('/u/0/library');
  assert.strictEqual(api.accountHere(), 'u:0');
});

it('the two answers are never mistaken for one another', function () {
  at('/u/0/library');
  delete api.wizValues.oPEP7c;
  const byAddress = api.accountHere();
  api.wizValues.oPEP7c = 'someone@example.com';
  assert.notStrictEqual(api.accountHere(), byAddress,
    'a row written while the page datum was readable must not be pruned against one '
    + 'written after that key was renamed');
});

// §library:freq -------------------------------------------------------------
// The replayed listing and conversation load are the page's own requests with
// one value swapped, and a request belongs to the account that made it.
// Measured: replaying the first account's listing while signed in as the second
// answers http 400, which reads as the harvest finding nothing at all.

it('a replay template is held per account, not once for the browser', function () {
  at('/library');
  api.wizValues.oPEP7c = 'someone@example.com';
  const first = api.freqKey('gpie_list_freq');
  api.wizValues.oPEP7c = 'other@example.net';
  assert.notStrictEqual(api.freqKey('gpie_list_freq'), first,
    'or the second account replays the first account\'s request and is refused');
});

it('the two templates stay apart within one account', function () {
  at('/library');
  api.wizValues.oPEP7c = 'someone@example.com';
  assert.notStrictEqual(api.freqKey('gpie_list_freq'), api.freqKey('gpie_conv_freq'));
});

// §origins:prune -----------------------------------------------------------

function ledger(rows) {
  Object.keys(api.turnTokens).forEach(function (k) { delete api.turnTokens[k]; });
  Object.keys(api.tokenByResp).forEach(function (k) { delete api.tokenByResp[k]; });
  deleted.length = 0;
  written.length = 0;
  rows.forEach(function (row) {
    api.turnTokens[api.turnSlot(row.resp, row.slot)] = row;
    api.tokenByResp[row.resp] = row;
  });
}

function row(resp, acct) {
  return { key: 'tok:' + resp + '#0', resp: resp, slot: 0, token: 'x', acct: acct };
}

function asAccount(mail) {
  api.wizValues.oPEP7c = mail;
  return api.accountHere();
}

it('a card this account no longer lists loses its token', function () {
  at('/library');
  const here = asAccount('someone@example.com');
  ledger([row('r_1111111111111111', here), row('r_2222222222222222', here)]);
  const dropped = api.pruneVanished({ r_1111111111111111: true });
  assert.strictEqual(dropped, 1, 'the one the listing did not name');
  assert.deepStrictEqual(deleted, ['tok:r_2222222222222222#0'], 'and it is deleted by key');
  assert.ok(api.turnTokens[api.turnSlot('r_1111111111111111', 0)], 'the listed one stands');
  assert.ok(!api.turnTokens[api.turnSlot('r_2222222222222222', 0)], 'the other is gone');
});

it('another account keeps its tokens through a listing that cannot name them', function () {
  at('/library');
  const elsewhere = asAccount('other@example.net');
  const here = asAccount('someone@example.com');
  ledger([row('r_1111111111111111', here), row('r_3333333333333333', elsewhere)]);
  // This account's whole library, read to the end. It names none of the other
  // account's turns, and no listing read here ever will.
  const dropped = api.pruneVanished({ r_1111111111111111: true });
  assert.strictEqual(dropped, 0,
    'nothing of this account is missing, and the rest is not this listing to judge');
  assert.deepStrictEqual(deleted, [], 'nothing is deleted');
  assert.ok(api.turnTokens[api.turnSlot('r_3333333333333333', 0)],
    'the other account keeps its token: only a listing read while signed in as it retires one');
});

it('a token from before the account was recorded is never dropped', function () {
  at('/library');
  asAccount('someone@example.com');
  ledger([row('r_4444444444444444', undefined)]);
  const dropped = api.pruneVanished({});
  assert.strictEqual(dropped, 0, 'it cannot be placed, so it cannot be shown to be stale');
  assert.deepStrictEqual(deleted, []);
  assert.ok(api.turnTokens[api.turnSlot('r_4444444444444444', 0)], 'and it stays');
});

it('the turn index is dropped with the row, and only for rows that go', function () {
  at('/library');
  const elsewhere = asAccount('other@example.net');
  const here = asAccount('someone@example.com');
  ledger([row('r_5555555555555555', here), row('r_6666666666666666', elsewhere)]);
  api.pruneVanished({});
  assert.ok(!api.tokenByResp.r_5555555555555555, 'ours went');
  assert.ok(api.tokenByResp.r_6666666666666666, 'theirs did not');
});

// §origins:adopt -----------------------------------------------------------
// A ledger written before the account was recorded is every row this script
// already holds, and none of them is ever rewritten: a token already held is
// skipped where the answer is read, so nothing would ever stamp them and the
// prune would be permanently inert. The listing settles it - naming a turn is
// this account saying the turn is one of its own - which is the same evidence
// the prune acts on, read the other way round.

it('a listing adopts the turns it names, so a ledger written before this can be judged', function () {
  at('/library');
  const here = asAccount('someone@example.com');
  ledger([row('r_7777777777777777', undefined), row('r_8888888888888888', undefined)]);
  const taken = api.adoptListed({ r_7777777777777777: true });
  assert.strictEqual(taken, 1, 'the one the listing named');
  assert.strictEqual(api.turnTokens[api.turnSlot('r_7777777777777777', 0)].acct, here);
  assert.strictEqual(written.length, 1, 'and it is written back, or the next document reads it unplaced');
  assert.strictEqual(api.turnTokens[api.turnSlot('r_8888888888888888', 0)].acct, undefined,
    'the one it did not name stays unplaced: absence from a listing is what the prune reads, '
    + 'and reading it as ownership too would make every listing adopt the other account');
});

it('an adopted row is prunable by the next listing that drops it', function () {
  at('/library');
  asAccount('someone@example.com');
  ledger([row('r_9999999999999999', undefined)]);
  api.adoptListed({ r_9999999999999999: true });
  deleted.length = 0;
  const dropped = api.pruneVanished({});
  assert.strictEqual(dropped, 1, 'the card is gone from the library, so the token goes');
  assert.deepStrictEqual(deleted, ['tok:r_9999999999999999#0']);
});

it('adoption never takes a row that already names an account', function () {
  at('/library');
  const elsewhere = asAccount('other@example.net');
  asAccount('someone@example.com');
  ledger([row('r_aaaaaaaaaaaaaaaa', elsewhere)]);
  const taken = api.adoptListed({ r_aaaaaaaaaaaaaaaa: true });
  assert.strictEqual(taken, 0, 'it is already placed, and this listing does not overrule that');
  assert.strictEqual(api.turnTokens[api.turnSlot('r_aaaaaaaaaaaaaaaa', 0)].acct, elsewhere);
  assert.deepStrictEqual(written, [], 'and nothing is written');
});

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
