import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Hide unfinished spreads without collapsing the inspector. Remember layout,
 * not numbers: old uncertainty is never shown next to a new nominal value. */
export function UncertaintyReadout({
  pending,
  children,
}: {
  readonly pending: boolean;
  readonly children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (pending || !content.current) return;
    const element = content.current;
    const observer = new ResizeObserver(() => {
      setHeight(element.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pending]);
  return (
    <div
      className={`wuncertainty${pending ? " pending" : ""}`}
      style={pending ? { height: height ?? 240 } : undefined}
      aria-busy={pending}
    >
      {pending && (
        <p className="whint wuncertaintystatus" role="status">
          Uncertainty updating… Nominal value shown.
        </p>
      )}
      <div
        ref={content}
        className="wuncertaintycontent"
        aria-hidden={pending || undefined}
        inert={pending}
      >
        {children}
      </div>
    </div>
  );
}
