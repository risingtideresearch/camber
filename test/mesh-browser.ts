/// <reference types="vite/client" />
// Executable in Vite dev AND the separate subpath-hosted spike build. No Node or Playwright dependency.
import React from "react";
import { createRoot } from "react-dom/client";
import { StabilityPanel } from "../src/analysis/ui/StabilityPanel";
import { emptyBook } from "../src/core/sheet/book";
import { evaluateBook } from "../src/core/sheet/evaluate";
import { createStlAnalysisClient } from "../src/analysis/mesh/client";
import { METRE_SETUP } from "../src/analysis/mesh/prepare";
import { defaultHull } from "../src/core/hull";
import { assemble, defaultSession } from "../src/core/runtime";
import { buildStl } from "../src/core/stl";
import { boxSoup, subdivide } from "./support/meshShapes";
import type { StabilityData } from "../src/analysis/api";
const output = document.getElementById("results")!;
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
function binary(soup: readonly number[]) {
  const buffer = new ArrayBuffer(84 + (soup.length / 9) * 50),
    v = new DataView(buffer);
  v.setUint32(80, soup.length / 9, true);
  for (let i = 0; i < soup.length; i++)
    v.setFloat32(84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4, soup[i], true);
  return buffer;
}
async function run() {
  let soup = boxSoup();
  for (let i = 0; i < 5; i++) soup = subdivide(soup);
  const state = defaultHull(),
    model = assemble(state, defaultSession(state));
  const fixtures = [
    {
      name: "12288-triangle box",
      buffer: binary(soup),
      scale: 1,
      deckClosure: undefined,
      waterline: 1,
    },
    {
      name: "Camber STL",
      buffer: new TextEncoder().encode(buildStl(model)).buffer,
      scale: 0.001,
      deckClosure: { accepted: true as const, closureId: "confirmed" },
      waterline: -model.waterline * 0.001,
    },
  ];
  const rows = [];
  let tables: StabilityData | undefined;
  for (const [i, f] of fixtures.entries()) {
    const start = performance.now(),
      client = createStlAnalysisClient(f.buffer, {
        physical: { ...METRE_SETUP, metresPerUnit: f.scale },
        analysis: {
          id: `browser-${i}`,
          fixedTrim: 0,
          keelZ: 0,
          referenceWaterlineZ: f.waterline,
        },
        deckClosure: f.deckClosure,
      });
    try {
      const report = await client.ready,
        prepareMs = performance.now() - start;
      check(f.buffer.byteLength > 0, "Original asset was detached");
      const times: number[] = [];
      for (let j = 0; j < 60; j++) {
        const t = performance.now();
        const answer = await client.hull.section({
          plane: {
            origin: [0.5 + (3 * (j + 0.4)) / 60, 0, 0],
            u: [0, 1, 0],
            v: [0, 0, 1],
          },
          envelope: "buoyancy",
        });
        check(
          answer.contextId === `browser-${i}` &&
            answer.result.status === "available",
          "Section failed",
        );
        times.push(performance.now() - t);
      }
      const t = performance.now(),
        [stability, independent] = await Promise.all([
          client.hull.stability(),
          client.hull.section({
            plane: { origin: [2, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
            envelope: "buoyancy",
          }),
        ]);
      if (stability.result.status !== "available")
        throw new Error(stability.result.reason);
      check(
        independent.result.status === "available",
        "An independent query was discarded",
      );
      const stabilityMs = performance.now() - t,
        again = performance.now();
      await client.hull.stability();
      const cachedMs = performance.now() - again;
      if (i === 0) {
        tables = stability.result.value;
        check(Math.abs(tables.hydro!.vol - 8) < 1e-8, "Analytic volume failed");
        check(
          tables.availability!.sheer.status === "unavailable",
          "Unannotated sheer became known",
        );
      }
      times.sort((a, b) => a - b);
      rows.push({
        fixture: f.name,
        triangles: report.triangles,
        prepareMs: +prepareMs.toFixed(1),
        sectionP95Ms: +times[57].toFixed(2),
        stabilityMs: +stabilityMs.toFixed(1),
        cachedMs: +cachedMs.toFixed(3),
      });
    } finally {
      client.dispose();
    }
  }
  // Terminate actual in-flight worker work, not only a fake transport or cached result.
  const cancellation = createStlAnalysisClient(fixtures[0].buffer, {
    physical: METRE_SETUP,
    analysis: { id: "cancel", fixedTrim: 0, keelZ: 0, referenceWaterlineZ: 1 },
  });
  await cancellation.ready;
  const pending = cancellation.hull.stability();
  setTimeout(() => cancellation.dispose(), 10);
  let aborted = false;
  try {
    await pending;
  } catch (e) {
    aborted = e instanceof DOMException && e.name === "AbortError";
  }
  check(aborted, "Worker disposal did not abort in-flight stability");
  // Table-only rendering must label an unknown sheer as unknown, not ">90°".
  const book = emptyBook();
  createRoot(document.getElementById("panel")!).render(
    React.createElement(StabilityPanel, {
      stability: { status: "available", value: tables! },
      unit: "m",
      density: 1.025,
      sheetResults: evaluateBook(book, null),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    document
      .getElementById("panel")!
      .textContent?.includes("Sheer immersion is unknown"),
    "Missing unknown-reference warning",
  );
  output.textContent = JSON.stringify({ passed: true, rows }, null, 2);
  output.dataset.state = "passed";
}
void run().catch((error) => {
  output.dataset.state = "failed";
  output.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(error);
});
