// Incremental immersion of the same closed station polygons used by sweep.cut.
// Each edge changes dry → crossing → submerged only once during an ascending
// sweep. Keep the submerged-edge boundary integrals and update only the crossing
// edges at each height. Green's theorem gives the same area/first/second moments
// as triangle integration, including concave outlines and their closure edges.
import type { BuoyancyCut, Column, StationGeom } from "./sweep";

// Raw shoelace sums: divide by 2, 6, 6, 12, 24 to obtain A, Ma, Mz, Maa, Maz.
function addEdge(
  sums: Float64Array,
  a: number,
  z: number,
  b: number,
  w: number,
) {
  const cross = a * w - b * z;
  sums[0] += cross;
  sums[1] += (a + b) * cross;
  sums[2] += (z + w) * cross;
  sums[3] += (a * a + a * b + b * b) * cross;
  sums[4] += (2 * a * z + a * w + b * z + 2 * b * w) * cross;
}

class Outline {
  readonly points: Float64Array;
  readonly edgeSums: Float64Array;
  readonly full = new Float64Array(5);
  readonly a0: number;
  readonly z0: number;
  readonly sign: number;

  constructor(readonly column: Column) {
    const poly = column.poly,
      n = poly.length;
    if (n < 3)
      throw new Error("Immersion sweep requires closed station polygons");
    // Translate before forming products to avoid cancellation from the authored
    // origin. Translate the resulting moments back only after summing edges.
    this.a0 = poly[0][0];
    this.z0 = poly[0][1];
    this.points = new Float64Array(2 * n);
    this.edgeSums = new Float64Array(5 * n);
    const sums = new Float64Array(5);
    for (let i = 0; i < n; i++) {
      this.points[2 * i] = poly[i][0] - this.a0;
      this.points[2 * i + 1] = poly[i][1] - this.z0;
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const edge = this.edgeSums.subarray(5 * i, 5 * i + 5);
      addEdge(
        edge,
        this.points[2 * i],
        this.points[2 * i + 1],
        this.points[2 * j],
        this.points[2 * j + 1],
      );
      for (let k = 0; k < 5; k++) sums[k] += edge[k];
    }
    this.sign = sums[0] < 0 ? -1 : 1;
    this.translate(sums, this.full);
    if (this.full.some((v) => !Number.isFinite(v)))
      throw new Error("Non-finite station moments in immersion sweep");
  }

  translate(sums: Float64Array, out: Float64Array) {
    const A = (this.sign * sums[0]) / 2,
      Ma = (this.sign * sums[1]) / 6,
      Mz = (this.sign * sums[2]) / 6;
    out[0] = A;
    out[1] = Ma + this.a0 * A;
    out[2] = Mz + this.z0 * A;
    out[3] = (this.sign * sums[3]) / 12 + 2 * this.a0 * Ma + this.a0 ** 2 * A;
    out[4] =
      (this.sign * sums[4]) / 24 +
      this.a0 * Mz +
      this.z0 * Ma +
      this.a0 * this.z0 * A;
  }
}

class SectionSweep {
  readonly heights: number[];
  readonly order: number[];
  readonly lo: number;
  readonly hi: number;
  readonly crossA: Float64Array;
  readonly crossZ: Float64Array;
  readonly active: number[] = []; // crossing edges, in polygon traversal order
  readonly wet: Uint8Array;
  readonly submerged = new Float64Array(5);
  readonly sums = new Float64Array(5);
  readonly result = new Float64Array(5);
  private next = 0;

