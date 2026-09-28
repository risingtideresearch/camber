import { createDocumentHistory } from "../src/document-store/history";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  emptyBook,
  interpretSheetCommand,
  type SheetCommand,
  type WeightBook,
} from "../src/core/sheet/book";
import { bookViolations } from "../src/core/invariants";
import { describeCommand, sameGesture } from "../src/core/commands";
import {
  evaluateBook,
  prepareBook,
  resultAt,
} from "../src/core/sheet/evaluate";
import {
  parseSheet,
  buildSheetJson,
  sheetIsEmpty,
} from "../src/core/sheet/json";
import { resolveScenario } from "../src/core/sheet/resolveScenario";
import { scenarioDiff } from "../src/core/sheet/scenarioDiff";
import { appliesTo, scenariosOf } from "../src/core/sheet/scenarios";
import { prepareTrials, evaluateTrial } from "../src/core/sheet/trial";
import { generateTrial } from "../src/core/sheet/generateTrials";
import { roleTotals } from "../src/core/sheet/rollups";
import {
  planWeightGeometry,
  resolveWeightGeometry,
} from "../src/editor/weightGeometryPlan";
import { register } from "node:module";

const main = "scenario-main",
  alternate = "alternate";
const scoped = (scenarioId: string) => ({ k: "scenario" as const, scenarioId });
function run(book: WeightBook, command: SheetCommand): WeightBook {
  const original = structuredClone(book);
  const outcome = interpretSheetCommand(book, command);
  assert.ok("book" in outcome, "rejected" in outcome ? outcome.rejected : "");
  assert.deepEqual(
    book,
    original,
    "commands never mutate the previous revision",
  );
  assert.deepEqual(bookViolations(outcome.book), []);
  return outcome.book;
}
const reject = (book: WeightBook, command: SheetCommand) =>
  assert.ok("rejected" in interpretSheetCommand(book, command));
let book = emptyBook();
assert.deepEqual(
  scenariosOf(book),
  [],
  "Shared is implicit; a new sheet has no Main scenario",
);
assert.deepEqual(bookViolations(book), []);
book = run(book, { type: "addItem", id: "engine", name: "engine", after: 0 });
book = run(book, {
  type: "addField",
  item: "engine",
  key: "mass",
  kind: "scalar",
});
book = run(book, {
  type: "setFieldUnit",
  item: "engine",
  field: "mass",
  unit: "kg",
});
book = run(book, {
  type: "setFieldRole",
  item: "engine",
  field: "mass",
  role: "MASS",
});
book = run(book, {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "200 ± 10",
});
book = run(book, {
  type: "setFacet",
  item: "engine",
  key: "system",
  value: "propulsion",
});
book = run(book, {
  type: "addRollup",
  id: "propulsion",
  name: "propulsion",
  facetKey: "system",
  facetValue: "propulsion",
});
book = run(book, {
  type: "setOutput",
  name: "DISPLACEMENT",
  formula: "ROLLUP.propulsion.MASS",
});
assert.equal(
  evaluateBook(resolveScenario(book, null), null).outputs.displacement?.v,
  200,
  "Shared is a working, evaluated estimate before scenarios exist",
);
book = run(book, { type: "addScenario", id: main, name: "Main" });
book = run(book, { type: "addScenario", id: alternate, name: "Offshore" });
book = run(book, {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "220 ± 12",
  scope: scoped(alternate),
});
const result = (book: WeightBook, id: string | null) =>
  evaluateBook(resolveScenario(book, id), null);
assert.equal(result(book, main).outputs.displacement?.v, 200);
assert.equal(result(book, alternate).outputs.displacement?.v, 220);
assert.equal(result(book, alternate).outputs.displacement?.worst.hi, 12);
assert.equal(
  book.items[0].fields.mass.k === "scalar" && book.items[0].fields.mass.formula,
  "200 ± 10",
);
assert.equal(scenarioDiff(book, alternate)[0].k, "override");
assert.equal(scenarioDiff(book, alternate)[0].fieldKey, "mass");
assert.equal(scenarioDiff(book, main).length, 0);

