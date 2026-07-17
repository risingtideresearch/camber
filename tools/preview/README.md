# Offline 3D render harness

Renders the hull geometry **headlessly** (no browser) so you can _see_ the mesh/lines/STEP while
debugging — it builds the model from `src/*`, draws an SVG, and rasterizes it to PNG with
[`@resvg/resvg-js`](https://github.com/yisibl/resvg-js). Built for diagnosing bow/keel/transom geometry
issues where you need to look at the actual surface, not just numbers.

## Usage

```sh
cd tools/preview
./render.sh <mode> <preset|yaw> [pitch] [out.png]
```

- **mode**
  - `lines` — white hidden-line lines plan (painter's algorithm), matches the editor's **Lines** view.
  - `shaded` — flat-Lambert shaded mesh (the GL surface). Use this to spot **puckers / creases** at the
    keel and bow; it draws the same `hullGrid` rows the app's 3D view does.
  - `stepnet` — the exported STEP file's NURBS **control net**, parsed back out of the STEP text. Use this
    to check that the STEP export matches the lines view (no overshoot / ill-conditioning).
- **preset** (camera): `3q` (¾ bow), `bow`, `stern`, `side`, `top`, `below` — or pass a numeric `yaw`
  (radians) plus `pitch`.
- Writes `out/<mode>-<preset>.png` (and the intermediate `.svg`) unless you give an explicit path.

## Examples

```sh
./render.sh shaded bow            # head-on bow, shaded — look for keel pucker
./render.sh lines 3q              # the lines view, ¾ bow
./render.sh stepnet -1.15 0.38    # STEP control net at a custom angle
```

Then open the PNG (or, in an agent session, Read it).

## How it works / extending

`render.ts` reuses the real geometry (`mesh.ts`'s `trimmedHullGrid` / `hullGrid`, `buildStep`) and a
projection that matches the WebGL vertex shader in `src/core/draw3d.ts`, so what you see here is faithful to
the app. To add a new view, add a `renderX(P)` that returns an SVG body and wire it into the `mode` switch.

The grids come back FULL WIDTH (starboard sheer → keel → port sheer, the keel an interior column) and already
trimmed, so nothing here mirrors or clips a half-hull; and the hull is positioned in the sheer plan's own
parameter `u ∈ [0,1]`, not in `x`. Coordinates are absolute in the document's unit, so any world-space
constant here is a fraction of the hull's own LOA rather than a fixed number.

Also here, outside `render.sh`: `plan.ts` (the max-beam longitudinal vs the sheer plan), `planview.ts` (the
editor's plan strip through the real `view.ts` mappings) and `profile.ts` (the side elevation: keel, trim,
transom, DWL). Run them like `CAMBER_DOC=/path/to.json npx tsx plan.ts out/plan.png`.

`render.sh` marks `@resvg/resvg-js` as an esbuild external and `npm install`s it here on first run, so the
native rasterizer stays out of the main project's dependencies. Everything generated (`node_modules`,
`render.mjs`, `out/`, scratch `*.svg`/`*.png`) is gitignored.
