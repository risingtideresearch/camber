// ---------- the editor scaffold ----------
//
// The DOM the camber editor wires itself onto, mirroring the `.app` markup in the repo's `index.html`.
// The tool injects this into its scoped container, then `startEditor()` resolves these nodes by id. Kept
// in sync with `index.html` by hand (the standalone page is intentionally left untouched).

export const SCAFFOLD_HTML = `
<div class="app">
  <div class="appbar">
    <div class="toolbar" id="toolbar">
      <button class="tool active" data-tool="select" title="Select — click a point to select it, then drag to move, Delete to remove, or set its knuckle">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 1.4l9.6 5.3-4.3.9-1 4.4z"/></svg>Select</button>
      <button class="tool" data-tool="add" title="Add — click empty space in an editor to add a control point there">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>Add</button>
    </div>
    <div class="selinfo" id="selinfo">
      <span class="sel-label muted" id="selLabel">No point selected</span>
      <label class="sel-knuckle" id="selKnuckleWrap">Knuckle
        <input type="range" id="selKnuckle" min="0" max="1" step="0.01" title="0 = smooth · 1 = hard corner">
      </label>
      <button id="selDelete" title="Delete the selected point (Delete / Backspace)">Delete</button>
    </div>
    <span class="tabsep"></span>
    <label class="ctl" title="Design waterline — depth below the sheer origin (deck datum)">WL
      <input type="range" id="wlRange" min="0" max="1400" step="10">
      <span class="ctlval" id="wlVal"></span></label>
    <label class="ctl" title="Deck rake — bow-up trim angle; rotates the whole hull about the sheer origin">Rake
      <input type="range" id="rakeRange" min="-12" max="12" step="0.5">
      <span class="ctlval" id="rakeVal"></span></label>
    <div class="toolacts">
      <button id="reset">Reset</button>
      <button id="importJson" title="Load a hull model from a JSON file (replaces the current model)">Import JSON</button>
      <button id="exportStep" title="Export the hull surfaces as a STEP (ISO 10303) file">Export STEP</button>
      <button id="exportJson" title="Export the editable hull model (sheer, transom, templates, weight curve) as JSON">Export JSON</button>
    </div>
  </div>
  <div class="main">
    <div class="leftcol">
      <div class="top3d">
        <canvas id="cv3d"></canvas>
        <div class="view3dctl">
          <button id="toggleZebra">Zebra</button>
          <button id="toggle3d">Untrimmed sheet</button>
        </div>
      </div>
      <div class="viewstrip"><svg id="svgPlan" viewBox="0 0 1000 278" preserveAspectRatio="xMidYMid meet"></svg></div>
      <div class="viewstrip"><svg id="svgProfile" viewBox="0 0 1000 422.4" preserveAspectRatio="xMidYMid meet"></svg></div>
    </div>
    <div class="rightcol">
      <div class="card sidecard">
        <div class="tabstrip" id="sideTabs"></div>
        <div class="sidefit">
          <div class="sidepanel">
            <div id="templateCards"></div>
            <svg id="svgCut" viewBox="0 0 360 360"></svg>
            <svg id="svgBody" viewBox="0 0 360 360"></svg>
          </div>
        </div>
        <div class="keelrow">
          <label class="ctl" id="keelCtl" title="Keel knuckle for the active template — 0 = smooth (C¹ across the centerline), 1 = a hard V">Keel
            <input type="range" id="keelRange" min="0" max="1" step="0.01">
            <span class="ctlval" id="keelVal">—</span></label>
        </div>
      </div>
      <div class="card blendcard">
        <div class="cap">Blend
          <span class="cap-right">
            <button id="addBlendBtn" title="Add a blend control point midway in the widest gap">+ blend point</button>
            <span class="val" id="profVal">—</span>
          </span>
        </div>
        <div class="blendfit">
          <svg id="svgWeights" viewBox="0 0 300 470" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
      </div>
    </div>
  </div>
</div>
`;