// Shared edits affect inheritors, never existing overrides, including equal/empty values.
book = run(book, {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "220 ± 12",
});
assert.equal(scenarioDiff(book, alternate).length, 1);
book = run(book, {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "230",
});
assert.equal(result(book, alternate).outputs.displacement?.v, 220);
assert.equal(result(book, main).outputs.displacement?.v, 230);
const empty = run(book, {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "",
  scope: scoped(alternate),
});
assert.equal(resultAt(result(empty, alternate), "engine", "mass")?.empty, true);
const reset = run(empty, {
  type: "resetScenarioOverrides",
  scenarioId: alternate,
  targets: [{ item: "engine", fieldKey: "mass" }],
});
assert.equal(result(reset, alternate).outputs.displacement?.v, 230);
reject(book, {
  type: "setFieldUnit",
  item: "engine",
  field: "mass",
  unit: "t",
  scope: scoped(alternate),
});
reject(book, {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "100",
  scope: scoped("gone"),
});
reject(book, {
  type: "setScenarioPatch",
  scenarioId: alternate,
  item: "engine",
  fieldKey: "mass",
  patch: { x: "2" },
});
reject(book, {
  type: "resetScenarioOverrides",
  scenarioId: alternate,
  targets: [
    { item: "engine", fieldKey: "mass" },
    { item: "engine", fieldKey: "gone" },
  ],
});
assert.equal(
  scenarioDiff(book, alternate).length,
  1,
  "a failed batch does not partly reset",
);

// Duplication copies overrides, not shared defaults or a parent link.
let duplicate = run(book, {
  type: "addScenario",
  id: "duplicate",
  name: "Copy",
  source: alternate,
});
assert.equal(result(duplicate, "duplicate").outputs.displacement?.v, 220);
duplicate = run(duplicate, {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "240",
  scope: scoped(alternate),
});
assert.equal(result(duplicate, "duplicate").outputs.displacement?.v, 220);

// Membership is effective-book structure, not a visual filter or a substitution of zero.
let excluded = run(book, {
  type: "removeItem",
  item: "engine",
  scope: scoped(alternate),
});
assert.equal(excluded.items.length, 1);
assert.equal(resolveScenario(excluded, alternate).items.length, 0);
assert.equal(
  resolveScenario(excluded, null).items.length,
  1,
  "excluding from a scenario does not remove the shared baseline item",
);
assert.match(
  resultAt(result(excluded, alternate), "OUT", "DISPLACEMENT")?.error ?? "",
  /no contributors/,
  "empty rollups retain the existing no-contributors diagnostic",
);
excluded = run(excluded, {
  type: "setOutput",
  name: "DISPLACEMENT",
  formula: "engine.mass",
});
assert.match(
  resultAt(result(excluded, alternate), "OUT", "DISPLACEMENT")?.error ?? "",
  /unavailable in Offshore/,
);
excluded = run(excluded, {
  type: "setApplicability",
  item: "engine",
  applicability: { k: "all" },
});
excluded = run(excluded, {
  type: "removeField",
  item: "engine",
  key: "mass",
  scope: scoped(alternate),
});
assert.match(
  resultAt(result(excluded, alternate), "OUT", "DISPLACEMENT")?.error ?? "",
  /engine.mass is unavailable/,
);
assert.ok(result(excluded, main).outputs.displacement);
const noFields = resolveScenario(excluded, alternate).items[0];
assert.deepEqual(Object.keys(noFields.fields), []);
assert.ok(
  resolveScenario(excluded, null).items[0].fields.mass,
  "field exclusion also preserves Shared membership",
);
assert.equal(
  roleTotals([noFields], result(excluded, alternate)).get("MASS")?.contributors,
  0,
);

// All includes future scenarios; a selected list of all current scenarios does not.
let membership = run(book, {
  type: "setApplicability",
  item: "engine",
  applicability: { k: "only", scenarios: [main, alternate] },
});
membership = run(membership, { type: "addScenario", id: "new", name: "New" });
assert.equal(resolveScenario(membership, "new").items.length, 0);
assert.equal(
  resolveScenario(
    run(book, { type: "addScenario", id: "new", name: "New" }),
    "new",
  ).items.length,
  1,
);
assert.equal(appliesTo({ k: "all" }, "future"), true);
reject(book, {
  type: "setApplicability",
  item: "engine",
  applicability: { k: "only", scenarios: ["unknown"] },
});

