# Offline 3D render harness

Renders the hull geometry **headlessly** (no browser) so you can *see* the mesh/lines/STEP while
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
    keel and bow; it mirrors `render.ts`'s `bilgeRows` (full-width rows, cosine station spacing).
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

`render.ts` reuses the real geometry (`trimmedHullGrid`, `sweptSection`, `buildStep`, `forwardLimit`) and a
projection that matches the WebGL vertex shader in `src/render.ts`, so what you see here is faithful to the
app. To add a new view, add a `renderX(P)` that returns an SVG body and wire it into the `mode` switch.

`render.sh` marks `@resvg/resvg-js` as an esbuild external and `npm install`s it here on first run, so the
native rasterizer stays out of the main project's dependencies. Everything generated (`node_modules`,
`render.mjs`, `out/`, scratch `*.svg`/`*.png`) is gitignored.
