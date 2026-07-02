import type { ReactNode } from "react";
import "./TopBar.css";

// A horizontal top bar: the panel-colored strip with a bottom rule that heads an app (and, in the library,
// its selection / blend sub-toolbars). Lays its children out in a centered flex row — drop a
// <span className="spacer" /> between groups to push them apart. `className` adds an app-specific variant.
interface TopBarProps {
  children: ReactNode;
  className?: string;
}

export function TopBar({ children, className }: TopBarProps) {
  return (
    <div className={"topbar" + (className ? " " + className : "")}>
      {children}
    </div>
  );
}
