import type { WeightBook } from "./book";
import {
  appliesTo,
  applyFieldPatch,
  scenariosOf,
  SHARED_WORKSPACE,
} from "./scenarios";

/** One effective world. Shared formulas resolve against this world's membership, not a UI filter. */
export function resolveScenario(
  book: WeightBook,
  scenarioId: string | null,
): WeightBook {
  if (book.scenarioContext)
    throw new Error(
      "Resolve scenarios from the authored book, not an effective world",
    );
  const scenario =
    scenarioId === null
      ? { id: SHARED_WORKSPACE, name: "Shared" }
      : scenariosOf(book).find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  return {
    ...book,
    scenarioContext: {
      id: scenario.id,
      name: scenario.name,
      ...(scenarioId === null ? { shared: true } : {}),
      authoredItems: book.items,
    },
    items: book.items
      .filter((item) => appliesTo(item.applicability, scenarioId))
      .map((item) => ({
        ...item,
        fields: Object.fromEntries(
          Object.entries(item.fields)
            .filter(([, field]) => appliesTo(field.applicability, scenarioId))
            .map(([key, field]) => [
              key,
              applyFieldPatch(
                field,
                scenarioId === null ? undefined : field.overrides?.[scenarioId],
              ),
            ]),
        ),
      })),
  };
}
