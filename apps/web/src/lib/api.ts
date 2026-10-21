"use client";

import type { Group, PatientField, Permission, RoleRule } from "@aipass/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Calls the api through this app's own origin (`/api/*` is proxied). */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...rest,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? res.statusText, res.status);
  return body as T;
}

/** Fetches on mount and on `reload()`; optional polling. */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [loading, setLoading] = useState(Boolean(path));
  const live = useRef(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (live.current) {
        setData(d);
        setError(undefined);
      }
    } catch (e) {
      if (live.current) setError(e as ApiError);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    live.current = true;
    void reload();
    if (!opts.pollMs)
      return () => {
        live.current = false;
      };
    const t = setInterval(() => void reload(), opts.pollMs);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [reload, opts.pollMs]);

  return { data, error, loading, reload };
}

export type Me = { id: string; name: string; email: string; role: string };

export type Agent = {
  id: string;
  name: string;
  description: string | null;
  roleId: string;
  roleName: string | null;
  status: "active" | "stopped";
  /** Where its records live; null for aipass's own FHIR server (S6). */
  fhirServerId: string | null;
  /** The built-in chat's model, and a fallback (S8). */
  modelConnectionId: string | null;
  model: string | null;
  fallbackConnectionId: string | null;
  fallbackModel: string | null;
  mcpUrl: string;
  lastActivity: string | null;
  createdAt: string;
};

export type Role = {
  id: string;
  name: string;
  description: string | null;
  rules: RoleRule[];
  patientFields: PatientField[];
  permissions: Permission[];
  /** Its agents may only use models that keep data on the network (S8). */
  networkModelsOnly: boolean;
  agentCount?: number;
};

export type Grant = {
  id: string;
  personId: string;
  agentId: string;
  agentName: string;
  permissions: Permission[];
  status: "active" | "revoked";
  /** Who said yes (D19): the person, or the admin for a test person. */
  setBy: "person" | "admin";
  grantedAt: string;
  revokedAt: string | null;
};

/** One of a person's records, at a FHIR server (S9). */
export type PersonRecord = {
  serverId: string;
  serverName: string;
  ref: string;
  /** "admin": picked from a search of aipass's own server; "person": they connected it (SMART). */
  linkedBy: "admin" | "person";
  kind?: "aipass" | "smart";
  linkedAt?: string;
};

/** A row of the People list (S9). */
export type PersonRow = {
  id: string;
  displayName: string;
  status: "active" | "suspended";
  isTest: boolean;
  email: string | null;
  records: PersonRecord[];
  ais: { active: number; total: number };
  lastActivity: string | null;
};

export type PersonList = { total: number; page: number; limit: number; items: PersonRow[] };

/** One person, for their side panel (S9). */
export type PersonDetail = {
  id: string;
  displayName: string;
  status: "active" | "suspended";
  isTest: boolean;
  createdAt: string;
  login: { email: string; createdAt: string; passkeys: number } | null;
  records: PersonRecord[];
  grants: (Grant & { ceiling: Permission[] })[];
  approvals: {
    id: string;
    agentName: string | null;
    summary: string;
    forThem: boolean;
    createdAt: string;
    expiresAt: string;
  }[];
};

export type Receipt = {
  id: string;
  seq: number;
  ts: string;
  agentId: string;
  personId: string | null;
  tool: string | null;
  action: string;
  group: string | null;
  decision: "allow" | "refuse";
  rule: number | null;
  reason: string | null;
  sentence: string;
  count: number;
  withheld: number;
  mode: "live" | "preview";
  auditEventId: string | null;
  auditEventUrl: string | null;
  /** The AI app that made the request (S8), when it held an OAuth pass. */
  clientId: string | null;
  clientName: string | null;
};

export type PreviewGroup =
  | {
      group: Group;
      decision: "allow";
      records: Record<string, string | number>[];
      withheld: { count: number; reasons: string[] };
    }
  | { group: Group; decision: "refuse"; rule: number; reason: string };

export type Preview = { agentId: string; personId: string; groups: PreviewGroup[] };

/** A FHIR server aipass uses (D18): its own (`aipass`), or an EHR over SMART (S6). */
export type FhirServer = {
  id: string;
  kind: "aipass" | "smart";
  name: string;
  baseUrl: string;
  /** SMART servers only. */
  clientId: string | null;
  scope: string | null;
  confidential: boolean;
  /** aipass's own server: whether aipass signs in with a credential of its own. */
  hasCredential: boolean;
  enabled: boolean;
};

export type FhirTest =
  | {
      ok: true;
      fhirVersion: string | null;
      software: string | null;
      ms: number;
      patients: number | null;
      smart: boolean | null;
    }
  | { ok: false; error: string };

export type DataLocation = "network" | "cloud";

/** An OpenAI-compatible model endpoint (S8). The key never comes back, only whether there is one. */
export type ModelConnection = {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  dataLocation: DataLocation;
  enabled: boolean;
  usedBy: string[];
};

export type ProbeResult = {
  models: string[];
  toolCall: { model: string; ok: boolean; detail: string; ms: number } | null;
};

export const DATA_WORDS: Record<DataLocation, string> = {
  network: "Stays on your network",
  cloud: "Goes to a cloud provider",
};

/** The built-in chat's OAuth client id (S8). */
export const CHAT_CLIENT_ID = "aipass-chat";

/** A patient a staff member has open with one AI (S10). */
export type OpenPatientRef = { ref: string; name: string | null };

/** A staff member's care team, from the record system (S10). */
export type CareTeam = {
  staff: boolean;
  patients: { ref: string; name: string | null; birthDate: string | null; gender: string | null }[];
};
