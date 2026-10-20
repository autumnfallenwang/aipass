import type { Group } from "@aipass/shared";

/** What the target said to one call. Leaks are judged on `text` only. */
export type Outcome = {
  status: "ok" | "refused" | "unauthorized" | "error";
  text: string;
};

/**
 * A credential the probe asks the target for. `groups` narrows what the agent
 * may see (when the target can express that). `variant` asks for a
 * deliberately bad one.
 */
export type CredentialRequest = {
  groups?: Group[];
  variant?: "expired" | "wrong_audience" | "forged" | "other_patient";
};

/** A credential, or `null` for "no credential". Opaque to probes. */
export type Credential = { bearer?: string; agent: "all" | "labs" } | null;

export type AuditRecord = {
  outcome: "success" | "failure";
  /** Who the record says acted (references such as `Device/…`). */
  agents: { ref: string; requestor: boolean }[];
  description: string;
};

export type Capabilities = {
  /** Checks a per-request credential (a pass, a token). */
  credentials: boolean;
  /** Can limit an agent to part of a person's record. */
  partialAccess: boolean;
  /** An admin can stop an agent. */
  adminStop: boolean;
  /** The person can withdraw their permission. */
  personRevoke: boolean;
  /** Writes an audit record we can read back. */
  audit: boolean;
};

/**
 * How the probes drive one system. Everything is phrased as "the agent,
 * acting for Maria". The fixtures (Maria, John, labelled records) must be
 * loaded in the target's FHIR server.
 */
export interface Target {
  name: string;
  version: string;
  capabilities: Capabilities;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  credential(req: CredentialRequest): Promise<Credential>;
  /** Read one record by type and id. */
  read(cred: Credential, type: string, id: string): Promise<Outcome>;
  /** Search one record type for a patient; `extra` holds raw parameters such as `_include`. */
  search(
    cred: Credential,
    type: string,
    query: { patient: string; category?: string; extra?: Record<string, string> },
  ): Promise<Outcome>;
  stopAgent?(): Promise<void>;
  resumeAgent?(): Promise<void>;
  revokeGrant?(): Promise<void>;
  restoreGrant?(): Promise<void>;
  /** Audit records the target wrote since `since`. */
  auditSince?(since: Date): Promise<AuditRecord[]>;
}

export type ProbeStatus = "pass" | "fail" | "missing" | "n/a";

export type ProbeResult = {
  id: string;
  title: string;
  tries: string;
  status: ProbeStatus;
  /** True for probes whose failure means data reached someone it shouldn't. */
  leak: boolean;
  detail: string;
};

export type Probe = {
  id: string;
  title: string;
  tries: string;
  leak: boolean;
  run(t: Target): Promise<{ status: ProbeStatus; detail: string }>;
};
