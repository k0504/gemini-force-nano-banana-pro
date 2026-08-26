  // §pro =====================================================================
  function applyProMarker(inner) {
    var tuple = inner[PROMPT_TUPLE];
    dbg('applyProMarker: before =', JSON.stringify(tuple[MODEL_MARKER]));
    while (tuple.length <= MODEL_MARKER) tuple.push(null);
    tuple[MODEL_MARKER] = PRO_MARKER;
    dbg('applyProMarker: wrote', JSON.stringify(PRO_MARKER));
    return true;
  }

