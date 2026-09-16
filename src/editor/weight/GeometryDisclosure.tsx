import { useState, type ReactNode } from "react";

/** The same disclosure glyph and gutter as the field and explorer, with native
 * button keyboard behavior instead of browser-dependent details markers. */
export function GeometryDisclosure({
  label,
  initiallyOpen = false,
  children,
}: {
  label: string;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section className="wpreviewdisclosure">
      <button
        type="button"
        className="wpreviewtoggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="wexptwist" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span>{label}</span>
      </button>
      {open && children}
    </section>
  );
}
