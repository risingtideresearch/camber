import { documentVersion } from "../core/document";
import type { DesignRow } from "../core/supabase";
import type { Topo } from "./topo";
import "./DesignCard.css";

// One design in the library grid: a stored 3/4 wireframe thumbnail, the name, the document's format version,
// its topology stat chips, and the created date. The presentation flags are derived by LibraryApp from the
// current selection / blend state; the blend-pick check badge and the compat/incompat dimming are driven by
// CSS off `.fileapp.blending`.
interface DesignCardProps {
  row: DesignRow;
  topo: Topo | null;
  selected: boolean; // the single selected card (out of blend mode)
  compat: boolean; // in blend mode: a blendable peer (any hull whose document parses)
  incompat: boolean; // in blend mode: dimmed and inert
  picked: boolean; // in blend mode: chosen for the blend
  onClick: () => void;
  onDoubleClick: () => void;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function StatChip({ value, label }: { value: number | string; label: string }) {
  return (
    <span className="stat">
      <b>{value}</b> {label}
    </span>
  );
}

export function DesignCard({
  row,
  topo,
  selected,
  compat,
  incompat,
  picked,
  onClick,
  onDoubleClick,
}: DesignCardProps) {
  // The format the document declares — untagged documents read as v1. LibraryApp lists only readable
  // versions, so this is a real number here; a NaN (non-numeric tag) would show nothing rather than "vNaN".
  const version = documentVersion(row.document);
  const cls = [
    "card",
    selected && "selected",
    compat && "compat",
    incompat && "incompat",
    picked && "picked",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} onClick={onClick} onDoubleClick={onDoubleClick}>
      {/* An <img> data-URI keeps the (openly-writable) preview string self-contained and script-disabled. */}
      {row.preview ? (
        <img
          className="preview"
          alt=""
          src={
            "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(row.preview)
          }
        />
      ) : (
        <div className="preview noprev">no preview</div>
      )}
      <div className="cname">{row.name}</div>
      {isFinite(version) && <div className="cver">camber v{version}</div>}
      {topo && (
        <div className="topo">
          <StatChip
            value={topo.loa >= 100 ? topo.loa.toFixed(0) : topo.loa.toFixed(2)}
            label={topo.unit}
          />
          <StatChip value={topo.stations} label="stations" />
          <StatChip value={topo.section} label="section" />
          <StatChip value={topo.plan} label="plan" />
          <StatChip value={topo.trim} label="trim" />
        </div>
      )}
      <div className="cdate">{fmtDate(row.created_at)}</div>
      <span className="pick">✓</span>
    </div>
  );
}
