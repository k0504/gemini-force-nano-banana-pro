// ==UserScript==
// @name         Gemini Imgen Enhancer
// @name:zh-TW   Gemini Imgen Enhancer
// @namespace    https://github.com/k0504/gemini-force-nano-banana-pro
// @author       k0504
// @license      MIT
// @homepageURL  https://github.com/k0504/gemini-imgen-enhancer
// @supportURL   https://github.com/k0504/gemini-imgen-enhancer/issues
// @version      3.58.0
// @description  Force Gemini image generation onto Nano Banana Pro from the first request, and edit the images attached to an existing prompt.
// @description:zh-TW  自首次請求即強制以 Nano Banana Pro 生成圖片，並可編輯既有 prompt 附加的圖片。
// @match        https://gemini.google.com/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @sandbox      raw
// @connect      googleusercontent.com
// @connect      google.com
// ==/UserScript==

// `@sandbox raw` runs this script in the page's own context: one window, one
// console, one fetch, one XMLHttpRequest, with the GM_ functions still
// granted. Everything this script observes is therefore what the page itself
// sees, and a request it makes shows up wherever the page's own requests do.

// §nav  Section index. Every section below opens with a line carrying its own
// §nav  tag, so `grep '§'` over this file prints the whole map with line
// §nav  numbers and jumping to one section is a single search.
//
//   §protocol   request field indices, attachment shapes, endpoints
//   §config     tunables and version
//   §trace      dbg behind a flag, info always on, attShape
//   §bodies     every outgoing send kept for field-level comparison
//   §page       WIZ_global_data recovery and small DOM helpers
//   §rpc        one call into batchexecute, and the envelope both kinds
//               of rpc answer in
//   §settings   persisted toggles and the manager menu
//   §pro        feature one: force Nano Banana Pro
//   §store      IndexedDB: the record, its image bytes, and the byte budget
//   §record     what a message's attachment list means, keyed by position,
//               and the three accessors every reader of it goes through
//   §view       drawing the record over Gemini's own carousel
//   §refresh    upgrading a record to the server's durable references
//   §upload     the three-step upload, and what counts as a contrib
//   §plan       the edit in progress
//   §freshen    turning every attachment into a contrib of this document
//   §apply      writing the plan into the outgoing prompt tuple
//   §shape      choosing the shape the resend goes out in
//   §resend     feature two, assembled: the editor's contribution to a send
//   §commit     what every rewritten send owes the record, in one place
//   §rewrite    one parse, both features, one serialise
//   §net        XHR and fetch hooks
//   §style      the injected stylesheet
//   §tiles      one thumbnail
//   §drag       reordering by pointer
//   §bar        the editor strip
//   §retry      the native regenerate, restored to older turns
//   §usage      the account's quota, and when it is worth asking for
//   §library    the library's download button, answered with the original
//   §lifecycle  detecting edit mode, scheduling passes
//   §boot       startup

(function () {
  'use strict';

