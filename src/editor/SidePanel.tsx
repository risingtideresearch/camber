import "./SidePanel.css";

// The section-template editor: the tab strip and the per-template editors are built imperatively by
// `render.ts` into the empty `#sideTabs` / `#templateCards` containers; the keel-knuckle slider is
// driven by `interaction.ts` (`refreshKeelUI()` + the `#keelRange` input listener). All static here —
// React owns only the surrounding card structure and leaves these containers' contents alone.
export function SidePanel() {
  return (
    <div className="card sidecard">
      <div className="tabstrip" id="sideTabs" />
      <div className="sidefit">
        <div className="sidepanel">
          <div id="templateCards" />
        </div>
      </div>
      <div className="keelrow">
        <label
          className="ctl"
          id="keelCtl"
          title="Keel knuckle for the active template — 0 = smooth (C¹ across the centerline), 1 = a hard V"
        >
          Keel
          <input type="range" id="keelRange" min="0" max="1" step="0.01" />
          <span className="ctlval" id="keelVal">
            —
          </span>
        </label>
      </div>
    </div>
  );
}
