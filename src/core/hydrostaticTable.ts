// Portable hydrostatic-table v1 data. This is a buoyancy response, not a
// Camber document, loading condition, mesh or CrossCurves cache.
export type HydrostaticPointM = [number, number, number];

export interface HydrostaticSample {
  waterplaneOffsetM: number;
  volumeM3: number;
  buoyancyCenterM: HydrostaticPointM | null;
  waterplane?: {
    areaM2: number;
    centroidM: HydrostaticPointM;
    secondMomentsM4: { xx: number; yy: number };
  };
}

export interface HydrostaticTable {
  format: "hydrostatic-table";
  version: 1;
  name: string;
  frame: {
    axes: "x-forward-y-port-z-up";
    originDescription: string;
    knReferenceM: HydrostaticPointM;
  };
  body: { description: string; buoyancyEnvelope: "closed-watertight" };
  table: {
    interpolation: "linear";
    rows: {
      heelDeg: number;
      trimDeg: number;
      samples: HydrostaticSample[];
    }[];
  };
  referenceState?: {
    heelDeg: number;
    trimDeg: number;
    waterplaneOffsetM: number;
  };
  immersionMarkers?: {
    id: string;
    label: string;
    kind: "deck-edge";
    pointsM: HydrostaticPointM[];
  }[];
  source: {
    tool: string;
    modelId?: string;
    generatedAt?: string;
    method: string;
    notes: string[];
  };
  notes: string[];
}
