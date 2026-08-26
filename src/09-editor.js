  // §tiles ===================================================================
  // The injected toolbar and the carousel it hides are owned here rather than
  // by the plan. A plan is dropped the moment its rewrite is applied, and both
  // of these nodes outlive edit mode, so hanging them off the plan loses the
  // only reference to them and leaves the message rendered with no images.
  var toolbar = null;
  // Which plan the toolbar was built for. Without it a toolbar left connected
  // by another message answers for this one.
  var toolbarPlan = null;
  var hiddenCarousel = null;
  var fileInput = null;

  function button(label, title, onClick, className) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.textContent = label;
    el.title = title;
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
    return el;
  }

  function makeTile(p, entry, index) {
    var tile = document.createElement('div');
    tile.className = 'gpie-tile';
    tile.title = 'Drag to reorder';
    tile.gpieEntry = entry;

    var thumb = document.createElement('img');
    thumb.className = 'gpie-thumb';
    thumb.src = entry.thumb;
    thumb.alt = '';
    thumb.draggable = false;
    if (entry.state === 'uploading') thumb.style.opacity = '.45';
    if (entry.state === 'failed') thumb.style.filter = 'grayscale(1)';
    tile.appendChild(thumb);

    var badge = document.createElement('span');
    badge.className = 'gpie-badge';
    badge.textContent = String(index + 1);
    tile.appendChild(badge);

    if (entry.state === 'uploading' || entry.state === 'failed') {
      var state = document.createElement('span');
      state.className = 'gpie-state';
      state.textContent = entry.state === 'failed' ? 'Failed' : 'Uploading';
      tile.appendChild(state);
    }
    // A failure has to say why on the tile itself. The console line is the only
    // other place it appears, and it is not somewhere a user is looking.
    if (entry.state === 'failed' && entry.error) {
      tile.title = 'Upload failed: ' + entry.error;
      var reason = document.createElement('div');
      reason.className = 'gpie-reason';
      reason.textContent = entry.error;
      tile.appendChild(reason);
    }

    // The position is resolved when the button is pressed rather than captured
    // here, because a drag reorders the tiles without a re-render.
    tile.appendChild(button('×', 'Remove', function () {
      removeEntry(p, entry);
    }, 'gpie-del'));

    return tile;
  }

  // A thumbnail this file minted with createObjectURL pins the file's bytes
  // until it is revoked, and an entry dropped from the strip is the last
  // reference to it. An existing entry's thumbnail belongs to the page or to
  // §store, which revokes its own; only what was minted in addFile is released.
  function releaseEntry(entry) {
    if (!entry || entry.kind !== 'new' || !entry.thumb) return;
    if (String(entry.thumb).indexOf('blob:') !== 0) return;
    try {
      URL.revokeObjectURL(entry.thumb);
    } catch (e) {
      // A URL already revoked is not an error worth reporting.
    }
    entry.thumb = '';
  }

  function releaseEntries(entries) {
    (entries || []).forEach(releaseEntry);
  }

  function removeEntry(p, entry) {
    var index = p.entries.indexOf(entry);
    if (index === -1) return;
    p.entries.splice(index, 1);
    releaseEntry(entry);
    renderBar(p);
  }

  function resetEntries(p) {
    releaseEntries(p.entries);
    p.entries = p.originalThumbs.map(function (thumb, index) {
      return { kind: 'existing', index: index, thumb: thumb };
    });
    renderBar(p);
  }

  function pickFiles(p) {
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
    }
    fileInput.onchange = function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';
      files.forEach(function (file) { addFile(p, file); });
    };
    fileInput.click();
  }

  function imageFilesOf(dataTransfer) {
    var files = dataTransfer && dataTransfer.files
      ? Array.prototype.slice.call(dataTransfer.files)
      : [];
    return files.filter(function (file) {
      return file.type && file.type.indexOf('image/') === 0;
    });
  }

  // Gemini watches the document for dragged files and takes them into the
  // composer as a new message. A drag aimed at the add tile therefore has to be
  // claimed before it reaches those listeners, which means handling it here in
  // the capture phase rather than on the tile: stopping propagation from the
  // document would cut off the tile's own handlers as well. Registered while the
  // document is still parsing so this listener precedes the application's.
  function onDocumentDrag(ev) {
    var target = ev.target;
    var tile = target && target.closest ? target.closest('.gpie-add') : null;
    if (!tile || !plan) return;

    ev.preventDefault();
    ev.stopPropagation();

    if (ev.type === 'drop') {
      tile.classList.remove('gpie-drop');
      imageFilesOf(ev.dataTransfer).forEach(function (file) { addFile(plan, file); });
      return;
    }
    if (ev.type === 'dragleave') {
      tile.classList.remove('gpie-drop');
      return;
    }
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    tile.classList.add('gpie-drop');
  }

  function addFile(p, file) {
    var entry = {
      kind: 'new',
      thumb: URL.createObjectURL(file),
      attachment: null,
      bytes: file,
      name: file.name,
      state: 'uploading'
    };
    p.entries.push(entry);
    renderBar(p);
    // The existing images start becoming contribs now, so that by the time
    // Update is pressed the send can take the shape §shape aims for.
    freshenExisting(p);

    uploadFile(file).then(function (attachment) {
      entry.attachment = attachment;
      entry.state = 'ready';
    }).catch(function (err) {
      say('warn', LOG_IMG, 'upload failed:', err);
      entry.state = 'failed';
      entry.error = String((err && err.message) || err);
    }).then(function () {
      if (plan === p) renderBar(p);
    });
  }

  // §drag ====================================================================
  // Pointer events, not the HTML5 drag API: a dragstart raised inside the page
  // makes Gemini put up its own file-drop overlay, and that API has nothing to
  // offer touch input. The pointer is captured on the strip rather than on the
  // tile, because reinserting a tile to reorder it releases a capture the tile
  // itself holds.
  var drag = null;
  // A render asked for while a drag held the strip, to be made once it ends.
  var renderHeld = false;

  function tilesOf(strip) {
    return Array.prototype.slice.call(strip.querySelectorAll('.gpie-tile'));
  }

  function renumber(strip) {
    tilesOf(strip).forEach(function (tile, index) {
      var badge = tile.querySelector('.gpie-badge');
      if (badge) badge.textContent = String(index + 1);
    });
  }

  // Offset from the tile's own layout slot rather than from the grab point, so
  // the tile stays under the pointer across the reorders it triggers.
  function follow(x, y) {
    drag.tile.style.transform = '';
    var rect = drag.tile.getBoundingClientRect();
    drag.tile.style.transform = 'translate(' + (x - rect.left - drag.grabX) + 'px,'
      + (y - rect.top - drag.grabY) + 'px)';
  }

  // The first tile the pointer sits ahead of in reading order; null means the
  // end. Rows are compared before columns, so a wrapped strip stays in order.
  function dropAnchor(x, y) {
    var others = tilesOf(drag.strip).filter(function (tile) { return tile !== drag.tile; });
    for (var i = 0; i < others.length; i++) {
      var rect = others[i].getBoundingClientRect();
      if (y < rect.top || (y <= rect.bottom && x < rect.left + rect.width / 2)) return others[i];
    }
    return null;
  }

  function beginDrag(ev, ctx) {
    // One at a time. A second finger landing on another tile used to overwrite
    // the single slot, so the first tile stayed lifted with nothing to put it
    // back and the release of the second pointer reordered against the first
    // one's strip.
    if (drag) return;
    var rect = ctx.tile.getBoundingClientRect();
    drag = {
      plan: ctx.plan,
      strip: ctx.strip,
      tile: ctx.tile,
      tail: ctx.tail,
      pointerId: ev.pointerId,
      grabX: ev.clientX - rect.left,
      grabY: ev.clientY - rect.top,
      startX: ev.clientX,
      startY: ev.clientY,
      active: false
    };
    try {
      ctx.strip.setPointerCapture(ev.pointerId);
    } catch (e) {
      // Capture only serves to keep the drag alive past the strip's edges.
    }
  }

  function onDragMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      // A press that never travels is a click on the tile, not a drag.
      if (Math.abs(ev.clientX - drag.startX) < 4 && Math.abs(ev.clientY - drag.startY) < 4) return;
      drag.active = true;
      drag.tile.classList.add('gpie-dragging');
    }
    ev.preventDefault();
    var anchor = dropAnchor(ev.clientX, ev.clientY) || drag.tail;
    if (anchor !== drag.tile.nextSibling) {
      drag.strip.insertBefore(drag.tile, anchor);
      renumber(drag.strip);
    }
    follow(ev.clientX, ev.clientY);
  }

  function endDrag(ev) {
    if (!drag || (ev && ev.pointerId !== drag.pointerId)) return;
    var d = drag;
    drag = null;
    try {
      d.strip.releasePointerCapture(d.pointerId);
    } catch (e) {
      // Already released, which is the ordinary case on pointerup.
    }
    d.tile.style.transform = '';
    d.tile.classList.remove('gpie-dragging');
    if (!d.active) {
      if (renderHeld) {
        renderHeld = false;
        renderBar(d.plan);
      }
      return;
    }
    renderHeld = false;
    // The DOM holds the order the user just arranged; the entries follow it.
    d.plan.entries = tilesOf(d.strip).map(function (tile) { return tile.gpieEntry; });
    renderBar(d.plan);
  }

  // §bar =====================================================================
  function renderBar(p) {
    if (!toolbar) return;
    // An upload finishing mid-drag used to wipe the strip and with it the tile
    // under the finger: the pointer capture went with the node, the drag was
    // never ended, and the order the user was arranging was lost. The render is
    // held until the drag lets go.
    if (drag) {
      renderHeld = true;
      return;
    }
    syncSentinel(p);
    toolbar.textContent = '';

    var strip = document.createElement('div');
    strip.className = 'gpie-strip';
    p.entries.forEach(function (entry, index) {
      strip.appendChild(makeTile(p, entry, index));
    });

    var add = button('+', 'Add an image, by dropping a file here or by picking one', function () {
      pickFiles(p);
    }, 'gpie-add');
    strip.appendChild(add);

    if (planIsDirty(p)) {
      strip.appendChild(button('Reset', 'Restore the original attachments', function () {
        resetEntries(p);
      }, 'gpie-reset'));
    }

    strip.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      var tile = ev.target && ev.target.closest ? ev.target.closest('.gpie-tile') : null;
      if (!tile || !strip.contains(tile) || ev.target.closest('.gpie-del')) return;
      // Suppresses the native image drag and the selection the press would start.
      ev.preventDefault();
      ev.stopPropagation();
      beginDrag(ev, { plan: p, strip: strip, tile: tile, tail: add });
    });
    strip.addEventListener('pointermove', onDragMove);
    strip.addEventListener('pointerup', endDrag);
    strip.addEventListener('pointercancel', endDrag);
    strip.addEventListener('lostpointercapture', endDrag);

    toolbar.appendChild(strip);
  }

  function ensureBar(p) {
    // Connected is not enough: the toolbar of a message whose edit mode was
    // left open elsewhere on the page is also connected, and returning on it
    // left the new plan describing itself through the old message's strip.
    if (toolbar && toolbar.isConnected && toolbarPlan === p) return;
    if (toolbar) teardownEditorUi();

    toolbarPlan = p;
    toolbar = document.createElement('div');
    toolbar.className = 'gpie-bar';
    // Clicks inside the toolbar must not reach the editor behind it.
    toolbar.addEventListener('click', function (ev) { ev.stopPropagation(); });

    if (p.container && p.container.isConnected) {
      p.container.insertAdjacentElement('afterend', toolbar);
    } else {
      p.host.insertBefore(toolbar, p.host.firstChild);
    }
    renderBar(p);

    // The original carousel cannot show a deletion or a reorder, so it is hidden
    // and the strip above becomes the only view of what will be sent. Only the
    // inline style is touched; no node Angular owns is added or removed.
    if (p.container) {
      var carousel = p.container.querySelector('user-query-file-carousel');
      if (carousel) {
        carousel.style.display = 'none';
        hiddenCarousel = carousel;
      }
    }
  }

  // Leaving edit mode destroys neither of these: Gemini keeps the carousel node
  // that was hidden above, and the toolbar sits next to it rather than inside the
  // part of the tree that goes away. Both have to be undone by hand.
  function teardownEditorUi() {
    if (hiddenCarousel) {
      hiddenCarousel.style.display = '';
      hiddenCarousel = null;
    }
    if (toolbar && toolbar.parentNode) toolbar.parentNode.removeChild(toolbar);
    toolbar = null;
    toolbarPlan = null;
  }

