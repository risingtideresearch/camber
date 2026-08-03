import type { Model } from "../core/model";
import { stationColor } from "../core/colors";

// The tab strip over the per-station editors: one tab per station (its accent color; the active one carries
// a ✕ to remove it), then a "+" to add a station (disabled at the palette cap of 7). Tabs are ordered by the
// stations' own position along the hull, so "S1" is always the aftmost.
interface SideTabsProps {
  model: Model;
  activeTab: number;
  onSelectTab: (t: number) => void;
  onAddStation: () => void;
  onRemoveStation: (si: number) => void;
}

export function SideTabs({
  model,
  activeTab,
  onSelectTab,
  onAddStation,
  onRemoveStation,
}: SideTabsProps) {
  const K = model.stations.length;
  return (
    <div className="tabstrip">
      {model.stations.map((st, j) => {
        const active = activeTab === j;
        return (
          <button
            key={j}
            className={"tab tpltab" + (active ? " active" : "")}
            style={{ ["--tab" as string]: stationColor(j) }}
            title={`Station ${j + 1} — at u = ${st.u.toFixed(3)} along the sheer plan`}
            onClick={() => onSelectTab(j)}
          >
            <span>{`S${j + 1}`}</span>
            {active && K > 1 && (
              <span
                className="tabx"
                title="Remove this station"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveStation(j);
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
        title="Add a station at the cut. Its section is read off the hull there, so the shape doesn't change — it just gains a handle. Drag its line along the sheer plan to move it."
        disabled={K >= 7}
        onClick={onAddStation}
      >
        +
      </button>
    </div>
  );
}