let additions = run(book, {
  type: "addItem",
  id: "generator",
  name: "generator",
  after: 0,
  scope: scoped(alternate),
});
additions = run(additions, {
  type: "addField",
  item: "generator",
  key: "mass",
  kind: "scalar",
  scope: scoped(alternate),
});
additions = run(additions, {
  type: "setFieldFormula",
  item: "generator",
  field: "mass",
  leaf: "formula",
  formula: "50",
  scope: scoped(alternate),
});
assert.equal(
  resolveScenario(additions, main).items.some((i) => i.id === "generator"),
  false,
);
assert.equal(
  resolveScenario(additions, alternate).items.some((i) => i.id === "generator"),
  true,
);
additions = run(additions, {
  type: "addScenario",
  id: "copy",
  name: "Copy",
  source: alternate,
});
assert.equal(
  resolveScenario(additions, "copy").items.some((i) => i.id === "generator"),
  true,
);
const orphan = run(
  run(book, {
    type: "addItem",
    id: "orphan",
    name: "orphan",
    after: 0,
    scope: scoped(alternate),
  }),
  { type: "removeScenario", id: alternate },
);
assert.equal(
  orphan.items.find((i) => i.id === "orphan")?.applicability?.k,
  "only",
);
assert.equal(
  resolveScenario(orphan, main).items.some((i) => i.id === "orphan"),
  false,
);
assert.equal(scenariosOf(orphan).length, 1);
const sharedOnly = run(orphan, { type: "removeScenario", id: main });
assert.deepEqual(
  scenariosOf(sharedOnly),
  [],
  "the last named scenario may be deleted",
);
assert.equal(result(sharedOnly, null).outputs.displacement?.v, 230);

// A shared rename moves the field, retaining overrides and membership under the new key.
const renameSource = run(book, {
  type: "setApplicability",
  item: "engine",
  fieldKey: "mass",
  applicability: { k: "only", shared: true, scenarios: [main, alternate] },
});
const membershipBeforeRename = renameSource.items[0].fields.mass.applicability;
const overridesBeforeRename = renameSource.items[0].fields.mass.overrides;
let renamed = run(renameSource, {
  type: "renameField",
  item: "engine",
  key: "mass",
  name: "weight",
  updateReferences: true,
});
assert.equal(renamed.items[0].fields.mass, undefined);
assert.deepEqual(
  renamed.items[0].fields.weight.overrides,
  overridesBeforeRename,
);
assert.deepEqual(
  renamed.items[0].fields.weight.applicability,
  membershipBeforeRename,
);
assert.ok(
  scenarioDiff(renamed, alternate).every(
    (change) => change.fieldKey === "weight",
  ),
);
reject(renamed, {
  type: "resetScenarioOverrides",
  scenarioId: alternate,
  targets: [{ item: "engine", fieldKey: "" }],
});
reject(renamed, {
  type: "resetScenarioOverrides",
  scenarioId: alternate,
  targets: [{ item: "engine", fieldKey: "mass" }],
});
const resetRenamed = run(renamed, {
  type: "resetScenarioOverrides",
  scenarioId: alternate,
  targets: [{ item: "engine", fieldKey: "weight" }],
});
assert.equal(
  resetRenamed.items[0].fields.weight.overrides?.[alternate],
  undefined,
);
renamed = run(renamed, { type: "removeField", item: "engine", key: "weight" });
renamed = run(renamed, {
  type: "addField",
  item: "engine",
  key: "weight",
  kind: "scalar",
});
assert.equal(renamed.items[0].fields.weight.overrides, undefined);
assert.equal("id" in renamed.items[0].fields.weight, false);
let references = run(book, {
  type: "addField",
  item: "engine",
  key: "double",
  kind: "scalar",
});
references = run(references, {
  type: "setFieldFormula",
  item: "engine",
  field: "double",
  leaf: "formula",
  formula: "mass * 2",
  scope: scoped(alternate),
});
references = run(references, {
  type: "renameField",
  item: "engine",
  key: "mass",
  name: "weight",
  updateReferences: true,
});
assert.equal(
  references.items[0].fields.double.overrides?.[alternate]?.formula,
  "weight * 2",
);
references = run(references, {
  type: "setFieldFormula",
  item: "engine",
  field: "double",
  leaf: "formula",
  formula: "engine.weight * 2",
  scope: scoped(alternate),
});
references = run(references, {
  type: "renameItem",
  item: "engine",
  name: "main engine",
  updateReferences: true,
});
assert.equal(
  references.items[0].fields.double.overrides?.[alternate]?.formula,
  "main engine.weight * 2",
);
assert.equal(
  resultAt(result(references, alternate), "engine", "double")?.reading?.v,
  440,
);

