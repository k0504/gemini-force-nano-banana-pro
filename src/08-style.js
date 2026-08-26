  // §style ===================================================================
  var STYLE = [
    // Shrink to the thumbnails and hug the end of the column. The attachment
    // container is only as wide as its images while the message is read, but
    // spans the whole column in edit mode; a strip left where a block lands
    // would sit clear of the prompt bubble with a gap after the last control.
    '.gpie-bar{margin:6px 0 2px;margin-inline-start:auto;width:fit-content;',
    'max-width:100%;font:13px/1.45 system-ui,sans-serif}',
    '.gpie-strip{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.gpie-tile{position:relative;width:84px;height:84px;flex:0 0 auto;cursor:grab;',
    'touch-action:none;user-select:none;-webkit-user-select:none}',
    '.gpie-tile.gpie-dragging{cursor:grabbing;z-index:5;opacity:.9;',
    'filter:drop-shadow(0 4px 10px rgba(0,0,0,.45))}',
    '.gpie-thumb{width:100%;height:100%;object-fit:cover;border-radius:8px;display:block;',
    'pointer-events:none;-webkit-user-drag:none;background:rgba(128,128,128,.2);',
    'border:1px solid rgba(128,128,128,.3)}',
    // The library card's mark. A dot rather than a glyph: it sits over a
    // thumbnail whose colours are unknown, so it carries its own ring instead
    // of relying on contrast with whatever is behind it.
    '.gpie-origin-dot{position:absolute;top:6px;right:6px;width:9px;height:9px;',
    'border-radius:50%;background:#34a853;box-shadow:0 0 0 2px rgba(0,0,0,.45);',
    'pointer-events:none;z-index:3;}',
    // The sweep runs for half a minute against a page that shows nothing while
    // it does, and the menu command that starts it read as doing nothing at
    // all. This is where it says otherwise.
    // The armed retry reads as a warning until it is pressed again or the
    // window lapses; nothing else on the row changes colour.
    '.gpie-retry .gpie-armed,.gpie-retry button.gpie-armed{outline:2px solid #e5a50a;',
    'outline-offset:2px;border-radius:50%}',
    '.gpie-progress{position:fixed;right:16px;bottom:16px;z-index:2147483000;',
    'max-width:320px;padding:9px 13px;border-radius:10px;',
    'background:rgba(32,33,36,.94);color:#e8eaed;border:1px solid rgba(255,255,255,.14);',
    'font:13px/1.5 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);',
    'pointer-events:none;white-space:pre-line}',
    '.gpie-progress.gpie-done{background:rgba(24,74,42,.94);border-color:rgba(52,168,83,.5)}',
    '.gpie-badge{position:absolute;top:4px;left:4px;background:rgba(0,0,0,.7);color:#fff;',
    'border-radius:6px;padding:0 5px;font-size:11px;line-height:16px;pointer-events:none}',
    '.gpie-state{position:absolute;left:4px;right:4px;bottom:4px;text-align:center;',
    'background:rgba(0,0,0,.7);color:#fff;border-radius:6px;font-size:11px;line-height:16px;',
    'pointer-events:none}',
    '.gpie-del{position:absolute;top:3px;right:3px;width:20px;height:20px;padding:0;',
    'display:flex;align-items:center;justify-content:center;border-radius:50%;',
    'border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.72);color:#fff;',
    'font-size:14px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s}',
    '.gpie-tile:hover .gpie-del,.gpie-del:focus-visible{opacity:1}',
    '.gpie-del:hover{background:#d93025}',
    '.gpie-tile.gpie-dragging .gpie-del{opacity:0}',
    '@media (hover:none){.gpie-del{opacity:1}}',
    '.gpie-view .gpie-tile{cursor:zoom-in;padding:0;border:0;background:transparent;',
    'display:block;font:inherit;color:inherit}',
    '.gpie-view .gpie-tile:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}',
    '.gpie-reason{position:absolute;top:100%;left:0;margin-top:4px;width:220px;',
    'padding:4px 6px;border-radius:6px;background:#d93025;color:#fff;font-size:11px;',
    'line-height:1.35;z-index:6;pointer-events:none}',
    '.gpie-add{width:84px;height:84px;flex:0 0 auto;border-radius:8px;',
    'border:1px dashed rgba(128,128,128,.55);background:transparent;color:inherit;',
    'font-size:24px;line-height:1;opacity:.65;cursor:pointer;display:flex;',
    'align-items:center;justify-content:center}',
    '.gpie-add:hover{opacity:1;background:rgba(128,128,128,.12)}',
    '.gpie-add.gpie-drop{opacity:1;border-style:solid;border-color:#1a73e8;',
    'background:rgba(26,115,232,.18)}',
    '.gpie-reset{flex:0 0 auto;height:84px;box-sizing:border-box;padding:0 14px;',
    'font-size:12px;cursor:pointer;border-radius:8px;',
    'border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}',
    '.gpie-reset:hover{background:rgba(128,128,128,.2)}',
    // The usage line stands in for Gemini's own disclaimer. Hiding that one is
    // keyed off ours being present, so a page the usage read never reached
    // keeps its original text and dropping ours restores it with nothing to
    // undo. Two classes and two types outrank .gds-body-s.desktop-spacing,
    // which is where the line gets its type from.
    'div.capabilities-disclaimer:has(>p.gpie-usage)>p:not(.gpie-usage){display:none}',
    // The line itself is not a control: the numbers on it are worth selecting
    // and copying, and the refresh button is where the click belongs.
    'div.capabilities-disclaimer>p.gpie-usage{cursor:default}',
    '.gpie-usage-refresh{display:inline-flex;align-items:center;justify-content:center;',
    'width:20px;height:20px;padding:0;margin-inline-start:2px;vertical-align:middle;',
    'border:0;border-radius:50%;background:transparent;color:inherit;opacity:.55;',
    'cursor:pointer}',
    '.gpie-usage-refresh:hover{opacity:1;background:rgba(128,128,128,.18)}',
    '.gpie-usage-refresh:focus-visible{outline:2px solid #1a73e8;outline-offset:1px}',
    '.gpie-usage-refresh>svg{width:14px;height:14px;display:block}',
    '.gpie-usage-refresh.gpie-usage-busy{opacity:1}',
    '.gpie-usage-refresh.gpie-usage-busy>svg{animation:gpie-spin .7s linear infinite}',
    '@keyframes gpie-spin{to{transform:rotate(360deg)}}',
    // Inline-block parts centred by the strip's own text-align, rather than a
    // flex row, so the line does not have to win a display declaration off
    // Gemini's own rule for that paragraph.
    '.gpie-usage-part{display:inline-block;white-space:nowrap;margin:0 14px}',
    '.gpie-usage-stale{opacity:.55}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('gpie-style')) return;
    var style = document.createElement('style');
    style.id = 'gpie-style';
    // Lets a live page report which build it is running, which a userscript
    // manager holding a stale installed copy otherwise makes unanswerable.
    style.setAttribute('data-version', VERSION);
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

