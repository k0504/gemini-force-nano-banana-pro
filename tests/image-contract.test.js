'use strict';
// The contracts every byte string and every image address has to satisfy
// before anything downstream reads it. See §guard in the built script.
//
// What these reproduce: a thumbnail address that had become same-origin was
// fetched, answered 200 with Gemini's own HTML shell, passed the only test
// there was - response.ok - and reached the server declared as image/jpeg. The
// message on screen then held a 840KB text/html file in place of a reference
// image, and the same bytes were stored and re-uploaded on every later resend.
//
// Run: node tests/image-contract.test.js

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

// The signature table is a var, not a function, so it is lifted by its own
// bounds. Taken from the shipped file for the same reason the functions are:
// a copy here would keep passing after the original changed.
function extractArray(name) {
  const at = source.indexOf('\n  var ' + name + ' = [');
  if (at === -1) throw new Error('not found in the built script: ' + name);
  const end = source.indexOf('\n  ];', at);
  if (end === -1) throw new Error('unterminated array reading ' + name);
  return source.slice(at + 1, end + 5);
}

const names = ['isWebpHead', 'imageMimeOf', 'describeHead', 'mustBeImageBytes', 'mustBeImageSource'];
const body = extractArray('IMAGE_SIGNATURES') + '\n' + names.map(extract).join('\n')
  + '\n; return { ' + names.join(', ') + ' };';
const { imageMimeOf, describeHead, mustBeImageBytes, mustBeImageSource } =
  new Function(body)();

const HTML_SHELL = Buffer.from(
  '<!doctype html><html lang="zh-TW" dir="ltr"><head><base href="https://gemini.google.com/">'
  + 'x'.repeat(2000));
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(64)]);

async function rejects(promise, needle, what) {
  try {
    await promise;
  } catch (err) {
    assert.ok(String(err.message).includes(needle),
      what + ': expected the message to name "' + needle + '", got ' + err.message);
    return err;
  }
  assert.fail(what + ': resolved when it had to be refused');
}

(async function run() {
  // The incident itself: the bytes are Gemini's own page and the label says
  // otherwise. The label is what the old code trusted.
  const posing = new Blob([HTML_SHELL], { type: 'image/jpeg' });
  const err = await rejects(mustBeImageBytes(posing, 'existing#3 (photo.jpg)'),
    'not an image', 'html labelled as a jpeg');
  assert.ok(err.message.includes('existing#3'), 'the failure names which attachment');
  assert.ok(err.message.includes('doctype html'),
    'the failure quotes what arrived instead: ' + err.message);

  // And the honest version of the same bytes, which the old code also took.
  await rejects(mustBeImageBytes(new Blob([HTML_SHELL], { type: 'text/html' }), 'existing#3'),
    'not an image', 'html labelled as html');

  await rejects(mustBeImageBytes(new Blob([], { type: 'image/jpeg' }), 'existing#0'),
    'zero bytes', 'an empty blob');
  await rejects(mustBeImageBytes(null, 'existing#0'), 'no bytes at all', 'no blob at all');

  // Every format the page actually renders, and the mime is the bytes' own
  // rather than the label's: a jpeg mislabelled png still uploads as a jpeg.
  assert.strictEqual(await mustBeImageBytes(new Blob([JPEG], { type: 'image/png' }), 'j'), 'image/jpeg');
  assert.strictEqual(await mustBeImageBytes(new Blob([PNG]), 'p'), 'image/png');
  assert.strictEqual(await mustBeImageBytes(new Blob([GIF]), 'g'), 'image/gif');
  assert.strictEqual(await mustBeImageBytes(new Blob([WEBP]), 'w'), 'image/webp');

  // A RIFF container that is not a webp is not an image.
  const riffWave = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);
  assert.strictEqual(imageMimeOf(new Uint8Array(riffWave)), null, 'RIFF alone is not webp');

  // The address the incident came in through, in both the forms it can take.
  assert.throws(() => mustBeImageSource('https://gemini.google.com/app/abc123', 'existing#3'),
    /not an lh3 image address/, 'a conversation address is not an image source');
  assert.throws(() => mustBeImageSource('https://gemini.google.com/app/abc123=s0', 'existing#3'),
    /not an lh3 image address/, 'nor is one with a size suffix appended');
  assert.throws(() => mustBeImageSource('', 'existing#3'), /no source address/, 'nor is nothing');
  assert.throws(() => mustBeImageSource(null, 'existing#3'), /no source address/, 'nor is null');

  const lh3 = 'https://lh3.googleusercontent.com/gg/ACRwjav';
  assert.strictEqual(mustBeImageSource(lh3, 'x'), lh3, 'lh3 is where thumbnails live');
  assert.strictEqual(mustBeImageSource('https://lh3.google.com/rd-gg/k', 'x'),
    'https://lh3.google.com/rd-gg/k', 'and the redirect host the download chain uses');
  assert.strictEqual(mustBeImageSource('blob:https://gemini.google.com/uuid', 'x'),
    'blob:https://gemini.google.com/uuid', 'this document mints its own');

  assert.strictEqual(describeHead(new Uint8Array([0xFF, 0xD8, 0xFF])), '"..."',
    'unprintable bytes read as dots rather than as garbage');

  console.log('image-contract: all assertions passed');
})();
