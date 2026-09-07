import { StabilityPanel as SharedStabilityPanel } from "../analysis/ui/StabilityPanel";
import { useAnalysis } from "../analysis/ui/AnalysisProvider";

export function StabilityPanel() {
  const { stability, displayUnit, book, weight } = useAnalysis();
  return (
    <SharedStabilityPanel
      stability={stability}
      unit={displayUnit}
      density={book.density}
      sheetResults={weight.results}
    />
  );
}
