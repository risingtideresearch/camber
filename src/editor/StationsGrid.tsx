import { useCallback, type RefObject } from "react";
import { NumberInput } from "polymorph-ui";
import { stationColor } from "../core/colors";
import { rejected } from "../core/commands";
import { drawStation } from "../core/draw2d";
import { STH, STW, viewOf } from "../core/view";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import { SvgView } from "./SvgView";
import { useSvgViewSync, type SvgViewSync } from "./svgViewSync";
import "./StationView.css";
import "./StationsGrid.css";

// Every station at once, laid out in a row — the tabbed section editor's other reading. The tabs make one
// station big and the rest invisible; this makes them all visible at once and asks them to be compared, which
// is what "is the run between S2 and S3 fair?" actually needs.
//
// The columns share ONE zoom / pan controller, y included (`linkY`), so they are drawn at the same scale
// about the same origin: a section that looks fuller than its neighbour here is fuller, not just nearer. Zoom
// or pan any column and they all follow.
//
// Everything else is the station editor's behaviour per column, with the station index no longer implicit:
// a control point drags (window-level, see editorUi), the "add" tool inserts into the column clicked, and the
// position / keel controls under each square edit that station.
export function StationsGrid() {
  const model = useDocumentRuntime();
  const sync = useSvgViewSync(true);
  return (
    <div className="stationsgrid">
      {model.stations.map((_, si) => (
        <StationColumn key={si} si={si} sync={sync} />
      ))}
    </div>
  );
}

function StationColumn({
  si,
  sync,
}: {
  readonly si: number;
  readonly sync: RefObject<SvgViewSync>;
}) {
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const { selection, setSelection, tool, setTool, curvature, knotLongs } =
    useEditorUi();
  const station = model.stations[si];

  const draw = useCallback(
    (g: SVGGElement, sx: number, sy: number) => {
      drawStation(
        model,
        selection,
        g,
        si,
        setSelection,
        [sx, sy],
        curvature,
        knotLongs,
      );
    },
    [model, selection, si, setSelection, curvature, knotLongs],
  );

  const onBackgroundClick = async (vx: number, vy: number) => {
    if (tool !== "add") {
      setSelection(null);
      return;
    }
    const v = viewOf(model);
    const out = await dispatch({
      type: "addStationPoint",
      si,
      n: v.invN(vx),
      z: v.invZ(vy),
    });
    setTool("select");
    if (rejected(out)) return;
    setSelection({ tgt: "station", idx: out.result as number, si });
  };

  // Rounded like the tabbed editor's field: dragging the station's handle in the plan view leaves a
  // full-precision float, and 3 decimals is already finer than the 0.02 minimum spacing.
  const u = Math.round(station.u * 1000) / 1000;

  return (
    <div
      className="card stationcol"
      style={{ ["--tab" as string]: stationColor(si) }}
    >
      <div className="stationcolhead">
        <span className="stationcolname">{`S${si + 1}`}</span>
      </div>
      <div className="stationbody">
        <SvgView
          contentWidth={STW}
          contentHeight={STH}
          draw={draw}
          sync={sync}
          cursor={tool === "add" ? "crosshair" : "default"}
          onBackgroundClick={(vx, vy) => void onBackgroundClick(vx, vy)}
        />
      </div>
      <div
        className="keelrow urow"
        title="Where this station sits along the sheer plan, in the plan's own parameter u — 0 at the transom, 1 at the stem. Type a value or drag across the field; the station stops 0.02 short of its neighbours."
      >
        <span>Position</span>
        <NumberInput
          label="u"
          value={u}
          onChange={(next: number) =>
            void dispatch({ type: "moveStationU", idx: si, u: next })
          }
          min={0}
          max={1}
        />
      </div>
      <div className="keelrow">
        <label
          className="ctl"
          title="Keel knuckle for this station — 0 = smooth (C¹ across the centerline), 1 = a hard V."
        >
          Keel
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={station.keelK}
            onChange={(e) =>
              void dispatch({
                type: "setKeelK",
                si,
                k: parseFloat(e.target.value),
              })
            }
          />
          <span className="ctlval">{station.keelK.toFixed(2)}</span>
        </label>
      </div>
    </div>
  );
}
