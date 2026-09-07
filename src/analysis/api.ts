// Phase 1's application-facing query boundary. Numerical analysis is SI. The two legacy
// geometry queries preserve existing sheet semantics; arbitrary-plane regions are phase 2,
// not a station disguised as a plane or an array of precomputed sections.
import type { HullMetrics } from "./hullMetrics";
import type { CrossCurves, LimitingKgPoint } from "./stability";
import type {
  HullOutlines,
  SectionKind,
  SectionOutline,
  SliceMeasurement,
} from "./geometry";
import type { SliceShape } from "../core/sheet/book";

export type Available<T> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: string };

export interface QueryResult<T> {
  readonly contextId: string;
  readonly result: Available<T>;
}

export const available = <T>(value: T): Available<T> => ({
  status: "available",
  value,
});
export const unavailable = (reason: string): Available<never> => ({
  status: "unavailable",
  reason,
});

export interface AnalysisContext {
  readonly id: string;
  readonly fixedTrim: number; // radians
  readonly referenceWaterline: number; // authored depth, metres; NOT height above K
  readonly weightFrame: "camber-deck-x-world-z";
}

/** All lengths in metres, volumes in m³, angles in radians; KG is above the keel datum. */
export interface StabilityData {
  readonly curves: CrossCurves;
  readonly limit: LimitingKgPoint[];
  readonly hydro: { readonly vol: number; readonly kb: number } | null;
  readonly lowestSheerKg: number;
}

export interface SliceQuery {
  readonly shape: SliceShape;
  readonly position: number; // metres, in the existing cut's authored convention
}
export interface OutlineQuery {
  readonly kind: SectionKind;
  readonly x: number; // sheet metres
}
export interface QueryOptions {
  readonly signal?: AbortSignal;
}

export interface HullAnalysis {
  readonly context: AnalysisContext;
  readonly capabilities: {
    readonly stability: boolean;
    readonly measurements: boolean;
    readonly legacySlices: boolean;
    readonly pointViews: boolean;
    readonly arbitraryPlanes: false;
  };
  stability(options?: QueryOptions): Promise<QueryResult<StabilityData>>;
  measurements(options?: QueryOptions): Promise<QueryResult<HullMetrics>>;
  outlines(options?: QueryOptions): Promise<QueryResult<HullOutlines>>;
  /** Curves and centroid are returned in sheet metres, unlike the old core's render coordinates. */
  slices(
    queries: readonly SliceQuery[],
    options?: QueryOptions,
  ): Promise<QueryResult<readonly Available<SliceMeasurement>[]>>;
  /** A preview drawing, not an area/perimeter measurement. An empty cut is available(null). */
  sectionOutline(
    query: OutlineQuery,
    options?: QueryOptions,
  ): Promise<QueryResult<SectionOutline | null>>;
}

/** Serializable request/result map shared by the facade and worker adapter. */
export interface AnalysisQueries {
  stability: { input: null; output: StabilityData };
  measurements: { input: null; output: HullMetrics };
  outlines: { input: null; output: HullOutlines };
  slices: {
    input: readonly SliceQuery[];
    output: readonly Available<SliceMeasurement>[];
  };
  sectionOutline: { input: OutlineQuery; output: SectionOutline | null };
}
export type QueryKind = keyof AnalysisQueries;
