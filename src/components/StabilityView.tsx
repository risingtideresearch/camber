import { useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { ButtonGroup } from "./ButtonGroup";
import { Dropdown } from "./Dropdown";
import type { PlotGrab } from "./ChartFrame";
import "./StabilityView.css";

/** Presentation only. Data sources supply charts, fields and formatted readings. */
export interface Reading {
  readonly id: string;
  readonly name: ReactNode;
  readonly value: string;
  readonly range?: ReactNode;
  readonly note?: ReactNode;
  readonly title?: string;
  readonly always: boolean;
}
export function InfoHint({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <span className="infohint">
      <button type="button" className="infomark" aria-label={label}>
        i
      </button>
      <span className="infobubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}
export function ShadePicker<K extends string>({
  options,
  value,
  onChange,
  children,
}: {
  readonly options: readonly { key: K; label: string; hint?: string }[];
  readonly value: K;
  readonly onChange: (value: K) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="shadebar">
      <ButtonGroup className="shadepick" aria-label="Shade the plane by">
        {options.map((option) => (
          <Button
            key={option.key}
            active={value === option.key}
            title={option.hint}
            aria-pressed={value === option.key}
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </Button>
        ))}
      </ButtonGroup>
      <InfoHint label="What this shading means">{children}</InfoHint>
    </div>
  );
}
export function Readings({
  readings,
  open,
  onToggle,
}: {
  readonly readings: readonly Reading[];
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className={open ? "gzreadout isopen" : "gzreadout"}>
      {readings
        .filter((r) => open || r.always)
        .map((r) => (
          <span key={r.id} data-reading={r.id} title={r.title}>
            <span className="rname">{r.name}</span> <strong>{r.value}</strong>
            {r.range}
            {r.note}
          </span>
        ))}
      <Button
        variant="ghost"
        className="readmore"
        active={open}
        aria-expanded={open}
        aria-label={open ? "Fewer readings" : "All readings"}
        title={
          open
            ? "Show only the key readings, and give the height back to the curve"
            : "Show every reading, at the curve’s expense"
        }
        onClick={onToggle}
      >
        {open ? "Less ▴" : "More ▾"}
      </Button>
    </div>
  );
}
export function ToleranceToggle({
  on,
  what,
  onChange,
}: {
  readonly on: boolean;
  readonly what: string;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <Button
      className="rangetoggle"
      active={on}
      aria-pressed={on}
      aria-label={`${what} tolerance`}
      title={
        on
          ? `Every reading spans this tolerance — click to read ${what} as one exact value`
          : `Give ${what} a tolerance, and read every value across it`
      }
      onClick={() => onChange(!on)}
    >
      ±
    </Button>
  );
}
/** Input slots preserve each source's own editing/scrubbing and validation semantics. */
export function ToleranceCells({
  low,
  high,
  linked,
  onLink,
  what = "the extents",
}: {
  readonly low: ReactNode;
  readonly high: ReactNode;
  readonly linked: boolean;
  readonly onLink: (linked: boolean) => void;
  readonly what?: string;
}) {
  return (
    <>
      {low}
      <button
        type="button"
        className={`tollink${linked ? " islinked" : ""}`}
        aria-pressed={linked}
        aria-label={`${linked ? "Unlink" : "Link"} ${what}`}
        title={
          linked
            ? "The two extents move together — click to give each its own"
            : "Each extent is its own — click to move them together, at the wider of the two"
        }
        onClick={() => onLink(!linked)}
      />
      {high}
    </>
  );
}
export interface ConditionQuantity {
  readonly label: string;
  readonly inputId: string;
  readonly input: ReactNode;
  readonly unit: string;
  readonly tolerance: ReactNode;
}
export function ConditionControls({
  quantities,
}: {
  readonly quantities: readonly ConditionQuantity[];
}) {
  return (
    <div className="conditionbar">
      {quantities.map((q) => (
        <div className="quantity" key={q.inputId}>
          <label className="cname" htmlFor={q.inputId}>
            {q.label}
          </label>
          {q.input}
          <span className="cunit">{q.unit}</span>
          {q.tolerance}
        </div>
      ))}
    </div>
  );
}
export interface OverlayReference {
  readonly id: string;
  readonly name: string;
  readonly on: boolean;
  readonly disabled?: boolean;
  readonly onChange: (on: boolean) => void;
  readonly parameter?: ReactNode;
}
export function OverlayMenu({
  references,
}: {
  readonly references: readonly OverlayReference[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      label="Overlays"
      open={open}
      onOpenChange={setOpen}
      title="Which reference marks are drawn over the shading"
      menuLabel="Overlays"
      align="right"
    >
      <div className="dd-section">
        <div className="dd-group">References</div>
        {references.map((r) => (
          <div key={r.id}>
            <label className="dd-row dd-check">
              <input
                type="checkbox"
                checked={r.on}
                disabled={r.disabled}
                onChange={(e) => r.onChange(e.target.checked)}
              />
              <span className="dd-name">{r.name}</span>
            </label>
            {r.parameter && (
              <div
                className={`dd-row dd-sub${r.on && !r.disabled ? "" : " isoff"}`}
                inert={!r.on || r.disabled}
              >
                {r.parameter}
              </div>
            )}
          </div>
        ))}
      </div>
    </Dropdown>
  );
}
export function BandLegend({
  bands,
  unit,
  earlyPeak = false,
}: {
  readonly bands: readonly {
    key: string;
    name: string;
    range: string;
    note?: string;
  }[];
  readonly unit: string;
  readonly earlyPeak?: boolean;
}) {
  return (
    <div className="bandlegend" style={{ paddingLeft: 64 }}>
      {bands.map((b) => (
        <span
          key={b.key}
          className={`bandkey ${b.key}`}
          title={`${b.name} · ${b.range} ${unit}${b.note ? ` — ${b.note}` : ""}`}
          tabIndex={0}
        >
          {b.name}
          <small>
            {b.range} {unit}
          </small>
        </span>
      ))}
      {earlyPeak && (
        <span className="hatchkey">Cross-hatched: peak before 25°</span>
      )}
    </div>
  );
}
export function SpreadHandle({
  px,
  py,
  axis,
  label,
  grab,
  onMove,
}: {
  readonly px: number;
  readonly py: number;
  readonly axis: "x" | "y";
  readonly label: string;
  readonly grab: PlotGrab;
  readonly onMove: (at: { x: number; y: number }) => void;
}) {
  const dragging = useRef(false),
    halfWidth = axis === "x" ? 5 : 11,
    halfHeight = axis === "y" ? 5 : 11;
  return (
    <g
      className={`spreadhandle ${axis}`}
      onPointerDown={(e) => {
        if (grab.panActive || e.button !== 0) return;
        e.stopPropagation();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        e.stopPropagation();
        const at = grab.locate(e.clientX, e.clientY);
        if (at) onMove(at);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        grab.suppressClick();
        e.stopPropagation();
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        grab.suppressClick();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <line
        className="spreadcap"
        x1={axis === "x" ? px : px - 7}
        x2={axis === "x" ? px : px + 7}
        y1={axis === "x" ? py - 7 : py}
        y2={axis === "x" ? py + 7 : py}
      />
      <rect
        className="spreadgrab"
        x={px - halfWidth}
        y={py - halfHeight}
        width={halfWidth * 2}
        height={halfHeight * 2}
      />
      <title>{label} — or edit its tolerance field</title>
    </g>
  );
}
export function StabilityView({
  overlays,
  shading,
  plane,
  legend,
  condition,
  planeFooter,
  curveValue,
  curveControls,
  curve,
  readings,
  numbersOpen,
  onToggleNumbers,
  hasRange = false,
  curveFooter,
}: {
  readonly overlays: ReactNode;
  readonly shading: ReactNode;
  readonly plane: ReactNode;
  readonly legend?: ReactNode;
  readonly condition: ReactNode;
  readonly planeFooter?: ReactNode;
  readonly curveValue: ReactNode;
  readonly curveControls?: ReactNode;
  readonly curve: ReactNode;
  readonly readings: readonly Reading[];
  readonly numbersOpen: boolean;
  readonly onToggleNumbers: () => void;
  readonly hasRange?: boolean;
  readonly curveFooter?: ReactNode;
}) {
  return (
    <div className="stabilitypanel">
      <section className="card stabilitycard limitingcard">
        <div className="cap">
          <h2 className="capname">Limiting KG</h2>
          <span className="capctls">{overlays}</span>
        </div>
        {shading}
        {plane}
        {legend}
        {condition}
        {planeFooter}
      </section>
      <section
        className={`card stabilitycard gzcard${numbersOpen ? " numbersopen" : ""}`}
      >
        <div className="cap">
          <h2 className="capname">
            {hasRange ? "GZ curve and range" : "GZ curve"}
          </h2>
          <span className="val">{curveValue}</span>
        </div>
        {curveControls}
        {curve}
        <Readings
          readings={readings}
          open={numbersOpen}
          onToggle={onToggleNumbers}
        />
        {curveFooter}
      </section>
    </div>
  );
}
