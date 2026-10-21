import { asSmart, type Db, fhirServers, type SmartServer, seal, unseal, vault } from "@aipass/db";
import {
  type CarePatient,
  careTeamOf,
  FhirClient,
  refreshTokens,
  type SmartTokens,
} from "@aipass/fhir";
import { firstName, type Refuse, refuse } from "@aipass/policy";
import { and, eq } from "drizzle-orm";

/** Where one call's records come from, and which patient they must belong to. */
export type Target = {
  fhir: FhirClient;
  /** The pinned patient at that server. */
  patientRef: string;
  /** Set when it's another server than aipass's own (S6). */
  source?: { id: string; name: string; baseUrl: string };
};

/** Refresh this long before the upstream token expires. */
const EARLY_MS = 30_000;

/**
 * Picks the FHIR server for a call (S6). An agent with no server set reads
 * aipass's own; otherwise the gateway opens the person's vault entry for that
 * server, refreshes the token if needed, and pins the patient from the launch.
 * The upstream token goes in a header to that server and nowhere else.
 */
export class Upstreams {
  private get opening(): Buffer[] {
    return this.deps.keys ?? [this.deps.key];
  }

  /** One refresh per vault entry at a time: refresh tokens may be single use. */
  private readonly refreshing = new Map<string, Promise<StoredTokens>>();

  constructor(
    private readonly deps: {
      db: Db;
      home: FhirClient;
      /** Seals (the current vault key). */
      key: Buffer;
      /** Opens (current first, then previous keys during a rotation). */
      keys?: Buffer[];
      fetch?: typeof fetch;
    },
  ) {}

  /**
   * Is this patient in the staff member's care (S10, D21)? Asked of aipass's
   * own FHIR server on every call; the patient's details if so. Throws when
   * the server doesn't answer, so the caller refuses (fail closed).
   */
  async inCare(practitionerRef: string, patientRef: string): Promise<CarePatient | null> {
    const found = await careTeamOf(this.deps.home, practitionerRef, patientRef);
    return found.find((p) => p.ref === patientRef) ?? null;
  }

  async target(
    serverId: string | null | undefined,
    person: { id: string; name: string },
    homePatientRef: string,
    opts: { staff?: boolean } = {},
  ): Promise<Target | Refuse> {
    if (!serverId) return { fhir: this.deps.home, patientRef: homePatientRef };
    const { db } = this.deps;
    const [row] = await db.select().from(fhirServers).where(eq(fhirServers.id, serverId));
    if (row?.kind === "aipass") return { fhir: this.deps.home, patientRef: homePatientRef };
    // A staff member's care team is at aipass's own server; at an EHR they'd need its own sign-in.
    if (opts.staff) {
      return refuse(
        4,
        "not_connected",
        "a staff member's records come from aipass's own FHIR server only, for now",
      );
    }
    const server = asSmart(row);
    if (!server?.enabled) {
      return refuse(
        0,
        "check_failed",
        "the record server is switched off, so nothing was released",
      );
    }
    const first = firstName(person.name);
    const [entry] = await db
      .select()
      .from(vault)
      .where(and(eq(vault.personId, person.id), eq(vault.serverId, server.id)));
    if (!entry) {
      return refuse(4, "not_connected", `${first} hasn't connected a record at ${server.name}`);
    }
    const bind = `${person.id}|${server.id}`;
    let tokens: StoredTokens;
    try {
      tokens = JSON.parse(unseal(this.opening, entry.tokensSealed, bind)) as StoredTokens;
    } catch {
      return refuse(
        0,
        "check_failed",
        "the stored connection couldn't be opened, so nothing was released",
      );
    }
    if (entry.expiresAt.getTime() - EARLY_MS < Date.now()) {
      const running = this.refreshing.get(bind);
      const job =
        running ??
        this.refresh(server, person.id, tokens, bind).finally(() => this.refreshing.delete(bind));
      if (!running) this.refreshing.set(bind, job);
      try {
        tokens = await job;
      } catch (err) {
        console.error(`upstream refresh for ${server.id} failed: ${(err as Error).message}`);
        return refuse(
          4,
          "not_connected",
          `the connection to ${server.name} expired; ${first} needs to reconnect`,
        );
      }
    }
    return {
      fhir: new FhirClient({
        baseUrl: server.baseUrl,
        headers: { authorization: `Bearer ${tokens.access_token}` },
        fetch: this.deps.fetch,
      }),
      patientRef: `Patient/${entry.patientId}`,
      source: { id: server.id, name: server.name, baseUrl: server.baseUrl },
    };
  }

  private async refresh(
    server: SmartServer,
    personId: string,
    old: StoredTokens,
    bind: string,
  ): Promise<StoredTokens> {
    const { db, key } = this.deps;
    if (!old.refresh_token) throw new Error("no refresh token");
    const secret = server.clientSecretSealed
      ? unseal(this.opening, server.clientSecretSealed, `server|${server.id}`)
      : null;
    const got: SmartTokens = await refreshTokens(
      { tokenUrl: server.tokenUrl, clientId: server.clientId, clientSecret: secret },
      old.refresh_token,
      this.deps.fetch,
    );
    // The launch pinned the patient; a refresh can't move it.
    if (got.patient && got.patient !== (await this.pinned(personId, server.id))) {
      throw new Error("the refreshed token is for a different patient");
    }
    const next: StoredTokens = {
      access_token: got.access_token,
      refresh_token: got.refresh_token ?? old.refresh_token,
      scope: got.scope ?? old.scope,
    };
    await db
      .update(vault)
      .set({
        tokensSealed: seal(key, JSON.stringify(next), bind),
        expiresAt: new Date(Date.now() + (got.expires_in ?? 300) * 1000),
      })
      .where(and(eq(vault.personId, personId), eq(vault.serverId, server.id)));
    return next;
  }

  private async pinned(personId: string, serverId: string): Promise<string | undefined> {
    const [row] = await this.deps.db
      .select({ patientId: vault.patientId })
      .from(vault)
      .where(and(eq(vault.personId, personId), eq(vault.serverId, serverId)));
    return row?.patientId;
  }
}

/** What the vault holds for one person at one server. */
export type StoredTokens = { access_token: string; refresh_token?: string; scope?: string };

export function isTarget(t: Target | Refuse): t is Target {
  return "fhir" in t;
}
