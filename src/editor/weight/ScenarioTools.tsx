import { useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dropdown } from "../../components/Dropdown";
import {
  leafOf,
  newId,
  type Field as BookField,
  type Item,
  type SheetCommand,
  type WeightBook,
} from "../../core/sheet/book";
import {
  appliesTo,
  applyFieldPatch,
  formulaProperties,
  scenariosOf,
  type Applicability,
  type FieldPatch,
} from "../../core/sheet/scenarios";
import {
  scenarioDiff,
  type ScenarioDifference,
} from "../../core/sheet/scenarioDiff";
import { Field } from "./weightFields";

type Send = (command: SheetCommand) => void;

/** One control in the existing view bar. Management never adds a permanent toolbar. */
export function ScenarioPicker({
  book,
  active,
  onPick,
  onInspect,
  send,
}: {
  readonly book: WeightBook;
  readonly active: string | null;
  readonly onPick: (id: string | null) => void;
  readonly onInspect: () => void;
  readonly send: Send;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scenarios = scenariosOf(book);
  const scenario = scenarios.find((s) => s.id === active);
  const close = () => {
    setOpen(false);
    setCreating(false);
    root.current?.querySelector("button")?.focus();
  };
  const start = (copy: boolean) => {
    setName("");
    setDuplicate(copy);
    setCreating(true);
  };
  return (
    <div
      className="wscenario-picker"
      ref={root}
      role="group"
      aria-label="Scenario workspace"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <Dropdown
        label={
          <>
            <span className="wscenario-picker-label">Scenario</span>{" "}
            {scenario?.name ?? "Shared"}
          </>
        }
        title={
          scenario
            ? `Editing ${scenario.name}; values override Shared`
            : "Editing shared values, inherited by scenarios"
        }
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setCreating(false);
        }}
        align="right"
      >
        <div className="wscenario-menu" aria-label="Scenario options">
          {creating ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !name.trim() ||
                  scenarios.some((s) => s.name === name.trim())
                )
                  return;
                send({
                  type: "addScenario",
                  id: newId("scenario-"),
                  name,
                  ...(duplicate && active ? { source: active } : {}),
                });
                close();
              }}
            >
              <strong>
                {duplicate ? `Duplicate ${scenario?.name}` : "New scenario"}
              </strong>
              <label>
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Offshore"
                  autoFocus
                />
              </label>
              <p className="whint">
                {duplicate
                  ? "Copy membership and overrides. Shared values stay linked."
                  : "Inherit Shared, then change only what differs."}
              </p>
              <div className="wscenario-actions">
                <Button onClick={() => setCreating(false)}>Cancel</Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    !name.trim() ||
                    scenarios.some((s) => s.name === name.trim())
                  }
                >
                  Create
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="wscenario-choices">
                <button
                  type="button"
                  aria-pressed={!active}
                  onClick={() => {
                    onPick(null);
                    close();
                  }}
                >
                  Shared <small>Default values</small>
                </button>
                {scenarios.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    aria-pressed={s.id === active}
                    onClick={() => {
                      onPick(s.id);
                      close();
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <div className="wscenario-menu-actions">
                <button type="button" onClick={() => start(false)}>
                  + New scenario…
                </button>
                {scenario && (
                  <button type="button" onClick={() => start(true)}>
                    Duplicate {scenario.name}…
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    onInspect();
                    close();
                  }}
                >
                  Manage scenarios…
                </button>
              </div>
            </>
          )}
        </div>
      </Dropdown>
    </div>
  );
}

