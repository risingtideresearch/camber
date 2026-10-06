import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Only model-independent UI. Never copy controllers, workers, geometry or loading state.
const files = [
  "Button.tsx",
  "Button.css",
  "ButtonGroup.tsx",
  "ButtonGroup.css",
  "Dropdown.tsx",
  "Dropdown.css",
  "ChartFrame.tsx",
  "ChartFrame.css",
  "StabilityView.tsx",
  "StabilityView.css",
  "chartPaths.ts",
];
const args = process.argv.slice(2),
  index = args.indexOf("--target");
if (
  index < 0 ||
  !args[index + 1] ||
  args.some((v, i) => i !== index + 1 && !["--target", "--check"].includes(v))
) {
  console.error(
    "Usage: node tools/sync-hydrostatic-frontend.mjs --target <standalone-directory> [--check]",
  );
  process.exit(1);
}
const project = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  target = resolve(args[index + 1]);
if (target === project)
  throw new Error(
    "The target must be the independent application, not the source project",
  );
await access(resolve(target, "package.json"));
const check = args.includes("--check"),
  missing = [];
for (const name of files) {
  const content = await readFile(resolve(project, "src/components", name));
  // Shared source may import React and the other shared presentation files only.
  for (const [, specifier] of content
    .toString()
    .matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)) {
    if (specifier === "react") continue;
    if (
      !specifier.startsWith("./") ||
      !files.some(
        (file) =>
          specifier === `./${file}` ||
          specifier === `./${file.replace(/\.tsx?$/, "")}`,
      )
    )
      throw new Error(
        `${name} imports a non-presentation dependency: ${specifier}`,
      );
  }
  const destination = resolve(target, "src/components", name);
  if (check) {
    try {
      if (!(await readFile(destination)).equals(content)) missing.push(name);
    } catch {
      missing.push(name);
    }
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}
if (missing.length) {
  console.error(`Frontend copies differ: ${missing.join(", ")}`);
  process.exitCode = 1;
} else
  console.log(
    `${check ? "Verified" : "Copied"} ${files.length} model-independent frontend files.`,
  );
