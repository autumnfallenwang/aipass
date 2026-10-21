/**
 * People (S9): who the agents act for, at a clinic's scale. The list is
 * searched, filtered and paged on the server; a person is added from a record
 * the admin picks in a FHIR server; and only the person can say yes to an AI
 * (D19), except test persons, whose grants the admin may set.
 */
import {
  agents,
  approvals,
  authSchema,
  type Db,
  fhirServers,
  grants,
  newId,
  persons,
  receipts,
  roles,
  users,
  vault,
} from "@aipass/db";
import type { FhirClient, Resource } from "@aipass/fhir";
import { firstName, Permission, PersonStatus, rulesToPermissions } from "@aipass/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  isNull,
  max,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import * as z from "zod";
import type { Auth } from "./auth.ts";
import { revokeRefreshTokens } from "./oauth.ts";

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  server: z.string().max(100).optional(),
  login: z.enum(["yes", "no"]).optional(),
  agent: z.string().max(100).optional(),
  status: PersonStatus.optional(),
  test: z.enum(["yes", "no"]).optional(),
  sort: z.enum(["name", "activity", "ais"]).default("name"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const AddBody = z.strictObject({
  /** The server the record is at; only aipass's own can be searched and picked. */
  serverId: z.string().min(1),
  ref: z.string().regex(/^(Patient|Practitioner)\/[A-Za-z0-9\-.]{1,64}$/),
  displayName: z.string().trim().min(1).max(120).optional(),
  isTest: z.boolean().optional(),
});

const PatchBody = z.strictObject({
  displayName: z.string().trim().min(1).max(120).optional(),
  status: PersonStatus.optional(),
});

const LoginBody = z.strictObject({
  email: z.email(),
  password: z.string().min(10).max(200),
});

const GrantBody = z.strictObject({ permissions: z.array(Permission) });

/** `%` and `_` typed in a search mean themselves. */
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** A FHIR HumanName as one line. */
function nameOf(r: Resource): string | null {
  const n = (r.name as { text?: string; given?: string[]; family?: string }[] | undefined)?.[0];
  if (!n) return null;
  return n.text ?? ([...(n.given ?? []), n.family].filter(Boolean).join(" ") || null);
}

export function adminPeopleRoutes(deps: { db: Db; auth: Auth; fhir: FhirClient }) {
  const { db, auth, fhir } = deps;
  const app = new Hono();

  async function aipassServer() {
    const [s] = await db.select().from(fhirServers).where(eq(fhirServers.kind, "aipass"));
    return s ?? null;
  }

  // ---------- the list ----------

  app.get("/persons", async (c) => {
    const parsed = ListQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const f = parsed.data;
    const where: SQL[] = [];
    if (f.q) {
      const like = likeOf(f.q);
      where.push(
        or(
          ilike(persons.displayName, like),
          ilike(persons.fhirRef, like),
          ilike(persons.id, like),
          exists(
            db
              .select({ one: sql`1` })
              .from(users)
              .where(and(eq(users.id, persons.userId), ilike(users.email, like))),
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(vault)
              .where(and(eq(vault.personId, persons.id), ilike(vault.patientId, like))),
          ),
        ) as SQL,
      );
    }
    if (f.server) {
      const own = await aipassServer();
      // Everyone has a record at aipass's own server; an EHR only after they connect it.
      if (f.server !== own?.id) {
        where.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(vault)
              .where(and(eq(vault.personId, persons.id), eq(vault.serverId, f.server))),
          ),
        );
      }
    }
    if (f.login === "yes") where.push(isNotNull(persons.userId));
    if (f.login === "no") where.push(isNull(persons.userId));
    if (f.agent) {
      where.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(grants)
            .where(
              and(
                eq(grants.personId, persons.id),
                eq(grants.agentId, f.agent),
                eq(grants.status, "active"),
              ),
            ),
        ),
      );
    }
    if (f.status) where.push(eq(persons.status, f.status));
    if (f.test) where.push(eq(persons.isTest, f.test === "yes"));
    const cond = where.length ? and(...where) : undefined;

    const lastActivity = sql<Date | null>`(select max(${receipts.ts}) from ${receipts}
      where ${receipts.personId} = ${persons.id} and ${receipts.mode} = 'live')`;
    const activeAis = sql<number>`(select count(*) from ${grants}
      where ${grants.personId} = ${persons.id} and ${grants.status} = 'active')`;
    const order =
      f.sort === "activity"
        ? [sql`${lastActivity} desc nulls last`, asc(persons.displayName), asc(persons.id)]
        : f.sort === "ais"
          ? [desc(activeAis), asc(persons.displayName), asc(persons.id)]
          : [asc(persons.displayName), asc(persons.id)];

    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(persons)
      .where(cond);
    const rows = await db
      .select({ person: persons, email: users.email })
      .from(persons)
      .leftJoin(users, eq(users.id, persons.userId))
      .where(cond)
      .orderBy(...order)
      .limit(f.limit)
      .offset((f.page - 1) * f.limit);

    const ids = rows.map((r) => r.person.id);
    const [own, links, gs, last] = ids.length
      ? await Promise.all([
          aipassServer(),
          db
            .select({
              personId: vault.personId,
              serverId: vault.serverId,
              patientId: vault.patientId,
              serverName: fhirServers.name,
            })
            .from(vault)
            .innerJoin(fhirServers, eq(fhirServers.id, vault.serverId))
            .where(inArray(vault.personId, ids)),
          db
            .select({ personId: grants.personId, status: grants.status })
            .from(grants)
            .where(inArray(grants.personId, ids)),
          db
            .select({ personId: receipts.personId, last: max(receipts.ts) })
            .from(receipts)
            .where(and(inArray(receipts.personId, ids), eq(receipts.mode, "live")))
            .groupBy(receipts.personId),
        ])
      : [null, [], [], []];

    return c.json({
      total,
      page: f.page,
      limit: f.limit,
      items: rows.map(({ person: p, email }) => {
        const mine = gs.filter((g) => g.personId === p.id);
        return {
          id: p.id,
          displayName: p.displayName,
          status: p.status,
          isTest: p.isTest,
          email: email ?? null,
          records: [
            {
              serverId: own?.id ?? "aipass",
              serverName: own?.name ?? "aipass's FHIR server",
              ref: p.fhirRef,
              linkedBy: "admin",
            },
            ...links
              .filter((l) => l.personId === p.id)
              .map((l) => ({
                serverId: l.serverId,
                serverName: l.serverName,
                ref: `Patient/${l.patientId}`,
                linkedBy: "person",
              })),
          ],
          ais: { active: mine.filter((g) => g.status === "active").length, total: mine.length },
          lastActivity: last.find((l) => l.personId === p.id)?.last ?? null,
        };
      }),
    });
  });

  // ---------- one person ----------

  app.get("/persons/:id", async (c) => {
    const [row] = await db
      .select({ person: persons, user: users })
      .from(persons)
      .leftJoin(users, eq(users.id, persons.userId))
      .where(eq(persons.id, c.req.param("id")));
    if (!row) return c.json({ error: "no such person" }, 404);
    const p = row.person;
    const own = await aipassServer();
    const links = await db
      .select({ v: vault, serverName: fhirServers.name })
      .from(vault)
      .innerJoin(fhirServers, eq(fhirServers.id, vault.serverId))
      .where(eq(vault.personId, p.id));
    const gs = await db
      .select({ grant: grants, agentName: agents.name, roleRules: roles.rules })
      .from(grants)
      .innerJoin(agents, eq(grants.agentId, agents.id))
      .innerJoin(roles, eq(agents.roleId, roles.id))
      .where(eq(grants.personId, p.id));
    const passkeys = row.user
      ? await db
          .select({ n: count() })
          .from(authSchema.passkey)
          .where(eq(authSchema.passkey.userId, row.user.id))
      : [];
    const waiting = await db
      .select({ a: approvals, agentName: agents.name })
      .from(approvals)
      .leftJoin(agents, eq(approvals.agentId, agents.id))
      .where(
        and(
          or(eq(approvals.personId, p.id), eq(approvals.approverPersonId, p.id)),
          eq(approvals.status, "pending"),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(20);
    return c.json({
      id: p.id,
      displayName: p.displayName,
      status: p.status,
      isTest: p.isTest,
      createdAt: p.createdAt,
      login: row.user
        ? {
            email: row.user.email,
            createdAt: row.user.createdAt,
            passkeys: passkeys[0]?.n ?? 0,
          }
        : null,
      records: [
        {
          serverId: own?.id ?? "aipass",
          serverName: own?.name ?? "aipass's FHIR server",
          kind: "aipass",
          ref: p.fhirRef,
          linkedBy: "admin",
          linkedAt: p.createdAt,
        },
        ...links.map(({ v, serverName }) => ({
          serverId: v.serverId,
          serverName,
          kind: "smart",
          ref: `Patient/${v.patientId}`,
          linkedBy: "person",
          linkedAt: v.connectedAt,
        })),
      ],
      grants: gs.map(({ grant, agentName, roleRules }) => ({
        ...grant,
        agentName,
        ceiling: rulesToPermissions(roleRules),
      })),
      approvals: waiting.map(({ a, agentName }) => ({
        id: a.id,
        agentName,
        summary: a.summary,
        forThem: a.personId === p.id,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
      })),
    });
  });

  // Rename, or pause / resume: a paused person's AIs are refused on their next call.
  app.patch("/persons/:id", async (c) => {
    const body = PatchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const [p] = await db
      .update(persons)
      .set(body.data)
      .where(eq(persons.id, c.req.param("id")))
      .returning();
    return p ? c.json(p) : c.json({ error: "no such person" }, 404);
  });

  /**
   * Off-boarding: their grants, connected records, chat links, login, sessions
   * and tokens go; their receipts stay, because they're the audit trail.
   */
  app.delete("/persons/:id", async (c) => {
    const [p] = await db
      .select()
      .from(persons)
      .where(eq(persons.id, c.req.param("id")));
    if (!p) return c.json({ error: "no such person" }, 404);
    await db.transaction(async (tx) => {
      await tx
        .update(approvals)
        .set({ status: "denied", deniedAt: new Date() })
        .where(
          and(
            or(eq(approvals.personId, p.id), eq(approvals.approverPersonId, p.id)),
            eq(approvals.status, "pending"),
          ),
        );
      await tx.delete(persons).where(eq(persons.id, p.id));
      // The login, with its sessions, passkeys, tokens and chat links (cascade).
      if (p.userId) await tx.delete(users).where(eq(users.id, p.userId));
    });
    const [kept] = await db
      .select({ n: count() })
      .from(receipts)
      .where(eq(receipts.personId, p.id));
    return c.json({ removed: p.id, receiptsKept: kept?.n ?? 0 });
  });

  // ---------- adding people from a record ----------

  // Search a FHIR server for the record to add. Only aipass's own can be searched:
  // aipass holds no access to an EHR of its own; people connect their records there.
  app.get("/fhir-servers/:id/patients", async (c) => {
    const [server] = await db
      .select()
      .from(fhirServers)
      .where(eq(fhirServers.id, c.req.param("id")));
    if (!server) return c.json({ error: "no such server" }, 404);
    if (server.kind !== "aipass") {
      return c.json(
        {
          error: `aipass can't search ${server.name}: people connect their own record there, from My AIs`,
        },
        400,
      );
    }
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const type = c.req.query("type") === "Practitioner" ? "Practitioner" : "Patient";
    const next = c.req.query("page");
    let bundle: Awaited<ReturnType<FhirClient["search"]>>;
    try {
      if (next) {
        // A paging link this server gave us, and only that.
        if (!fhir.owns(next)) return c.json({ error: "that page isn't from this server" }, 400);
        bundle = await fhir.page(next);
      } else {
        const params = new URLSearchParams({ _count: "20", _sort: "name" });
        if (q) params.set(/\d/.test(q) ? "identifier" : "name", q);
        bundle = await fhir.search(type, params);
      }
    } catch (err) {
      return c.json({ error: `the search didn't work (${(err as Error).message})` }, 502);
    }
    const found = (bundle.entry ?? [])
      .map((e) => e.resource)
      .filter((r): r is Resource => Boolean(r?.id) && r?.resourceType === type);
    const refs = found.map((r) => `${type}/${r.id}`);
    const taken = refs.length
      ? await db
          .select({ ref: persons.fhirRef, id: persons.id, name: persons.displayName })
          .from(persons)
          .where(inArray(persons.fhirRef, refs))
      : [];
    const link = (bundle.link as { relation: string; url: string }[] | undefined)?.find(
      (l) => l.relation === "next",
    );
    return c.json({
      total: typeof bundle.total === "number" ? bundle.total : null,
      next: link?.url ?? null,
      items: found.map((r) => {
        const ref = `${type}/${r.id}`;
        const t = taken.find((x) => x.ref === ref);
        const ident = (r.identifier as { value?: string }[] | undefined)?.[0]?.value ?? null;
        return {
          ref,
          name: nameOf(r),
          birthDate: (r.birthDate as string | undefined) ?? null,
          gender: (r.gender as string | undefined) ?? null,
          identifier: ident,
          takenBy: t ? { id: t.id, displayName: t.name } : null,
        };
      }),
    });
  });

  app.post("/persons", async (c) => {
    const body = AddBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const own = await aipassServer();
    if (body.data.serverId !== own?.id) {
      return c.json({ error: "people are added from a record at aipass's own FHIR server" }, 400);
    }
    const [type, rid] = body.data.ref.split("/") as [string, string];
    let record: Resource | null;
    try {
      record = await fhir.read(type, rid);
    } catch (err) {
      return c.json({ error: `couldn't read that record (${(err as Error).message})` }, 502);
    }
    if (!record) return c.json({ error: `there's no ${body.data.ref} at ${own.name}` }, 400);
    const [taken] = await db.select().from(persons).where(eq(persons.fhirRef, body.data.ref));
    if (taken) {
      return c.json({ error: `that record is already ${taken.displayName}` }, 409);
    }
    const displayName = body.data.displayName ?? nameOf(record) ?? body.data.ref;
    const base =
      displayName
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "person";
    let id = base;
    for (let n = 2; ; n++) {
      const [hit] = await db.select({ id: persons.id }).from(persons).where(eq(persons.id, id));
      if (!hit) break;
      id = `${base}-${n}`;
    }
    const [person] = await db
      .insert(persons)
      .values({ id, displayName, fhirRef: body.data.ref, isTest: body.data.isTest ?? false })
      .returning();
    return c.json(person, 201);
  });

  // A login, so they can consent, chat and see "My AIs". The password is temporary.
  app.post("/persons/:id/login", async (c) => {
    const body = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected {email, password (10+ characters)}" }, 400);
    const [person] = await db
      .select()
      .from(persons)
      .where(eq(persons.id, c.req.param("id")));
    if (!person) return c.json({ error: "no such person" }, 404);
    if (person.userId) return c.json({ error: "this person already has a login" }, 409);
    try {
      const { user } = await auth.api.signUpEmail({
        body: { name: person.displayName, email: body.data.email, password: body.data.password },
      });
      await db.update(persons).set({ userId: user.id }).where(eq(persons.id, person.id));
      return c.json({ personId: person.id, email: body.data.email }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---------- grants: only the person says yes (D19) ----------

  async function personFor(id: string) {
    const [p] = await db.select().from(persons).where(eq(persons.id, id));
    return p ?? null;
  }
  const onlyThem = (p: { displayName: string }) =>
    `only ${firstName(p.displayName)} can agree to this, on their consent page or My AIs; you can revoke it`;

  app.put("/persons/:id/grants/:agentId", async (c) => {
    const body = GrantBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const person = await personFor(c.req.param("id"));
    if (!person) return c.json({ error: "no such person" }, 404);
    if (!person.isTest) return c.json({ error: onlyThem(person) }, 403);
    const agentId = c.req.param("agentId");
    const [grant] = await db
      .insert(grants)
      .values({
        id: newId("grt"),
        personId: person.id,
        agentId,
        permissions: body.data.permissions,
        status: "active",
        setBy: "admin",
      })
      .onConflictDoUpdate({
        target: [grants.personId, grants.agentId],
        set: {
          permissions: body.data.permissions,
          status: "active",
          revokedAt: null,
          setBy: "admin",
        },
      })
      .returning()
      .catch(() => []);
    if (!grant) return c.json({ error: "no such agent" }, 404);
    return c.json(grant);
  });

  app.post("/persons/:id/grants/:agentId/revoke", async (c) => {
    const person = await personFor(c.req.param("id"));
    if (!person) return c.json({ error: "no such person" }, 404);
    const agentId = c.req.param("agentId");
    const [grant] = await db
      .update(grants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(grants.personId, person.id), eq(grants.agentId, agentId)))
      .returning();
    if (!grant) return c.json({ error: "no such grant" }, 404);
    // As when the person revokes: the AI's refresh tokens stop working too.
    if (person.userId) await revokeRefreshTokens(db, person.userId, agentId);
    return c.json(grant);
  });

  app.post("/persons/:id/grants/:agentId/restore", async (c) => {
    const person = await personFor(c.req.param("id"));
    if (!person) return c.json({ error: "no such person" }, 404);
    if (!person.isTest) return c.json({ error: onlyThem(person) }, 403);
    const [grant] = await db
      .update(grants)
      .set({ status: "active", revokedAt: null, setBy: "admin" })
      .where(and(eq(grants.personId, person.id), eq(grants.agentId, c.req.param("agentId"))))
      .returning();
    if (!grant) return c.json({ error: "no such grant" }, 404);
    return c.json(grant);
  });

  return app;
}
