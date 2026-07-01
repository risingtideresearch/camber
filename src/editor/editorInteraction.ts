import {
  setTool,
  getDrag,
  setDrag,
  getVB,
  moveSheer,
  moveTrim,
  moveTransom,
  moveWeight,
  deleteSelected,
  setSelectedKnuckle,
  setActiveKeel,
  vbCoords,
  select,
  clearSelection,
  addSheerPoint,
  addTrimPoint,
  addWeightPoint,
  refreshSelUI,
  refreshKeelUI,
} from "../core/interaction";
import { clamp } from "../core/math";
import { state, L, NMIN, NMAX, DMAX, type ActiveTarget } from "../core/model";
import { invX, invN, invD, invY, invZp } from "../core/view";
import { draw3d, render } from "../core/render";
import { svgL, svgP, svgW } from "./dom";

// ---------- wire up the global / per-svg pointer listeners (called once at startup) ----------

export function initInteraction(): void {
  const toolbar = document.getElementById("toolbar")!;
  toolbar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tool");
    if (b) setTool(b.dataset.tool as typeof state.tool);
  });

  const cv3d = document.getElementById("cv3d") as HTMLCanvasElement;
  cv3d.addEventListener("pointerdown", (e) => {
    setDrag({
      kind: "rot",
      px0: e.clientX,
      py0: e.clientY,
      yaw0: state.rot.yaw,
      pitch0: state.rot.pitch,
    });
    e.preventDefault();
  });
  // scroll-wheel zoom (smooth, multiplicative); the lines overlay is pointer-events:none so this still fires
  cv3d.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0015), 0.3, 8);
      draw3d(false);
    },
    { passive: false },
  );

  window.addEventListener("pointermove", (e) => {
    const drag = getDrag();
    if (!drag) return;
    if (drag.kind === "rot") {
      state.rot.yaw = drag.yaw0! + (e.clientX - drag.px0!) * 0.008;
      state.rot.pitch = clamp(
        drag.pitch0! + (e.clientY - drag.py0!) * 0.008,
        -1.45,
        1.45,
      );
      draw3d(false); // rotation only redraws GL (mesh is cached)
      return;
    }
    const [vx, vy] = getVB(drag, e);
    if (drag.kind === "slider") {
      // the cut scrubs along x — horizontal in all three strips (plan, profile, blend)
      state.x0 = clamp(invX(vx), 0, L);
    } else if (drag.kind === "sheer") moveSheer(drag, vx, vy);
    else if (drag.kind === "trim") moveTrim(drag, vx, vy);
    else if (drag.kind === "transom") moveTransom(drag, vx, vy);
    else if (drag.kind === "weight") moveWeight(drag, vy);
    else if (drag.kind === "stn") {
      const arr = state.templates[drag.ti!],
        i = drag.idx!,
        cp = arr[i];
      cp.n = clamp(invN(vx), NMIN, NMAX); // negative = outboard of the sheer (tumblehome)
      const lo = arr[i - 1].d,
        hi = i < arr.length - 1 ? arr[i + 1].d : DMAX; // keep d descending so the section never curls up
      cp.d = clamp(invD(vy), lo, hi);
    }
    render();
  });
  window.addEventListener("pointerup", () => {
    setDrag(null); // selection persists after a drag, so the point stays highlighted and editable
  });

  // delete the selected point with Delete/Backspace (unless typing in the knuckle slider)
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (state.selected) {
      e.preventDefault();
      deleteSelected();
    }
  });
  document
    .getElementById("selDelete")!
    .addEventListener("click", deleteSelected);
  document
    .getElementById("selKnuckle")!
    .addEventListener("input", (e) =>
      setSelectedKnuckle(parseFloat((e.target as HTMLInputElement).value)),
    );
  document
    .getElementById("keelRange")!
    .addEventListener("input", (e) =>
      setActiveKeel(parseFloat((e.target as HTMLInputElement).value)),
    );

  // editor backgrounds: in "add" mode click empty space to add a point there (then back to select, with
  // the new point selected); in "select" mode an empty click clears the selection.
  const onBg = (
    svg: SVGSVGElement,
    add: (vx: number, vy: number) => { tgt: ActiveTarget; idx: number },
  ): void => {
    svg.addEventListener("pointerdown", (e) => {
      if (state.tool === "add") {
        const [vx, vy] = vbCoords(svg, e),
          { tgt, idx } = add(vx, vy);
        setTool("select");
        select(tgt, idx); // select() re-renders with the new point highlighted
      } else {
        clearSelection();
      }
    });
  };
  onBg(svgL, (vx, vy) => ({
    tgt: "plan",
    idx: addSheerPoint(invX(vx), invY(vy)),
  }));
  onBg(svgP, (vx, vy) => ({
    tgt: "trim",
    idx: addTrimPoint(invX(vx), invZp(vy)),
  }));
  // the weight editor (persistent element): add a blend control point at the clicked x
  svgW.addEventListener("pointerdown", (e) => {
    if (state.tool === "add") {
      const [vx] = vbCoords(svgW, e),
        idx = addWeightPoint(invX(vx));
      setTool("select");
      select("weight", idx);
    } else {
      clearSelection();
    }
  });

  refreshSelUI();
  refreshKeelUI();
}
