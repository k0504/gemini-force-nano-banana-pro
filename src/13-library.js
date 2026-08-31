
  // §library =================================================================
  // The library page hands out the wrong copy. A card renders the preview key
  // of its image, its download button seeds lh3's download chain with that
  // same key, and a chain seeded with the preview key ends in the 1264x848
  // file however the request is phrased. The two keys share only the fixed
  // `ACRwja` prefix, so the original's seed cannot be derived from the
  // preview's.
  //
  // The original's own seed key is not minted, it is listed. A conversation
  // load answers with both copies of an image side by side under one parent,
  // each declaring its pixels and its byte count, and the original is simply
  // the larger: 2528x1696 against the preview's 1264x848. A chain seeded with
  // that key ends in the full file, which is what a conversation's own
  // lightbox does - `gg/<original>=d-I` and two pointers later, six megabytes.
  //
  //   card -> preview key -> conversation id -> conversation load
  //        -> the larger of the two copies under the same parent
  //        -> lh3 download chain -> the file
  //
  // Only an image the conversation still lists can be reached this way. An
  // image edited since is dropped from the conversation while the library
  // keeps its card, and for those the original is not offered anywhere.
  //
  // Neither answer is parsed by index. Their shape is Gemini's and changes
  // without notice, so each is walked as a tree and read by what the values
  // look like: an lh3 URL or a bare key, a token, a triple of numbers.

  var CONV_LOAD_RPC = 'hNvQHb';
  var LIBRARY_LIST_RPC = 'jGArJ';
  var STORE_CONV_FREQ = 'gpie_conv_freq';
  var STORE_LIST_FREQ = 'gpie_list_freq';

  // Ids are sixteen hex digits behind a prefix that says what they name: a
  // conversation, a response, a candidate. Only a conversation id is a
  // conversation load's subject, and the library page issues loads of its own
  // naming a candidate instead, so the prefix is read and not the digits alone.

  // Neither call is composed, both are replayed. Their payload shapes are
  // Gemini's and undocumented, so the page's own last request of each kind is
  // kept and the one value that identifies the target swapped inside it - the
  // conversation id for the load, the token for the key. Both are persisted
  // because the library page sends neither of its own: the templates have to
  // survive the visit to the conversation that produced them.
  var freqCache = Object.create(null);

  // A template is one account's request. There is one store for the browser, so
  // a template captured while signed in as one account was replayed by the
  // other and answered http 400 - which arrives as a harvest that read nothing,
  // an index never built, and no mark on any card of the second account.
  //
  // Namespaced rather than shared, and with no reading across: each account
  // captures its own from its own page's request, which the library page issues
  // whenever it opens. That is what the wait before the first harvest is for.
  // See §origins:account for what names the account.
  function freqKey(store) {
    return store + ':' + accountHere();
  }

  function storedFreq(store) {
    var key = freqKey(store);
    if (freqCache[key] !== undefined) return freqCache[key];
    try {
      freqCache[key] = (typeof GM_getValue === 'function' && GM_getValue(key, '')) || '';
    } catch (e) {
      freqCache[key] = '';
    }
    return freqCache[key];
  }

  // Which templates this script holds, on the style node. Whether a download
  // elsewhere can work at all is decided by these, and a console line is gone
  // the moment the page is looked at from outside it.
  function noteTemplates() {
    var node = document.getElementById('gpie-style');
    if (!node) return;
    node.setAttribute('data-templates',
      'conversation=' + (storedFreq(STORE_CONV_FREQ) ? 'held' : 'none')
      + ' listing=' + (storedFreq(STORE_LIST_FREQ) ? 'held' : 'none'));
  }

  function keepFreq(store, freq) {
    var key = freqKey(store);
    if (freqCache[key] === freq) return false;
    freqCache[key] = freq;
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, freq);
    } catch (e) {
      // A template that cannot be persisted still serves this page.
    }
    return true;
  }

  function loadConvFreq() {
    return storedFreq(STORE_CONV_FREQ);
  }

  // Called from §net for every request that goes by, in both transports.
  function noteLibraryRpc(url, body) {
    if (typeof url !== 'string' || typeof body !== 'string') return;
    var m = /f\.req=([^&]*)/.exec(body);
    if (!m) return;
    var freq = decodeURIComponent(m[1].replace(/\+/g, '%20'));

    // The listing the library page pages through. Its body is
    // [[flags], count, cursor] - the count and the cursor are both swapped when
    // §origins replays it, which is how the whole library is read without
    // scrolling a grid that positions itself by transform and answers no
    // scrollTop at all.
    if (url.indexOf('rpcids=' + LIBRARY_LIST_RPC) !== -1) {
      if (keepFreq(STORE_LIST_FREQ, freq)) {
        dbg('library: listing template captured,', freq.length, 'chars');
      }
      return;
    }

    // The download request is not kept. It is composed from the ledger for the
    // image being asked for - see §library:token - and a body kept from one
    // image names that image's address, which is the one field the server reads
    // and refuses when it disagrees with the token beside it.

    if (url.indexOf('rpcids=' + CONV_LOAD_RPC) === -1) return;
    // A conversation id is what gets swapped in, so a request that does not
    // name one in the position the swap writes to is no use as a template. The
    // library page sends loads of this same shape naming a candidate; keeping
    // one of those leaves its prefix behind, and the replay then asks for
    // `rc_<conversation>`, which the server answers with nothing at all.
    if (!convIdIn(freq)) return;
    if (keepFreq(STORE_CONV_FREQ, freq)) {
      dbg('library: conversation-load template captured,', freq.length, 'chars');
    }
  }

  // The envelope is [[[rpc, "<inner json>", null, "generic"]]] and the
  // conversation id is the inner array's first element. Reaching it through
  // JSON.parse is the only way that holds: in the text the id sits inside a
  // quoted payload, so its own quotes are escaped, and a pattern written for
  // plain quotes matches nothing. One written for the escaped form matches the
  // first request and then silently stops matching the moment the encoding
  // shifts - which is what happened here, and every conversation load for it
  // asked for whichever id the template already carried.
  function innerOf(freq) {
    var outer = JSON.parse(freq);
    return { outer: outer, inner: JSON.parse(outer[0][0][1]) };
  }

  function convIdIn(freq) {
    var parsed;
    try {
      parsed = innerOf(freq);
    } catch (err) {
      return null;
    }
    var head = parsed.inner[0];
    return typeof head === 'string' && /^c_[0-9a-f]{16}$/.test(head) ? head.slice(2) : null;
  }

  // §library:read ------------------------------------------------------------
  // What the conversation answer is read for, in the terms the values
  // themselves carry rather than the positions they sit at.

  function lhKey(url) {
    if (typeof url !== 'string') return null;
    var at = url.indexOf('googleusercontent.com/gg/');
    if (at === -1) return null;
    var key = url.slice(at + 'googleusercontent.com/gg/'.length);
    // A size suffix is a request parameter, not part of the identity.
    var cut = key.search(/[=?#]/);
    return cut === -1 ? key : key.slice(0, cut);
  }

  // A key is not always spelled as a URL in the answer - it also stands as a
  // bare string, several hundred characters under the shared prefix.
  function bareKey(s) {
    return /^ACRwja[A-Za-z0-9_-]{200,}$/.test(s) ? s : null;
  }

  // Every image entry declares its own pixels and byte count, the preview and
  // the original alike, and the triple sits directly on the entry. Reading it
  // from descendants as well would mark every ancestor of an image as an image
  // too, which is what once made a whole answer look like nothing but previews.
  function sizeOf(node) {
    if (!Array.isArray(node)) return null;
    for (var i = 0; i < node.length; i++) {
      var v = node[i];
      if (Array.isArray(v) && v.length === 3
        && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number'
        && v[0] > 0 && v[1] > 0 && v[2] > 1000) return v;
    }
    return null;
  }

  // Every image entry in the order the answer lists them. An entry is the
  // smallest array holding one image key - as an lh3 URL or as a bare string -
  // which is the level the token, the size triple and the media type sit at
  // too.
  // The parent is carried along because it is what tells one image's copies
  // from another's: an answer lists the preview and the original of the same
  // image as neighbours under one parent, and lists other images elsewhere.
  // The turn is carried down as well. A conversation page draws its generated
  // images from blob: URLs and puts no key on them at all, so the only thing
  // naming one there is the turn it belongs to and its place in it - see
  // §origins:turn.
  //
  // A turn does not name itself among its own strings. It opens with a header
  // tuple holding the conversation id and the response id, and the images sit
  // in later siblings of that header, not beneath it:
  //
  //   turn ── [0] header  [c_<hex>, r_<hex>]
  //        ├─ [2] the user's message   ── its uploaded images
  //        └─ [3] the model's response ── its generated images
  //
  // So the node to attribute is the one whose own child holds the id, and the
  // id governs that node's whole subtree. Reading the id from a node's own
  // strings instead - which is what this did first - attributes the header and
  // nothing else, and every image comes out belonging to no turn at all.
  function imageEntries(node, out, parent, resp) {
    out = out || [];
    if (!Array.isArray(node)) return out;
    var mine = null;
    var here = resp || null;
    for (var r = 0; r < node.length && here === (resp || null); r++) {
      var header = node[r];
      if (!Array.isArray(header)) continue;
      for (var h = 0; h < header.length; h++) {
        if (typeof header[h] === 'string' && /^r_[0-9a-f]{16}$/.test(header[h])) {
          here = header[h];
          break;
        }
      }
    }
    for (var i = 0; i < node.length; i++) {
      var v = node[i];
      if (typeof v === 'string') {
        var key = lhKey(v) || bareKey(v);
        if (key && !mine) mine = key;
      } else if (Array.isArray(v)) {
        imageEntries(v, out, node, here);
      }
    }
    if (mine) out.push({ key: mine, size: sizeOf(node), parent: parent || null, resp: here });
    return out;
  }

  // §library:token -----------------------------------------------------------
  // The route the lightbox's own download takes, and the only one that reaches
  // the original for an image the answer lists just once. `c8o8Fe` is handed
  // the image's media token together with the turn it sits in, and answers with
  // a key whose `=s0` is the original - measured 1696x2528 and 1792x2400
  // against previews of 848x1264 and 896x1200, in two conversations where the
  // doubling rule below found no pair at all and reported the image as beyond
  // reach.
  //
  // Nothing has to be captured from a click: the token and both ids are in the
  // conversation answer already. An image entry carries two tokens, and they
  // are not interchangeable - the one at index 3 answers, the one at index 4
  // answers nothing, measured on both conversations.
  var DOWNLOAD_RPC = 'c8o8Fe';

  function tokenEntries(payload) {
    var out = [];
    (function walk(node, resp, rc) {
      if (!Array.isArray(node)) return;
      var here = resp;
      var cand = rc;
      // The ids sit in a header tuple that is a child of the node they govern,
      // not among the node's own strings - the same shape §library:read reads
      // the turn from. Looking only at this node's strings finds the header and
      // nothing else, and every token comes out belonging to no turn.
      for (var i = 0; i < node.length; i++) {
        var v = node[i];
        if (typeof v === 'string') {
          if (/^r_[0-9a-f]{16}$/.test(v)) here = v;
          else if (/^rc_[0-9a-f]{16}$/.test(v)) cand = v;
        } else if (Array.isArray(v)) {
          for (var h = 0; h < v.length; h++) {
            if (typeof v[h] !== 'string') continue;
            if (/^r_[0-9a-f]{16}$/.test(v[h])) here = here || v[h];
            else if (/^rc_[0-9a-f]{16}$/.test(v[h])) cand = cand || v[h];
          }
        }
      }
      var token = Array.isArray(node[3]) && typeof node[3][5] === 'string'
        && node[3][5].charAt(0) === '$' ? node[3][5] : null;
      if (token && here && cand) {
        // The node's own byte count comes along: an image is listed twice, the
        // preview and the original, and only the original's token is answered
        // for by the download rpc. Without this the preview's token was sent
        // and the rpc returned an envelope with nothing in it.
        var size = sizeOf(node);
        out.push({ token: token, resp: here, rc: cand, bytes: size ? size[2] : 0 });
      }
      for (var j = 0; j < node.length; j++) walk(node[j], here, cand);
    })(payload, null, null);

    // The same entry is listed more than once, and a turn numbers its images in
    // the order they first appear.
    var seen = Object.create(null);
    var slots = Object.create(null);
    var rows = [];
    out.forEach(function (row) {
      if (seen[row.token]) return;
      seen[row.token] = true;
      slots[row.resp] = slots[row.resp] === undefined ? 0 : slots[row.resp] + 1;
      row.slot = slots[row.resp];
      rows.push(row);
    });
    return rows;
  }

  // The request the lightbox sends, reduced to the part of it that names the
  // image.
  //
  //   POST /_/BardChatUi/data/batchexecute
  //        ?rpcids=c8o8Fe&source-path=/app/<conv>&bl=..&f.sid=..&hl=..&_reqid=..&rt=c
  //   f.req=<urlencoded [[["c8o8Fe","<inner>",null,"generic"]]]>&at=<csrf>&
  //
  // The page sends more than this: beside the token it carries the image's
  // googleusercontent address, the prompt that made it and the model that ran,
  // which is why its body runs past a thousand characters where this one is
  // under five hundred. Measured field by field against the page's own body
  // (2026-08-29), the server reads exactly one of the extra fields and only
  // when it is there: the address. Left out, the call is answered; carrying an
  // address that belongs to another image, it is refused with
  // `BardErrorInfo [1003]`.
  //
  // That is what makes this composed rather than replayed. A body kept from one
  // image cannot serve another - its address would have to be swapped along
  // with the token, and the address is the one value the ledger has no copy of.
  function originalByToken(row, conv) {
    var inner = [
      [[null, null, null, [null, null, null, null, null, row.token]],
        null, null, null, null, null, null, null, null, null],
      [row.resp, row.rc, 'c_' + conv, null, null],
      1, 0, 1
    ];
    var freq = JSON.stringify([[[DOWNLOAD_RPC, JSON.stringify(inner), null, 'generic']]]);
    return rpcPost(rpcUrl(DOWNLOAD_RPC, conv), freq, DOWNLOAD_RPC, 'original by token')
      .then(function (payload) {
        var url = payload && payload[0];
        if (typeof url !== 'string' || url.indexOf('googleusercontent') === -1) {
          throw new Error('the download rpc named no image');
        }
        // The key out of it. The chain is seeded with the key, not with the
        // url the answer spells it into.
        return lhKey(url);
      });
  }

  // §library:resolve ---------------------------------------------------------

  function rpcUrl(rpcid, conv) {
    return BATCH_EXECUTE_PATH
      + '?rpcids=' + rpcid
      + '&source-path=' + encodeURIComponent('/app/' + conv)
      + '&' + rpcQuery();
  }

  // A page of the library listing. The template is replayed with its own two
  // variables changed: how many cards to answer with, and where to carry on
  // from. An empty cursor asks for the first page.
  // The two variables are reached through the structure rather than matched in
  // the text. The body is [[["jGArJ", "<inner json>", null, "generic"]]] and
  // the inner array is [[flags], count, cursor], so parsing twice and assigning
  // to two positions is exact. The patterns this replaces were matching escaped
  // text inside a quoted payload and had no way to report a miss: a template
  // they failed to change was replayed unchanged, which asked for the same
  // first page over and over and looked like the request itself was at fault.
  function loadLibraryPage(cursor, count) {
    var freq = storedFreq(STORE_LIST_FREQ);
    if (!freq) {
      return Promise.reject(new Error('no listing template yet; open the library once'));
    }
    var swapped;
    try {
      var outer = JSON.parse(freq);
      var inner = JSON.parse(outer[0][0][1]);
      inner[1] = count;
      inner[2] = cursor;
      outer[0][0][1] = JSON.stringify(inner);
      swapped = JSON.stringify(outer);
    } catch (err) {
      return Promise.reject(new Error('the listing template does not parse: ' + err.message));
    }
    return rpcPost(rpcUrl(LIBRARY_LIST_RPC, ''), swapped, LIBRARY_LIST_RPC, 'library listing');
  }

  function loadConversation(conv) {
    var freq = storedFreq(STORE_CONV_FREQ);
    if (!freq) {
      return Promise.reject(new Error('no conversation-load template yet; '
        + 'open any conversation once and the library learns how to ask'));
    }
    var swapped;
    try {
      var parsed = innerOf(freq);
      parsed.inner[0] = 'c_' + conv;
      parsed.outer[0][0][1] = JSON.stringify(parsed.inner);
      swapped = JSON.stringify(parsed.outer);
    } catch (err) {
      return Promise.reject(new Error('the conversation-load template does not parse: '
        + err.message));
    }
    return rpcPost(rpcUrl(CONV_LOAD_RPC, conv), swapped, CONV_LOAD_RPC, 'library origin')
      .then(function (payload) {
        // The answer names the conversation it is. A load that comes back
        // naming a different one is the substitution having failed, and reading
        // it would file another conversation's images under this one - which is
        // how a sweep of 292 ids read the same conversation 292 times and
        // reported nothing wrong. It is an error, not a result.
        var named = conversationIn(payload);
        if (named && named !== conv) {
          throw new Error('asked for ' + conv.slice(-6) + ' and the answer names '
            + named.slice(-6) + '; the template is not being substituted');
        }
        return payload;
      });
  }

  // §library:save ------------------------------------------------------------
  // lh3 does not answer a cross-origin fetch from this document, so the bytes
  // come through GM_xmlhttpRequest, which the header grants for exactly this.

  // Generous against a six megabyte original on a slow line, and far short of
  // the forever that a missing deadline means.
  var GET_TIMEOUT_MS = 90000;

  function gmGet(url, type) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest not granted'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: type,
        // Without one, ontimeout below can never fire: a stalled connection
        // leaves the promise pending, the button marked busy for good, and
        // every later click on it silently swallowed.
        timeout: GET_TIMEOUT_MS,
        onload: function (r) {
          if (r.status === 200) resolve(r.response);
          else reject(new Error('http ' + r.status));
        },
        onerror: function () { reject(new Error('network error')); },
        ontimeout: function () { reject(new Error('timed out')); }
      });
    });
  }

  // The download is a chain, not a request: `gg/<seed>=d-I` answers a
  // text/plain body holding the next URL, that one answers another, and only
  // the last answers the file. Each hop is followed until the body stops
  // being text.
  //
  // Pointers are followed to the host they name. The middle hop names
  // lh3.google.com, and rewriting it onto googleusercontent.com - which the
  // header's @connect used to be the only reason for - answers with a further
  // pointer rather than the file, on and on past any hop limit. The header
  // grants lh3.google.com instead, and the chain is walked as served.
  // Where the chain starts. The key is the seed and `=d-I` is what asks for the
  // file rather than a rendering of it.
  function seedUrl(key) {
    return 'https://lh3.googleusercontent.com/gg/' + key + '=d-I?alr=yes';
  }

  function followChain(url, hops) {
    return gmGet(url, 'blob').then(function (blob) {
      if (!blob || blob.type.indexOf('text/') !== 0) return blob;
      if (hops <= 0) throw new Error('the pointer chain did not end');
      return blob.text().then(function (text) {
        var next = text.trim();
        if (next.indexOf('https://') !== 0) {
          throw new Error('unexpected answer inside the pointer chain');
        }
        return followChain(next, hops - 1);
      });
    });
  }

  function saveBlob(blob, name) {
    var href = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
      URL.revokeObjectURL(href);
    }, 4000);
  }

  // The chain answers with whatever the image actually is, and the measured
  // original came back a JPEG. The name follows the type rather than asserting
  // png over it.
  function saveName(id, type) {
    var ext = 'img';
    if (/jpeg|jpg/.test(type || '')) ext = 'jpg';
    else if (/webp/.test(type || '')) ext = 'webp';
    else if (/png/.test(type || '')) ext = 'png';
    return 'gemini-' + id.slice(-12).replace(/[^A-Za-z0-9]/g, '') + '.' + ext;
  }

  // §library:click -----------------------------------------------------------
  // The button is Gemini's and its handler downloads the preview. Taking the
  // click in the capture phase is what leaves room to answer with the original
  // instead; the native download is only allowed through when the original
  // cannot be reached, so a failure here costs the smaller file, not nothing.

  var busy = Object.create(null);

  function previewKeyNear(el) {
    var node = el;
    for (var up = 0; node && up < 8; up++) {
      var img = node.querySelector && node.querySelector('img[src*="googleusercontent.com/gg/"]');
      if (img) {
        var key = lhKey(img.src);
        if (key) return key;
      }
      node = node.parentElement;
    }
    var dialog = document.querySelector('mat-dialog-container img[src*="googleusercontent.com/gg/"]');
    return dialog ? lhKey(dialog.src) : null;
  }

  // The page names the conversation on the button itself. Gemini tags its
  // logged controls with a `jslog` attribute, and the download button's carries
  // a BardVeMetadataKey naming the response, the conversation and the candidate
  // the image belongs to:
  //
  //   jslog="185865;track:...;BardVeMetadataKey:[["r_<hex>","c_<hex>",null,...]]"
  //
  // Only the `c_` entry is read. The click resolves to the outer custom
  // element while the attribute sits on the native button inside it, so the
  // element's own subtree is read first; the walk up the ancestors after it
  // covers a future move of the attribute up the tree. Ancestors are never
  // searched downward - high enough up, a descendant lookup would reach the
  // other cards and answer with some other image's conversation.
  function conversationTag(node) {
    var tag = node.getAttribute && node.getAttribute('jslog');
    var m = tag && /"c_([0-9a-f]{16})"/.exec(tag);
    return m ? m[1] : null;
  }

  function conversationNear(el) {
    var conv = conversationTag(el);
    if (conv) return conv;
    var tagged = el.querySelector && el.querySelector('[jslog*="c_"]');
    if (tagged) {
      conv = conversationTag(tagged);
      if (conv) return conv;
    }
    var node = el.parentElement;
    for (var up = 0; node && up < 8; up++) {
      conv = conversationTag(node);
      if (conv) return conv;
      node = node.parentElement;
    }
    return null;
  }

  // Every way the page offers to download a generated image, on both pages.
  // Three of them, and not one delivers the original: the control on the image,
  // the entry in the message's own menu, and the library card's button. The
  // control's label reads as the original-size download; taking that label at
  // its word is why this took the library page alone for as long as it did.
  var DOWNLOAD_BUTTONS = [
    'download-generated-image-button',
    '[data-test-id="download-generated-image-button"]',
    '[data-test-id="image-download-button"]'
  ].join(', ');

  // A conversation page names its conversation in its own address, which is the
  // one thing the library page has nothing to read.
  function conversationHere() {
    var found = /^\/app\/([0-9a-f]{16})/.exec(appPath());
    return found ? found[1] : null;
  }

  // Which image a click is about, answered differently on each page because the
  // two carry different things.
  //
  // A library card draws the image itself, so its key is on the element. A
  // conversation draws its generated images from blob: URLs and puts no key
  // anywhere near them; walking up from the button there reaches the message's
  // uploaded reference images, and seeding the chain with one of those hands
  // back a reference image in place of the generated one. What a conversation
  // does carry is the turn and the image's place in it, which is the other way
  // the ledger is indexed.
  function singleImageOf(button) {
    if (!button.closest('gem-menu, .cdk-overlay-pane')) return button.closest('single-image');
    // A menu entry opens in an overlay parented to the document, so walking up
    // from it reaches the overlay and never the message. What it belongs to is
    // the message marked as having a menu open.
    var owner = document.querySelector('message-actions.has-open-menu');
    var host = owner && owner.closest('.conversation-container');
    var images = host ? host.querySelectorAll('single-image') : [];
    // Which of several the entry means is stated nowhere on it, and answering
    // with the wrong image is worse than answering with a smaller copy of the
    // right one.
    if (images.length !== 1) {
      if (images.length) {
        dbg('download: the menu belongs to a message holding', images.length,
          'images and does not say which; leaving it to Gemini');
      }
      return null;
    }
    return images[0];
  }

  // The message menu opens in an overlay of its own, so nothing above the
  // button reaches the image. What names the message is the action row the menu
  // was opened from, and the turn around it holds the images.
  function menuHost() {
    var bar = document.querySelector('message-actions.has-open-menu');
    var turn = bar && bar.closest ? bar.closest('.conversation-container') : null;
    var hosts = turn ? turn.querySelectorAll('single-image[data-image-attachment-index]') : [];
    if (!hosts.length) return null;
    if (hosts.length > 1) {
      say('warn', LOG_IMG, 'download: the menu names no image and this turn holds '
        + hosts.length + '; the first is taken');
    }
    return hosts[0];
  }

  // Which image the lightbox is showing. The overlay it opens in holds no image
  // node of the message, so what names it is the image that was pressed to open
  // it, recorded on the way through.
  var lastImage = null;

  function noteImagePress(ev) {
    var host = ev.target && ev.target.closest
      ? ev.target.closest('single-image[data-image-attachment-index]') : null;
    if (host) lastImage = host;
  }

  function targetOf(button) {
    if (appPath().indexOf('/library') === 0) {
      var key = previewKeyNear(button);
      return key ? { id: key, key: key } : null;
    }
    var host = singleImageOf(button) || menuHost() || lastImage;
    if (!host || !host.isConnected) return null;
    var named = /"(r_[0-9a-f]{16})"/.exec(host.getAttribute('jslog') || '');
    var slot = parseInt(host.getAttribute('data-image-attachment-index'), 10);
    if (!named || isNaN(slot)) {
      dbg('download: this image names neither its turn nor its place in it');
      return null;
    }
    return { id: named[1] + '#' + slot, resp: named[1], slot: slot };
  }

  // The outcome of the last download, on the style node beside the ledger's
  // own counts. A console line is gone the moment the page is looked at from
  // outside it; this is readable at any time, by anyone, including a browser
  // being driven.
  function noteDownload(text) {
    var node = document.getElementById('gpie-style');
    if (node) node.setAttribute('data-download', text);
  }


  // The same question the mark answers: is there a media token for this image.
  // Nothing else is a reason to take a button.
  function downloadable(target, button) {
    if (target.resp) return !!tokenForTurn(target.resp, target.slot);
    var card = target.key ? cardOrigin(target.key) : null;
    if (!card || !card.resp) return false;
    if (cardsOfTurn(card.resp) > 1) return false;
    return !!tokenForTurn(card.resp, 0);
  }

  function onDownloadClick(ev) {
    var button = ev.target && ev.target.closest && ev.target.closest(DOWNLOAD_BUTTONS);
    if (!button) return;

    // Only an image this script can answer for. The mark on the page says which
    // ones those are, and it says it by the same rule this reads: a media token
    // on record. An image without one is the page's to download as it always
    // did - taking those buttons too left them delivering nothing at all.
    var target = targetOf(button);
    if (!target || !downloadable(target, button)) {
      dbg('download: unmarked image, left to the page');
      return;
    }

    // From here the page's own handler never runs. A button that sometimes
    // hands over one file and sometimes another is the thing this replaces.
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    if (busy[target.id]) return;
    busy[target.id] = true;
    info('download: fetching the original of ' + target.id.slice(-8));
    noteDownload('asking for ' + target.id.slice(-8));

    // There is one route and it is the lightbox's own: the image's media token
    // goes to the download rpc, the url that answers is walked to the file. No
    // other route exists here. A key chain seeded from the ledger, from a
    // conversation load or from the card itself reaches a file by a different
    // road, and a mark on this page promises this road.
    var card = target.key ? cardOrigin(target.key) : null;
    var conv = conversationNear(button) || conversationHere() || (card && card.conv);
    // A card names its turn but not which image in it, so it is answered for
    // only where that turn left one image in the library.
    var cardIsPlain = !!(card && card.resp && cardsOfTurn(card.resp) === 1);

    // Every token this turn has, the largest first. They are all the same
    // route; which of them the rpc answers for is what differs.
    function tokensNow() {
      if (target.resp) {
        var here = tokenForTurn(target.resp, target.slot);
        var all = tokensOfTurn(target.resp);
        if (here && all.indexOf(here) === -1) all.unshift(here);
        return all;
      }
      return cardIsPlain ? tokensOfTurn(card.resp) : [];
    }

    // One token, all the way to the bytes. The rpc and the chain are one
    // attempt, not two stages: a token the rpc answers for can still hand back
    // a key the chain refuses with a 400, and stopping at the rpc's answer left
    // that token's failure standing for the image while another token on the
    // same turn would have delivered the file. Measured on a turn whose ledger
    // rows had gone stale: the first token was refused outright, the second was
    // answered with a key the chain would not serve.
    function byToken(row) {
      return originalByToken(row, row.conv || conv).then(function (key) {
        noteDownload('the rpc answered, walking the download chain');
        // The chain the lightbox walks, seeded the way the lightbox seeds it.
        // Each hop's body is the next url and is used as it stands.
        return followChain(seedUrl(key), 4);
      });
    }

    function tryInTurn(tokens, i) {
      if (i >= tokens.length) {
        return Promise.reject(new Error(tokens.length
          ? 'none of the ' + tokens.length + ' token(s) this image has reached the file'
          : 'no token for this image'));
      }
      return byToken(tokens[i]).catch(function (err) {
        if (i + 1 >= tokens.length) throw err;
        dbg('download: token ' + (i + 1) + ' of ' + tokens.length
          + ' did not reach the file (' + err.message + '), the next is tried');
        return tryInTurn(tokens, i + 1);
      });
    }

    // A conversation reached by a full page load arrives inside the document
    // rather than over an rpc, so §origins never sees it and the ledger keeps
    // whatever an earlier sweep left. Those rows outlive the tokens they name,
    // and a stale row is indistinguishable from a live one until it is spent.
    // The reload is therefore the answer to a failure, not a precondition: the
    // held rows are tried first because they usually work, and the conversation
    // is asked for only once they have not.
    function refreshed(tried) {
      if (!conv) return Promise.reject(new Error('nothing names this image\'s conversation'));
      noteDownload('the held tokens did not answer, reloading the conversation');
      return loadConversation(conv).then(function (payload) {
        rememberOrigins(payload, 'a load made for this download');
        var late = tokensNow().filter(function (row) { return tried.indexOf(row.token) === -1; });
        if (!late.length) throw new Error('the conversation lists no token this image has not already spent');
        info('download: the conversation answered with ' + late.length + ' token(s) not tried yet');
        return tryInTurn(late, 0);
      });
    }

    var held = tokensNow();
    noteDownload(held.length + ' token(s) held, asking the download rpc');
    tryInTurn(held, 0).catch(function (err) {
      dbg('download: the held tokens did not reach the file (' + err.message + ')');
      return refreshed(held.map(function (row) { return row.token; }));
    }).then(function (blob) {
      noteDownload('fetched ' + blob.size + ' bytes, saving');
      saveBlob(blob, saveName(target.id, blob.type));
      info('download: saved the original from the download rpc, '
        + Math.round(blob.size / 1024) + ' KB');
      noteDownload('saved ' + blob.size + ' bytes of ' + target.id.slice(-8));
    }).catch(function (err) {
      say('warn', LOG_IMG, 'download: the original could not be fetched (' + err.message
        + '); nothing was saved, and nothing else was tried');
      noteDownload('failed: ' + err.message);
    }).then(function () {
      delete busy[target.id];
    });
  }

  // §library:mark ------------------------------------------------------------
  // Which cards this script can answer for is invisible on the page: every card
  // draws a preview, and whether the original behind it is reachable only shows
  // after a download has already run. The mark says so beforehand.
  //
  // Read fresh on every pass rather than trusted from the last one. The grid is
  // Angular's and is rebuilt freely, and the ledger fills in the background, so
  // a card can become answerable without anything about the card changing.
  // A card's key is not the key the conversation used. Measured on one image
  // three ways: the listing draws the card from `ACRwjavaE-_a...`, while the
  // conversation that made it lists `ACRwjasdpmZb...` beside its original
  // `ACRwjauXOvKL...`. Three renditions, one image, and a lookup by key alone
  // reports the card as unknown while the original sits in the ledger under a
  // key the card never carries.
  //
  // What the two do share is the turn. The listing names every card's response
  // id - §origins keeps that index - and the ledger is written by turn as well
  // as by key, which is the same identity the download already falls back to.
  function markableCard(key) {
    var card = cardOrigin(key);
    if (!card || !card.resp) return false;
    // More than one card names this turn, so which of its images this card
    // shows cannot be told, and the mark would promise the wrong one.
    if (cardsOfTurn(card.resp) > 1) return false;
    // The token and nothing else. A key on file reaches the image by the road
    // this page no longer takes, so marking on one would promise a download
    // that cannot be made.
    return !!tokenForTurn(card.resp, 0);
  }

  function markLibraryCards() {
    if (appPath().indexOf('/library') !== 0) return;
    var imgs = document.querySelectorAll(
      'div.library-item-card > img[src*="googleusercontent.com/gg/"]');
    for (var i = 0; i < imgs.length; i++) {
      var card = imgs[i].parentElement;
      if (!card) continue;
      var known = markableCard(lhKey(imgs[i].src));
      var dot = card.querySelector(':scope > .gpie-origin-dot');
      if (known === !!dot) continue;
      if (!known) {
        dot.remove();
        continue;
      }
      // The card positions nothing of its own, so the corner has to be made
      // before anything can sit in it.
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      dot = document.createElement('span');
      dot.className = 'gpie-origin-dot';
      dot.title = 'the original of this image is on record';
      card.appendChild(dot);
    }
  }

  // The same mark on a conversation page. An image there renders from a blob:
  // URL and carries no key at all, so what is looked up is the turn and the
  // slot within it - the same identity the download takes - rather than a key.
  // Without this the mark existed only where images are listed and not where
  // they are made, which reads as the mark being broken.
  function markConversationImages() {
    if (appPath().indexOf('/app/') !== 0) return;
    var hosts = document.querySelectorAll('single-image[data-image-attachment-index]');
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      var named = /"(r_[0-9a-f]{16})"/.exec(host.getAttribute('jslog') || '');
      var slot = parseInt(host.getAttribute('data-image-attachment-index'), 10);
      var known = !!(named && !isNaN(slot) && tokenForTurn(named[1], slot));
      var dot = host.querySelector(':scope > .gpie-origin-dot');
      if (known === !!dot) continue;
      if (!known) {
        dot.remove();
        continue;
      }
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      dot = document.createElement('span');
      dot.className = 'gpie-origin-dot';
      dot.title = 'the original of this image is on record';
      host.appendChild(dot);
    }
  }

  function installLibraryHook() {
    document.addEventListener('click', noteImagePress, true);
    document.addEventListener('click', onDownloadClick, true);
    // After the style node exists, which is what the report is written on.
    setTimeout(noteTemplates, 0);
  }
