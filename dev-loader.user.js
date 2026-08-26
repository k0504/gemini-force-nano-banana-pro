// ==UserScript==
// @name         Gemini Imgen Enhancer (development)
// @namespace    https://github.com/k0504/gemini-imgen-enhancer
// @author       k0504
// @license      MIT
// @version      1.0.0
// @description  Development stub. Runs the working copy on disk rather than a snapshot held by the userscript manager.
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
// @require      file:///C:/project/gemini-force-nano-banana-pro/gemini-imgen-enhancer.user.js
// ==/UserScript==

/*
 * Installed once; @version stays at 1.0.0. The manager re-reads a file://
 * require on every load rather than holding the copy it was installed with, so
 * the cycle is: edit a part under src/, build, reload the page. Leaving
 * `python build.py --watch` running reduces that to edit and reload.
 *
 * The require names the built script at the repository root, not a part: the
 * parts share one closure and cannot be loaded separately.
 *
 * Requires, on chrome://extensions under this extension's details:
 *   - Allow access to file URLs, on
 *   - Site access, set to on all sites; a narrower setting fails file:// reads
 *
 * The required file carries its own metadata block, which is inert here: this
 * stub's grants are what it runs with, so the two lists have to agree - and
 * that includes @sandbox raw, which is what puts the script in the page's own
 * context. Changing a line in this block means saving this script again in the
 * manager; a change to the required file alone is picked up by a reload.
 *
 * Disable the released script while this one is installed, or both run.
 *
 * The path is this machine's. Anyone else working on the script edits that one
 * line; nothing else here is local.
 *
 * A require that names a missing file loads nothing and reports nothing: the
 * stub still runs, the manager still lists it as active, and the page looks as
 * though no userscript were installed at all. Check the path first when the
 * script appears not to run.
 *
 * The .user.js extension is not a problem here, contrary to what is sometimes
 * written about Chrome intercepting such requests. Measured with two required
 * files differing in nothing but their extension: both loaded.
 */
