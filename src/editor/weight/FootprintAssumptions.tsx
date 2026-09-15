import { GeometryDisclosure } from "./GeometryDisclosure";

/** Model information belongs to the footprint, not to every value using it. */
export function FootprintAssumptions() {
  return (
    <GeometryDisclosure label="Estimation assumptions">
      <div className="wgeometryassumptions whint">
        <p>
          A footprint estimates a uniform distribution, not individual member
          positions. No end members or mirrored copies are added. Spacing/count
          uncertainty describes the average repetition of the whole family.
        </p>
        <p>
          Grid-placement uncertainty estimates the effect of shifting a regular
          grid within one spacing. It applies even with an exact equivalent
          count. Properties of one footprint share that shift; separate
          footprints assume independent shifts.
        </p>
        <p>
          Likely uses weighted RMS deviation from the continuous estimate. Worst
          uses a sampled envelope, not a guaranteed bound. Centroids and derived
          formulas use first-order propagation. This does not cover irregular
          construction or hull sampling error.
        </p>
      </div>
    </GeometryDisclosure>
  );
}
