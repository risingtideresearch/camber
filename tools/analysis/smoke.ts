// Run against the independent production artifact, including its real workers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { boxSoup, boxWithSmallOpening } from "../../test/support/meshShapes";
import { decodeProject } from "../../src/stl-workspace/project";
const root = resolve("dist");
const server = createServer(async (req, res) => {
  try {
    let path = resolve(
      root,
      "." + decodeURIComponent(new URL(req.url!, "http://localhost").pathname),
    );
    if (!path.startsWith(root + "/") && path !== root) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
    };
    res.setHeader(
      "Content-Type",
      types[extname(path)] ?? "application/octet-stream",
    );
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const address = server.address();
assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/analysis/`;
const directory = await mkdtemp(join(tmpdir(), "camber-stl-ui-"));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
const errors: string[] = [];
function stl(open = false, defects = false, smallOpening = false) {
  const original = smallOpening
      ? boxWithSmallOpening(open)
      : boxSoup(4, 2, 2, open),
    s = defects
      ? [...original, ...original.slice(0, 9), 0, 0, 0, 0, 0, 0, 0, 0, 0]
      : original,
    buffer = Buffer.alloc(84 + (s.length / 9) * 50);
  buffer.writeUInt32LE(s.length / 9, 80);
  s.forEach((v, i) =>
    buffer.writeFloatLE(v, 84 + Math.floor(i / 9) * 50 + 12 + (i % 9) * 4),
  );
  return {
    name: open ? "open.stl" : "closed.stl",
    mimeType: "application/octet-stream",
    buffer,
  };
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    const actions: string[] = [];
    Object.defineProperty(window, "stlRequests", { value: actions });
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: { action?: { type: string; kind?: string } },
      transfer: Transferable[] = [],
    ) {
      if (message.action)
        actions.push(message.action.kind ?? message.action.type);
      original.call(this, message, transfer);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  await page.goto(url);
  let workers = 0;
  page.on("worker", () => workers++);
  await page.getByLabel("Import STL or analysis project").setInputFiles(stl());
  await page.getByText("Scale not set", { exact: true }).waitFor();
  await page.getByRole("img", { name: "Profile hull projection" }).waitFor();
  assert.equal(await page.getByLabel("Import steps").count(), 0, "No wizard");
  const requests = () =>
    page.evaluate(
      () => (window as unknown as { stlRequests: string[] }).stlRequests,
    );
  assert.ok(
    (await requests()).every((x) => x === "preview"),
    "Opening only parses/previews",
  );
  assert.equal(workers, 1);

  // Unknown scale is a saveable state, not a failed import.
  let downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download project", exact: true })
    .click();
  const partialPath = join(directory, "partial.camber-analysis");
  await (await downloaded).saveAs(partialPath);
  const partialData = await readFile(partialPath);
  const partial = decodeProject(
    partialData.buffer.slice(
      partialData.byteOffset,
      partialData.byteOffset + partialData.byteLength,
    ) as ArrayBuffer,
  );
  assert.equal(partial.configuration.metresPerUnit, 0);
  assert.equal(partial.configuration.waterlineZ, null);
  assert.equal(partial.configuration.wholeSurface, false);
  await page
    .getByLabel("Import STL or analysis project")
    .setInputFiles(partialPath);
  await page.getByText("Scale not set", { exact: true }).waitFor();
  await page.getByText("Downloaded snapshot", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Weights", exact: true }).click();
  await page
    .getByRole("button", { name: "Start an estimate", exact: true })
    .click();
  assert.ok(
    !(await requests()).includes("stability"),
    "Weights does not compute stability",
  );
  await page.getByRole("button", { name: "Hull", exact: true }).click();
  await page.getByRole("button", { name: "Set scale", exact: true }).click();
  await page.getByText("Base length: 4 STL units", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: "Up, bow direction" }).count(),
    0,
  );
  await page
    .getByLabel("STL source units", { exact: true })
    .selectOption("0.001");
  await page
    .getByText("With selected units: 0.004 m", { exact: true })
    .waitFor();
  await page.getByText("Base length: 4 STL units", { exact: true }).waitFor();
  await page
    .getByRole("group", { name: "Choose bow direction" })
    .getByRole("button", { name: "+Y", exact: true })
    .click();
  await page.getByText("Base length: 2 STL units", { exact: true }).waitFor();
  await page
    .getByRole("group", { name: "Choose bow direction" })
    .getByRole("button", { name: "+X", exact: true })
    .click();
  await page.getByLabel("Known length (m)").fill("8");
  await page.getByRole("button", { name: "Set length", exact: true }).click();
  await page.getByText("With selected units: 8 m", { exact: true }).waitFor();
  await page.getByText("Base length: 4 STL units", { exact: true }).waitFor();
  await page.getByLabel("STL source units", { exact: true }).selectOption("1");
  await page
    .getByRole("button", { name: "Apply calibration", exact: true })
    .click();
  await page.getByText("Scale and coordinates set", { exact: true }).waitFor();
  assert.ok(!(await requests()).includes("validate"));
  assert.ok(!(await requests()).includes("stability"));

  // Full-size tabs, plus a truly shared detached weight editor.
  await page.getByRole("button", { name: "Weights", exact: true }).click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open in separate window" }).click();
  const popup = await popupPromise;
  popup.on("pageerror", (e) => errors.push(e.message));
  await popup.locator(".weightpanel").waitFor();
  await page.locator(".stl-project-menu summary").click();
  await page.getByRole("button", { name: "Undo", exact: true }).click(); // calibration
  await page.getByRole("button", { name: "Undo", exact: true }).click(); // add item
  await popup
    .getByRole("button", { name: "Start an estimate", exact: true })
    .waitFor();
  await popup
    .getByRole("button", { name: "Start an estimate", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Start an estimate", exact: true })
      .count(),
    0,
    "Popup edits the authoritative book",
  );
  await popup.close();
  await page.locator(".stl-project-menu summary").click();

  // Restore calibration and request stability, without inventing a waterline.
  await page.getByRole("button", { name: "Hull", exact: true }).click();
  await page.getByRole("button", { name: "Set scale", exact: true }).click();
  await page.getByLabel("STL source units").selectOption("1");
  await page
    .getByRole("button", { name: "Apply calibration", exact: true })
    .click();
  await page.getByText("Scale and coordinates set", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stability", exact: true }).click();
  await page.locator('[id="cond-kg::input"]').waitFor();
  await page.locator('[id="cond-kg::input"]').fill("0.7");
  await page.locator('[id="cond-kg::input"]').press("Enter");
  assert.ok((await requests()).includes("stability"));
  downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download project", exact: true })
    .click();
  const completePath = join(directory, "complete.camber-analysis");
  await (await downloaded).saveAs(completePath);
  const data = await readFile(completePath);
  const complete = decodeProject(
    data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer,
  );
  assert.equal(complete.configuration.waterlineZ, null);
  assert.equal(complete.loading.condition?.kg, 0.7);

  // Fresh browser context reopens directly, with no setup questionnaire.
  const fresh = await browser.newContext({
    viewport: { width: 1200, height: 850 },
  });
  const reopened = await fresh.newPage();
  reopened.on("pageerror", (e) => errors.push(e.message));
  await reopened.goto(url);
  await reopened
    .getByLabel("Import STL or analysis project")
    .setInputFiles(completePath);
  await reopened
    .getByText("Scale and coordinates set", { exact: true })
    .waitFor();
  await reopened
    .getByRole("button", { name: "Stability", exact: true })
    .click();
  await reopened.locator('[id="cond-kg::input"]').waitFor();
  assert.equal(
    await reopened.locator('[id="cond-kg::input"]').inputValue(),
    "0.7",
  );

  // Failed import leaves the project intact.
  await reopened.getByLabel("Import STL or analysis project").setInputFiles({
    name: "bad.stl",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("broken"),
  });
  await reopened.getByRole("alert").waitFor();
  assert.equal(
    await reopened.locator('[id="cond-kg::input"]').inputValue(),
    "0.7",
  );
  await fresh.close();

  // Open-rim validation remains strict and caps are not fabricated.
  await page
    .getByLabel("Import STL or analysis project")
    .setInputFiles(stl(true));
  await page.getByText("Scale not set", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Set scale", exact: true }).click();
  await page.getByLabel("STL source units").selectOption("1");
  await page
    .getByRole("button", { name: "Apply calibration", exact: true })
    .click();
  await page.getByText("Scale and coordinates set", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stability", exact: true }).click();
  await page
    .getByText("Validated open sheer · stops at first rim immersion", {
      exact: true,
    })
    .waitFor();

  // Tiny gaps need no repair interaction, and the assumption can be reversed.
  await page
    .getByLabel("Import STL or analysis project")
    .setInputFiles(stl(false, false, true));
  await page.getByText("Scale not set", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Set scale", exact: true }).click();
  await page.getByLabel("STL source units").selectOption("1");
  await page
    .getByRole("button", { name: "Apply calibration", exact: true })
    .click();
  await page.getByRole("button", { name: "Stability", exact: true }).click();
  await page
    .getByText("1 small gap sealed for calculation.", { exact: true })
    .waitFor();
  await page
    .getByText("Closed envelope · downflooding unknown", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Find bounded repairs" }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Leave small openings unsealed", exact: true })
    .click();
  await page.getByRole("button", { name: "Find bounded repairs" }).waitFor();
  await page.getByRole("button", { name: "Hull", exact: true }).click();
  await page.getByText("Small openings", { exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: "Automatically seal tiny mesh gaps for calculations",
    })
    .click();
  await page.getByRole("button", { name: "Stability", exact: true }).click();
  await page
    .getByText("1 small gap sealed for calculation.", { exact: true })
    .waitFor();

  // Repairs are requested, previewed and explicitly accepted—not an import gate.
  await page
    .getByLabel("Import STL or analysis project")
    .setInputFiles(stl(false, true));
  await page.getByText("Scale not set", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Set scale", exact: true }).click();
  await page.getByLabel("STL source units").selectOption("1");
  await page
    .getByRole("button", { name: "Apply calibration", exact: true })
    .click();
  await page.getByText("Scale and coordinates set", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stability", exact: true }).click();
  await page.getByRole("button", { name: "Find bounded repairs" }).click();
  await page
    .getByRole("button", { name: "Apply repairs", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: "I reviewed" }).count(),
    0,
  );
  assert.ok(
    await page
      .getByRole("button", { name: "Apply repairs", exact: true })
      .isEnabled(),
  );
  await page
    .getByRole("button", { name: "Apply repairs", exact: true })
    .click();
  await page
    .getByText("Closed envelope · downflooding unknown", { exact: true })
    .waitFor();

  // Assetless authoring and opt-in recovery retain unsaved work without pretending
  // that browser storage is a downloaded project.
  const recoveryContext = await browser.newContext();
  const recoveryPage = await recoveryContext.newPage();
  recoveryPage.on("dialog", (d) => void d.accept());
  recoveryPage.on("pageerror", (e) => errors.push(e.message));
  await recoveryPage.goto(url);
  await recoveryPage
    .getByRole("button", { name: "Start a weight book" })
    .click();
  await recoveryPage.getByRole("button", { name: "Start an estimate" }).click();
  await recoveryPage.locator(".stl-project-menu summary").click();
  await recoveryPage
    .getByRole("checkbox", { name: "Keep local recovery copy" })
    .check();
  await recoveryPage
    .getByText("Local recovery updated · still download to keep", {
      exact: true,
    })
    .waitFor();
  await recoveryPage.reload();
  await recoveryPage.getByRole("button", { name: "Recover Untitled" }).click();
  await recoveryPage.getByText("Unsaved changes", { exact: true }).waitFor();
  assert.equal(
    await recoveryPage
      .getByRole("button", { name: "Start an estimate", exact: true })
      .count(),
    0,
  );
  await recoveryContext.close();

  if (process.argv.includes("--examples")) {
    for (const name of ["canvas-back.stl", "cg40.stl", "dev-boat.stl"]) {
      console.log(`  browser example: ${name}`);
      await page
        .getByLabel("Import STL or analysis project")
        .setInputFiles(resolve("examples/stls", name));
      await page.getByText("Scale not set", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Set scale", exact: true })
        .click();
      await page.getByLabel("STL source units").selectOption("0.001");
      await page
        .getByRole("button", { name: "Apply calibration", exact: true })
        .click();
      await page
        .getByText("Scale and coordinates set", { exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Stability", exact: true })
        .click();
      const repairs = page.getByRole("button", {
        name: "Find bounded repairs",
      });
      const ready = page.getByText(
        "Validated open sheer · stops at first rim immersion",
        { exact: true },
      );
      await repairs.or(ready).first().waitFor({ timeout: 300_000 });
      if (name === "cg40.stl") {
        assert.equal(
          await repairs.count(),
          0,
          "cg40 must not require manual repair",
        );
        await page
          .getByText("2 small gaps sealed for calculation.", { exact: true })
          .waitFor();
      } else if (await repairs.isVisible()) {
        await repairs.click();
        await page
          .getByRole("button", { name: "Apply repairs", exact: true })
          .click({ timeout: 300_000 });
      }
      await page
        .getByText("Validated open sheer · stops at first rim immersion", {
          exact: true,
        })
        .waitFor({ timeout: 300_000 });
    }
  }
  await page.getByRole("button", { name: "Hull", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Edit calibration", exact: true })
    .click();
  await page.getByLabel("STL source units").waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Calibration fits phone width",
  );
  assert.deepEqual(errors, []);
  console.log(
    "  ok: progressive import, no eager analysis, full-size views, shared detached editing, unified undo, direct reopen, repairs, loading persistence, local recovery and mobile calibration",
  );
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      console.error(
        "Failed browser state:",
        page.url(),
        await page
          .locator("body")
          .innerText()
          .catch(() => "Page unavailable"),
      );
    }
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
}
