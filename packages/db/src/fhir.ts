/**
 * aipass's own FHIR server, registered like everything else (D18). It's
 * written once from the install's settings (FHIR_BASE_URL, FHIR_AUTHORIZATION);
 * after that the admin changes it on the FHIR servers page, and the running
 * api and gateway follow within seconds.
 */
import { eq } from "drizzle-orm";
import type { Db } from "./index.ts";
import { fhirServers } from "./schema.ts";
import { seal, unseal, vaultKey, vaultKeys } from "./vault.ts";

export const AIPASS_FHIR_ID = "aipass";
export const AIPASS_FHIR_NAME = "aipass's FHIR server";

export const fhirAuthBind = (id: string) => `fhir-auth|${id}`;

export type FhirTarget = { baseUrl: string; headers: Record<string, string> };

/** Registers aipass's own FHIR server from the install's settings, unless it already is. */
export async function ensureAipassFhirServer(
  db: Db,
  seed: { baseUrl: string; authorization?: string | null },
): Promise<void> {
  const [hit] = await db
    .select({ id: fhirServers.id })
    .from(fhirServers)
    .where(eq(fhirServers.kind, "aipass"));
  if (hit) return;
  await db
    .insert(fhirServers)
    .values({
      id: AIPASS_FHIR_ID,
      kind: "aipass",
      name: AIPASS_FHIR_NAME,
      baseUrl: seed.baseUrl.replace(/\/+$/, ""),
      authHeaderSealed: seed.authorization
        ? seal(vaultKey(), seed.authorization, fhirAuthBind(AIPASS_FHIR_ID))
        : null,
    })
    .onConflictDoNothing();
}

/** Where aipass's own FHIR server is right now, and the headers to sign in with. */
export async function aipassFhirTarget(db: Db): Promise<FhirTarget | null> {
  const [s] = await db.select().from(fhirServers).where(eq(fhirServers.kind, "aipass"));
  if (!s) return null;
  return {
    baseUrl: s.baseUrl,
    headers: s.authHeaderSealed
      ? { authorization: unseal(vaultKeys(), s.authHeaderSealed, fhirAuthBind(s.id)) }
      : {},
  };
}

/**
 * Keeps something pointed at the registered server: reads it now and every
 * `ms` after, calling `apply` when it changed. A failed read keeps the last
 * good target. `refresh()` reads it straight away (after an edit).
 */
export function followAipassFhir(
  db: Db,
  apply: (t: FhirTarget) => void,
  ms = 5000,
): { refresh: () => Promise<void>; stop: () => void } {
  let last = "";
  const refresh = async () => {
    try {
      const t = await aipassFhirTarget(db);
      if (!t) return;
      const key = JSON.stringify(t);
      if (key !== last) {
        last = key;
        apply(t);
      }
    } catch (err) {
      console.error(`reading aipass's FHIR server failed: ${(err as Error).message}`);
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), ms);
  timer.unref?.();
  return { refresh, stop: () => clearInterval(timer) };
}

type Server = typeof fhirServers.$inferSelect;
export type SmartServer = Server & {
  kind: "smart";
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
};

/** The row as a SMART server, or null when it isn't one (aipass's own, or incomplete). */
export function asSmart(s: Server | undefined): SmartServer | null {
  return s?.kind === "smart" && s.authorizeUrl && s.tokenUrl && s.clientId && s.scope
    ? (s as SmartServer)
    : null;
}
