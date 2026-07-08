import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button";
import "./Dropdown.css";

// A split "button + caret" control with a popover panel — the shared pattern behind the 3D view's Mesh
// resolution control and the editor's Curvature control. The main button is a toggle (its pressed state is
// `active`, its click is `onToggle`); the caret opens the panel, which renders `children` and closes on any
// outside pointer-down. The caller owns both the toggle state and the open state, so the control stays a
// pure presentation of them. `align` picks which edge the panel hangs from (default: the button's left).
//
// Panel contents use the shared row primitives in Dropdown.css: `.dd-group` (a section header), `.dd-row`
// (name · control · value), and `.dd-check` (a whole-row checkbox label).
interface DropdownProps {
  label: ReactNode; // the main button's content
  active: boolean; // the main button's pressed (ink) state
  onToggle: () => void; // the main button's click
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
  active,
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
      {open && (
        <div className={"dropdown-panel dropdown-panel--" + align}>
          {children}
        </div>
      )}
    </div>
  );
}
