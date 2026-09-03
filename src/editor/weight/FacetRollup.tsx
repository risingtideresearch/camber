import { Fragment, useState } from "react";
import type { DocumentCommand } from "../../core/commands";
import {
  isReserved,
  isValidName,
  leavesOf,
  newId,
  rollupsOf,
  type FieldLeaf,
  type Item,
  type Rollup,
  type View,
  type WeightBook,
} from "../../core/sheet/book";
import type { BookResults, CellResult } from "../../core/sheet/evaluate";
import { groupItems, type Group } from "../../core/sheet/views";
import {
  itemRoleResult,
  roleLeaves,
  roleTotals,
  type RoleTotal,
  type RollupLeaf,
} from "../../core/sheet/rollups";
import { ROLES, type RoleSpec } from "../../core/sheet/roles";
import { naturalUnit } from "../../core/sheet/units";
import { inUnit, showSpread, sig } from "./weightFormat";

export interface RollupSelection {
  readonly viewId: string;
  readonly key: string;
  readonly label: string;
  readonly itemIds: readonly string[];
  readonly role: string;
  readonly leaf: RollupLeaf;
}

interface FacetRollupProps {
  readonly book: WeightBook;
  readonly view: View;
  readonly items: readonly Item[];
  readonly results: BookResults;
  readonly reading: "worst" | "likely";
  readonly focus: {
    readonly item: string;
    readonly field: string | null;
    readonly leaf: FieldLeaf;
  } | null;
  readonly selectedTotal: RollupSelection | null;
  readonly onSelectItem: (
    itemId: string,
    fieldKey: string,
    leaf: FieldLeaf,
  ) => void;
  readonly onSelectTotal: (selection: RollupSelection) => void;
  readonly onOpenItem: (itemId: string) => void;
  readonly send: (command: DocumentCommand) => void;
}

const itemsIn = (group: Group): Item[] => [
  ...group.items,
  ...group.children.flatMap(itemsIn),
];

const findGroup = (groups: readonly Group[], value: string): Group | null => {
  for (const group of groups) {
    if (group.value === value) return group;
    const child = findGroup(group.children, value);
    if (child) return child;
  }
  return null;
};

const commonUnit = (spec: RoleSpec) => naturalUnit(spec.dim);

function Value({
  cell,
  spec,
  which,
}: {
  readonly cell: CellResult;
  readonly spec: RoleSpec;
  readonly which: "worst" | "likely";
}) {
  const unit = commonUnit(spec);
  const reading = cell.reading!;
  return (
    <>
      <span className="wrollnumber">{sig(inUnit(reading.v, unit.factor))}</span>
      {showSpread(reading, unit.factor, which) && (
        <span className="wrollspread">
          {" "}
          {showSpread(reading, unit.factor, which)}
        </span>
      )}
    </>
  );
}

function ItemRoleCells({
  item,
  spec,
  results,
  reading,
  focus,
  onSelect,
}: {
  readonly item: Item;
  readonly spec: RoleSpec;
  readonly results: BookResults;
  readonly reading: "worst" | "likely";
  readonly focus: FacetRollupProps["focus"];
  readonly onSelect: FacetRollupProps["onSelectItem"];
}) {
  const leaves = roleLeaves(spec);
  const resolved = itemRoleResult(item, spec, results);
  if (resolved.k === "none")
    return leaves.map((leaf) => (
      <td key={leaf} className="wrollvalue empty">
        —
      </td>
    ));
  if (resolved.k === "error") {
    const field = resolved.fieldKey ? item.fields[resolved.fieldKey] : null;
    return leaves.map((leaf, index) => {
      const fieldLeaf = field
        ? leaf === "value"
          ? leavesOf(field)[0]
          : leaf
        : null;
      const selected =
        fieldLeaf &&
        focus?.item === item.id &&
        focus.field === resolved.fieldKey &&
        focus.leaf === fieldLeaf;
      return (
        <td
          key={leaf}
          className={`wrollvalue bad${selected ? " selected" : ""}`}
          title={resolved.message}
        >
          {fieldLeaf && resolved.fieldKey ? (
            <button
              onClick={() => onSelect(item.id, resolved.fieldKey!, fieldLeaf)}
            >
              {index === 0 ? "!" : "—"}
            </button>
          ) : index === 0 ? (
            "!"
          ) : (
            "—"
          )}
        </td>
      );
    });
  }
  const field = item.fields[resolved.fieldKey];
  return leaves.map((leaf) => {
    const fieldLeaf = leaf === "value" ? leavesOf(field)[0] : leaf;
    const selected =
      focus?.item === item.id &&
      focus.field === resolved.fieldKey &&
      focus.leaf === fieldLeaf;
    return (
      <td key={leaf} className={`wrollvalue${selected ? " selected" : ""}`}>
        <button onClick={() => onSelect(item.id, resolved.fieldKey, fieldLeaf)}>
          <Value cell={resolved.cells[leaf]} spec={spec} which={reading} />
        </button>
      </td>
    );
  });
}

