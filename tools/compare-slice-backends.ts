import { compareSliceBackends } from "../test/compare-slice-backends";
import { sliceBackendFixtures } from "../test/slice-backend-fixtures";
const samples = Number(process.argv[2] ?? 1024),
  seed = Number(process.argv[3] ?? 12345);
console.log(
  JSON.stringify(
    sliceBackendFixtures().map((fixture) =>
      compareSliceBackends(fixture, {
        samples,
        seed,
        resolutions: [16, 64, 256],
        tolerance: {
          relative: 0.002,
          area: 1e-8,
          length: 1e-8,
          momentLengthScale: 3.5,
        },
      }),
    ),
    null,
    2,
  ),
);