// Dependency preparation and trial plans are per resolved world.
const cyclic = run(book, {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "mass",
  scope: scoped(alternate),
});
assert.match(
  resultAt(result(cyclic, alternate), "engine", "mass")?.error ?? "",
  /itself/,
);
assert.equal(resultAt(result(cyclic, main), "engine", "mass")?.error, null);
const plans = [main, alternate].map((id) =>
  prepareTrials(prepareBook(resolveScenario(book, id))),
);
assert.equal(plans[0].sources.length, 0);
assert.equal(plans[1].sources.length, 1);
const trial = generateTrial(plans[1], 42, 0);
const sample = evaluateTrial(plans[1], trial);
assert.ok(sample);
assert.deepEqual(generateTrial(plans[1], 42, 0), trial);

// Point gestures and boundary patches preserve other inherited properties.
let geometry = run(book, {
  type: "addField",
  item: "engine",
  key: "cg",
  kind: "point",
});
geometry = run(geometry, {
  type: "setPointPosition",
  item: "engine",
  field: "cg",
  x: "1",
  y: "0",
  z: "2",
});
geometry = run(geometry, {
  type: "setPointPosition",
  item: "engine",
  field: "cg",
  x: "3",
  z: "4",
  scope: scoped(alternate),
});
assert.deepEqual(geometry.items[0].fields.cg.overrides?.[alternate], {
  x: "3",
  z: "4",
});
geometry = run(geometry, {
  type: "setPointPosition",
  item: "engine",
  field: "cg",
  y: "5",
});
const cg = resolveScenario(geometry, alternate).items[0].fields.cg;
assert.ok(cg.k === "point");
assert.equal(cg.y, "5");
assert.equal(cg.z, "4");
geometry = run(geometry, {
  type: "addField",
  item: "engine",
  key: "cut",
  kind: "cut",
});
geometry = run(geometry, {
  type: "setFieldFormula",
  item: "engine",
  field: "cut",
  leaf: "pos",
  formula: "0.5",
});
geometry = run(geometry, {
  type: "setFieldFormula",
  item: "engine",
  field: "cut",
  leaf: "pos",
  formula: "1",
  scope: scoped(alternate),
});
const worlds = [main, alternate].map((id) => resolveScenario(geometry, id));
const geometryPlans = worlds.map((world) =>
  planWeightGeometry(world, evaluateBook(world, null)),
);
assert.notEqual(geometryPlans[0].jobs[0].key, geometryPlans[1].jobs[0].key);
assert.equal(resolveWeightGeometry(geometryPlans[1], new Map()).pending, true);
geometry = run(geometry, {
  type: "setCutShape",
  item: "engine",
  field: "cut",
  shape: "transverse",
});
geometry = run(geometry, {
  type: "setSectionBoundary",
  item: "engine",
  field: "cut",
  leaf: "topHeight",
  enabled: true,
});
geometry = run(geometry, {
  type: "setSectionBoundary",
  item: "engine",
  field: "cut",
  leaf: "bottomHeight",
  enabled: true,
  scope: scoped(alternate),
});
geometry = run(geometry, {
  type: "setSectionBoundary",
  item: "engine",
  field: "cut",
  leaf: "topHeight",
  enabled: false,
  scope: scoped(alternate),
});
const section = resolveScenario(geometry, alternate).items[0].fields.cut;
assert.ok(section.k === "cut");
assert.deepEqual(section.boundaryEnabled, {
  topHeight: false,
  bottomHeight: true,
});

