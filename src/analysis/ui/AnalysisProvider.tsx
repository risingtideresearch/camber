import { measureWeightCuts } from "../weightGeometry";
import { pointViewOutlines } from "../pointViewGeometry";
/* eslint-disable react-refresh/only-export-components -- the provider and its hook form one binding */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { Unit } from "../../core/document";
import type { SheetCommand, WeightBook } from "../../core/sheet/book";
import {
  available,
  type HullAnalysis,
  type QueryOptions,
  type SliceQuery,
} from "../api";
import { planWeightBook, finishWeightBook } from "../weightBook";
import { useAnalysisQuery } from "./useAnalysisQuery";

export interface AnalysisHost {
  readonly hull: HullAnalysis;
  readonly book: WeightBook;
  readonly displayUnit: Unit;
  readonly dispatch: (
    command: SheetCommand,
  ) => Promise<{ rejected: string } | { accepted: true }>;
}

function useAnalysisResults(host: AnalysisHost, demand: AnalysisDemand) {
  const { hull, book } = host;
  const id = hull.context.id;
  const loadStability = useCallback(
    (options: QueryOptions) => hull.stability(options),
    [hull],
  );
  const loadMetrics = useCallback(
    (options: QueryOptions) => hull.measurements(options),
    [hull],
  );
  const loadOutlines = useCallback(
    (options: QueryOptions) => pointViewOutlines(hull, options),
    [hull],
  );
  // One provider owns these queries, even if both panels are mounted in the same window.
  const metrics = useAnalysisQuery(
    id,
    "measurements",
    loadMetrics,
    demand.metrics,
  );
  const outlines = useAnalysisQuery(
    id,
    "outlines",
    loadOutlines,
    demand.outlines,
  );
  const stability = useAnalysisQuery(
    id,
    "stability",
    loadStability,
    demand.stability,
  );
  const metricValues = metrics.status === "available" ? metrics.value : null;
  const plan = useMemo(
    () => planWeightBook(book, metricValues),
    [book, metricValues],
  );
  // Formula/name edits can change bindings without changing the actual geometry queries.
  const signature = JSON.stringify(plan.queries);
  const queries = useMemo(
    () => JSON.parse(signature) as SliceQuery[],
    [signature],
  );
  const loadCuts = useCallback(
    (options: QueryOptions) =>
      queries.length
        ? measureWeightCuts(hull, queries, options)
        : Promise.resolve({ contextId: id, result: available([]) }),
    [hull, id, queries],
  );
  const cuts = useAnalysisQuery(id, signature, loadCuts, demand.cuts);
  const weight = useMemo(
    () =>
      finishWeightBook(
        book,
        metricValues,
        plan,
        cuts.status === "available" ? cuts.value : [],
      ),
    [book, metricValues, plan, cuts],
  );
  return { ...host, stability, metrics, outlines, cuts, weight };
}

type AnalysisView = ReturnType<typeof useAnalysisResults>;
const Context = createContext<AnalysisView | null>(null);

export interface AnalysisDemand {
  metrics: boolean;
  outlines: boolean;
  stability: boolean;
  cuts: boolean;
}
const EAGER: AnalysisDemand = {
  metrics: true,
  outlines: true,
  stability: true,
  cuts: true,
};

export function AnalysisProvider({
  host,
  children,
  demand = EAGER,
}: {
  demand?: AnalysisDemand;
  host: AnalysisHost;
  children: ReactNode;
}) {
  const value = useAnalysisResults(host, demand);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAnalysis(): AnalysisView {
  const value = useContext(Context);
  if (!value) throw new Error("Analysis panels need an AnalysisProvider");
  return value;
}
