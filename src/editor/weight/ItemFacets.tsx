// Tags are facets in the document model, never part of a formula address.
// Adding and editing share one picker; browsing and typing remain local drafts
// until a complete key/value pair can be sent as a single setFacet command.
import { useEffect, useId, useRef, useState } from "react";
import type { DocumentCommand } from "../../core/commands";
import {
  facetChildren,
  facetKeys,
  facetSegments,
  isValidName,
  isValidFacetValue,
  tidyFacetValue,
  tidyName,
  type Item,
  type WeightBook,
} from "../../core/sheet/book";

export function ItemFacets(props: {
  readonly book: WeightBook;
  readonly item: Item;
  readonly send: (command: DocumentCommand) => void;
}) {
  // Navigation must also discard any open picker and its draft.
  return <ItemTags key={props.item.id} {...props} />;
}

function ItemTags({ book, item, send }: Parameters<typeof ItemFacets>[0]) {
  const headingId = useId();
  const file = (key: string, value: string) =>
    send({ type: "setFacet", item: item.id, key, value });
  return (
    <section className="wtags" aria-labelledby={headingId}>
      <header className="wtaghead">
        <h3 id={headingId}>Tags</h3>
        <TagPicker book={book} item={item} onFile={file} />
      </header>
      {Object.entries(item.facets).map(([key, value]) => (
        <div className="wtagrow" key={key}>
          <span className="wtagkey">{key}</span>
          <TagPicker
            book={book}
            item={item}
            tagKey={key}
            value={value}
            onFile={file}
          />
          <button
            type="button"
            className="wtagremove"
            aria-label={`Remove ${key} tag`}
            title={`Remove ${key} tag`}
            onClick={() => file(key, "")}
          >
            ×
          </button>
        </div>
      ))}
      {Object.keys(item.facets).length === 0 && (
        <p className="wtaghint">No tags yet.</p>
      )}
    </section>
  );
}

function TagPicker({
  book,
  item,
  tagKey,
  value,
  onFile,
}: {
  readonly book: WeightBook;
  readonly item: Item;
  readonly tagKey?: string;
  readonly value?: string;
  readonly onFile: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [typed, setTyped] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pickerId = useId();
  const titleId = useId();
  const errorId = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);

  const known = facetKeys(book).filter((key) => !(key in item.facets));
  const children = tag ? facetChildren(book, tag, path.join("/")) : [];
  const newValue = tidyFacetValue(typed);
  const newTag = tidyName(typed);
  const error = !typed.trim()
    ? null
    : !tag && newTag in item.facets
      ? "This tag is already assigned. Edit its value instead."
      : !(tag ? isValidFacetValue(newValue) : isValidName(newTag))
        ? "Start names with a letter or underscore; use letters, digits, spaces or underscores."
        : null;
  const valid = !!typed.trim() && !error && (!tag || !!newValue);
  const choose = (next: string[]) => {
    if (!tag) return;
    onFile(tag, next.join("/"));
    close();
  };
  const browse = (next: string[]) => {
    setPath(next);
    setCreating(false);
    setTyped("");
    panel.current?.focus();
  };

  return (
    <div className={`wtaganchor${tagKey ? " wtaganchorvalue" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="wtagtrigger"
        aria-label={tagKey ? `Edit ${tagKey} tag: ${value}` : "Add tag"}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? pickerId : undefined}
        onClick={() => {
          if (open) return close();
          setTag(tagKey ?? null);
          setPath(value ? facetSegments(value) : []);
          setCreating(false);
          setTyped("");
          setOpen(true);
        }}
      >
        {value ? facetSegments(value).join(" › ") : "+ Add"}
      </button>
      {open && (
        <div
          ref={panel}
          id={pickerId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="wtagpicker"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="wtagpickerhead">
            {(path.length > 0 || (tag && !tagKey)) && (
              <button
                type="button"
                aria-label="Back"
                onClick={() => {
                  if (path.length) browse(path.slice(0, -1));
                  else {
                    setTag(null);
                    browse([]);
                  }
                }}
              >
                ←
              </button>
            )}
            <strong id={titleId}>
              {tag ? [tag, ...path].join(" › ") : "Choose a tag"}
            </strong>
            <button type="button" aria-label="Close tag picker" onClick={close}>
              ×
            </button>
          </div>
          <div className="wtagchoices">
            {tag && path.length > 0 && (
              <button type="button" onClick={() => choose(path)}>
                Use {path[path.length - 1]}
              </button>
            )}
            {!tag
              ? known.map((key) => (
                  <button
                    type="button"
                    key={key}
                    onClick={() => {
                      setTag(key);
                      browse([]);
                    }}
                  >
                    <span>{key}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                ))
              : children.map((child) => {
                  const next = [...path, child];
                  return (
                    <div className="wtagchoice" key={child}>
                      <button
                        type="button"
                        className="wtagselect"
                        title={`Use ${next.join(" › ")}`}
                        onClick={() => choose(next)}
                      >
                        {child}
                      </button>
                      <button
                        type="button"
                        className="wtagexplore"
                        aria-label={`Explore values under ${child}`}
                        title={`Explore values under ${child}`}
                        onClick={() => browse(next)}
                      >
                        <span aria-hidden="true">›</span>
                      </button>
                    </div>
                  );
                })}
            {tag && path.length === 0 && children.length === 0 && (
              <p className="wtaghint">Choose a new value.</p>
            )}
          </div>
          {creating ? (
            <form
              className="wtagcreate"
              onSubmit={(event) => {
                event.preventDefault();
                if (!valid) return;
                if (tag) choose([...path, ...facetSegments(newValue)]);
                else {
                  setTag(newTag);
                  setTyped("");
                  // Existing tags should offer their values, not duplicate them.
                  setCreating(!facetKeys(book).includes(newTag));
                  if (facetKeys(book).includes(newTag)) panel.current?.focus();
                }
              }}
            >
              <input
                autoFocus
                aria-label={tag ? "New value" : "New tag"}
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                placeholder={tag ? "New value" : "New tag"}
                value={typed}
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
              />
              <button type="submit" disabled={!valid}>
                {tag ? "Add" : "Next"}
              </button>
              {error && (
                <p id={errorId} className="wtaghint">
                  {error}
                </p>
              )}
            </form>
          ) : (
            <button
              type="button"
              className="wtagnew"
              onClick={() => setCreating(true)}
            >
              {tag
                ? path.length
                  ? `+ New value under ${path[path.length - 1]}…`
                  : "+ New value…"
                : "+ New tag…"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
