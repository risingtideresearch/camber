import type { HTMLAttributes } from "react";
import "./ButtonGroup.css";

// Buttons joined into one control: the borders between them collapse to single dividing lines and only the
// outer ends stay rounded. It composes with Button rather than replacing it — the children are ordinary
// <Button>s, so `variant`, `active`, `disabled` and the rest keep working, and `active` reads as the selected
// segment of the bar.
//
// WHEN to reach for it: the buttons have to be one thing said several ways — a pick-one choice (the 3D view's
// shading modes) or one movement offered in either direction (Undo / Redo). Independent toggles must stay
// standalone rounded buttons: joined, two of them lit at once reads as a broken radio group.
//
// It is not polymorph-ui's InputGroup, which is the nearest thing there and still the wrong one: that joins
// INPUTS, whose border belongs to the container, so it never collapses the seam between two bordered children
// the way a row of .btn needs; it rounds its ends with polymorph's own --border-radius, which this app leaves
// undefined outside the few places it hosts a polymorph input (see StationView.css); and it knows nothing of
// a selected segment. polymorph-ui has no button of its own either — which is why Button lives here.

export function ButtonGroup({
  className,
  role = "group",
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={className ? `btngroup ${className}` : "btngroup"}
      role={role}
      {...rest}
    />
  );
}
