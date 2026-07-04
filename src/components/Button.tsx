import type { ButtonHTMLAttributes } from "react";
import "./Button.css";

// The standard action button shared across the editor, interpolation, and library apps. `variant` picks the
// visual role — a plain bordered button, the accent-blue primary call-to-action, or a red destructive
// action — and `active` renders the pressed/selected (ink) state used by toggles. Everything else (onClick,
// disabled, title, …) passes straight through to the underlying <button>.
type Variant = "default" | "primary" | "danger";

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
