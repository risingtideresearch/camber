// Application-facing query boundary. Numerical analysis is SI. Physical plane sections
// are distinct from compatibility queries preserving the existing sheet semantics.
import type {
  ProjectionRequest,
  ProjectionResult,
  DisplayGeometry,
} from "./projections";
import type { SectionRequest, SectionResult } from "./sections";
import type { Vec3 } from "../core/math";
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
  readonly referenceWaterline: number; // metres; meaning is fixed by referenceWaterlineConvention
  readonly weightFrame: "camber-deck-x-world-z" | "upright-cartesian";
  /** Omitted for legacy Camber contexts; mesh contexts name world height explicitly. */
  readonly referenceWaterlineConvention?: "camber-depth" | "world-z";
  /** SI body point → weight point: rows × point + offset. Legacy Camber
   * mappings remain in outlines().frame until its authoring migration. */
  readonly hullToWeight?: {
    readonly rows: readonly [Vec3, Vec3, Vec3];
    readonly offset: Vec3;
  };
  readonly shellScope?: {
    readonly confirmed: true;
    readonly surfaces: readonly string[];
    readonly label: string;
  };
  readonly kgDatum?: { readonly frame: "upright"; readonly z: number };
}

/** All lengths in metres, volumes in m³, angles in radians; KG is above the keel datum. */
export interface StabilityData {
  readonly curves: CrossCurves;
  readonly limit: LimitingKgPoint[];
  readonly hydro: { readonly vol: number; readonly kb: number } | null;
  readonly lowestSheerKg: number;
  readonly availability?: {
    readonly sheer: Available<true>;
    readonly referenceWaterline: Available<true>;
    readonly downflooding: Available<true>;
  };
  readonly assumptions?: readonly string[];
  readonly numerics?: {
    method: string;
    sinkageSteps: number;
    triangles?: number;
    errorBound: null;
  };
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
    readonly authoredStations: boolean;
  };
  project(
    query: ProjectionRequest,
    options?: QueryOptions,
  ): Promise<QueryResult<ProjectionResult>>;
  displayGeometry(
    options?: QueryOptions,
  ): Promise<QueryResult<DisplayGeometry>>;
  section(
    query: SectionRequest,
    options?: QueryOptions,
  ): Promise<QueryResult<SectionResult>>;
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
  project: { input: ProjectionRequest; output: ProjectionResult };
  displayGeometry: { input: null; output: DisplayGeometry };
  section: { input: SectionRequest; output: SectionResult };
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
