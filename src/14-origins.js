  // §origins =================================================================
  // A library card is not enough to download the image it shows. The card
  // carries a rendition of its own, measured to be a third key again - neither
  // the conversation's preview nor its original - and it is capped at the
  // preview's pixels however the request is phrased: `=s0`, `=d` and `=s4096`
  // all answer 848x1264 where the original is 1696x2528. The original has to
  // come from the conversation.
  //
  // Two things there reach it, and only one of them reaches most images.
  //
  // The pair. An answer that lists both copies declares each one's pixels, and
  // the original is exactly twice the preview - see §origins:read. This is free
  // to use afterwards and answers nothing for an image the answer lists once,
  // which measured as 26 turns out of 189 conversations.
  //
  // The token. Every image the answer lists carries a media token, and the
  // download rpc trades that token for the original - see §library:token. It
  // costs one request at the moment of the download and it answers for every
  // image the conversation still lists: 178 turns of the same 189.
  //
  // Both are written down as answers go by rather than asked for at the moment
  // of the download, because by then the answer may no longer exist. Edit an
  // image once and the version it replaced is dropped from the conversation
  // while the library keeps its card, and from then on nothing - no pair, no
  // token, no route at all - reaches that original. Those cards are not marked
  // and cannot be.

  // Read once at startup and answered from memory afterwards. The library draws
  // its mark on every scan pass, and a store read per card per pass would be
  // paid for on a page that holds hundreds of them.
  var origins = Object.create(null);
  // The same ledger read the other way. A conversation page has no key to look
  // an image up by, only the turn it sits in and its place in that turn.
  var byTurn = Object.create(null);
  // The media token a turn's image carries, which §library hands to the
  // download rpc to be given the original. Kept beside the pairs rather than in
  // place of them: a pair answers without a request, a token costs one.
  var turnTokens = Object.create(null);
  // The same tokens under the turn alone. §library draws its mark on every scan
  // pass and a library page holds hundreds of cards, so the lookup a card makes
  // has to be a hash read rather than a walk over every token held.
  var tokenByResp = Object.create(null);
  // Every conversation this browser has been told exists, and when the ledger
  // last read it. The sweep's work list is the ones with no readAt.
  var knownConvs = Object.create(null);
  // A library card names its own conversation and its own turn. Neither is on
  // the card in the grid - its jslog is a metadata key of nothing but nulls -
  // but both are in the listing answer that put it there, alongside the key of
  // the copy it displays. That makes the listing a card-to-conversation index,
  // which is what lets a download on a card the ledger has never seen resolve
  // in one request instead of failing or sweeping.
  //
  // Memory only. It costs a fourteen-second harvest to refill and is worth less
  // than the upgrade hazard a third object store would carry.
  var cardConv = Object.create(null);

  function turnSlot(resp, slot) {
    return resp + '#' + slot;
  }

  // §origins:account ---------------------------------------------------------
  // The ledger is one store for gemini.google.com, and a second signed-in
  // account shares it: the taps read what the requests carry and no request
  // says which account made it, so both accounts' tokens land in the same
  // place. That is harmless to a lookup - a turn is only ever reached through
  // the listing of the account that owns it - and fatal to the prune, which
  // deletes every row the listing it just read does not name. Read as one
  // library, the other account's images are images that have been deleted.
  //
  // So each row says whose it is, and the prune judges only its own.
  //
  // Two answers, and which one is in hand is part of the answer. The address is
  // the account's position in the switcher, which moves when an account is
  // signed out; the page's own datum is the account itself and does not. The
  // datum sits behind an obfuscated build symbol that can be renamed under us,
  // so the address is the fallback rather than the source - and a row written
  // under one is never compared against a row written under the other, which
  // costs a rename nothing more than a prune that stops retiring old rows.
  //
  // Folded rather than stored: the ledger is readable by anything on this
  // origin, and which images are whose is all this has to answer.
  function accountHere() {
    var mail = wiz(WIZ_KEYS.acct);
    if (typeof mail === 'string' && mail.indexOf('@') !== -1) {
      var fold = 5381;
      for (var i = 0; i < mail.length; i++) {
        fold = ((fold * 33) ^ mail.charCodeAt(i)) >>> 0;
      }
      return 'e:' + fold.toString(16);
    }
    // Measured against two accounts on one browser: /library and /u/0/library
    // are served the same account, so the bare address is the first one and not
    // a third state.
    var numbered = /^\/u\/(\d+)(?=\/|$)/.exec(location.pathname);
    return 'u:' + (numbered ? numbered[1] : '0');
  }

  // The ledger's size as an attribute, which survives where a log line does
  // not: it answers "is the ledger filling" for a page opened long after the
  // lines scrolled past, and for a driver that attached after load. §log now
  // writes to the page's console as well, so this is a second view of the same
  // thing rather than the only one.
  // #gpie-style already carries data-version for the same reason.
  // Three numbers: keys held, turns indexed, and conversations answered out of
  // ids still worth asking about. A candidate that answered nothing is counted
  // in neither - it is not a conversation and will not be asked again.
  function convTally() {
    var answered = 0;
    var pending = 0;
    for (var id in knownConvs) {
      if (!readInThisGeneration(knownConvs[id])) pending++;
      else if (knownConvs[id].kind === 'conversation') answered++;
    }
    return answered + 'of' + (answered + pending);
  }

  // What the page can see of a run that would otherwise be silent. One node,
  // reused: a sweep reports into it while it works and leaves the outcome
  // there, and a run started by hand is answered the moment it is asked for.
  var progressHide = 0;

  function progress(text, done) {
    var node = document.getElementById('gpie-progress');
    if (!node) {
      node = document.createElement('div');
      node.id = 'gpie-progress';
      node.className = 'gpie-progress';
      (document.body || document.documentElement).appendChild(node);
    }
    node.className = 'gpie-progress' + (done ? ' gpie-done' : '');
    node.textContent = text;
    if (progressHide) clearTimeout(progressHide);
    progressHide = done ? setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 8000) : 0;
  }

  function noteLedgerSize() {
    var node = document.getElementById('gpie-style');
    if (!node) return;
    node.setAttribute('data-origins', Object.keys(origins).length
      + '/' + Object.keys(byTurn).length
      + '/' + convTally());
  }

  // `origins` is initialised when this part runs, which is after §boot's own
  // top-level statements. Every reader below is reached from a timer or an
  // event, long after the whole script has run, but the guard costs one token
  // and removes the question.
  function originalFor(key) {
    var known = key && origins && origins[key];
    return known ? known.original : null;
  }

  // A turn's images are numbered by the page from what it renders, and the
  // answer's own ordering does not always agree - one measured turn carried two
  // tokens where the page shows one image. An exact slot is preferred and the
  // turn's longest token is the fallback: the token that answers is 281
  // characters where the one that answers nothing is shorter, measured on both
  // conversations read while this was written.
  function tokenForTurn(resp, slot) {
    if (!resp || !turnTokens) return null;
    return turnTokens[turnSlot(resp, slot)] || tokenByResp[resp] || null;
  }

  // Both indexes are written together, and the turn's index keeps the longest
  // token it has been shown.
  function holdToken(row) {
    if (!row || !row.token || !row.resp) return;
    turnTokens[turnSlot(row.resp, row.slot)] = row;
    var best = tokenByResp[row.resp];
    if (!best || row.token.length > best.token.length) tokenByResp[row.resp] = row;
  }

  // A library card names the turn it came from but not which image in it, so a
  // turn whose images are several is ambiguous: answering with slot 0 hands
  // back another image under this card's name, which §library holds to be worse
  // than answering with a smaller copy.
  //
  // What counts the images is the listing, not the ledger. A single image is
  // listed twice in a conversation answer - the preview and the original, each
  // with a token of its own - so counting token rows called every turn
  // ambiguous and took every mark on the page down with it. The library draws
  // one card per image, so the cards that name a turn are its images.
  var cardsPerTurn = Object.create(null);

  // Every token recorded for a turn, the one whose node declared the most bytes
  // first. An image is listed twice and only the original's token is answered
  // for by the download rpc, so the order is what makes the first ask the right
  // one; rows stored before the byte count was kept sort last and are tried in
  // the order they were read.
  function tokensOfTurn(resp) {
    if (!resp) return [];
    var prefix = resp + '#';
    var rows = [];
    for (var at in turnTokens) {
      if (at.indexOf(prefix) === 0) rows.push(turnTokens[at]);
    }
    rows.sort(function (a, b) { return (b.bytes || 0) - (a.bytes || 0); });
    return rows;
  }

  function cardsOfTurn(resp) {
    return (resp && cardsPerTurn[resp]) || 0;
  }

  function originalForTurn(resp, slot) {
    var known = resp && byTurn && byTurn[turnSlot(resp, slot)];
    return known ? known.original : null;
  }

  function loadOrigins() {
    return dbReadAll(ORIGINS).then(function (rows) {
      rows.forEach(function (row) {
        if (!row || !row.key) return;
        if (row.token) {
          holdToken(row);
          return;
        }
        origins[row.key] = row;
        if (row.resp && typeof row.slot === 'number') byTurn[turnSlot(row.resp, row.slot)] = row;
      });
      noteLedgerSize();
      dbg('origins:', rows.length, 'keys read back from the ledger');
      // Cards already drawn were drawn against an empty ledger.
      if (rows.length) schedule();
    }).then(function () {
      return dbReadAll(CONVERSATIONS).then(function (rows) {
        rows.forEach(function (row) {
          if (row && row.key) knownConvs[row.key] = row;
        });
        noteLedgerSize();
        dbg('origins:', rows.length, 'ids read back,', convTally(), 'conversations answered');
      });
    }).catch(function (err) {
      say('warn', LOG_IMG, 'the origin ledger could not be read:', err);
    });
  }

  // §origins:convs -----------------------------------------------------------
  // A sweep needs a work list and neither page carries one. A library card
  // names no conversation at all, and a sidebar entry keeps its id in Angular's
  // own state rather than in an href or an attribute.
  //
  // The answers do carry it. Rather than identify which rpc lists the sidebar -
  // it is served once at page load, before anything outside this script could
  // be watching - every batchexecute answer is scanned for conversation ids and
  // whatever it names is remembered. An answer naming none costs one regular
  // expression over a body already in memory.
  function remember(ids, kind) {
    var fresh = [];
    ids.forEach(function (id) {
      if (knownConvs[id]) return;
      knownConvs[id] = { key: id, readAt: 0, kind: kind };
      fresh.push(knownConvs[id]);
    });
    if (!fresh.length) return 0;
    noteLedgerSize();
    dbWrite(CONVERSATIONS, fresh).catch(function (err) {
      say('warn', LOG_IMG, 'the conversation list could not be written:', err);
    });
    return fresh.length;
  }

  // The ids sit quoted inside a quoted payload, so their quotes arrive escaped
  // and a pattern anchored on a plain quote matches nothing - which is why a
  // library page full of them once contributed none. Matching the id itself
  // sidesteps the quoting; the one thing to exclude is rc_, which ends in the
  // same sixteen digits behind a different prefix.
  function noteConversationIds(text) {
    var found = text.match(/(^|[^r])c_[0-9a-f]{16}/g);
    if (!found) return;
    var added = remember(found.map(function (hit) {
      return hit.slice(hit.indexOf('c_') + 2);
    }), 'conversation');
    if (added) dbg('origins:', added, 'conversations named by an answer');
  }

  // The sidebar's own list is not fetched, it is baked into the page, and its
  // ids are written bare - no c_ in front of them anywhere in the document.
  // Bare sixteen hex digits is not a shape that tells a conversation from a
  // response or a candidate, and the page holds ninety of them against
  // The bare hex ids scattered through the page used to be collected here and
  // fed to the sweep as candidates, on the reasoning that the server would rule
  // out the ones that name nothing. It did, at a request each: one run reported
  // ninety-four conversations found and two keys learned. The library listing
  // names conversations exactly, so the guessing is gone and the sweep's work
  // list is what the listing said.

  // A conversation is read by a particular version of the reader. Until 3.23.0
  // the reader substituted nothing and every load answered with whichever
  // conversation the stored template already named, so a mark left by an older
  // generation records that an id was asked for, not that it was read. Stamping
  // the generation is what lets those marks be retired instead of trusted; the
  // alternative was telling every install to clear its ledger by hand. The
  // stamp moves again whenever the reader changes what it can extract: 3 is the
  // doubling rule, which pairs answers the parent rule discarded; 4 is the media
  // token, which reaches originals the doubling rule never paired at all.
  var SWEEP_GENERATION = 4;

  function readInThisGeneration(row) {
    return !!(row && row.readAt && row.generation === SWEEP_GENERATION);
  }

  function markConversationRead(conv) {
    if (!conv) return;
    var row = knownConvs[conv] || (knownConvs[conv] = { key: conv, readAt: 0 });
    row.readAt = Date.now();
    row.generation = SWEEP_GENERATION;
    noteLedgerSize();
    dbWrite(CONVERSATIONS, [row]).catch(function () {
      // A mark that cannot be stored costs one repeated read, nothing worse.
    });
  }

  // The answer says which conversation it is - the turn's header tuple opens
  // with the conversation id - so nothing has to be threaded in from a caller.
  function conversationIn(payload) {
    var found = /"c_([0-9a-f]{16})"/.exec(JSON.stringify(payload));
    return found ? found[1] : null;
  }

  // §origins:read ------------------------------------------------------------

  // An answer lists an image's two copies, each declaring [width, height,
  // bytes], and the original is exactly twice the preview in both directions.
  // Measured without exception: 896x1200 beside 1792x2400, 1264x848 beside
  // 2528x1696. That doubling is what identifies a pair.
  //
  // Sharing a parent was the first rule and it does not hold. A parent collects
  // whatever the answer nests together, which measured as groups of one, two,
  // four and five across fifteen conversations - the four uploaded reference
  // images and the preview under one parent, the original alone under another.
  // Requiring a parent of exactly two entries then threw away the pair the
  // answer plainly contained: nine groups of fifty-six paired, and a library of
  // 1,283 images ended with seven originals on record.
  //
  // The uploads cannot be mistaken for a pair under the doubling rule - a
  // measured turn carried 299x299, 768x1024, 1090x1090 and 848x1264, no one of
  // them twice another - which is what the parent rule was guarding against.
  //
  // An answer also lists the same entry more than once, so entries are reduced
  // to one per key before anything is matched.
  function pairsIn(payload) {
    var seen = Object.create(null);
    var entries = [];
    imageEntries(payload).forEach(function (entry) {
      if (!entry.size || seen[entry.key]) return;
      seen[entry.key] = true;
      entries.push(entry);
    });

    // A turn at a time, so two images generated in one turn cannot pair across
    // turns, and so the slot numbering runs in the order the answer lists them.
    var turns = [];
    var byResp = Object.create(null);
    entries.forEach(function (entry) {
      var resp = entry.resp || '';
      if (!byResp[resp]) {
        byResp[resp] = [];
        turns.push(resp);
      }
      byResp[resp].push(entry);
    });

    var pairs = [];
    turns.forEach(function (resp) {
      var group = byResp[resp];
      var taken = Object.create(null);
      var slot = -1;
      group.forEach(function (small) {
        var big = null;
        for (var i = 0; i < group.length && !big; i++) {
          var other = group[i];
          if (other === small || taken[other.key]) continue;
          if (other.size[0] !== small.size[0] * 2) continue;
          if (other.size[1] !== small.size[1] * 2) continue;
          if (other.size[2] <= small.size[2]) continue;
          big = other;
        }
        if (!big) return;
        taken[big.key] = true;
        taken[small.key] = true;
        slot++;
        [small, big].forEach(function (entry) {
          pairs.push({
            key: entry.key,
            original: big.key,
            resp: resp || null,
            slot: resp ? slot : null,
            w: big.size[0],
            h: big.size[1],
            bytes: big.size[2]
          });
        });
      });
    });
    return pairs;
  }

  function rememberOrigins(payload, where) {
    var pairs;
    try {
      pairs = pairsIn(payload);
    } catch (err) {
      dbg('origins: the answer could not be read (' + err.message + ')');
      return;
    }
    rememberTokens(payload);
    if (!pairs.length) return;

    var now = Date.now();
    var fresh = 0;
    pairs.forEach(function (pair) {
      if (!origins[pair.key]) fresh++;
      pair.seenAt = now;
      origins[pair.key] = pair;
      if (pair.resp && typeof pair.slot === 'number') {
        byTurn[turnSlot(pair.resp, pair.slot)] = pair;
      }
    });
    noteLedgerSize();
    dbWrite(ORIGINS, pairs).then(function () {
      dbg('origins: ' + where + ' contributed', pairs.length, 'keys,', fresh, 'of them new');
      // A mark can be drawn now that could not be a moment ago.
      if (fresh) schedule();
    }).catch(function (err) {
      say('warn', LOG_IMG, 'the origin ledger could not be written:', err);
    });
  }

  // Stored under a key of their own so one ledger holds both without either
  // shadowing the other; a token row is never an image key and never answers a
  // lookup by one.
  function rememberTokens(payload) {
    var conv = conversationIn(payload);
    if (!conv) return;
    var rows;
    try {
      rows = tokenEntries(payload);
    } catch (err) {
      dbg('origins: the tokens could not be read (' + err.message + ')');
      return;
    }
    var here = accountHere();
    var fresh = [];
    rows.forEach(function (row) {
      var at = turnSlot(row.resp, row.slot);
      if (turnTokens[at] && turnTokens[at].token === row.token) return;
      row.key = 'tok:' + at;
      row.conv = conv;
      // Whose turn this is, written at the only moment it is known: the answer
      // being read was served to whoever is signed in now. See §origins:account.
      row.acct = here;
      holdToken(row);
      fresh.push(row);
    });
    if (!fresh.length) return;
    noteLedgerSize();
    dbWrite(ORIGINS, fresh).then(function () {
      dbg('origins:', fresh.length, 'tokens recorded');
      schedule();
    }).catch(function (err) {
      say('warn', LOG_IMG, 'the tokens could not be written:', err);
    });
  }

  function noteConversationText(text, where) {
    if (typeof text !== 'string' || !text) return;
    noteConversationIds(text);
    if (where.indexOf('generation') !== -1) {
      // Read for its tokens, not marked as read: this is one turn and the
      // sweep still has the rest of the conversation to walk.
      wrbPayloads(text, null).forEach(function (chunk) {
        rememberOrigins(chunk, where);
      });
      return;
    }
    if (where.indexOf('conversation load') === -1) {
      // A listing answer indexes cards; it carries no pairs.
      try {
        noteCardConversations(wrbPayload(text, LIBRARY_LIST_RPC));
      } catch (err) {
        // Most answers on that address are not listings.
      }
      return;
    }
    var payload;
    try {
      payload = wrbPayload(text, CONV_LOAD_RPC);
    } catch (err) {
      // Not every answer on that address carries a payload this can read - a
      // failed load answers a short envelope with nothing in it.
      return;
    }
    markConversationRead(conversationIn(payload));
    rememberOrigins(payload, where);
  }

  // Each card is one entry: a URL holding the key of the copy the grid shows,
  // and the two ids that say where it came from. The card's key is a preview -
  // measured at half the original in both directions, 896x1200 against
  // 1792x2400 - so the listing names the image without ever naming its original.
  function noteCardConversations(payload, standing) {
    var cards = payload && Array.isArray(payload[0]) ? payload[0] : null;
    if (!cards) return 0;
    var added = 0;
    cards.forEach(function (card) {
      if (!Array.isArray(card)) return;
      var text = JSON.stringify(card);
      var url = /googleusercontent\.com\/gg\/[A-Za-z0-9_-]+/.exec(text);
      var conv = /(^|[^r])c_([0-9a-f]{16})/.exec(text);
      if (!url || !conv) return;
      var key = lhKey(url[0]);
      if (!key) return;
      if (cardConv[key]) {
        if (standing && cardConv[key].resp) standing[cardConv[key].resp] = true;
        return;
      }
      var resp = /r_[0-9a-f]{16}/.exec(text);
      if (resp && standing) standing[resp[0]] = true;
      cardConv[key] = { conv: conv[2], resp: resp ? resp[0] : null };
      // One card per image, so this counts the images the turn still has here.
      if (resp) cardsPerTurn[resp[0]] = (cardsPerTurn[resp[0]] || 0) + 1;
      added++;
    });
    return added;
  }

  // A token is worth keeping only while the card it belongs to is still in the
  // library. Delete an image there and the ledger would otherwise hold its
  // token for good: nothing prunes, and no card is ever drawn for it again, so
  // the row is dead the moment the card goes.
  //
  // Reconciled against the listing rather than hooked onto the delete, which
  // makes it answer for a deletion made in another tab, on another machine, or
  // before this script was installed - and costs nothing beyond the harvest the
  // library page already runs.
  //
  // Only against a listing read to its end. A harvest that stopped early has
  // seen some of the library, and pruning against that would throw away tokens
  // for cards it simply never reached.
  // Every row this script already holds was written before the account was
  // recorded, and none of them is ever rewritten: rememberTokens skips a token
  // already held, so nothing on the reading side would ever stamp one and the
  // prune below - which judges only rows it can place - would be inert for good
  // on exactly the ledger it exists to keep.
  //
  // The listing places them. A turn it names is a turn this account owns, which
  // is the same fact the prune reads in the negative, so adopting on it costs no
  // request and no new assumption. Only the turns it names: a row it is silent
  // about is a row this listing cannot speak for, and taking those would hand
  // the other account's ledger to whichever library happened to be read first.
  //
  // Written back rather than held, or the next document reads them unplaced and
  // the adoption has to happen again on every load.
  function adoptListed(standing) {
    var here = accountHere();
    var taken = [];
    for (var at in turnTokens) {
      var row = turnTokens[at];
      if (row.acct || !standing[row.resp]) continue;
      row.acct = here;
      taken.push(row);
    }
    if (!taken.length) return 0;
    dbWrite(ORIGINS, taken).then(function () {
      dbg('origins:', taken.length, 'tokens placed with the account that listed them');
    }).catch(function (err) {
      say('warn', LOG_IMG, 'the tokens could not be placed with their account:', err);
    });
    return taken.length;
  }

  // Only ever against the account whose listing was read. A row belonging to
  // another account is absent from this listing because this listing could not
  // have named it, and a row from before the account was recorded cannot be
  // placed at all - neither is evidence of a deleted card, and the deletion is
  // permanent where the evidence is not. Both are left for a listing read while
  // signed in as their owner, which is the only reading that can retire them.
  function pruneVanished(standing) {
    var here = accountHere();
    var gone = [];
    for (var at in turnTokens) {
      var row = turnTokens[at];
      if (standing[row.resp]) continue;
      if (row.acct !== here) continue;
      gone.push(row);
    }
    if (!gone.length) return 0;
    gone.forEach(function (row) {
      delete turnTokens[turnSlot(row.resp, row.slot)];
      // By the turn, not by identity. The second index keeps the longest token
      // a turn has been shown, which is often a different row object from the
      // one being pruned, and comparing the two left that turn answering with a
      // token whose card the listing no longer names.
      delete tokenByResp[row.resp];
    });
    dbDelete(ORIGINS, gone.map(function (row) { return row.key; })).catch(function (err) {
      say('warn', LOG_IMG, 'the vanished tokens could not be dropped:', err);
    });
    noteLedgerSize();
    schedule();
    return gone.length;
  }

  // What the library page knows about one of its own cards. Read by §library
  // when a download lands on a card whose original is not in the ledger.
  function cardOrigin(key) {
    return (key && cardConv[key]) || null;
  }

  // §origins:tap -------------------------------------------------------------
  // The answer is read where it already goes by. A conversation load runs to
  // megabytes and this script has no business asking for one the page was not
  // going to make anyway; both transports are tapped for the same reason §net
  // hooks both, so a migration off either does not silently empty the ledger.

  // Two things are read, from different sets of answers. The pairs come from a
  // conversation load alone; the conversation ids come from any answer that
  // happens to name one, because the answer listing them all is served before
  // this script could ask for it.
  function whatToRead(url) {
    if (typeof url !== 'string') return null;
    // A generation answers with the turn it has just written, in the shape a
    // conversation load answers with the whole thread. Reading it is what puts
    // an image on record while it is being looked at, rather than on whatever
    // later load happens to walk past it.
    if (url.indexOf('StreamGenerate') !== -1) return 'generation';
    if (url.indexOf('batchexecute') === -1) return null;
    return url.indexOf('rpcids=' + CONV_LOAD_RPC) !== -1 ? 'conversation load' : 'answer';
  }

  function tapRpcXhr(xhr, url) {
    var kind = whatToRead(url);
    if (!kind) return;
    xhr.addEventListener('load', function () {
      try {
        noteConversationText(xhr.responseText, 'an xhr ' + kind);
      } catch (err) {
        // Reading the answer must never break the request it rode in on.
      }
    });
  }

  function tapRpcFetch(url, promise) {
    var kind = whatToRead(url);
    if (!kind) return promise;
    return promise.then(function (res) {
      try {
        // The page's own copy of the body is left untouched; the clone is this
        // script's to consume.
        res.clone().text().then(function (text) {
          noteConversationText(text, 'a fetch ' + kind);
        }, function () {
          // A body that cannot be read teaches nothing.
        });
      } catch (err) {
        // Cloning fails on a body already consumed elsewhere.
      }
      return res;
    });
  }


  // §origins:sweep -----------------------------------------------------------
  // The ledger fills as conversations are opened, which leaves a newly
  // installed script marking almost nothing while the library shows every image
  // ever generated. The sweep reads the conversations that have been learned of
  // but never read, so the marks mean something before every thread has been
  // walked by hand.
  //
  // From the menu rather than a page visit: it is this script issuing requests
  // the page was not going to make, one per conversation, which is a thing to
  // be asked for. They go one at a time with a pause, and a conversation
  // already read is skipped, so a second run costs one pass over an empty list.
  var sweeping = false;
  var harvested = false;
  // `harvested` is set before the harvest starts, so it says a harvest has been
  // asked for, not that one has finished. What has to wait on the requests
  // themselves - the sweep, whose 189 conversation loads on top of a listing
  // replay is the traffic that met Google's interstitial - waits on this.
  var harvesting = false;
  var afterHarvest = [];

  // The work list comes off the library's listing rpc, replayed rather than
  // scrolled for. Neither the cards nor a lightbox is touched.
  //
  // Scrolling was the first attempt and it cannot be done from here. The grid
  // positions itself by transform: under a real wheel it pages happily while
  // not one ancestor's scrollTop changes, so there is no element for a script
  // to move, and an untrusted wheel event moves nothing. Measured, the grid sat
  // on its first thirty cards through every combination of scrollTop,
  // scrollIntoView and dispatched wheels.
  //
  // The listing itself has no such problem. Its body is [[flags], count,
  // cursor]; the answer ends with the cursor for the page after it, and carries
  // the conversation ids of the cards it just described. Asking for page after
  // page reads the whole library in a handful of requests.
  // Measured on a library of 1,283 images: thirteen pages, eight seconds, 180
  // conversations named. A hundred at a time is what makes that hold - the
  // page asks for far fewer, and the listing answers whatever it is asked for.
  var PAGE_SIZE = 100;
  var MAX_PAGES = 60;

  function harvestLibrary(then) {
    harvesting = true;
    var known = Object.keys(knownConvs).length;
    var pages = 0;
    var cards = 0;
    var indexed = 0;
    var cursor = '';
    // Every turn the listing still names, gathered as the pages go by.
    var standing = Object.create(null);
    info('origins: reading the library listing');
    progress('Reading the library listing...');

    function next() {
      if (pages >= MAX_PAGES) {
        done('the listing did not run out');
        return;
      }
      loadLibraryPage(cursor, PAGE_SIZE).then(function (payload) {
        pages++;
        // The answer is [the cards, the cursor for the page after them]. The
        // last page carries no cursor, and that absence is the only
        // end-of-listing signal there is.
        var items = Array.isArray(payload[0]) ? payload[0] : [];
        var carry = typeof payload[1] === 'string' ? payload[1] : '';
        cards += items.length;
        progress('Reading the library listing: page ' + pages + ', ' + cards + ' cards');
        noteConversationIds(JSON.stringify(payload));
        indexed += noteCardConversations(payload, standing);
        // The absence of a cursor is the only end-of-listing signal, and the
        // label matters beyond bookkeeping: 'read to the end' is what lets the
        // prune delete tokens. A listing that repeats its cursor or answers an
        // empty page while still carrying one has stopped making progress, not
        // ended, and pruning against it would drop the tokens of every card on
        // the pages it never reached.
        if (!carry) {
          done('read to the end');
          return;
        }
        if (carry === cursor || !items.length) {
          done('the listing stopped making progress at page ' + pages);
          return;
        }
        cursor = carry;
        setTimeout(next, 200);
      }, function (err) {
        done('the listing stopped answering (' + err.message + ')');
      });
    }

    function done(why) {
      // Also on the style node, for the same reason the ledger's size is:
      // a harvest that stopped early and one that found nothing read the same
      // to anyone who was not watching the console while it ran.
      var named = Object.keys(knownConvs).length - known;
      // Both read the same listing, and both only from one read to its end: a
      // harvest that stopped early has seen some of the library, and neither
      // what it names nor what it omits speaks for the pages it never reached.
      var placed = why === 'read to the end' ? adoptListed(standing) : 0;
      var dropped = why === 'read to the end' ? pruneVanished(standing) : 0;
      var told = pages + ' pages, ' + cards + ' cards, ' + indexed + ' indexed, '
        + named + ' named, ' + placed + ' placed, ' + dropped + ' dropped, ' + why;
      var node = document.getElementById('gpie-style');
      if (node) node.setAttribute('data-harvest', told);
      info('origins: ' + told);
      progress('Listing read: ' + cards + ' cards, ' + indexed + ' indexed'
        + (dropped ? ', ' + dropped + ' stale tokens dropped' : ''), true);
      harvesting = false;
      var waiting = afterHarvest;
      afterHarvest = [];
      then();
      waiting.forEach(function (fn) { fn(); });
    }

    next();
  }

  // The listing is what says which card belongs to which conversation, and the
  // page asks for thirty cards at a time. A card the grid has never reached is
  // a card no mark can be drawn on, so the listing is read to its end as soon
  // as a library page opens rather than waiting for a scroll that may never
  // come. Measured at thirteen requests and eight seconds against 1,283 cards.
  //
  // Only the index is built here. Nothing is fetched per conversation, which is
  // what makes this cheap enough to run unasked; filling the ledger itself is
  // still the sweep's job and still asked for from the menu.
  //
  // Once per visit, not once per page load. Every mark is drawn from this
  // index, and an image made after it was built is absent from it, so a load
  // that read the listing before that image existed marks nothing for it. The
  // application never reloads on its own, so nothing rebuilt the index either,
  // and the mark stayed missing until the page was reloaded by hand - which is
  // indistinguishable from the mark being broken.
  //
  // The interval is against a library entered and left repeatedly: thirteen
  // requests and a progress panel per visit, for an index that cannot have
  // moved in between. Making an image and coming back takes longer than this.
  var INDEX_MIN_GAP = 60000;
  var indexedAt = 0;

  function indexLibrary() {
    if (appPath().indexOf('/library') !== 0) return;
    // `harvested` no longer serves as this guard, since it now says a harvest
    // has happened at some point rather than that one is under way.
    if (harvesting) return;
    if (harvested && Date.now() - indexedAt < INDEX_MIN_GAP) return;
    harvested = true;
    indexedAt = Date.now();
    // The index alone, which is thirteen requests. The sweep that follows it is
    // one request per conversation and stays on the menu: running 189 of them
    // unasked, twelve abreast, on top of the replay is what put this browser in
    // front of Google's interstitial while this was being measured.
    harvestLibrary(schedule);
  }

  function sweepOrigins() {
    if (harvesting) {
      // The library page starts its own harvest four seconds after it opens,
      // and the menu is reachable throughout. Both at once is the listing
      // replay and the sweep sharing a window, which is what to avoid.
      if (afterHarvest.indexOf(sweepOrigins) === -1) afterHarvest.push(sweepOrigins);
      info('origins: the library listing is still being read - the sweep follows it');
      progress('Reading the library listing first...');
      return;
    }
    if (sweeping) {
      info('origins: the sweep is already running');
      progress('The sweep is already running');
      return;
    }
    // The library is the one page that can say which conversations matter, so
    // it is read first and the sweep follows on what it found.
    if (appPath().indexOf('/library') === 0 && !harvested) {
      harvested = true;
      indexedAt = Date.now();
      // The harvest is an optimisation, not a precondition: the ids it looks
      // for also arrive on their own, from every listing answer the page makes.
      // So it is given a deadline and the sweep runs either way, rather than a
      // listing that stops answering taking the sweep down with it.
      //
      // Two minutes, against a measured eight seconds. The first deadline here
      // was twenty seconds, which cut a working harvest off in the middle of
      // its thirteen pages and was then read as the replay having hung.
      var moved = false;
      var carryOn = function () {
        if (moved) return;
        moved = true;
        sweepOrigins();
      };
      setTimeout(function () {
        if (moved) return;
        var node = document.getElementById('gpie-style');
        if (node) node.setAttribute('data-harvest', 'timed out, sweeping anyway');
        // The harvest is given up on here, so the sweep that follows is not
        // sent back to wait on it. A listing that answers later finds nothing
        // queued and simply finishes.
        harvesting = false;
        carryOn();
      }, 120000);
      harvestLibrary(carryOn);
      return;
    }
    var pending = [];
    for (var id in knownConvs) {
      if (!readInThisGeneration(knownConvs[id])) pending.push(id);
    }
    if (!pending.length) {
      info('origins: nothing left to try - ' + convTally() + ' conversations answered');
      progress('Nothing left to sweep (' + convTally() + ')', true);
      return;
    }

    sweeping = true;
    var before = Object.keys(origins).length;
    var total = pending.length;
    var read = 0;
    var silent = 0;
    progress('Sweeping for originals: 0 / ' + total);
    info('origins: sweeping ' + pending.length + ' ids not tried yet - most of them '
      + 'will not be conversations, which is how they get ruled out');

    // Twelve at a time rather than one every 400ms. Sequential and polite is
    // what a background sweep wants; a sweep asked for by hand is waited on,
    // and 187 conversations at two and a half seconds each is seven minutes of
    // waiting for work that finishes in half a minute when it runs abreast.
    var WORKERS = 12;
    var running = 0;
    var stopped = false;

    function finish() {
      sweeping = false;
      info('origins: ' + read + ' were conversations, ' + silent + ' were not, ledger '
        + before + ' -> ' + Object.keys(origins).length + ' keys');
      progress('Sweep finished: ' + read + ' conversations read, ledger '
        + before + ' -> ' + Object.keys(origins).length + ' keys', true);
      schedule();
    }

    function next() {
      if (stopped) return;
      if (!pending.length) {
        if (!running) finish();
        return;
      }
      var conv = pending.shift();
      running++;
      loadConversation(conv).then(function (payload) {
        if (!conversationIn(payload)) {
          silent++;
          markConversationRead(conv);
          return;
        }
        read++;
        knownConvs[conv].kind = 'conversation';
        rememberOrigins(payload, 'the sweep');
      }, function (err) {
        // A template that will not substitute is not this id being
        // unanswerable - it is every id being unanswerable, and marking them
        // read would quietly empty the work list while learning nothing.
        if (/not being substituted|does not parse|no conversation-load template/.test(err.message)) {
          stopped = true;
          sweeping = false;
          pending.length = 0;
          say('error', LOG_IMG, 'origins: the sweep stopped - ' + err.message);
          info('origins: the sweep stopped after ' + read + ' conversations - ' + err.message);
          progress('The sweep stopped: ' + err.message, true);
          return;
        }
        silent++;
        markConversationRead(conv);
        dbg('origins: ..' + conv.slice(-6) + ' answered nothing (' + err.message + ')');
      }).then(function () {
        running--;
        progress('Sweeping for originals: ' + (read + silent) + ' / ' + total
          + ', ' + read + ' were conversations');
        if (stopped) return;
        if (!pending.length && !running) {
          finish();
          return;
        }
        next();
      });
    }

    for (var w = 0; w < WORKERS && pending.length; w++) next();
  }
