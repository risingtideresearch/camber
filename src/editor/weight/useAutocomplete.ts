import { useMemo, useState } from "react";
import { suggestAt, type Completion, type Suggest } from "./weightCompletions";

/** Keyboard and caret bookkeeping for one formula field. */
export function useAutocomplete(all: readonly Completion[]) {
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [active, setActive] = useState(0);
  const refresh = useMemo(
    () => (source: string, caret: number) => {
      const next = suggestAt(all, source, caret);
      setSuggest(next);
      setActive(0);
    },
    [all],
  );
  return { suggest, active, setActive, refresh, close: () => setSuggest(null) };
}