  constructor(
    readonly outline: Outline,
    C0: number,
    C1: number,
    C2: number,
  ) {
    const poly = outline.column.poly,
      n = poly.length;
    this.heights = poly.map((v) => {
      const h = C0 + C1 * v[0] + C2 * v[1];
      if (!Number.isFinite(h))
        throw new Error("Non-finite station height in immersion sweep");
      return h;
    });
    this.order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => this.heights[a] - this.heights[b],
    );
    this.lo = this.heights[this.order[0]];
    this.hi = this.heights[this.order[n - 1]];
    this.wet = new Uint8Array(n);
    this.crossA = new Float64Array(n);
    this.crossZ = new Float64Array(n);
  }

  moments(h: number): Float64Array {
    const { outline, heights, order, active, wet } = this;
    const n = heights.length;
    // Exact plateaus, including a plane parallel to the entire station polygon.
    if (h >= this.hi) {
      active.length = 0;
      return outline.full;
    }
    if (h <= this.lo) {
      this.result.fill(0);
      return this.result;
    }
    while (this.next < n && heights[order[this.next]] <= h) {
      const vertex = order[this.next++];
      wet[vertex] = 1;
      for (let incident = 0; incident < 2; incident++) {
        const edge = incident ? vertex : (vertex + n - 1) % n;
        const other = incident ? (vertex + 1) % n : edge;
        if (wet[other]) {
          const index = active.indexOf(edge);
          if (index >= 0) {
            for (let k = index; k + 1 < active.length; k++)
              active[k] = active[k + 1];
            active.length--;
          }
          for (let k = 0; k < 5; k++)
            this.submerged[k] += outline.edgeSums[5 * edge + k];
        } else {
          let index = active.length;
          active.push(edge);
          while (index > 0 && active[index - 1] > edge) {
            active[index] = active[index - 1];
            index--;
          }
          active[index] = edge;
        }
      }
    }
    this.sums.set(this.submerged);
    const p = outline.points;
    for (let i = 0; i < active.length; i++) {
      const edge = active[i],
        j = (edge + 1) % n;
      const t = (h - heights[edge]) / (heights[j] - heights[edge]);
      const a = p[2 * edge] + (p[2 * j] - p[2 * edge]) * t,
        z = p[2 * edge + 1] + (p[2 * j + 1] - p[2 * edge + 1]) * t;
      this.crossA[i] = a;
      this.crossZ[i] = z;
      if (wet[edge]) addEdge(this.sums, p[2 * edge], p[2 * edge + 1], a, z);
      else addEdge(this.sums, a, z, p[2 * j], p[2 * j + 1]);
    }
    // Each exiting crossing connects to the following entering crossing. This
    // also handles multiple wet runs in a re-entrant outline; never replace them
    // by a single outermost strip for volume integration.
    for (let i = 0; i < active.length; i++) {
      if (!wet[active[i]]) continue;
      const j = (i + 1) % active.length;
      addEdge(
        this.sums,
        this.crossA[i],
        this.crossZ[i],
        this.crossA[j],
        this.crossZ[j],
      );
    }
    outline.translate(this.sums, this.result);
    // Boundary sums subtract finite edge terms at a tangent plane. When the
    // immersed area (or remaining dry cap) is tiny, triangle integration rooted
    // at a clipped vertex is better conditioned. This rare fallback preserves
    // meaningful centroids even for vanishingly small positive volumes.
    const tangentArea = outline.full[0] * 1e-7;
    if (
      this.result[0] < tangentArea ||
      outline.full[0] - this.result[0] < tangentArea
    )
      return this.tangentMoments(h);
    return this.result;
  }

  private tangentMoments(h: number): Float64Array {
    const poly = this.outline.column.poly;
    const clipped: [number, number][] = [];
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const fa = h - this.heights[i],
        fb = h - this.heights[j];
      if (fa >= 0) clipped.push([poly[i][0], poly[i][1]]);
      if (fa >= 0 !== fb >= 0) {
        const t = fa / (fa - fb);
        clipped.push([
          poly[i][0] + (poly[j][0] - poly[i][0]) * t,
          poly[i][1] + (poly[j][1] - poly[i][1]) * t,
        ]);
      }
    }
    const out = this.result;
    out.fill(0);
    const p0 = clipped[0];
    for (let i = 1; i + 1 < clipped.length; i++) {
      const p1 = clipped[i],
        p2 = clipped[i + 1];
      const at =
        ((p1[0] - p0[0]) * (p2[1] - p0[1]) -
          (p2[0] - p0[0]) * (p1[1] - p0[1])) /
        2;
      const sa = p0[0] + p1[0] + p2[0],
        sz = p0[1] + p1[1] + p2[1];
      out[0] += at;
      out[1] += (at * sa) / 3;
      out[2] += (at * sz) / 3;
      out[3] += (at * (p0[0] ** 2 + p1[0] ** 2 + p2[0] ** 2 + sa ** 2)) / 12;
      out[4] +=
        (at * (p0[0] * p0[1] + p1[0] * p1[1] + p2[0] * p2[1] + sa * sz)) / 12;
    }
    const sign = out[0] < 0 ? -1 : 1;
    for (let k = 0; k < 5; k++) out[k] *= sign;
    return out;
  }
}

