import type { ButtonHTMLAttributes } from "react";
import "./Button.css";

// The standard action button shared across the editor, interpolation, and library apps. `variant` picks the
// visual role — a plain bordered button, the accent-blue primary call-to-action, a red destructive action, or
// the borderless ghost — and `active` renders the pressed/selected state used by toggles. Everything else
// (onClick, disabled, title, …) passes straight through to the underlying <button>.
//
// GHOST is for a control that sits ON something rather than in a bar of its own — the chart toolbars, which
// live in the plot's own top margin. A bordered white pill there reads as application furniture wherever it
// is nested, because that is exactly what it looks like in the app bar; the ghost drops the border and the
// fill and takes the muted colour of the axis labels, so the buttons read as part of the drawing until they
// are reached for, at which point they take a pill back and behave like every other button.
type Variant = "default" | "primary" | "danger" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  active?: boolean;
}

export function Button({
  variant = "default",
  active = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = [
    "btn",
    variant !== "default" && variant,
    active && "active",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={cls} {...rest} />;
}
