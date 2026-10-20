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
  agentCount?: number;
};

export type Grant = {
  id: string;
  personId: string;
  agentId: string;
  agentName: string;
  permissions: Permission[];
  status: "active" | "revoked";
  grantedAt: string;
  revokedAt: string | null;
};

export type Person = {
  id: string;
  displayName: string;
  fhirRef: string;
  userId: string | null;
  grants: Grant[];
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

export type FhirServer = {
  id: string;
  name: string;
  baseUrl: string;
  clientId: string;
  confidential: boolean;
  scope: string;
  enabled: boolean;
};
