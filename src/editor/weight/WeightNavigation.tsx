import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type WeightDestination = "sheet" | "loading" | "problems" | "scenarios";

const Target = createContext<HTMLDivElement | null>(null);
const SetTarget = createContext<((node: HTMLDivElement | null) => void) | null>(
  null,
);

/** The panel owns navigation state; its window supplies a place in the app bar. */
export function WeightNavigationProvider({
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

export function WeightNavigationSlot() {
  const setTarget = useContext(SetTarget);
  return <div className="weight-navigation-slot" ref={setTarget} />;
}

export function WeightNavigation({
  destination,
  onPick,
  problemCount,
  workspaceControl,
}: {
  readonly destination: WeightDestination;
  readonly onPick: (destination: WeightDestination) => void;
  readonly problemCount: number;
  readonly workspaceControl?: ReactNode;
}) {
  const target = useContext(Target);
  const navigation = (
    <div className="weight-navigation-tools">
      <nav className="weight-navigation" aria-label="Weight sheet views">
        {(["sheet", "loading", "problems", "scenarios"] as const).map((id) => (
          <button
            type="button"
            key={id}
            aria-current={destination === id ? "page" : undefined}
            onClick={() => onPick(id)}
          >
            {
              {
                sheet: "Sheet",
                loading: "Loading",
                problems: "Problems",
                scenarios: "Scenarios",
              }[id]
            }
            {id === "problems" && (
              <span
                className={`wproblembadge${problemCount ? "" : " empty"}`}
                aria-hidden={!problemCount}
                aria-label={
                  problemCount ? `${problemCount} problems` : undefined
                }
              >
                {problemCount > 99 ? "99+" : problemCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      {workspaceControl}
    </div>
  );
  return target ? createPortal(navigation, target) : navigation;
}
