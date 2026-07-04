import type { Model } from "../core/model";
import { tplColor } from "../core/colors";

// The tab strip over the per-template editors: one tab per template (its accent color; the active one carries
// a ✕ to remove it), then a "+" to add a template (disabled at the palette cap of 7).
interface SideTabsProps {
  model: Model;
  activeTab: number;
  onSelectTab: (t: number) => void;
  onAddTemplate: () => void;
  onRemoveTemplate: (ti: number) => void;
}

export function SideTabs({
  model,
  activeTab,
  onSelectTab,
  onAddTemplate,
  onRemoveTemplate,
}: SideTabsProps) {
  const K = model.templates.length;
  return (
    <div className="tabstrip" id="sideTabs">
      {model.templates.map((_, j) => {
        const active = activeTab === j;
        return (
          <button
            key={j}
            className={"tab tpltab" + (active ? " active" : "")}
            style={{ ["--tab" as string]: tplColor(j) }}
            onClick={() => onSelectTab(j)}
          >
            <span>{`T${j + 1}`}</span>
            {active && K > 1 && (
              <span
                className="tabx"
                title="Remove this template"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveTemplate(j);
                }}
              >
                ✕
              </span>
            )}
          </button>
        );
      })}
      <button
        className="tab tabadd"
        title="Add a section template (enters the blend at zero weight; raise it in the blend editor)"
        disabled={K >= 7}
        onClick={onAddTemplate}
      >
        +
      </button>
    </div>
  );
}
