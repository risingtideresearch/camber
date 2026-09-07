import type { Field, Item, RenameCommand, WeightBook } from "./book";
import { parseFormula, tokenize, type Node } from "./formula";

/** Rewrite reference tokens in their original scope, preserving all other source text. */
export function renameReferences(
  book: WeightBook,
  command: RenameCommand,
  symbols: readonly string[],
): { book: WeightBook; dependents: string[] } {
  const name = command.name.trim().replace(/\s+/g, " ");
  const owner =
    command.type === "renameRollup"
      ? undefined
      : book.items.find((item) => item.id === command.item);
  const oldName =
    command.type === "renameRollup"
      ? book.rollups?.find((rollup) => rollup.id === command.id)?.name
      : command.type === "renameField"
        ? owner?.fields[command.key] && command.key
        : owner?.name;
  const dependents = new Set<string>();
  if (!oldName || !name || oldName === name) return { book, dependents: [] };

  const segment = (path: readonly string[], from?: Item): number | null => {
    if (command.type === "renameRollup")
      return path[0] === "ROLLUP" && path[1] === oldName ? 1 : null;
    // Local fields shadow item names, even in dotted paths. Role aliases are
    // reserved names and do not change when their underlying field is renamed.
    if (from?.fields[path[0]])
      return command.type === "renameField" &&
        from.id === owner?.id &&
        path[0] === oldName
        ? 0
        : null;
    if (path.length < 2 || path[0] !== owner?.name) return null;
    if (command.type === "renameItem") return 0;
    return path[1] === oldName ? 1 : null;
  };

  const rewrite = (source: string, address: string, from?: Item): string => {
    if (!source.trim()) return source;
    let tree: Node;
    try {
      tree = parseFormula(source, symbols);
    } catch {
      // An unfinished expression has no reliable reference tree to rewrite.
      return source;
    }
    const tokens = tokenize(source, symbols);
    const byOffset = new Map(tokens.map((token, index) => [token.at, index]));
    const edits: { at: number; end: number }[] = [];
    const walk = (node: Node): void => {
      switch (node.k) {
        case "ref": {
          const index = segment(node.path, from);
          if (index !== null) {
            const token = tokens[byOffset.get(node.at)! + index * 2];
            edits.push({ at: token.at, end: token.at + token.text.length });
          }
          break;
        }
        case "neg":
        case "pct":
          walk(node.a);
          break;
        case "bin":
          walk(node.a);
          walk(node.b);
          break;
        case "call":
          node.args.forEach(walk);
          break;
      }
    };
    walk(tree);
    if (!edits.length) return source;
    dependents.add(address);
    for (const edit of edits.sort((a, b) => b.at - a.at))
      source = source.slice(0, edit.at) + name + source.slice(edit.end);
    return source;
  };

  const items = book.items.map((item) => {
    const fields = Object.fromEntries(
      Object.entries(item.fields).map(([key, field]) => {
        const address = `${item.name || "unnamed item"}.${key}`;
        const formula = (source: string) => rewrite(source, address, item);
        let next: Field;
        switch (field.k) {
          case "scalar":
            next = { ...field, formula: formula(field.formula) };
            break;
          case "point":
            // Include saved coordinates too: turning off a derivation restores them.
            next = {
              ...field,
              from: formula(field.from),
              x: formula(field.x),
              y: formula(field.y),
              z: formula(field.z),
            };
            break;
          case "cut":
            next = { ...field, pos: formula(field.pos) };
            break;
        }
        return [key, next];
      }),
    );
    return { ...item, fields };
  });
  const outputs = Object.fromEntries(
    Object.entries(book.outputs).map(([key, source]) => [
      key,
      rewrite(source, `OUT.${key}`),
    ]),
  );
  return {
    book: dependents.size ? { ...book, items, outputs } : book,
    dependents: [...dependents],
  };
}
