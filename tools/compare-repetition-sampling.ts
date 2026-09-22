import { compareRepetitionSampling } from "../test/compare-repetition-sampling";
import { repetitionComparisonFixtures } from "../test/repetition-sampling-fixtures";
const existing = process.argv[2] === "existing";
const samples = Number(process.argv[2] ?? 1024);
const seed = Number(process.argv[3] ?? 12345);
console.log(
  JSON.stringify(
    repetitionComparisonFixtures().map(({ name, book, measure, targets }) => ({
      name,
      ...compareRepetitionSampling(
        book,
        measure,
        existing ? { mode: "existing", targets } : { samples, seed, targets },
      ),
    })),
    null,
    2,
  ),
);
