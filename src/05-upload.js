  // §upload ==================================================================
  // Three steps, then the result is referenced as a form B attachment.
  //   1. start a resumable upload, the response header carries the upload URL
  //   2. push the bytes, the response body is the contrib_service path
  //   3. ProcessFile exchanges that path for the uuid the prompt tuple needs
  //
  // Contrib paths minted here are noted, because one read back out of the
  // record was minted by an earlier document and carries that document's
  // remaining time to live; it is not assumed to still resolve.
  //
  // The mint time is what is kept, not a bare yes. The server measures ttl_1d
  // from the mint, not from the document, so a tab left open overnight was
  // vouching for paths the server had already collected.
  var contribsThisDocument = {};
  // Well inside the day the server allows, and past any editing session.
  var CONTRIB_TTL_MS = 20 * 60 * 60 * 1000;

  function contribIsOurs(path) {
    var at = path && contribsThisDocument[path];
    return !!at && (Date.now() - at) < CONTRIB_TTL_MS;
  }

  function isContribTuple(t) {
    return Array.isArray(t) && Array.isArray(t[0]) && typeof t[0][0] === 'string'
      && t[0][0].indexOf(CONTRIB_PREFIX) === 0;
  }

  // The only answer to "what is this attachment". The question used to be asked
  // in four places that disagreed: §shape gated on the prefix alone, so a
  // contrib minted by a dead document passed; §freshen and §retry each asked
  // the prefix and the mint separately; and the console label asked the prefix
  // without even the Array.isArray guard. A line an operator read could
  // therefore contradict the gate that made the decision, which is how a live
  // fix read as a reverted one. Both predicates above stay private to this file
  // so the disagreement cannot come back.
  //   contrib-live   this document minted it and is still inside CONTRIB_TTL_MS
  //   contrib-stale  a contrib path, but not one this document can vouch for
  //   token          the server reference §refresh writes back into a record
  //   other          anything else, a native prompt tuple included
  function attClass(t) {
    if (isContribTuple(t)) return contribIsOurs(t[0][0]) ? 'contrib-live' : 'contrib-stale';
    if (Array.isArray(t) && t.length >= 3 && typeof t[2] === 'string') return 'token';
    return 'other';
  }

  function uploadFile(file) {
    var mime = file.type || 'image/jpeg';
    var startHeaders = {
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Tenant-Id': 'bard-storage'
    };
    var pctx = sniffed['x-client-pctx'] || wiz(WIZ_KEYS.pctx);
    var pushId = sniffed['push-id'] || wiz(WIZ_KEYS.pushId);
    // Both are mandatory. Sending the request without them answers a bare 400
    // that reads as a server-side refusal, so the real cause is named here.
    if (!pctx || !pushId) {
      return Promise.reject(new Error('page context unavailable (X-Client-Pctx '
        + (pctx ? 'ok' : 'missing') + ', Push-ID ' + (pushId ? 'ok' : 'missing')
        + '), reload the page'));
    }
    startHeaders['X-Client-Pctx'] = pctx;
    startHeaders['Push-ID'] = pushId;

    dbg('upload step 1: start,', file.name, file.size + 'B,', mime,
      '(pctx ' + (sniffed['x-client-pctx'] ? 'sniffed' : 'wiz') + ', pushId '
      + (sniffed['push-id'] ? 'sniffed' : 'wiz') + ')');
    var doneStep1 = dbgT('upload step 1');
    var doneStep2 = null;
    var doneStep3 = null;
    noteUploadStart();
    return fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: startHeaders,
      body: 'File name: ' + file.name
    }).then(function (res) {
      var target = res.headers.get('x-goog-upload-url');
      doneStep1('status', res.status + ',', 'target', target ? 'received' : 'MISSING');
      if (!target) throw new Error('upload init returned no target (status ' + res.status + ')');
      doneStep2 = dbgT('upload step 2');
      return fetch(target, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Goog-Upload-Command': 'upload, finalize',
          'X-Goog-Upload-Offset': '0',
          'X-Tenant-Id': 'bard-storage'
        },
        body: file
      });
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var contrib = String(text).trim();
      doneStep2('contrib', contrib.slice(0, 50) + '...');
      if (contrib.indexOf(CONTRIB_PREFIX) !== 0) throw new Error('upload returned no contrib path');
      doneStep3 = dbgT('upload step 3');
      return processFile(contrib, file.name, mime).then(function (uuid) {
        doneStep3('uuid', uuid, '-> form B tuple ready');
        noteUploadEnd();
        contribsThisDocument[contrib] = Date.now();
        // Nine elements with the [0] tail, which is what an edit resend
        // carries. §apply trims it to two for a send that takes the brand-new
        // upload shape.
        return [[contrib, 1, null, mime, uuid], file.name,
          null, null, null, null, null, null, [0]];
      });
    });
  }

  function processFile(contrib, name, mime) {
    var hl = locale();
    var inner = JSON.stringify([[[contrib, null, 1, mime], name], null, 1, [hl]]);
    // A dedicated path rather than batchexecute: the rpc is named by the
    // address, so the envelope it answers in carries a null where a
    // batchexecute answer would name it.
    return rpcPost(PROCESS_FILE_PATH + '?' + rpcQuery(),
      JSON.stringify([null, inner]), null, 'ProcessFile').then(function (parsed) {
      var uuid = parsed && parsed[3] && parsed[3][0];
      if (!uuid) throw new Error('ProcessFile returned no uuid');
      return uuid;
    });
  }

