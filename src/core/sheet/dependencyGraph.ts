import { cellKey } from "./addresses";
import type {
  GeometryOperation,
  MeasureOperation,
  ValueOperation,
} from "./operations";

/** Tagged ids keep internal operation nodes separate from authored cell keys. */
export const cellNodeId = (key: string): string =>
  JSON.stringify(["cell", key]);
export const geometryNodeId = (item: string, field: string): string =>
  JSON.stringify(["geometry", item, field]);
export const HULL_NODE = JSON.stringify(["hull"]);
export const phaseNodeId = (item: string, field: string): string =>
  JSON.stringify(["phase", item, field]);
export type DependencyNode =
  | { readonly k: "cell"; readonly key: string }
  | { readonly k: "geometry"; readonly operation: GeometryOperation }
  | { readonly k: "aggregate"; readonly operation: ValueOperation }
  | { readonly k: "hull" }
  | { readonly k: "phase"; readonly itemId: string; readonly fieldKey: string };
export interface DependencyGraph {
  readonly nodes: ReadonlyMap<string, DependencyNode>;
  /** Node → inputs, including dependencies that fail in the current world. */
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  /** Input → immediate consumers. */
  readonly dependents: ReadonlyMap<string, ReadonlySet<string>>;
}
interface PlannedCell {
  readonly operations: ReadonlyMap<number, ValueOperation>;
  readonly measurement?: MeasureOperation;
}

/** Cell-level operation graph, not an arithmetic-expression graph. Literal inputs
 * live inside their authored cell. Hull includes the fixed geometry settings.
 * Cycles and forbidden geometry-to-geometry edges are retained for inspection;
 * lazy runtime validation still reports them without blocking unrelated cells.
 */
export function buildDependencyGraph(
  cells: ReadonlyMap<string, PlannedCell>,
): DependencyGraph {
  const nodes = new Map<string, DependencyNode>();
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const node = (id: string, value: DependencyNode): string => {
    if (!nodes.has(id)) {
      nodes.set(id, value);
      dependencies.set(id, new Set());
      dependents.set(id, new Set());
    }
    return id;
  };
  const cellNode = (key: string) => node(cellNodeId(key), { k: "cell", key });
  const edge = (from: string, input: string) => {
    dependencies.get(from)!.add(input);
    dependents.get(input)!.add(from);
  };
  const inputCells = (from: string, geometry: GeometryOperation) => {
    for (const input of geometry.inputs)
      edge(from, cellNode(cellKey(input.itemId, input.fieldKey, input.leaf)));
  };
  const measuredCell = (operation: MeasureOperation): string => {
    const { geometry, leaf } = operation;
    const { item, key, field } = geometry;
    const id = cellNode(cellKey(item.id, key, leaf));
    // Equivalent count is algebra over repetition inputs, not a layout request.
    if (leaf === "equivalentCount") inputCells(id, geometry);
    else {
      const geometryId = node(geometryNodeId(item.id, key), {
        k: "geometry",
        operation: geometry,
      });
      edge(id, geometryId);
      inputCells(geometryId, geometry);
      edge(geometryId, node(HULL_NODE, { k: "hull" }));
      if (field.k === "repetition")
        edge(
          geometryId,
          node(phaseNodeId(item.id, key), {
            k: "phase",
            itemId: item.id,
            fieldKey: key,
          }),
        );
    }
    return id;
  };
  const inputsOf = (from: string, operation: ValueOperation): void => {
    switch (operation.k) {
      case "error":
        return;
      case "cell":
        edge(
          from,
          cellNode(
            cellKey(operation.itemId, operation.fieldKey, operation.leaf),
          ),
        );
        return;
      case "hull":
        edge(from, node(HULL_NODE, { k: "hull" }));
        return;
      case "measure":
        edge(from, measuredCell(operation));
        return;
      case "sum":
        operation.terms.forEach((term) => inputsOf(from, term));
        return;
      case "weightedMean":
        for (const entry of operation.entries) {
          if (entry.k === "error") continue;
          inputsOf(from, entry.weight);
          inputsOf(from, entry.value);
        }
    }
  };
  for (const [key, cell] of cells) {
    const id = cellNode(key);
    if (cell.measurement) measuredCell(cell.measurement);
    for (const [at, operation] of cell.operations) {
      if (operation.k === "sum" || operation.k === "weightedMean") {
        const aggregate = node(JSON.stringify(["aggregate", key, at]), {
          k: "aggregate",
          operation,
        });
        edge(id, aggregate);
        inputsOf(aggregate, operation);
      } else inputsOf(id, operation);
    }
  }
  return { nodes, dependencies, dependents };
}

/** Cycle-safe, inclusive traversal. Unknown roots are caller errors, not an
 * empty impact set (which could otherwise leave cached results silently stale).
 */
function closure(
  graph: DependencyGraph,
  roots: Iterable<string>,
  edges: DependencyGraph["dependencies"],
): ReadonlySet<string> {
  const pending = [...roots];
  for (const id of pending)
    if (!graph.nodes.has(id)) throw new Error(`Unknown dependency node: ${id}`);
  const reached = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const next of edges.get(id)!) pending.push(next);
  }
  return reached;
}

/** Inputs needed by the roots, including the roots themselves. */
export const requiredNodes = (
  graph: DependencyGraph,
  roots: Iterable<string>,
): ReadonlySet<string> => closure(graph, roots, graph.dependencies);

/** Conservative invalidation impact, including changed nodes themselves.
 * Valid for a fixed compiled revision. Formula/name/role/facet/schema edits must
 * rebuild the plan; this query alone does not reconcile two different graphs.
 */
export const affectedNodes = (
  graph: DependencyGraph,
  changed: Iterable<string>,
): ReadonlySet<string> => closure(graph, changed, graph.dependents);

/** Authored/result cell keys affected by changed operation nodes. */
export function affectedCells(
  graph: DependencyGraph,
  changed: Iterable<string>,
): ReadonlySet<string> {
  const cells = new Set<string>();
  for (const id of affectedNodes(graph, changed)) {
    const node = graph.nodes.get(id)!;
    if (node.k === "cell") cells.add(node.key);
  }
  return cells;
}
