// ============================================================================================
//  random.ts — generating hull designs by REPARAMETERIZING the unconstrained vector space
// ============================================================================================
//
// STATUS: not wired into the UI. The "Randomize" button was removed — the sampled hulls aren't yet
// convincing enough — and this module is kept as a documented, self-contained reference for the
// reparameterization approach and as the basis for the next iteration. The exports
// `randomDoc(adventure)`, `meanDoc()`, and `randomizeModel()` remain, so it can be re-hooked to a
// button or driven from the console / a test without further plumbing.
//
// ---- the problem: validity is not realism -------------------------------------------------
// The README's "Unconstrained parameterization" gives a flat real vector θ ∈ ℝᴹ in which every
// coordinate is free and the decode φ: ℝᴹ → variant is a per-slot monotone bijection, so EVERY θ
// decodes to a valid hull (no feasible region to respect). That guarantees VALIDITY, not REALISM:
// a boat hull is a smooth, strongly-coupled, low-dimensional object, so the valid hulls that also
// look like boats form a thin, curved manifold inside ℝᴹ. A flat / independent prior on θ (what the
// raw encoding invites) lands almost everywhere EXCEPT on that manifold ⇒ lumpy, non-closing junk.
//
// ---- the approach: bake the prior into the coordinates, not the sampler -------------------
// Two ways to get boat-like samples:
//   (a) keep φ flat and draw θ from a clever distribution — a SAMPLER prior. Only the sampler then
//       benefits; an optimizer / autodiff / editor still sees the ill-conditioned flat space.
//   (b) change variables so the SIMPLE prior (small θ, independent unit normals) already lands on
//       boats, while φ stays a bijection onto the whole valid region — a REPARAMETERIZATION.
// This file does (b). `decodeDoc` is a TRIANGULAR (autoregressive) change of variables: coordinates
// are consumed strictly in dependency order, and each downstream slot is
//        slot = predict(already-decoded slots)  ∘  residual(next θ coordinate)
// Each residual enters through a monotone map (eᵘ on positive rays, additive on free reals, the
// shifted logistic on bounded intervals — see the residual decoders below), so the whole composite
// is a diffeomorphism of ℝᴹ:
//   • REACHABILITY is untouched — every valid hull is still some θ (generality preserved);
//   • θ = 0 lands on a deliberate CANONICAL boat (every residual is the identity there);
//   • small θ stays near it (boat-like); large θ ranges out to the rest of the valid region.
// The only price: the change-of-variables Jacobian is no longer diagonal (it is triangular). For
// purely deterministic use (optimization of a geometric objective) that is irrelevant; but if a
// DENSITY is ever placed on θ (sampling / MAP — see the README "For sampling and priors" note) the
// log-density must carry the triangular log-det Σⱼ log φ′ⱼ, now WITH cross terms.
//
// ---- couplings expressed as coordinate axes (the "transform of another parameter" idea) ---
//   #2  PER-POINT residuals shrunk toward a smooth BACKBONE. The plan beam, the sheer line, and the
//       section are each a few-parameter backbone curve PLUS a small per-control-point deviation. At
//       θ = 0 the deviations vanish (pure backbone = a fair curve); they grow with θ toward arbitrary
//       curves. Residuals are multiplicative (eᵘ) on the non-negative slots (half-breadth, depth,
//       depth-steps) so those stay valid for ANY θ, and additive on the free slot (inboard n).
//   #3  the section's keel REACH is a residual on the decoded BEAM, not an independent number:
//             reach = (maxBeam / Tx) · eᵖ ,   ρ = one coordinate
//       ρ = 0 closes the bottom with a margin; ρ → −∞ opens it; ρ → +∞ overshoots. "Does the hull
//       close" becomes a single interpretable axis instead of a coincidence the sampler must hit.
//       Geometry: at a station the world half-breadth of a section point at inboard offset n is
//       y = beam + n·n̂_y with n̂_y = −Tx, where Tx is the x-component of the unit sheer-plan tangent
//       (so n̂ swings inboard as the sheer turns). The section reaches the centerline where n = beam/Tx.
//       The lofted n-values run LINEARLY aft→fore (two stations ⇒ a straight loft) but the beam BULGES
//       amidships, so the binding station is the widest one — we bind reach on max(beam/Tx) over the
//       hull, not on the ends.
//   #4  the aft and fore STATIONS are carried as base ± ½Δ, not two independents. Δ = 0 is constant
//       camber (aft = fore — the natural baseline); the prior centres Δ on a gentle bow-fining trend
//       (finer, rounder, deeper-forefoot forward); Δ free reaches any pair. The midship section is
//       exactly `base`. BOTH the gross character (#4 backbone) and the per-point (#2) residuals use
//       this base/Δ split, so "constant camber" is recoverable at every level by zeroing the Δ coords.
//       The two stations sit at u = 0 and u = 1, and a two-knot loft is exactly a straight line between
//       them, so the section still varies LINEARLY aft→fore — which is what #3 below leans on.
//
// ---- levers NOT yet pulled (where the next iteration should go) ---------------------------
//   #1  dimensionless coordinates: carry L/B, B/T, a prismatic-like fullness, deadrise ANGLE … as the
//       latents (each a ratio of an upstream-decoded dimension) so the prior lives where the naval-
//       architecture knowledge actually lives, and scale decouples from shape.
//   #5  section as cumulative PANEL ANGLES (flare → bilge turn → deadrise) instead of (n,d) offset
//       pairs — scale-free, with meaningful angle priors, and monotone-depth becomes "heading stays
//       within ±90° of straight down".
//   #6  smooth-basis SPACING: put the dx/dd increments in a low-frequency basis so control-point
//       spacing fairs too. Here x-spacing is just UNIFORM and only the values carry residuals.
//   #7  a fuller transom coupling (its outline tied to the aft sections, beyond depthTop = sheer-at-stern).
//
// ---- empirically (from the throwaway verification harnesses, not kept in the repo) --------
//   Measured when the model was unitless against a fixed L = 1000; the backbone targets below are still
//   written at that scale and are scaled to the live hull's LOA by `S1` (see decodeDoc), so the shapes
//   these describe are unchanged — only their absolute size follows the hull.
//   θ = 0 → closure ≈ 0.97, half-beam ≈ 503, draft ≈ 642, L/B ≈ 4.0 — a sensible boat.
//   100% of sampled θ are VALID at every `adventure` scale (generality holds).
//   the prior concentrates: closed-fraction degrades smoothly as `adventure` grows; open bottoms are
//   common only far from the origin. At adventure = 1, ≈8% of draws open — part of why this is not yet
//   UI-ready, and a reason to pursue #1/#5 (a tighter, more shape-aware prior) next.
//
// ---- decode order = the layout of θ (coordinates are consumed top-to-bottom, EXACTLY this order) --
//   beam backbone:        Bmax, fPeak, Btransom-frac, Bbow-frac                 (4)
//   beam #2 residuals:    interior plan points 1..P-2                           (P-2)
//   keel reach #3:        ρ                                                     (1)
//   section #4 backbone:  Db, nbBase, nbΔ, draftBase, draftΔ, kBase, kΔ         (7)
//   section #2 residuals: depth-steps i=1..S-1 (base,Δ) + n i=1..S-2 (base,Δ)   (2(S-1)+2(S-2))
//   sheer backbone:       dMaxTrim, dTransom, dBow, fLow                        (4)
//   sheer #2 residuals:   interior trim points 1..Q-2                           (Q-2)
//   transom:              immersion-frac, x, rake                               (3)
//   ⇒ M = 19 + (P-2) + (Q-2) + (4S-6)      (default topology 5 / 4 / 5  ⇒  M = 38)
//   Past the end of θ the coordinate source returns 0 (the backbone value), so a short or empty θ
//   simply yields the canonical hull — which is exactly how `meanDoc()` works.
//   (v1 carried per-station blend WEIGHTS in the plan; they were always the straight aft→fore handoff
//   and never consumed a coordinate, so dropping them leaves the layout of θ untouched.)