// Persistence preserves explicit empty/equal overrides, field keys and dormant membership.
for (const value of [book, empty, additions, orphan, references, geometry]) {
  const encoded = buildSheetJson(value),
    decoded = parseSheet(encoded);
  assert.equal(buildSheetJson(decoded), encoded);
  assert.deepEqual(bookViolations(decoded), []);
  for (const scenario of scenariosOf(value))
    assert.deepEqual(
      scenarioDiff(decoded, scenario.id),
      scenarioDiff(value, scenario.id),
    );
}
const legacy = parseSheet(
  JSON.stringify({
    version: 1,
    items: [
      {
        id: "i",
        name: "old",
        fields: { mass: { k: "scalar", formula: "10" } },
      },
    ],
  }),
);
assert.deepEqual(
  scenariosOf(legacy),
  [],
  "legacy estimates open in Shared, without an automatic Main",
);
assert.equal("id" in legacy.items[0].fields.mass, false);
assert.equal(resultAt(result(legacy, null), "i", "mass")?.reading?.v, 10);
// Older version-2 documents may contain IDs. Import drops them without losing scenario data.
const withOldIds = JSON.parse(buildSheetJson(book));
withOldIds.nextFieldId = 123;
for (const item of withOldIds.items)
  for (const field of Object.values(item.fields))
    (field as Record<string, unknown>).id = "old-field-id";
const withoutIds = parseSheet(JSON.stringify(withOldIds));
assert.equal(buildSheetJson(withoutIds), buildSheetJson(book));
assert.equal("nextFieldId" in withoutIds, false);
assert.ok(
  withoutIds.items.every((item) =>
    Object.values(item.fields).every((field) => !("id" in field)),
  ),
);
const corrupted = JSON.parse(buildSheetJson(book));
corrupted.items[0].fields.mass.overrides[alternate] = { unit: "t" };
corrupted.items[0].applicability = { k: "only", scenarios: ["missing"] };
const recovered = parseSheet(JSON.stringify(corrupted));
assert.deepEqual(recovered.items[0].fields.mass.overrides, undefined);
assert.equal(
  resolveScenario(recovered, main).items.length,
  0,
  "malformed membership never broadens to all",
);
assert.equal(sheetIsEmpty(emptyBook()), true);
assert.equal(
  sheetIsEmpty(
    run(emptyBook(), { type: "addScenario", id: main, name: "Coastal" }),
  ),
  false,
);

const gesture: SheetCommand = {
  type: "setPointPosition",
  item: "engine",
  field: "cg",
  x: "1",
  scope: scoped(main),
};
assert.equal(sameGesture(gesture, { ...gesture, x: "2" }), true);
assert.equal(
  sameGesture(gesture, { ...gesture, scope: scoped(alternate) }),
  false,
);
assert.match(describeCommand(gesture), /scenario-main/);
assert.match(
  describeCommand({ ...gesture, scope: { k: "shared" } }, book),
  /\[Shared\]$/,
);
assert.match(
  describeCommand({ ...gesture, scope: scoped("__shared__") }, book),
  /\[Shared\]$/,
);
assert.ok(
  describeCommand(gesture, book).endsWith(
    `[${scenariosOf(book).find((s) => s.id === main)!.name}]`,
  ),
);
assert.doesNotMatch(describeCommand(gesture, book), /scenario-main/);
assert.equal(
  describeCommand(
    { type: "resetScenarioOverrides", scenarioId: main, targets: [] },
    book,
  ),
  `Reset overrides in ${scenariosOf(book).find((s) => s.id === main)!.name}`,
);
const labelledHistory = createDocumentHistory<WeightBook>({
  initial: book,
  describe: (command, moment) => describeCommand(command, moment),
});
const namedBefore = scenariosOf(book).find((s) => s.id === main)!.name;
const namedAfter = run(book, {
  type: "renameScenario",
  id: main,
  name: "Renamed alternative",
});
labelledHistory.record({
  before: book,
  after: book,
  command: gesture,
  touched: 2,
  author: "test",
});
labelledHistory.record({
  before: book,
  after: namedAfter,
  command: { type: "renameScenario", id: main, name: "Renamed alternative" },
  touched: 2,
  author: "test",
});
assert.ok(
  labelledHistory.timeline().steps[1].label.endsWith(`[${namedBefore}]`),
  "historical labels use names at that moment, even after a rename",
);