function addStrip(
  values: Float64Array,
  index: number,
  c: Column,
  weight: number,
  lo: number,
  hi: number,
  divisor: number,
  ax: number,
  bx: number,
  ay: number,
  by: number,
) {
  const m0 = hi - lo,
    m1 = (hi ** 2 - lo ** 2) / 2,
    m2 = (hi ** 3 - lo ** 3) / 3,
    m3 = (hi ** 4 - lo ** 4) / 4;
  const W0 = ((c.speed * m0 + c.kSpeed * m1) / divisor) * weight,
    W1 = ((c.speed * m1 + c.kSpeed * m2) / divisor) * weight,
    W2 = ((c.speed * m2 + c.kSpeed * m3) / divisor) * weight;
  values[index + 4] += W0;
  values[index + 5] += ax * W0 + bx * W1;
  values[index + 6] += ay * W0 + by * W1;
  values[index + 7] += ax * ax * W0 + 2 * ax * bx * W1 + bx * bx * W2;
  values[index + 8] += ay * ay * W0 + 2 * ay * by * W1 + by * by * W2;
}

/** Evaluate a whole ascending immersion row without reclipping every polygon.
 * The geometry is read-only; all mutable edge/event state belongs to this call. */
export function sweepBuoyancy(
  g: StationGeom,
  heelRad: number,
  offsets: readonly number[],
): BuoyancyCut[] {
  return prepareImmersionSweep(g)(heelRad, offsets);
}

/** Reuse attitude-independent outlines across heels at this fixed trim.
 * Each invocation gets fresh event state and requires ascending offsets. */
export function prepareImmersionSweep(
  g: StationGeom,
): (heelRad: number, offsets: readonly number[]) => BuoyancyCut[] {
  const outlines = g.cols.map((c) => new Outline(c));
  return (heelRad, offsets) => sweepPrepared(g, outlines, heelRad, offsets);
}

