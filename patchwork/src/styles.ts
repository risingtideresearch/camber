// ---------- scoped editor styles ----------
//
// The standalone editor's CSS (from `index.html`) namespaced under `.camber-app` so it styles only the
// tool's own subtree and never leaks onto the Patchwork host. The palette custom properties live on
// `.camber-app` (the tool passes that element to `startEditor` as the palette root), and the page-level
// `:root` / `html,body` rules are replaced by sizing on `.camber-app` itself.

export const CAMBER_CSS = `
.camber-app{
  --sheer:#dd6b20; --keel:#0f766e; --aft:#2b6cb0; --fore:#7c3aed; --station:#94a3b8;
  --wl:#0ea5e9; --bt:#64748b; --deck:#cbd5e1; --transom:#b45309;
  --ink:#1a202c; --mut:#718096; --bg:#f7fafc; --panel:#ffffff; --line:#e2e8f0;
  --slider:#e11d48;
  height:100%; width:100%; overflow:hidden;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  color:var(--ink); background:var(--bg);
}
.camber-app *{box-sizing:border-box}
.camber-app .app{display:flex;flex-direction:column;height:100%;overflow:hidden;
     user-select:none;-webkit-user-select:none;}
.camber-app .main{display:flex;gap:14px;flex:1 1 0;min-height:0;padding:14px 24px;justify-content:center;}
.camber-app .leftcol{flex:1 1 0;min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px;}
.camber-app .top3d{position:relative;flex:1 1 0;min-height:140px;border:1px solid var(--line);border-radius:10px;
       overflow:hidden;background:linear-gradient(#eef3f8,#d7e0ea);}
.camber-app .view3dctl{position:absolute;top:10px;right:14px;display:flex;gap:8px;z-index:1;}
.camber-app .viewstrip{flex:0 0 auto;width:100%;border:1px solid var(--line);border-radius:10px;background:var(--panel);
           overflow:hidden;}
.camber-app .viewstrip svg{display:block;width:100%;height:auto;}
.camber-app .rightcol{flex:0 0 auto;min-height:0;display:flex;flex-direction:column;gap:10px;}
.camber-app .sidecard{flex:0 0 auto;display:flex;flex-direction:column;}
.camber-app .sidefit{flex:0 0 auto;min-height:0;display:flex;align-items:center;justify-content:center;}
.camber-app .sidepanel{position:relative;width:100%;aspect-ratio:1;}
.camber-app .keelrow{flex:0 0 auto;margin-top:8px;}
.camber-app .keelrow .ctl{display:flex;align-items:center;gap:8px;width:100%;}
.camber-app .keelrow .ctl input[type=range]{flex:1;width:auto;}
.camber-app .keelrow .ctl.disabled{opacity:.4;}
.camber-app .sidepanel > #templateCards{position:absolute;inset:0;}
.camber-app .sidepanel > svg{position:absolute;inset:0;}
.camber-app .sidepanel svg{width:100%;height:100%;display:block;}
.camber-app .blendcard{flex:1 1 0;min-height:0;display:flex;flex-direction:column;}
.camber-app .blendcard .cap{margin-bottom:8px;}
.camber-app .cap .cap-right{display:flex;align-items:center;gap:10px;}
.camber-app .cap .cap-right .val{white-space:nowrap;}
.camber-app .cap .cap-right button{padding:3px 9px;font-size:12px;}
.camber-app .blendfit{flex:1 1 0;min-height:0;position:relative;}
.camber-app .blendfit svg{position:absolute;inset:0;width:100%;height:100%;display:block;}
.camber-app .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;}
.camber-app .tabstrip{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px;}
.camber-app .tab{border:1px solid var(--line);background:#fff;border-radius:7px;padding:4px 11px;font:inherit;font-size:12px;
     color:#4a5568;cursor:pointer;display:inline-flex;align-items:center;gap:6px;line-height:1.4;}
.camber-app .tab:hover{background:#f1f5f9;}
.camber-app .tab.tpltab{color:var(--tab);font-weight:600;}
.camber-app .tab.active{background:var(--tab,var(--ink));border-color:var(--tab,var(--ink));color:#fff;}
.camber-app .tab .tabx{font-size:10px;opacity:.85;}
.camber-app .tab .tabx:hover{opacity:1;}
.camber-app .tab.tabadd{font-weight:700;color:var(--mut);padding:4px 9px;}
.camber-app .tab.tabadd:disabled{opacity:.4;cursor:not-allowed;}
.camber-app .tabsep{width:1px;align-self:stretch;background:var(--line);margin:2px 3px;}
.camber-app .appbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
        padding:10px 20px;border-bottom:1px solid var(--line);background:var(--panel);}
.camber-app .appbar button{padding:6px 10px;}
.camber-app .appbar .selinfo{gap:8px;}
.camber-app .appbar .sel-label{min-width:92px;}
.camber-app .appbar .sel-knuckle{flex:0 0 auto;min-width:120px;}
.camber-app .appbar .sel-knuckle input{flex:0 0 66px;width:66px;}
.camber-app .appbar .ctl input[type=range]{width:84px;}
.camber-app .toolacts{display:flex;gap:8px;margin-left:auto;}
.camber-app .cap{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 8px;
     display:flex;justify-content:space-between;align-items:baseline;}
.camber-app .cap .val{text-transform:none;letter-spacing:0;font-weight:600;color:var(--ink);font-size:13px;}
.camber-app .cap .tag{text-transform:none;letter-spacing:0;font-weight:700;font-size:12px;padding:1px 8px;border-radius:10px;color:#fff;}
.camber-app svg{display:block;width:100%;height:auto;touch-action:none;}
.camber-app #cv3d{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab;background:transparent;}
.camber-app button.on{background:var(--ink);color:#fff;border-color:var(--ink);}
.camber-app button.on:hover{background:var(--ink);}
.camber-app .hint{font-size:12px;color:var(--mut);margin-top:8px;}
.camber-app button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 12px;font:inherit;
       cursor:pointer;color:#4a5568;}
.camber-app button:hover{background:#f1f5f9;}
.camber-app .barrow{display:flex;gap:10px;align-items:center;margin-bottom:4px;flex-wrap:wrap;}
.camber-app .toolbar{display:inline-flex;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;}
.camber-app .toolbar .tool{display:inline-flex;align-items:center;gap:6px;border:0;border-left:1px solid var(--line);
               border-radius:0;padding:6px 12px;}
.camber-app .toolbar .tool:first-child{border-left:0;}
.camber-app .toolbar .tool svg{width:14px;height:14px;display:block;}
.camber-app .toolbar .tool.active{background:var(--ink);color:#fff;}
.camber-app .toolbar .tool.active:hover{background:var(--ink);}
.camber-app .selinfo{display:flex;gap:8px;align-items:center;}
.camber-app .selinfo .sel-label{font-weight:600;color:var(--ink);font-size:13px;}
.camber-app .selinfo .sel-label.muted{color:var(--mut);font-weight:400;}
.camber-app .selinfo .sel-knuckle{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--mut);}
.camber-app .selinfo .sel-knuckle input{flex:1;width:auto;vertical-align:middle;}
.camber-app .selinfo .sel-knuckle:has(input:disabled){opacity:.45;}
.camber-app #selDelete{align-self:flex-start;}
.camber-app #selDelete:disabled,.camber-app #selKnuckle:disabled{opacity:.4;cursor:not-allowed;}
.camber-app .ctl{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--mut);}
.camber-app .ctl input[type=range]{width:92px;vertical-align:middle;}
.camber-app .ctl .ctlval{font-weight:600;color:var(--ink);min-width:38px;}
`;