const coverageIssue = (total: RoleTotal): string | null => {
  if (!total.coverage || total.coverage.total.v === total.coverage.included.v)
    return null;
  const unit = naturalUnit(total.coverage.total.dim);
  return `${sig(inUnit(total.coverage.included.v, unit.factor))} of ${sig(
    inUnit(total.coverage.total.v, unit.factor),
  )} ${unit.label} has a ${total.role}`;
};

function TotalRoleCells({
  total,
  spec,
  reading,
  selectionBase,
  selected,
  onSelect,
}: {
  readonly total: RoleTotal;
  readonly spec: RoleSpec;
  readonly reading: "worst" | "likely";
  readonly selectionBase: Omit<RollupSelection, "role" | "leaf">;
  readonly selected: RollupSelection | null;
  readonly onSelect: FacetRollupProps["onSelectTotal"];
}) {
  const leaves = roleLeaves(spec);
  const unit = commonUnit(spec);
  const coverage = coverageIssue(total);
  const issue = [...total.issues, ...(coverage ? [coverage] : [])].join("\n");
  return leaves.map((leaf) => {
    const value = total.readings[leaf];
    return (
      <td
        key={leaf}
        className={`wrollvalue total${issue ? " warning" : ""}${
          selected?.viewId === selectionBase.viewId &&
          selected.key === selectionBase.key &&
          selected.role === spec.name &&
          selected.leaf === leaf
            ? " selected"
            : ""
        }`}
        title={issue || undefined}
      >
        {total.contributors && value ? (
          <button
            onClick={() =>
              onSelect({ ...selectionBase, role: spec.name, leaf })
            }
          >
            <span className="wrollnumber">
              {sig(inUnit(value.v, unit.factor))}
            </span>
            {showSpread(value, unit.factor, reading) && (
              <span className="wrollspread">
                {" "}
                {showSpread(value, unit.factor, reading)}
              </span>
            )}
            {issue && <span className="wrollwarn">!</span>}
          </button>
        ) : issue ? (
          <span className="wrollwarn">!</span>
        ) : (
          "—"
        )}
      </td>
    );
  });
}

function TotalCells({
  items,
  results,
  reading,
  selectionBase,
  selected,
  onSelect,
}: {
  readonly items: readonly Item[];
  readonly results: BookResults;
  readonly reading: "worst" | "likely";
  readonly selectionBase: Omit<RollupSelection, "role" | "leaf">;
  readonly selected: RollupSelection | null;
  readonly onSelect: FacetRollupProps["onSelectTotal"];
}) {
  const totals = roleTotals(items, results);
  return ROLES.map((spec) => (
    <Fragment key={spec.name}>
      <TotalRoleCells
        total={totals.get(spec.name)!}
        spec={spec}
        reading={reading}
        selectionBase={selectionBase}
        selected={selected}
        onSelect={onSelect}
      />
    </Fragment>
  ));
}

function ItemRow({
  item,
  depth,
  results,
  onOpenItem,
  reading,
  focus,
  onSelectItem,
}: {
  readonly item: Item;
  readonly depth: number;
  readonly results: BookResults;
  readonly onOpenItem: (itemId: string) => void;
  readonly reading: "worst" | "likely";
  readonly focus: FacetRollupProps["focus"];
  readonly onSelectItem: FacetRollupProps["onSelectItem"];
}) {
  return (
    <tr className="wrollitem">
      <th style={{ paddingLeft: `${depth * 14 + 8}px` }}>
        <button
          onClick={() => onOpenItem(item.id)}
          title="Open this item to edit it"
        >
          {item.name || <i>unnamed</i>}
        </button>
      </th>
      {ROLES.map((spec) => (
        <Fragment key={spec.name}>
          <ItemRoleCells
            item={item}
            spec={spec}
            results={results}
            reading={reading}
            focus={focus}
            onSelect={onSelectItem}
          />
        </Fragment>
      ))}
    </tr>
  );
}