/** Explicit Shared membership is preserved when a named scenario excludes a base item. */
function Membership({
  book,
  rule,
  onChange,
}: {
  readonly book: WeightBook;
  readonly rule?: Applicability;
  readonly onChange: (rule: Applicability) => void;
}) {
  const selected = rule?.k === "only";
  return (
    <div className="wscenario-membership">
      <label>
        <input
          type="checkbox"
          checked={!selected}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? { k: "all" }
                : {
                    k: "only",
                    shared: true,
                    scenarios: scenariosOf(book).map((s) => s.id),
                  },
            )
          }
        />
        Shared and all scenarios
      </label>
      {selected && (
        <div className="wscenario-membership-list">
          <label>
            <input
              type="checkbox"
              checked={rule.shared === true}
              onChange={(event) =>
                onChange({ ...rule, shared: event.target.checked })
              }
            />
            Shared
          </label>
          {scenariosOf(book).map((s) => (
            <label key={s.id}>
              <input
                type="checkbox"
                checked={rule.scenarios.includes(s.id)}
                onChange={(event) =>
                  onChange({
                    ...rule,
                    scenarios: event.target.checked
                      ? [...rule.scenarios, s.id]
                      : rule.scenarios.filter((id) => id !== s.id),
                  })
                }
              />
              {s.name}
            </label>
          ))}
          {!rule.scenarios.length && !rule.shared && (
            <small className="whint">Included nowhere</small>
          )}
        </div>
      )}
    </div>
  );
}

function MembershipStatus({ included }: { readonly included: boolean }) {
  return (
    <span
      className={`wscenario-membership-status ${included ? "is-included" : "is-excluded"}`}
    >
      {included ? "Included" : "Excluded"}
    </span>
  );
}

const text = (value: unknown): string =>
  value === undefined
    ? "Not set"
    : typeof value === "string"
      ? value || "(empty)"
      : JSON.stringify(value);