import { bounds, loa, type Bounds, type Model } from "./model";
import { VERSION, type HullDocument } from "./document";
import { loadJsonText } from "./json";

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
const sigmoid = (u: number): number => 1 / (1 + Math.exp(-u));
const logit = (p: number): number => Math.log(p / (1 - p));

// standard normal via Box–Muller (browser Math.random is fine here)
function randn(): number {
  const u = Math.max(Math.random(), 1e-12),
    v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- residual decoders: each maps one θ-coordinate `z` onto a slot, centred at `target` at z=0 ----------
// bounded interval (lo,hi): the README's transom-x transform, shifted so z=0 ⇒ target. Always interior.
const bounded = (
  z: number,
  target: number,
  lo: number,
  hi: number,
  spread = 1,
): number =>
  lo +
  (hi - lo) *
    sigmoid(
      spread * z + logit(clamp((target - lo) / (hi - lo), 1e-4, 1 - 1e-4)),
    );
// positive ray (0,∞): geometric residual, z=0 ⇒ target. The full ray (incl. arbitrarily small) is reachable.
const positive = (z: number, target: number, spread = 1): number =>
  target * Math.exp(spread * z);
// free real ℝ: additive residual, z=0 ⇒ target.
const real = (z: number, target: number, scale: number): number =>
  target + scale * z;

const smooth = (r: number): number => {
  r = clamp(r, 0, 1);
  return r * r * (3 - 2 * r); // smoothstep
};
// a smooth unimodal profile over f ∈ [0,1]: `v0` at f=0, peak `vp` at f=`fp`, `v1` at f=1
function bump(
  f: number,
  fp: number,
  v0: number,
  vp: number,
  v1: number,
): number {
  if (f <= fp) return v0 + (vp - v0) * smooth(fp <= 0 ? 1 : f / fp);
  return vp + (v1 - vp) * smooth(fp >= 1 ? 1 : (f - fp) / (1 - fp));
}

// One station's section (deck → turn of bilge → deep keel point) over S points, as absolute (n, d, k),
// where d is DEPTH below the deck datum (the document stores world z = −d; the residual pass below works
// in depth increments, which is why the sign is flipped only on the way out).
// The deepest point reaches `nKeel` inboard — past the centerline for every station — so a keel emerges
// from the trim; where the sweep crosses y=0 sets the LOCAL draft (a fine bow crosses high and sweeps
// the forefoot up, a full midship crosses deep on the deadrise). So `draft` here is the depth of the
// section's deepest point, NOT the hull's draft — the real draft is shallower and emerges per station.
// This emergent keel is the constant-camber idea; the section is the same shape swept along the sheer.
// Points: 0 = pinned deck point; a single bilge point at `bIdx` carries the knuckle; the topside
// (deck→bilge) and the bottom (bilge→keel) are straight runs that the downstream spline fairs.
function buildSection(
  S: number,
  b: Bounds,
  dMin: number, // the shallowest a keel point may be, in the hull's own scale
  nKeel: number,
  draft: number,
  Db: number, // turn-of-bilge depth fraction
  Nb: number, // turn-of-bilge inboard fraction (small ⇒ near-vertical topside)
  kBilge: number, // knuckle at the bilge (1 = hard chine, 0 = round)
): { n: number; d: number; k: number }[] {
  const dKeel = clamp(draft, dMin, -b.zMin);
  const pts = [{ n: 0, d: 0, k: 0 }]; // pinned deck point
  const bIdx = S >= 3 ? clamp(Math.round((S - 1) * 0.55), 1, S - 2) : -1; // which point is the bilge
  for (let i = 1; i < S; i++) {
    let n: number,
      d: number,
      k = 0;
    if (S < 3) {
      n = nKeel;
      d = dKeel;
    } else if (i < bIdx) {
      const r = i / bIdx; // topside: deck → bilge
      n = Nb * nKeel * r;
      d = Db * dKeel * r;
    } else if (i === bIdx) {
      n = Nb * nKeel;
      d = Db * dKeel;
      k = kBilge;
    } else {
      const r = (i - bIdx) / (S - 1 - bIdx); // bottom: bilge → keel (the deadrise)
      n = Nb * nKeel + (nKeel - Nb * nKeel) * r;
      d = Db * dKeel + (dKeel - Db * dKeel) * r;
    }
    pts.push({ n: clamp(n, b.nMin, b.nMax), d, k });
  }
  return pts;
}

// A source of θ-coordinates, consumed in decode order. `() => 0` gives the canonical hull (θ = 0);
// `() => adventure·randn()` samples around it. The sequence of next() calls IS the traversal of θ.
type Coord = () => number;

// The reparameterization φ: θ → HullDocument (v2: absolute coordinates in the model's own unit), over the
// CURRENT topology.
function decodeDoc(model: Model, z: Coord): string {
  const P = model.sheerPlan.length, // sheerPlan count
    Q = model.sheerTrim.length, // sheerTrim count
    S = model.stations[0].points.length; // section count (every station shares it)
  const b = bounds(model),
    L = loa(model) || 1,
    DEPTH_MAX = -b.zTrimMin;
  // The backbone targets below are written at v1's unitless 1000-long scale, where this prior was tuned.
  // v2's coordinates are absolute in the document's unit, so every LENGTH-dimensioned target is mapped onto
  // the live hull's own LOA — the canonical boat is then the same SHAPE whatever the hull's size or unit.
  // Fractions, slopes, and logit-space targets carry across untouched.
  const S1 = (v: number): number => (v * L) / 1000;

  // #2 helper: a base ± ½Δ residual pair, consuming two coordinates. Δ=0 (second coord 0) ⇒ aft & fore
  // get the SAME residual (constant-camber-consistent); a nonzero Δ lets the two ends deviate per-point.
  const pair = (
    baseSpread: number,
    deltaSpread: number,
  ): { aft: number; fore: number } => {
    const b = baseSpread * z(),
      d = deltaSpread * z();
    return { aft: b - 0.5 * d, fore: b + 0.5 * d };
  };

  // --- beam backbone → a smooth unimodal half-breadth curve B(x): fine bow, fuller stern ---
  const Bmax = bounded(z(), S1(620), S1(480), S1(820)),
    fPeak = bounded(z(), 0.58, 0.5, 0.68),
    Btransom = Bmax * bounded(z(), 0.78, 0.55, 0.95),
    Bbow = Bmax * bounded(z(), 0.04, 0.005, 0.12);
  const beam = (x: number): number =>
    clamp(bump(clamp(x, 0, L) / L, fPeak, Btransom, Bmax, Bbow), 0, b.yMax);
  const tx = (x: number): number => {
    const e = S1(25),
      lo = Math.max(x - e, 0),
      hi = Math.min(x + e, L);
    return 1 / Math.hypot(1, (beam(hi) - beam(lo)) / (hi - lo || 1)); // sheer-tangent x-component
  };
  // #2: per-point half-breadth residuals on the INTERIOR plan points (ends stay on the backbone, so the
  // transom beam and the fine bow are governed by their backbone latents). Multiplicative ⇒ y ≥ 0 always.
  const planY = Array.from({ length: P }, (_, i) => {
    const y = beam((L * i) / (P - 1));
    return i === 0 || i === P - 1
      ? y
      : clamp(y * Math.exp(0.12 * z()), 0, b.yMax);
  });

  // --- #3: keel reach as a residual on the decoded beam. The binding station is the widest one (n
  // blends linearly aft→fore but beam bulges amidships), so predict from max beam/Tx, then ρ = z(). ---
  let maxReq = 0;
  for (let i = 0; i <= 20; i++) {
    const x = (L * i) / 20;
    maxReq = Math.max(maxReq, beam(x) / Math.max(tx(x), 0.3));
  }
  const reach = clamp(positive(z(), maxReq * 1.15, 0.16), 0, b.nMax); // ρ=0 ⇒ closes w/ 15% margin

  // --- #4: aft/fore section character carried as base ± ½Δ (Δ=0 ⇒ constant camber) ---
  const Db = bounded(z(), 0.64, 0.5, 0.76); // turn-of-bilge depth fraction (shared)
  // bilge inboard fraction Nb, in logit space so base ± ½Δ stays in (nbLo,nbHi):
  const nbLo = 0.12,
    nbHi = 0.5;
  const nbBase = real(z(), logit((0.3 - nbLo) / (nbHi - nbLo)), 1.0),
    nbDelta = real(z(), -0.9, 0.8); // <0 ⇒ fore has a tighter bilge (more deadrise) than aft
  const NbAft = nbLo + (nbHi - nbLo) * sigmoid(nbBase - 0.5 * nbDelta),
    NbFore = nbLo + (nbHi - nbLo) * sigmoid(nbBase + 0.5 * nbDelta);
  // keel-point depth (actual draft emerges shallower), as a base with a log fore/aft trend:
  const dMin = S1(60), // the shallowest a keel point may be
    draftBase = positive(z(), S1(680), 0.22),
    draftDelta = real(z(), 0.3, 0.25); // >0 ⇒ deeper forefoot than run
  const draftAft = clamp(
      draftBase * Math.exp(-0.5 * draftDelta),
      dMin,
      -b.zMin,
    ),
    draftFore = clamp(draftBase * Math.exp(+0.5 * draftDelta), dMin, -b.zMin);
  // chine knuckle, base ± ½Δ in logit space:
  const kBase = real(z(), 0.0, 1.1),
    kDelta = real(z(), -2.6, 1.0); // <0 ⇒ fore rounder than aft (hard chine aft → soft bow)
  const kAft = sigmoid(kBase - 0.5 * kDelta),
    kFore = sigmoid(kBase + 0.5 * kDelta);

  const aft = buildSection(S, b, dMin, reach, draftAft, Db, NbAft, kAft);
  const fore = buildSection(S, b, dMin, reach, draftFore, Db, NbFore, kFore);
  // #2: per-point section residuals, base ± ½Δ. Depth steps get a multiplicative log-residual (dd > 0
  // preserved for any θ ⇒ the section never stops descending), so the keel point's depth drifts but the
  // strict-descent invariant is safe. Inboard n gets an additive residual on the interior points only —
  // the pinned sheer point and the deepest reach point are held so closure (#3) stays intact.
  {
    let aD = 0,
      fD = 0,
      paD = 0,
      pfD = 0; // running perturbed / backbone depths
    for (let i = 1; i < S; i++) {
      const r = pair(0.12, 0.1);
      aD += (aft[i].d - paD) * Math.exp(r.aft);
      fD += (fore[i].d - pfD) * Math.exp(r.fore);
      paD = aft[i].d;
      pfD = fore[i].d;
      aft[i].d = aD;
      fore[i].d = fD;
    }
    for (let i = 1; i < S - 1; i++) {
      const r = pair(S1(55), S1(45));
      aft[i].n = clamp(aft[i].n + r.aft, b.nMin, b.nMax);
      fore[i].n = clamp(fore[i].n + r.fore, b.nMin, b.nMax);
    }
  }

  // --- sheer plan: control points evenly along x; interior half-breadths carry #2 residuals (planY).
  // (v1 also carried per-point blend weights here — the straight aft→fore handoff. v2 has no blend: the
  // two sections are stations at u = 0 and u = 1, and the loft between them IS that handoff.) ---
  const sheerPlan = Array.from({ length: P }, (_, i) => ({
    x: (L * i) / (P - 1),
    y: planY[i],
  }));

  // --- sheer trim backbone: a smooth spring, deepest amidships, rising to both ends ---
  const dMaxTrim = bounded(z(), S1(260), S1(150), S1(380)),
    dTransom = bounded(z(), S1(70), S1(30), S1(140)),
    dBow = bounded(z(), S1(45), S1(15), S1(110)),
    fLow = bounded(z(), 0.45, 0.32, 0.58);
  const trimDepth = (x: number): number =>
    clamp(
      bump(clamp(x, 0, L) / L, fLow, dTransom, dMaxTrim, dBow),
      0,
      DEPTH_MAX,
    );
  // #2: per-point depth residuals on interior trim points (ends governed by their backbone latents)
  const sheerTrim = Array.from({ length: Q }, (_, i) => {
    const x = (L * i) / (Q - 1),
      d = trimDepth(x);
    return {
      x,
      z: -(i === 0 || i === Q - 1
        ? d
        : clamp(d * Math.exp(0.13 * z()), 0, DEPTH_MAX)),
      k: 0,
    };
  });

  // --- transom: top edge meets the sheer at the stern (predicted, no own coord); immersion ∝ aft draft.
  // v1 stated a point, a depth-step and a rake slope; v2 states both profile points outright, so the rake
  // is applied here rather than stored. ---
  const depthTop = clamp(trimDepth(0), S1(5), DEPTH_MAX * 0.5),
    depthBot = clamp(
      bounded(z(), 0.7, 0.45, 0.95) * draftAft * 0.8,
      depthTop + S1(40),
      DEPTH_MAX,
    );
  const tx0 = clamp(bounded(z(), S1(150), S1(60), S1(360)), 0, L * 0.45),
    rake = real(z(), -0.25, 0.2), // dx/dz: negative ⇒ the foot sits FORWARD of the top (a raked transom)
    zTop = -depthTop,
    zBot = -depthBot;
  const transom = [
    { x: tx0, z: zTop },
    { x: tx0 + (zBot - zTop) * rake, z: zBot },
  ];

  // the two sections become stations at the ends of the plan; `d` is depth, the document stores world z
  const station = (
    u: number,
    pts: { n: number; d: number; k: number }[],
  ): HullDocument["stations"][number] => ({
    u,
    keelK: 0,
    points: pts.map((p) => ({ n: p.n, z: -p.d, k: p.k })),
  });

  const doc: HullDocument = {
    version: VERSION,
    name: "random",
    unit: model.unit,
    waterline: model.waterline, // preserve the current trim controls; only the shape is resampled
    deckRakeDeg: (model.deckRake * 180) / Math.PI,
    sheerPlan,
    sheerTrim,
    transom,
    stations: [station(0, aft), station(1, fore)],
  };
  return JSON.stringify(doc);
}

// θ ~ adventure·N(0,1) per coordinate. `adventure` is the standard deviation of every residual
// coordinate, i.e. a single scalar temperature on the whole prior: 0 = the canonical boat, larger =
// further from it (and eventually off the boat-prior — e.g. an open bottom — but ALWAYS a valid hull,
// since φ is onto the valid region for every θ). Returns a HullDocument JSON string.
export function randomDoc(model: Model, adventure = 1): string {
  return decodeDoc(model, () => adventure * randn());
}
// θ = 0 → the canonical hull the prior is centred on. Useful for verifying "small θ ⇒ sensible boat"
// and as a known-good baseline; equivalently, decoding an empty/zero θ (the coordinate source returns 0).
export function meanDoc(model: Model): string {
  return decodeDoc(model, () => 0);
}

// Decode a fresh random variant and load it into the live model (through the canonical json.ts path).
// NOTE: currently called by nothing — the UI button was removed. Retained so the generator can be
// re-hooked to a control or invoked from a console/test without re-deriving the wiring.
export function randomizeModel(model: Model): void {
  loadJsonText(model, randomDoc(model));
}
