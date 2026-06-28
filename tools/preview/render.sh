#!/usr/bin/env bash
# Offline 3D render harness — bundles src/* with esbuild, builds the hull, rasterizes SVG→PNG via resvg.
# First run installs @resvg/resvg-js locally (kept out of the main project's package.json).
#
#   ./render.sh <mode> <preset|yaw> [pitch] [out.png]
#   mode:   lines | shaded | stepnet
#   preset: 3q | bow | stern | side | top | below   (or a numeric yaw + pitch in radians)
#
# Examples:
#   ./render.sh shaded bow
#   ./render.sh lines 3q
#   ./render.sh stepnet -1.15 0.38 out/step.png
set -e
cd "$(dirname "$0")"
[ -d node_modules/@resvg/resvg-js ] || npm install --silent
npx esbuild render.ts --bundle --platform=node --format=esm \
  --external:@resvg/resvg-js --outfile=render.mjs --log-level=error
node render.mjs "$@"