function GroupRows({
  group,
  closed,
  onToggle,
  results,
  reading,
  onOpenItem,
  viewId,
  focus,
  selectedTotal,
  onSelectItem,
  onSelectTotal,
}: {
  readonly group: Group;
  readonly closed: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly results: BookResults;
  readonly reading: "worst" | "likely";
  readonly onOpenItem: (itemId: string) => void;
  readonly viewId: string;
  readonly focus: FacetRollupProps["focus"];
  readonly selectedTotal: RollupSelection | null;
  readonly onSelectItem: FacetRollupProps["onSelectItem"];
  readonly onSelectTotal: FacetRollupProps["onSelectTotal"];
}) {
  const id = `${group.key}:${group.value}:${group.depth}`;
  const folded = closed.has(id);
  const members = itemsIn(group);
  return (
    <>
      <tr className="wrollgroup">
        <th style={{ paddingLeft: `${group.depth * 14 + 6}px` }}>
          <button
            className="wexptwist"
            aria-expanded={!folded}
            onClick={() => onToggle(id)}
          >
            {folded ? "▸" : "▾"}
          </button>
          <span>{group.label}</span>
          <small>{group.count}</small>
        </th>
        <TotalCells
          items={members}
          results={results}
          reading={reading}
          selectionBase={{
            viewId,
            key: id,
            label: `${group.label} total`,
            itemIds: members.map((item) => item.id),
          }}
          selected={selectedTotal}
          onSelect={onSelectTotal}
        />
      </tr>
      {!folded && (
        <>
          {group.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              depth={group.depth + 1}
              results={results}
              onOpenItem={onOpenItem}
              reading={reading}
              focus={focus}
              onSelectItem={onSelectItem}
            />
          ))}
          {group.children.map((child) => (
            <GroupRows
              key={`${child.key}:${child.value}:${child.depth}`}
              group={child}
              closed={closed}
              onToggle={onToggle}
              results={results}
              reading={reading}
              onOpenItem={onOpenItem}
              viewId={viewId}
              focus={focus}
              selectedTotal={selectedTotal}
              onSelectItem={onSelectItem}
              onSelectTotal={onSelectTotal}
            />
          ))}
        </>
      )}
    </>
  );
}

const rollupNameIssue = (
  book: WeightBook,
  name: string,
  except: string | null,
): string | null => {
  const tidied = name.trim().replace(/\s+/g, " ");
  if (!isValidName(tidied))
    return "Use letters, digits, spaces and _, starting with a letter.";
  if (isReserved(tidied))
    return `${tidied} is reserved by the formula language.`;
  if (book.items.some((item) => item.name === tidied))
    return `An item is already called ${tidied}.`;
  if (
    rollupsOf(book).some(
      (rollup) => rollup.id !== except && rollup.name === tidied,
    )
  )
    return `A roll-up is already called ${tidied}.`;
  return null;
};

function SavedRollupName({
  book,
  rollup,
  send,
}: {
  readonly book: WeightBook;
  readonly rollup: Rollup;
  readonly send: FacetRollupProps["send"];
}) {
  const [name, setName] = useState(rollup.name);
  const issue = rollupNameIssue(book, name, rollup.id);
  const commit = () => {
    if (!issue && name.trim() !== rollup.name)
      send({ type: "renameRollup", id: rollup.id, name });
  };
  return (
    <div className="wrollbinding">
      <code>ROLLUP.</code>
      <input
        value={name}
        aria-label="Roll-up formula name"
        spellCheck={false}
        className={issue ? "bad" : ""}
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setName(rollup.name);
            event.currentTarget.blur();
          }
        }}
      />
      <span className="wrolladdresses">.MASS · .CG.x · .CG.y · .CG.z</span>
      {issue && <span className="wrollnameissue">{issue}</span>}
      <button
        className="wrollforget"
        title="Remove this formula name; formulas using it will stop resolving"
        onClick={() => send({ type: "removeRollup", id: rollup.id })}
      >
        ×
      </button>
    </div>
  );
}