function ChangeList({
  changes,
  active,
  send,
  onOpen,
  canOpen,
}: {
  readonly canOpen?: (item: string, field: string | null) => boolean;
  readonly changes: readonly ScenarioDifference[];
  readonly active: string;
  readonly send: Send;
  readonly onOpen: (item: string, field: string | null) => void;
}) {
  return (
    <ul className="wscenario-changes">
      {changes.map((change, index) => (
        <li key={index}>
          <button
            type="button"
            disabled={canOpen && !canOpen(change.item, change.fieldKey ?? null)}
            title={
              canOpen && !canOpen(change.item, change.fieldKey ?? null)
                ? "Not included anywhere. Update membership below to open in the sheet."
                : "Open in sheet"
            }
            className="wscenario-address"
            onClick={() => onOpen(change.item, change.fieldKey ?? null)}
          >
            {change.label}
          </button>
          {change.k === "membership" ? (
            <small>
              <MembershipStatus included={change.included} />
            </small>
          ) : (
            <>
              <div className="wscenario-change-values">
                <span title="Shared">{text(change.shared)}</span>
                <span aria-hidden="true">→</span>
                <span>{text(change.value)}</span>
              </div>
              <div className="wscenario-actions">
                {!change.active && (
                  <small className="whint">Dormant override</small>
                )}
                <button
                  type="button"
                  className="wscenario-link"
                  onClick={() =>
                    send({
                      type: "resetScenarioOverrides",
                      scenarioId: active,
                      targets: [
                        {
                          item: change.item,
                          fieldKey: change.fieldKey,
                          property: change.property,
                        },
                      ],
                    })
                  }
                >
                  Reset to Shared
                </button>
              </div>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Document-level management, independent of the current cell selection. */
export function ScenariosView({
  book,
  active,
  send,
  onOpen,
  onEdit,
}: {
  readonly book: WeightBook;
  readonly active: string | null;
  readonly send: Send;
  readonly onEdit: (workspace: string | null) => void;
  readonly onOpen: (
    item: string,
    field: string | null,
    workspace: string | null,
  ) => void;
}) {
  const [selection, setSelection] = useState(active);
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState<string | undefined>();
  const [name, setName] = useState("");
  const scenarios = scenariosOf(book);
  const scenario = scenarios.find((s) => s.id === selection);
  const selected = scenario?.id ?? null;
  const changes = selected ? scenarioDiff(book, selected) : [];
  const start = (source?: string) => {
    setSource(source);
    setName("");
    setCreating(true);
  };
  const destination = (itemId: string, key: string | null) => {
    const item = book.items.find((item) => item.id === itemId);
    return item
      ? [selected, null, ...scenarios.map((s) => s.id)].find(
          (id) =>
            appliesTo(item.applicability, id) &&
            (!key || appliesTo(item.fields[key]?.applicability, id)),
        )
      : undefined;
  };
  return (
    <div className="wscenarios-view">
      <nav className="wscenarios-nav" aria-label="Manage scenarios">
        <h2>Scenarios</h2>
        <div className="wscenario-choices">
          <button
            type="button"
            aria-pressed={!selected}
            onClick={() => setSelection(null)}
          >
            Shared<small>Default estimate</small>
          </button>
          {scenarios.map((s) => (
            <button
              type="button"
              key={s.id}
              aria-pressed={selected === s.id}
              onClick={() => setSelection(s.id)}
            >
              {s.name}
              <small>
                {scenarioDiff(book, s.id).length}{" "}
                {scenarioDiff(book, s.id).length === 1 ? "change" : "changes"}
              </small>
            </button>
          ))}
        </div>
        <Button onClick={() => start()}>+ New scenario…</Button>
        {creating && (
          <form
            className="wscenarios-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || scenarios.some((s) => s.name === name.trim()))
                return;
              const id = newId("scenario-");
              send({
                type: "addScenario",
                id,
                name,
                ...(source ? { source } : {}),
              });
              setSelection(id);
              setCreating(false);
            }}
          >
            <label>
              {source ? "Duplicate scenario" : "New scenario"}
              <input
                aria-label="New scenario name"
                placeholder="e.g. Main"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Escape") setCreating(false);
                }}
              />
            </label>
            <div className="wscenario-actions">
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button
                type="submit"
                disabled={
                  !name.trim() || scenarios.some((s) => s.name === name.trim())
                }
              >
                Create
              </Button>
            </div>
          </form>
        )}
      </nav>
      <section
        className="wscenarios-detail wscenario-inspector"
        aria-label="Scenario management"
      >
        <header>
          <h2>{scenario?.name ?? "Shared"}</h2>
          <p className="whint">
            {selected
              ? "An alternative to Shared. Value overrides and membership apply to this whole estimate."
              : "The default estimate. Named scenarios inherit these values unless overridden."}
          </p>
          <Button onClick={() => onEdit(selected)}>Open in sheet</Button>
          {scenario && (
            <div className="wscenarios-settings">
              <label>
                Name
                <Field
                  key={scenario.id}
                  value={scenario.name}
                  placeholder="Scenario name"
                  ariaLabel="Rename scenario"
                  onCommit={(name) =>
                    send({ type: "renameScenario", id: scenario.id, name })
                  }
                />
              </label>
              <Button onClick={() => start(scenario.id)}>Duplicate…</Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete “${scenario.name}” and its overrides? Shared values are kept.`,
                    )
                  )
                    send({ type: "removeScenario", id: scenario.id });
                }}
              >
                Delete scenario
              </Button>
            </div>
          )}
          {!scenarios.length && (
            <p className="whint">
              No alternatives yet. Create a scenario when you want to explore a
              different estimate.
            </p>
          )}
        </header>
        {selected && (
          <section className="wscenario-section">
            <h3>Changes from Shared ({changes.length})</h3>
            {changes.length ? (
              <ChangeList
                changes={changes}
                active={selected}
                send={send}
                canOpen={(item, field) =>
                  destination(item, field) !== undefined
                }
                onOpen={(item, field) => {
                  const id = destination(item, field);
                  if (id !== undefined) onOpen(item, field, id);
                }}
              />
            ) : (
              <p className="whint">
                No differences from Shared. Edit values in this scenario to
                create overrides.
              </p>
            )}
            {changes.some((change) => change.k === "override") && (
              <Button
                onClick={() => {
                  if (
                    window.confirm(
                      "Reset every value override in this scenario? Membership will not change.",
                    )
                  )
                    send({
                      type: "resetScenarioOverrides",
                      scenarioId: selected,
                      targets: changes
                        .filter((change) => change.k === "override")
                        .map((change) => ({
                          item: change.item,
                          fieldKey: change.fieldKey,
                          property: change.property,
                        })),
                    });
                }}
              >
                Reset all value overrides
              </Button>
            )}
          </section>
        )}
        <section className="wscenario-section">
          <h3>Membership</h3>
          <p className="whint">
            All authored items and fields, including excluded content. Field
            membership also requires its item to be included. “Shared and all
            scenarios” includes future scenarios.
          </p>
          {!book.items.length && (
            <p className="whint">
              Add items in the sheet to manage their membership here.
            </p>
          )}
          {book.items.map((item) => (
            <details key={item.id} className="wscenarios-member">
              <summary>
                {item.name || "Unnamed item"}
                <MembershipStatus
                  included={appliesTo(item.applicability, selected)}
                />
              </summary>
              <Membership
                book={book}
                rule={item.applicability}
                onChange={(applicability) =>
                  send({
                    type: "setApplicability",
                    item: item.id,
                    applicability,
                  })
                }
              />
              {Object.entries(item.fields).map(([key, field]) => (
                <details key={key} className="wscenarios-field">
                  <summary>
                    {key}
                    <MembershipStatus
                      included={
                        appliesTo(item.applicability, selected) &&
                        appliesTo(field.applicability, selected)
                      }
                    />
                  </summary>
                  {!appliesTo(item.applicability, selected) && (
                    <p className="whint">
                      The item is excluded from this estimate.
                    </p>
                  )}
                  <Membership
                    book={book}
                    rule={field.applicability}
                    onChange={(applicability) =>
                      send({
                        type: "setApplicability",
                        item: item.id,
                        fieldKey: key,
                        applicability,
                      })
                    }
                  />
                </details>
              ))}
            </details>
          ))}
        </section>
      </section>
    </div>
  );
}

/** A narrow, selection-only alternative to the former full-sheet matrix. */
export function ScenarioInputs({
  book,
  item,
  fieldKey,
  workspaceIds,
  send,
}: {
  readonly book: WeightBook;
  readonly item: Item;
  readonly fieldKey: string;
  readonly workspaceIds: readonly (string | null)[];
  readonly send: Send;
}) {
  const field = item.fields[fieldKey];
  const properties = formulaProperties(field).filter((property) => {
    if (property === "from")
      return workspaceIds.some(
        (id) =>
          !!leafOf(
            applyFieldPatch(field, id ? field.overrides?.[id] : undefined),
            property,
          ),
      );
    return (
      property in field ||
      workspaceIds.some((id) => id && property in (field.overrides?.[id] ?? {}))
    );
  });
  return (
    <details className="wscenario-section">
      <summary>Compare input formulas</summary>
      {workspaceIds.map((id) => {
        const name = id
          ? scenariosOf(book).find((s) => s.id === id)?.name
          : "Shared";
        const effective: BookField = applyFieldPatch(
          field,
          id ? field.overrides?.[id] : undefined,
        );
        const included =
          appliesTo(item.applicability, id) &&
          appliesTo(field.applicability, id);
        return (
          <div key={id ?? "shared"} className="wscenario-inputs">
            <h4>{name}</h4>
            {included ? (
              properties.map((property) => {
                const overridden =
                  id &&
                  Object.prototype.hasOwnProperty.call(
                    field.overrides?.[id] ?? {},
                    property,
                  );
                return (
                  <label key={property}>
                    <span>
                      {property}{" "}
                      {id && (
                        <small>{overridden ? "· override" : "· shared"}</small>
                      )}
                    </span>
                    <Field
                      value={leafOf(effective, property) ?? ""}
                      placeholder="Formula"
                      ariaLabel={`${fieldKey}.${property} · ${name}`}
                      onCommit={(formula) =>
                        send({
                          type: "setFieldFormula",
                          item: item.id,
                          field: fieldKey,
                          leaf: property,
                          formula,
                          scope: id
                            ? { k: "scenario", scenarioId: id }
                            : { k: "shared" },
                        })
                      }
                    />
                    {overridden && (
                      <button
                        type="button"
                        className="wscenario-link"
                        onClick={() =>
                          send({
                            type: "resetScenarioOverrides",
                            scenarioId: id!,
                            targets: [
                              {
                                item: item.id,
                                fieldKey: fieldKey,
                                property: property as keyof FieldPatch,
                              },
                            ],
                          })
                        }
                      >
                        Reset to Shared
                      </button>
                    )}
                  </label>
                );
              })
            ) : (
              <p className="whint">Not included</p>
            )}
          </div>
        );
      })}
    </details>
  );
}