function sweepPrepared(
  g: StationGeom,
  outlines: readonly Outline[],
  heelRad: number,
  offsets: readonly number[],
): BuoyancyCut[] {
  if (
    offsets.some(
      (h, i) => !Number.isFinite(h) || (i > 0 && h <= offsets[i - 1]),
    )
  )
    throw new Error("Immersion offsets must be finite and strictly increasing");
  if (
    !Number.isFinite(heelRad) ||
    !Number.isFinite(g.cosTrim) ||
    !Number.isFinite(g.sinTrim)
  )
    throw new Error("Invalid immersion attitude");
  if (!offsets.length) return [];
  const cosPhi = Math.cos(heelRad),
    sinPhi = Math.sin(heelRad);
  const upright = Math.abs(sinPhi) < 1e-12;
  const C2 = g.cosTrim * cosPhi;
  const measurable = Math.abs(C2) > 1e-9;
  let sheerZ = Infinity;
  for (const c of g.cols) {
    if (!c.topIsSheer) continue;
    for (const side of [1, -1]) {
      const C0 = c.px * g.sinTrim * cosPhi - side * c.py * sinPhi,
        C1 = c.nx * g.sinTrim * cosPhi - side * c.ny * sinPhi;
      sheerZ = Math.min(sheerZ, c.topZ * C2 + c.topA * C1 + C0);
    }
  }
  // V, Qx, Qy, Qz and the five raw waterplane moments per offset. Each column's
  // trapezoidal weight is fixed, so it can contribute all heights in one pass.
  const values = new Float64Array(offsets.length * 9);
  for (let columnIndex = 0; columnIndex < g.cols.length; columnIndex++) {
    const c = g.cols[columnIndex];
    const prevU = columnIndex ? g.cols[columnIndex - 1].u : c.u,
      nextU = columnIndex + 1 < g.cols.length ? g.cols[columnIndex + 1].u : c.u;
    const weight = (nextU - prevU) / 2;
    const outline = outlines[columnIndex];
    for (const side of [1, -1]) {
      const C0 = c.px * g.sinTrim * cosPhi - side * c.py * sinPhi,
        C1 = c.nx * g.sinTrim * cosPhi - side * c.ny * sinPhi;
      const sweep = new SectionSweep(outline, C0, C1, C2);
      const crossings: number[] = [];
      for (let sample = 0; sample < offsets.length; sample++) {
        const h = offsets[sample],
          index = sample * 9;
        const m = sweep.moments(h);
        if (m[0] <= 0) continue;
        const w0 = c.speed * m[0] + c.kSpeed * m[1],
          w1 = c.speed * m[1] + c.kSpeed * m[3],
          wz = c.speed * m[2] + c.kSpeed * m[4];
        values[index] += w0 * weight;
        values[index + 1] += (c.px * w0 + c.nx * w1) * weight;
        values[index + 2] += side * (c.py * w0 + c.ny * w1) * weight;
        values[index + 3] += wz * weight;
        if (!measurable || h > sheerZ || !sweep.active.length) continue;
        if (upright) {
          let bestA = Infinity;
          for (let i = 0; i < sweep.active.length; i++)
            if (c.poly[sweep.active[i]][2])
              bestA = Math.min(bestA, sweep.crossA[i] + outline.a0);
          if (bestA < c.aC)
            addStrip(
              values,
              index,
              c,
              weight,
              bestA,
              c.aC,
              g.cosTrim,
              (c.px - g.sinTrim * h) / g.cosTrim,
              c.nx / g.cosTrim,
              side * c.py,
              side * c.ny,
            );
        } else {
          crossings.length = 0;
          for (let i = 0; i < sweep.active.length; i++)
            crossings.push(sweep.crossA[i] + outline.a0);
          crossings.sort((a, b) => a - b);
          const z0 = (h - C0) / C2,
            z1 = -C1 / C2;
          const ax = c.px * g.cosTrim - z0 * g.sinTrim,
            bx = c.nx * g.cosTrim - z1 * g.sinTrim,
            ay =
              side * c.py * cosPhi +
              (c.px * g.sinTrim + z0 * g.cosTrim) * sinPhi,
            by =
              side * c.ny * cosPhi +
              (c.nx * g.sinTrim + z1 * g.cosTrim) * sinPhi;
          for (let i = 0; i + 1 < crossings.length; i += 2)
            addStrip(
              values,
              index,
              c,
              weight,
              crossings[i],
              crossings[i + 1],
              Math.abs(C2),
              ax,
              bx,
              ay,
              by,
            );
        }
      }
    }
  }
  return offsets.map((h, sample) => {
    const i = sample * 9,
      vol = values[i],
      wA = values[i + 4];
    return {
      vol,
      xB: vol > 0 ? values[i + 1] / vol : 0,
      yB: vol > 0 ? values[i + 2] / vol : 0,
      zB: vol > 0 ? values[i + 3] / vol : 0,
      deckDown: sheerZ < h,
      wp:
        wA > 1e-9
          ? {
              area: wA,
              cx: values[i + 5] / wA,
              cy: values[i + 6] / wA,
              it: values[i + 8] - values[i + 6] ** 2 / wA,
              il: values[i + 7] - values[i + 5] ** 2 / wA,
            }
          : null,
    };
  });
}
