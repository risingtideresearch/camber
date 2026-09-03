// ---------- the cells every weight view is built from ----------
//
// The panel is an EDITOR first, and these are what that means in practice: a text cell that holds its own
// draft while the caret is in it, a formula cell that does the same plus autocomplete and the `±`
// substitution, and the grip that drags a row. Formatting lives in `weightFormat.ts`.
//
// They live apart from any one view because every view needs them: the grouped table, the per-item detail
// and the summary all edit the same cells, and a cell that behaved differently depending on which view you
// were looking at would be a bug nobody could describe.

import { Fragment, useEffect, useRef, useState } from "react";
import { AutocompleteList } from "./WeightAutocomplete";
import { useAutocomplete } from "./useAutocomplete";
import type { Completion } from "./weightCompletions";

/** One consistent, textual treatment for anything that needs attention beside an evaluated field. */
export function ResultIssue({
  message,
  severity,
}: {
  readonly message: string | null | undefined;
  readonly severity: "error" | "warning";
}) {
  if (!message) return null;
  return (
    <span className={`wissue ${severity}`} title={message}>
      <span className="wissuemark" aria-hidden="true">
        !
      </span>
      <span>{message}</span>
    </span>
  );
}

// ---------- edit-on-blur fields ----------
//
// The store is authoritative and every keystroke would otherwise be a command, so a field holds its own draft
// while it has the caret and commits on blur or Enter. Escape puts back what the document says, which is the
// only way to abandon a half-typed formula without leaving it in the history.

export function Field({
  value,
  placeholder,
  className,
  title,
  ariaLabel,
  autoFocus = false,
  list,
  size,
  onCommit,
  onFocus,
  onDone,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly className?: string;
  readonly title?: string;
  /** For a cell with no visible label of its own, where `title` is a sentence rather than a name. */
  readonly ariaLabel?: string;
  /**
   * Take the caret on mount, with the existing text selected so typing replaces it.
   *
   * For a field that was just CREATED and is waiting to be named. Only on mount: a cell that stole focus
   * whenever a prop happened to change would fight the person typing in the next one along.
   */
  readonly autoFocus?: boolean;
  /** The id of a `<datalist>` to offer, for a cell whose useful values are already in the book. */
  readonly list?: string;
  /** Width in characters, where the cell should be as wide as what it holds rather than as wide as a column. */
  readonly size?: number;
  readonly onCommit: (value: string) => void;
  readonly onFocus?: () => void;
  /**
   * The caret left, whether or not anything was committed.
   *
   * For a cell that only exists while it is being typed in — an empty box opened to hold the next thing —
   * which has to be taken away again when it is abandoned, and `onCommit` never fires for a blank one.
   */
  readonly onDone?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    input.current?.focus();
    input.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      ref={input}
      className={className}
      value={draft ?? value}
      placeholder={placeholder}
      title={title}
      aria-label={ariaLabel}
      list={list}
      size={size}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={onFocus}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
        onDone?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") input.current?.blur();
        else if (event.key === "Escape") {
          setDraft(null);
          input.current?.blur();
        }
      }}
    />
  );
}

/**
 * The formula field: the same edit-on-blur contract, plus the two things a formula wants.
 *
 * `+-` becomes `±` as it is typed, because the real character is a nuisance on most keyboards and the
 * substitution is exact — the lexer already treats them as the same token, so nothing changes meaning; it
 * just stops looking like a workaround.
 */
export function FormulaField({
  value,
  error,
  completions,
  placeholder = "—",
  onCommit,
  onFocus,
}: {
  readonly value: string;
  readonly error: string | null;
  readonly completions: readonly Completion[];
  readonly placeholder?: string;
  readonly onCommit: (value: string) => void;
  readonly onFocus?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { suggest, active, setActive, refresh, close } =
    useAutocomplete(completions);
  const shown = draft ?? value;

  const setAll = (text: string, caret: number) => {
    setDraft(text);
    refresh(text, caret);
    // The caret has to be restored after React writes the value back, or typing `+-` would jump it to the end.
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(caret, caret);
    });
  };

  const pick = (item: Completion) => {
    if (!suggest) return;
    const before = shown.slice(0, suggest.from);
    const after = shown.slice(input.current?.selectionStart ?? shown.length);
    const text = before + item.insert + after;
    setDraft(text);
    close();
    const caret = before.length + item.insert.length;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  };

  return (
    <span className="wformulawrap">
      <input
        ref={input}
        className={`wformula${error ? " bad" : ""}`}
        value={shown}
        placeholder={placeholder}
        title={error ?? (shown || undefined)}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          const raw = event.target.value;
          const caret = event.target.selectionStart ?? raw.length;
          // Substitute as typed. The replacement is one character shorter, so the caret moves back by one
          // for each substitution that happened before it.
          const upTo = raw.slice(0, caret);
          const text = raw.replace(/\+-/g, "±");
          const shift = (upTo.match(/\+-/g)?.length ?? 0) * 1;
          setAll(text, caret - shift);
        }}
        onFocus={(event) => {
          onFocus?.();
          refresh(event.target.value, event.target.selectionStart ?? 0);
        }}
        onClick={(event) =>
          refresh(
            event.currentTarget.value,
            event.currentTarget.selectionStart ?? 0,
          )
        }
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft);
          setDraft(null);
          close();
        }}
        onKeyDown={(event) => {
          // Alt+↑/↓ belongs to the block this cell sits in — it reorders the field. Left alone here so the
          // suggestion list does not move its highlight during the same keystroke.
          if (suggest && !event.altKey) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((active + 1) % suggest.items.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (active - 1 + suggest.items.length) % suggest.items.length,
              );
              return;
            }
            if (event.key === "Tab" || event.key === "Enter") {
              event.preventDefault();
              pick(suggest.items[active]);
              return;
            }
          }
          if (event.key === "Enter") input.current?.blur();
          else if (event.key === "Escape") {
            if (suggest) close();
            else {
              setDraft(null);
              input.current?.blur();
            }
          } else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
            close();
        }}
      />
      {suggest && (
        <AutocompleteList suggest={suggest} active={active} onPick={pick} />
      )}
    </span>
  );
}

/** The drag handle. Carries whatever identifies what is being dragged, so a drop anywhere knows what it got. */
export function Grip({
  payload,
  onDragStart,
  onDragEnd,
  className = "wdrag",
  title = "Drag to reorder, or onto a group in the explorer to file it — or Alt+↑/↓ from any cell",
}: {
  readonly payload: string;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly className?: string;
  readonly title?: string;
}) {
  return (
    <span
      className={className}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag without payload, and the identifier is the useful thing to carry —
        // it is also what lets the explorer accept a drop from the table and file the item.
        event.dataTransfer.setData("text/plain", payload);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      title={title}
      aria-hidden="true"
    >
      {/* Two columns of four on a square 4px pitch: the proportions a grip is expected to have. The size is
          stated in CSS as well as here because the editor sets `svg { width: 100% }` app-wide. */}
      <svg viewBox="0 0 6 16" width="6" height="16" aria-hidden="true">
        {[2, 6, 10, 14].map((y) => (
          <Fragment key={y}>
            <circle cx="1" cy={y} r="1" />
            <circle cx="5" cy={y} r="1" />
          </Fragment>
        ))}
      </svg>
    </span>
  );
}
