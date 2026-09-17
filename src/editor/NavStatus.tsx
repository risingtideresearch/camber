import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./NavStatus.css";

const Target = createContext<HTMLDivElement | null>(null);
const SetTarget = createContext<((node: HTMLDivElement | null) => void) | null>(
  null,
);

/** A window-local status outlet. The panel still owns its calculation and text;
 * moving the presentation into the nav must not start another worker/subscription. */
export function NavStatusProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <SetTarget.Provider value={setTarget}>
      <Target.Provider value={target}>{children}</Target.Provider>
    </SetTarget.Provider>
  );
}

export function NavStatusSlot() {
  const setTarget = useContext(SetTarget);
  return <div className="navstatusslot" ref={setTarget} />;
}

/** Portals follow the panel's lifetime: closing it cannot leave a stale status. */
export function NavStatus({ message }: { readonly message: string }) {
  const target = useContext(Target);
  return target
    ? createPortal(
        <span
          className="navstatus"
          role="status"
          aria-atomic="true"
          title={message}
        >
          {message || "\u00a0"}
        </span>,
        target,
      )
    : null;
}
