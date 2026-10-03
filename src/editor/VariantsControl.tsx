import { useMemo, useState } from "react";
import { Button } from "../components/Button";
import { ButtonGroup } from "../components/ButtonGroup";
import { Dropdown } from "../components/Dropdown";
import type { HullState } from "../core/hull";
import { buildPreviewSvg } from "../core/preview";
import { createHullCodec, sampleAround } from "../core/reparam";
import { assemble } from "../core/runtime";
import { seededRandom } from "../core/sheet/generateTrials";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import "./VariantsControl.css";

// The app-bar "Variants" control: a popover of six random neighbours of the current design, drawn in the
// ratio coordinates of `core/reparam.ts` around the design's own θ, each shown as the same 3/4 wireframe the
// library's cards use. Clicking one installs it — an ordinary `installHull`, so it lands in the history and
// Undo takes it back — and the panel then re-centres on the adopted hull, so a run of picks is a walk.
//
// The spread is the temperature of the step: Subtle keeps the character and nudges proportions, Bold ranges
// to a noticeably different boat. Whatever the spread, a variant keeps the design's length and never lets a
// station's keel reach fall below the original's (see `sampleAround`), so a closed bottom stays closed.
//
// Nothing is swept while the panel is closed: the six previews are built only on open, on a new set, on a
// change of spread, or after the hull itself changes under an open panel.
const SPREADS = [
  { label: "Subtle", T: 0.25, title: "Small nudges to proportions and curves" },
  { label: "Medium", T: 0.5, title: "Clearly different, same kind of boat" },
  { label: "Bold", T: 1, title: "Ranges to a different boat" },
];
const COUNT = 6;

interface Variant {
  hull: HullState;
  svg: string;
}

export function VariantsControl() {
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const { setSelection } = useEditorUi();
  const [open, setOpen] = useState(false);
  const [spread, setSpread] = useState(1);
  const [set, setSet] = useState(1);

  const variants = useMemo((): Variant[] => {
    if (!open) return [];
    const codec = createHullCodec(model),
      theta0 = codec.encode(model),
      rng = seededRandom(set),
      T = SPREADS[spread].T;
    const out: Variant[] = [];
    for (let i = 0; i < COUNT; i++) {
      // the codec names nothing; a variant is still this design
      const hull: HullState = {
        ...codec.decode(sampleAround(codec, theta0, rng, T)),
        name: model.name,
      };
      out.push({ hull, svg: buildPreviewSvg(assemble(hull)) });
    }
    return out;
  }, [open, model, set, spread]);

  const adopt = (hull: HullState): void => {
    setSelection(null);
    void dispatch({ type: "installHull", state: hull });
  };

  return (
    <Dropdown
      label="Variants"
      title="Random variants of this design — click one to adopt it (Undo takes it back)"
      menuLabel="Variants"
      open={open}
      onOpenChange={setOpen}
      className="variantsctl"
    >
      <div className="dd-row variantsbar">
        <ButtonGroup className="variantspread" aria-label="Spread">
          {SPREADS.map((s, i) => (
            <Button
              key={s.label}
              active={i === spread}
              title={s.title}
              onClick={() => setSpread(i)}
            >
              {s.label}
            </Button>
          ))}
        </ButtonGroup>
        <Button
          title="Draw six more at this spread"
          onClick={() => setSet((n) => n + 1)}
        >
          More
        </Button>
      </div>
      <div className="variantgrid">
        {variants.map((v, i) => (
          <button
            key={i}
            type="button"
            className="variant"
            title="Adopt this variant"
            onClick={() => adopt(v.hull)}
          >
            {v.svg ? (
              <img
                alt={`Variant ${i + 1}`}
                src={"data:image/svg+xml;utf8," + encodeURIComponent(v.svg)}
              />
            ) : (
              <span className="variantnone">no hull</span>
            )}
          </button>
        ))}
      </div>
      <div className="variantshint">
        Neighbours of the current design, same length. Pick one and the set
        re-centres on it.
      </div>
    </Dropdown>
  );
}
