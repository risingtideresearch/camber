import { useEffect, useRef } from "react";
import type { Completion, Suggest } from "./weightCompletions";

// ---------- the list ----------

export function AutocompleteList({
  suggest,
  active,
  onPick,
}: {
  readonly suggest: Suggest;
  readonly active: number;
  readonly onPick: (item: Completion) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <ul className="wac" ref={list} role="listbox">
      {suggest.items.map((item, i) => (
        <li
          key={item.insert}
          data-i={i}
          role="option"
          aria-selected={i === active}
          className={`wacitem${i === active ? " on" : ""} k-${item.kind}`}
          // pointerDown rather than click: the input blurs on click, and a blur commits the draft before the
          // pick would have landed.
          onPointerDown={(event) => {
            event.preventDefault();
            onPick(item);
          }}
        >
          <span className="wacname">{item.insert}</span>
          <span className="wachint">{item.hint}</span>
        </li>
      ))}
    </ul>
  );
}