// Alternative fields can supply the same role when their memberships are disjoint.
let alternativeRole = run(book, {
  type: "setApplicability",
  item: "engine",
  fieldKey: "mass",
  applicability: { k: "only", scenarios: [main] },
});
alternativeRole = run(alternativeRole, {
  type: "addField",
  item: "engine",
  key: "offshoreMass",
  kind: "scalar",
  scope: scoped(alternate),
});
alternativeRole = run(alternativeRole, {
  type: "setFieldRole",
  item: "engine",
  field: "offshoreMass",
  role: "MASS",
});
assert.equal(
  alternativeRole.items[0].fields.mass.k === "scalar" &&
    alternativeRole.items[0].fields.mass.role,
  "MASS",
);
assert.equal(
  alternativeRole.items[0].fields.offshoreMass.k === "scalar" &&
    alternativeRole.items[0].fields.offshoreMass.role,
  "MASS",
);

// Scenario preparation is explicit; a filtered world can never replace the authored book.
assert.throws(() => prepareBook(book), /Resolve a scenario/);
assert.throws(
  () => buildSheetJson(resolveScenario(book, main)),
  /authored book/,
);
assert.throws(
  () => resolveScenario(resolveScenario(book, main), alternate),
  /authored book/,
);
reject(book, { type: "installSheet", book: resolveScenario(book, alternate) });

const history = createDocumentHistory<WeightBook>({ initial: book });
const mainEdit: SheetCommand = {
  type: "setFieldFormula",
  item: "engine",
  field: "mass",
  leaf: "formula",
  formula: "300",
  scope: scoped(main),
};
const alternateEdit: SheetCommand = {
  ...mainEdit,
  formula: "400",
  scope: scoped(alternate),
};
const mainEdited = run(book, mainEdit),
  bothEdited = run(mainEdited, alternateEdit);
history.record({
  before: book,
  after: mainEdited,
  command: mainEdit,
  touched: 1,
  author: "test",
  at: 1,
});
history.record({
  before: mainEdited,
  after: bothEdited,
  command: alternateEdit,
  touched: 1,
  author: "test",
  at: 2,
});
assert.equal(
  history.timeline().steps.length,
  3,
  "edits to different scenarios never coalesce",
);
assert.deepEqual(history.undo()?.state, mainEdited);
assert.deepEqual(history.undo()?.state, book);
assert.deepEqual(history.redo()?.state, mainEdited);
assert.deepEqual(history.redo()?.state, bothEdited);

// Inspector/picker markup: the workspace control stays compact, and comparison follows selection.
register("./support/ignore-css.mjs", import.meta.url);
const { ScenarioPicker, ScenariosView, ScenarioInputs } =
  await import("../src/editor/weight/ScenarioTools");
const { WeightNavigation } =
  await import("../src/editor/weight/WeightNavigation");
