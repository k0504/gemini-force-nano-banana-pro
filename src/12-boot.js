  // §lifecycle ===============================================================
  // The application routes without reloading, so the pathname changing is the
  // only sign a different page is on screen. Read from the scan pass rather
  // than from history: a route change rebuilds the view, so a pass is already
  // on its way, and nothing of the page's own has to be wrapped.
  var lastPath = location.pathname;
  function watchRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    // Everything a conversation owns is read here rather than at document
    // start, where the pathname is /app and belongs to no conversation at all.
    // The prune is chained rather than fired alongside so it sees the records
    // this restore has just claimed, and it is what keeps a session that never
    // reloads from growing the store without bound: persistOverrides writes on
    // every send, and nothing else checks the budget.
    restoreOverrides().then(pruneStore);
    if (lastPath.indexOf('/library') !== 0) return;
    // Behind the page's own listing, which is what keeps the replayed template
    // current. Shorter than the wait at boot: by now a template is held - the
    // library page issues a listing whenever it opens, and it is persisted -
    // so this waits on the request being current, not on there being one.
    setTimeout(indexLibrary, 1500);
  }

  function scan() {
    watchRoute();
    // Ahead of the editor's own gate: the usage line is not part of that
    // feature and is drawn whether or not it is switched on.
    ensureUsageLine();
    // The library mark belongs to neither feature's gate: it reports what this
    // script knows about an image, on a page where no editing happens.
    markLibraryCards();
    markConversationImages();
    if (!imageEditor) {
      discardPlan();
      removeRetryButtons();
      return;
    }
    var host = document.querySelector('div.user-query-container.edit-mode');
    // Not while a message is open for editing. The retry rewrites the message
    // it is pressed on, which is what edit mode is already doing by hand, and
    // the clone sits in the row the page's own controls are in - close enough
    // to the editor's own toolbar for a stray press to throw the edit away.
    // The button is put back by the pass that follows the edit closing.
    if (host) removeRetryButtons(); else ensureRetryButtons();
    if (!host) {
      teardownEditorUi();
      syncOverrides();
      // Update tears the editor down in the same tick it fires the request, so
      // the plan is armed rather than dropped and expires on its own.
      if (plan && plan.armedAt === null) plan.armedAt = Date.now();
      return;
    }
    if (!plan || plan.host !== host) {
      plan = makePlan(host);
      if (plan.originalCount === 0 && !plan.container) {
        // Nothing to edit and no anchor to hang the toolbar on.
        plan = null;
        return;
      }
    }
    plan.armedAt = null;
    syncOverrides();
    ensureBar(plan);
  }

  // Gemini writes the model it actually used into this node. Logging it turns
  // "did the injection work" into an observation instead of a guess.
  function logModelLines() {
    var nodes = document.querySelectorAll('[data-test-id="model-line"]:not([data-nbpro-seen])');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('data-nbpro-seen', '1');
      say('log', LOG_PRO, 'model-line:', (nodes[i].textContent || '').trim().replace(/\s+/g, ' '));
    }
  }

  // A timer rather than an animation frame: a background tab never paints, so a
  // requestAnimationFrame callback would sit unfired and hold the guard flag,
  // stalling every later mutation until the tab is looked at again.
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      try {
        var t0 = performance.now();
        logModelLines();
        scan();
        var cost = performance.now() - t0;
        // Logging every pass would flood the console; a pass this slow is the
        // only kind worth seeing.
        if (cost > 8) dbg('scan pass took', cost.toFixed(1) + 'ms');
      } catch (e) {
        say('warn', LOG_IMG, 'scan failed:', e);
      }
    }, 0);
  }

  // §boot ====================================================================
  function start() {
    injectStyle();
    installLibraryHook();
    loadOrigins();
    // After the page has issued a listing of its own: the replay borrows that
    // request as its template, and there is none to borrow at document start.
    setTimeout(indexLibrary, 4000);
    startUsageWatch();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    // Cancel throws the edit away, so the plan goes with it.
    document.addEventListener('click', function (ev) {
      var target = ev.target;
      if (target && target.closest && target.closest('gem-button.cancel-button')) discardPlan();
    }, true);
    schedule();
  }

  renderMenu();
  // The same pair watchRoute runs, for the one case it cannot see: a document
  // opened straight onto a conversation, where no pathname change follows.
  restoreOverrides().then(pruneStore);

  // Ahead of the application's own listeners, which is the point.
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (type) {
    document.addEventListener(type, onDocumentDrag, true);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
