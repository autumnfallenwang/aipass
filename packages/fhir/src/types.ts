/** Just enough FHIR R4 typing for aipass. Everything else stays `unknown` and is never trusted. */
export type Coding = { system?: string; code?: string; display?: string };
export type CodeableConcept = { coding?: Coding[]; text?: string };
export type Reference = { reference?: string; display?: string };
export type Quantity = { value?: number; unit?: string; system?: string; code?: string };

export type Resource = {
  resourceType: string;
  id?: string;
  meta?: { security?: Coding[]; tag?: Coding[]; versionId?: string; lastUpdated?: string };
  [key: string]: unknown;
};

export type BundleEntry = {
  fullUrl?: string;
  resource?: Resource;
  search?: { mode?: "match" | "include" | "outcome" };
};

export type Bundle = Resource & {
  resourceType: "Bundle";
  type?: string;
  total?: number;
  link?: { relation: string; url: string }[];
  entry?: BundleEntry[];
};

export type OperationOutcome = Resource & {
  resourceType: "OperationOutcome";
  issue?: { severity?: string; code?: string; diagnostics?: string }[];
};
