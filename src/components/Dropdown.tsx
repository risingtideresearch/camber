import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button";
import "./Dropdown.css";

// A button with a popover panel, in two forms — the shared pattern behind the 3D view's Mesh resolution
// control, the editor's Curvature control and the stability panel's Overlays menu. The panel renders
// `children` and closes on any outside pointer-down; `align` picks which edge it hangs from (default: the
// button's left).
//
// SPLIT form, when `onToggle` is given: a toggle button (pressed state `active`, click `onToggle`) joined to
// a caret that opens the panel. For a feature that is switched on and off AND configured.
//
// MENU form, when it is not: one button carrying the caret, which only opens the panel. For a set of choices
// with no master switch over them — where a toggle would have to invent one, and the button would claim to
// enable something it merely lists.
//
// The caller owns the open state either way, so the control stays a pure presentation of it.
//
// Panel contents use the shared row primitives in Dropdown.css: `.dd-group` (a section header), `.dd-row`
// (name · control · value), `.dd-check` (a whole-row checkbox label), and `.dd-sub` (a parameter row indented
// under the check it configures, `.isoff` while that one is off, with `.dd-unit` for a trailing unit).
interface DropdownProps {
  label: ReactNode; // the main button's content
  active?: boolean; // split form: the main button's pressed (ink) state
  onToggle?: () => void; // split form: the main button's click. Omit for the menu form.
  open: boolean; // whether the panel is shown
  onOpenChange: (open: boolean) => void;
  children: ReactNode; // the panel content
  title?: string; // the main button's tooltip
  menuLabel?: string; // the caret button's aria-label / tooltip
  align?: "left" | "right";
  className?: string;
}

export function Dropdown({
  label,
  active = false,
  onToggle,
  open,
  onOpenChange,
  children,
  title,
  menuLabel = "Options",
  align = "left",
  className,
}: DropdownProps) {
  const groupRef = useRef<HTMLDivElement>(null);

  // close on any pointer-down outside the group
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!groupRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);

  return (
    <div
      className={"dropdown" + (className ? " " + className : "")}
      ref={groupRef}
    >
      {onToggle ? (
        <>
          <Button active={active} title={title} onClick={onToggle}>
            {label}
          </Button>
          <Button
            className="dropdown-caret"
            active={open}
            title={menuLabel}
            aria-label={menuLabel}
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
          >
            ▾
          </Button>
        </>
      ) : (
        <Button
          active={open}
          title={title ?? menuLabel}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          {label}
          <span className="dropdown-caret-mark" aria-hidden="true">
            ▾
          </span>
        </Button>
      )}
      {open && (
        <div className={"dropdown-panel dropdown-panel--" + align}>
          {children}
        </div>
      )}
    </div>
  );
}