const { Explorer } = await import("../src/editor/weight/Explorer");
const { Problems } = await import("../src/editor/weight/Summary");
for (const destination of ["sheet", "problems", "scenarios"] as const) {
  const navigation = renderToStaticMarkup(
    createElement(WeightNavigation, {
      destination,
      onPick: () => {},
      problemCount: 2,
    }),
  );
  assert.equal((navigation.match(/<button/g) ?? []).length, 3);
  assert.equal((navigation.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(navigation, /Sheet/);
  assert.match(navigation, /Problems/);
  assert.match(navigation, /Scenarios/);
  assert.doesNotMatch(navigation, /Summary|Add an item/);
}
const explorer = renderToStaticMarkup(
  createElement(Explorer, {
    book,
    flagged: new Set<string>(),
    activeItem: null,
    summarySelected: true,
    allSelected: false,
    onOpenSummary: () => {},
    onOpenItem: () => {},
    onOpenField: () => {},
    onOpenAll: () => {},
    onOpenFacet: () => {},
    onAddItem: () => {},
    send: () => {},
  }),
);
assert.match(explorer, /aria-current="page">Summary/);
assert.match(explorer, /All items/);
assert.match(explorer, /Add an item/);
assert.doesNotMatch(explorer, /role="tab"/);
const diagnostics = renderToStaticMarkup(
  createElement(Problems, {
    problems: [
      {
        item: book.items[0],
        fieldKey: "mass",
        leaf: "formula",
        message: "Unknown value",
      },
    ],
    onOpen: () => {},
  }),
);
assert.match(diagnostics, /Open this value in the sheet/);
assert.match(diagnostics, /Unknown value/);
const { ScenarioComparison } =
  await import("../src/editor/weight/ScenarioComparison");
const { assemble } = await import("../src/core/runtime");
const { defaultHull } = await import("../src/core/hull");
const send = () => {};
const picker = renderToStaticMarkup(
  createElement(ScenarioPicker, {
    book,
    active: null,
    onPick: () => {},
    onInspect: () => {},
    send,
  }),
);
assert.match(picker, /Scenario.*Shared/);
assert.doesNotMatch(picker, /Main|Offshore|Input matrix|Membership/);
assert.equal(
  (picker.match(/<button/g) ?? []).length,
  1,
  "only one collapsed workspace control",
);
const focus = { item: "engine", field: "mass", leaf: "formula" as const };
const management = renderToStaticMarkup(
  createElement(ScenariosView, {
    book,
    active: alternate,
    onEdit: () => {},
    send,
    onOpen: () => {},
  }),
);
assert.match(management, /Reset to Shared/);
assert.match(management, /Changes from Shared/);
assert.match(management, /Membership/);
assert.match(management, /Rename scenario/);
assert.match(management, /Delete scenario/);
assert.match(management, /Open in sheet/);
assert.doesNotMatch(management, /Select an item or field/);
const emptyManagement = renderToStaticMarkup(
  createElement(ScenariosView, {
    book: emptyBook(),
    active: null,
    send,
    onOpen: () => {},
    onEdit: () => {},
  }),
);
assert.match(emptyManagement, /No alternatives yet/);
assert.match(emptyManagement, /New scenario/);
assert.doesNotMatch(emptyManagement, /Delete scenario|Rename scenario/);
const inputs = renderToStaticMarkup(
  createElement(ScenarioInputs, {
    book,
    item: book.items[0],
    fieldKey: "mass",
    workspaceIds: [null, alternate],
    send,
  }),
);
assert.match(inputs, /Compare input formulas/);
assert.match(inputs, /· override/);
const model = assemble(defaultHull());
const compare = renderToStaticMarkup(
  createElement(ScenarioComparison, {
    book,
    active: alternate,
    focus,
    output: null,
    scope: { k: "all" },
    model,
    sampling: null,
    metrics: null,
    send,
  }),
);
assert.match(compare, /engine.mass/);
assert.match(compare, /Current workspace/);
assert.doesNotMatch(compare, /Comparison baseline/);
assert.equal(
  (compare.match(/<select/g) ?? []).length,
  1,
  "only the other workspace is selectable",
);
assert.ok(
  compare.includes(
    `<strong>${scenariosOf(book).find((s) => s.id === alternate)!.name}</strong>`,
  ),
);
const sharedComparison = renderToStaticMarkup(
  createElement(ScenarioComparison, {
    book,
    active: null,
    focus,
    output: null,
    scope: { k: "all" },
    model,
    sampling: null,
    metrics: null,
    send,
  }),
);
assert.match(sharedComparison, /<strong>Shared<\/strong>/);
assert.doesNotMatch(sharedComparison, /<option[^>]*value="__shared__"/);
assert.match(compare, /Difference = other/);
assert.match(compare, /Difference/);
assert.match(compare, /220/);
assert.match(compare, /230/);
assert.doesNotMatch(compare, /Inspect item|wscenario-table/);
const emptyComparison = renderToStaticMarkup(
  createElement(ScenarioComparison, {
    book: emptyBook(),
    active: null,
    focus: null,
    output: null,
    scope: { k: "all" },
    model,
    sampling: null,
    metrics: null,
    send,
  }),
);
assert.match(emptyComparison, /Create an alternative/);
console.log(
  "Scenarios: Shared-first editing, optional scenarios, preserved baseline membership, diffs, trials, persistence and inspector UI passed",
);
