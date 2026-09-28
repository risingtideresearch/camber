import { compareSampling } from "../test/compare-sampling";
import { comparisonFixtures } from "../test/sampling-fixtures";

const samples = Number(process.argv[2] ?? 1024);
const seed = Number(process.argv[3] ?? 12345);
console.log(
  JSON.stringify(
    comparisonFixtures().map(({ name, book, targets }) => ({
      name,
      ...compareSampling(book, { samples, seed, targets }),
    })),
    null,
    2,
  ),
);