function RollupNames({
  book,
  view,
  send,
}: Pick<FacetRollupProps, "book" | "view" | "send">) {
  const [draft, setDraft] = useState("");
  if (view.scope.k !== "facet") return null;
  const scope = view.scope;
  const saved = rollupsOf(book).filter(
    (rollup) =>
      rollup.facetKey === scope.key && rollup.facetValue === scope.value,
  );
  const issue = draft ? rollupNameIssue(book, draft, null) : null;
  const add = () => {
    if (!draft.trim() || issue) return;
    send({
      type: "addRollup",
      id: newId("r"),
      name: draft,
      facetKey: scope.key,
      facetValue: scope.value,
    });
    setDraft("");
  };
  return (
    <section className="wrollnames">
      <span className="wrollnamelabel">Use in formulas</span>
      {saved.map((rollup) => (
        <SavedRollupName
          key={`${rollup.id}:${rollup.name}`}
          book={book}
          rollup={rollup}
          send={send}
        />
      ))}
      {saved.length === 0 && (
        <div className="wrollbinding new">
          <code>ROLLUP.</code>
          <input
            value={draft}
            placeholder="name this roll-up"
            aria-label="New roll-up formula name"
            spellCheck={false}
            className={issue ? "bad" : ""}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && add()}
          />
          <button disabled={!draft.trim() || !!issue} onClick={add}>
            Save
          </button>
          {issue && <span className="wrollnameissue">{issue}</span>}
        </div>
      )}
    </section>
  );
}

/** A facet is a report: filing chooses the rows, and roles provide stable, meaningful columns and totals. */
export function FacetRollup({
  book,
  view,
  items,
  results,
  reading,
  focus,
  selectedTotal,
  onSelectItem,
  onSelectTotal,
  onOpenItem,
  send,
}: FacetRollupProps) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setClosed((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const grouped = groupItems(items, view.groupBy);
  const groups =
    view.scope.k === "facet"
      ? [findGroup(grouped, view.scope.value)].filter(
          (group): group is Group => !!group,
        )
      : grouped;
  const columnCount = ROLES.reduce(
    (count, spec) => count + roleLeaves(spec).length,
    0,
  );

  return (
    <div className="wrollup">
      <RollupNames key={view.id} book={book} view={view} send={send} />
      <table>
        <thead>
          <tr>
            <th rowSpan={2}>Item / group</th>
            {ROLES.map((spec) => (
              <th
                key={spec.name}
                colSpan={roleLeaves(spec).length}
                title={spec.hint}
              >
                {spec.name}
              </th>
            ))}
          </tr>
          <tr>
            {ROLES.flatMap((spec) =>
              roleLeaves(spec).map((leaf) => (
                <th key={`${spec.name}:${leaf}`}>
                  {leaf === "value"
                    ? commonUnit(spec).label
                    : `${leaf} (${commonUnit(spec).label})`}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <GroupRows
              key={`${group.key}:${group.value}:${group.depth}`}
              group={group}
              closed={closed}
              onToggle={toggle}
              results={results}
              reading={reading}
              onOpenItem={onOpenItem}
              viewId={view.id}
              focus={focus}
              selectedTotal={selectedTotal}
              onSelectItem={onSelectItem}
              onSelectTotal={onSelectTotal}
            />
          ))}
          {!groups.length &&
            items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                depth={0}
                results={results}
                onOpenItem={onOpenItem}
                reading={reading}
                focus={focus}
                onSelectItem={onSelectItem}
              />
            ))}
        </tbody>
        <tfoot>
          <tr>
            <th>
              Total <small>{items.length} items</small>
            </th>
            <TotalCells
              items={items}
              results={results}
              reading={reading}
              selectionBase={{
                viewId: view.id,
                key: "all",
                label: `${view.name} total`,
                itemIds: items.map((item) => item.id),
              }}
              selected={selectedTotal}
              onSelect={onSelectTotal}
            />
          </tr>
        </tfoot>
      </table>
      <p className="wrollnote">
        Read-only. Facets choose what is included; role tags choose the values.
        Open an item to edit it.
      </p>
      {columnCount === 0 && <p className="whint">No roles are defined.</p>}
    </div>
  );
}
