import { agents, approvalRules, approvals, authSchema, type Db, persons, roles } from "@aipass/db";
import { approvalChallenge, type FhirClient, humanName, normaliseRef } from "@aipass/fhir";
import { APPROVAL_WINDOW_SECONDS } from "@aipass/policy";
import { GROUPS, rulesToPermissions } from "@aipass/shared";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { decodeJwt } from "jose";
import * as z from "zod";
import type { Auth } from "./auth.ts";
import { config } from "./config.ts";

const { passkey } = authSchema;

/** Planted defect for the health check's `self_approve` probe (refused in production). */
function brokenApproveAuth(): boolean {
  const on = (process.env.AIPASS_BROKEN ?? "").split(",").includes("approve_auth");
  if (on && process.env.NODE_ENV === "production")
    throw new Error("AIPASS_BROKEN is refused in production");
  return on;
}

type Env = { Variables: { userId: string } };

/**
 * The approver's side of S5. Only a signed-in person (a browser session, never
 * an agent's pass) can approve, only the approver the proposal names, and only
 * with a passkey assertion with user verification over a challenge that binds
 * this payload, this approval and a nonce.
 */
export function approvalRoutes(deps: { db: Db; auth: Auth; fhir: FhirClient }) {
  const { db, auth, fhir } = deps;
  const origin = new URL(config.publicUrl);
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session) {
      c.set("userId", session.user.id);
      return next();
    }
    // Planted defect only: treat an agent's bearer pass as the person's session.
    const bearer = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/)?.[1];
    if (bearer && brokenApproveAuth()) {
      const sub = decodeJwt(bearer).sub ?? "";
      const [p] = await db.select().from(persons).where(eq(persons.id, sub));
      c.set("userId", p?.userId ?? `person:${sub}`);
      return next();
    }
    return c.json({ error: "sign in first (approvals need the person, in a browser)" }, 401);
  });

  /** The signed-in user is this person (or, with the planted defect, holds this person's pass). */
  function isPerson(p: { id: string; userId: string | null } | undefined, userId: string): boolean {
    return Boolean(p && (p.userId === userId || userId === `person:${p.id}`));
  }

  async function load(id: string) {
    const [row] = await db
      .select({ approval: approvals, agentName: agents.name })
      .from(approvals)
      .leftJoin(agents, eq(approvals.agentId, agents.id))
      .where(eq(approvals.id, id));
    if (!row) return null;
    const [approver] = await db
      .select()
      .from(persons)
      .where(eq(persons.id, row.approval.approverPersonId));
    const [forPerson] = await db
      .select()
      .from(persons)
      .where(eq(persons.id, row.approval.personId));
    return { ...row, approver, forPerson };
  }

  /**
   * Whose record the change goes into, when that's not the person the AI acts
   * for: a staff member's change is to the patient they had open (S10).
   */
  async function patientOf(
    a: typeof approvals.$inferSelect,
    forPerson: { fhirRef: string } | undefined,
  ): Promise<string | null> {
    if (!forPerson?.fhirRef.startsWith("Practitioner/")) return null;
    const subject = (a.payload as { subject?: { reference?: string } }).subject?.reference;
    const ref = normaliseRef(subject);
    if (!ref?.startsWith("Patient/")) return null;
    const [known] = await db.select().from(persons).where(eq(persons.fhirRef, ref));
    if (known) return known.displayName;
    const p = await fhir.read("Patient", ref.slice("Patient/".length)).catch(() => null);
    return (p && humanName(p)) ?? ref;
  }

  function stateOf(a: typeof approvals.$inferSelect): string {
    if (a.status === "pending" && a.expiresAt <= new Date()) return "expired";
    if (
      a.status === "approved" &&
      a.approvedAt &&
      Date.now() - a.approvedAt.getTime() > APPROVAL_WINDOW_SECONDS * 1000
    ) {
      return "expired";
    }
    return a.status;
  }

  // The approver's waiting list.
  app.get("/", async (c) => {
    const mine = await db
      .select()
      .from(persons)
      .where(eq(persons.userId, c.get("userId")));
    if (!mine.length) return c.json([]);
    const rows = await db
      .select({ approval: approvals, agentName: agents.name })
      .from(approvals)
      .leftJoin(agents, eq(approvals.agentId, agents.id))
      .where(
        inArray(
          approvals.approverPersonId,
          mine.map((p) => p.id),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(20);
    return c.json(
      rows.map(({ approval: a, agentName }) => ({
        id: a.id,
        agentName,
        summary: a.summary,
        status: stateOf(a),
        createdAt: a.createdAt,
      })),
    );
  });

  app.get("/:id", async (c) => {
    const found = await load(c.req.param("id"));
    if (!found) return c.json({ error: "no such approval" }, 404);
    const { approval: a, approver, forPerson, agentName } = found;
    const isApprover = isPerson(approver, c.get("userId"));
    // Someone who is neither the approver nor the person learns only who may approve (S7, ASVS V8.2.2).
    if (!isApprover && !isPerson(forPerson, c.get("userId"))) {
      return c.json(
        { error: `Only ${approver?.displayName ?? "the approver"} can approve this.` },
        403,
      );
    }
    const status = stateOf(a);
    const keys = await db
      .select()
      .from(passkey)
      .where(eq(passkey.userId, c.get("userId")));
    const options =
      isApprover && status === "pending" && keys.length
        ? await generateAuthenticationOptions({
            rpID: origin.hostname,
            challenge: approvalChallenge(a.payloadHash, a.id, a.nonce),
            allowCredentials: keys.map((k) => ({
              id: k.credentialID,
              transports: k.transports?.split(",") as AuthenticatorTransport[] | undefined,
            })),
            userVerification: "required",
            timeout: 120_000,
          })
        : null;
    return c.json({
      id: a.id,
      agentName,
      forPerson: forPerson?.displayName,
      patient: await patientOf(a, forPerson),
      approver: approver?.displayName,
      isApprover,
      hasPasskey: keys.length > 0,
      summary: a.summary,
      payload: a.payload,
      payloadHash: a.payloadHash,
      status,
      expiresAt: a.expiresAt,
      options,
    });
  });

  app.post("/:id/approve", async (c) => {
    const found = await load(c.req.param("id"));
    if (!found) return c.json({ error: "no such approval" }, 404);
    const { approval: a, approver } = found;
    if (!isPerson(approver, c.get("userId"))) {
      return c.json(
        { error: `only ${approver?.displayName ?? "the approver"} can approve this` },
        403,
      );
    }
    if (stateOf(a) !== "pending") return c.json({ error: `this approval is ${stateOf(a)}` }, 409);

    if (!brokenApproveAuth()) {
      const body = z
        .object({
          response: z.custom<AuthenticationResponseJSON>(
            (v) => typeof v === "object" && v !== null,
          ),
        })
        .safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "approve with your passkey" }, 400);
      const [key] = await db
        .select()
        .from(passkey)
        .where(
          and(eq(passkey.credentialID, body.data.response.id), eq(passkey.userId, c.get("userId"))),
        );
      if (!key) return c.json({ error: "that passkey isn't yours" }, 403);
      const expectedChallenge = Buffer.from(
        approvalChallenge(a.payloadHash, a.id, a.nonce),
      ).toString("base64url");
      let verified = false;
      let newCounter = key.counter;
      try {
        const v = await verifyAuthenticationResponse({
          response: body.data.response,
          expectedChallenge,
          expectedOrigin: config.publicUrl,
          expectedRPID: origin.hostname,
          credential: {
            id: key.credentialID,
            publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64")),
            counter: key.counter,
            transports: key.transports?.split(",") as AuthenticatorTransport[] | undefined,
          },
          requireUserVerification: true,
        });
        verified = v.verified;
        newCounter = v.authenticationInfo.newCounter;
      } catch (err) {
        return c.json({ error: `passkey check failed: ${(err as Error).message}` }, 403);
      }
      if (!verified) return c.json({ error: "passkey check failed" }, 403);
      await db.update(passkey).set({ counter: newCounter }).where(eq(passkey.id, key.id));
      await db
        .update(approvals)
        .set({ credentialId: key.credentialID })
        .where(eq(approvals.id, a.id));
    }
    const [done] = await db
      .update(approvals)
      .set({ status: "approved", approvedAt: new Date(), approvedByUserId: c.get("userId") })
      .where(and(eq(approvals.id, a.id), eq(approvals.status, "pending")))
      .returning();
    if (!done) return c.json({ error: "this approval was already decided" }, 409);
    return c.json({ id: done.id, status: done.status, approvedAt: done.approvedAt });
  });

  app.post("/:id/deny", async (c) => {
    const found = await load(c.req.param("id"));
    if (!found) return c.json({ error: "no such approval" }, 404);
    if (!isPerson(found.approver, c.get("userId"))) {
      return c.json({ error: "only the approver can decide this" }, 403);
    }
    const [done] = await db
      .update(approvals)
      .set({ status: "denied", deniedAt: new Date() })
      .where(and(eq(approvals.id, found.approval.id), eq(approvals.status, "pending")))
      .returning();
    if (!done) return c.json({ error: "this approval was already decided" }, 409);
    return c.json({ id: done.id, status: done.status });
  });

  return app;
}

/** Admin: who approves which proposals, and what happened lately. */
export function adminApprovalRoutes(deps: { db: Db }) {
  const { db } = deps;
  const app = new Hono();

  app.get("/approval-rules", async (c) => {
    const rs = await db.select().from(roles).orderBy(roles.name);
    const rules = await db.select().from(approvalRules);
    return c.json(
      rs.flatMap((r) =>
        GROUPS.filter((g) => rulesToPermissions(r.rules).includes(`${g}:propose`)).map((group) => ({
          roleId: r.id,
          roleName: r.name,
          group,
          approverPersonId:
            rules.find((x) => x.roleId === r.id && x.group === group)?.approverPersonId ?? null,
        })),
      ),
    );
  });

  app.put("/approval-rules", async (c) => {
    const body = z
      .strictObject({
        roleId: z.string(),
        group: z.enum(GROUPS),
        approverPersonId: z.string().nullable(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected {roleId, group, approverPersonId}" }, 400);
    if (body.data.approverPersonId === null) {
      await db
        .delete(approvalRules)
        .where(
          and(eq(approvalRules.roleId, body.data.roleId), eq(approvalRules.group, body.data.group)),
        );
    } else {
      await db
        .insert(approvalRules)
        .values(body.data)
        .onConflictDoUpdate({
          target: [approvalRules.roleId, approvalRules.group],
          set: { approverPersonId: body.data.approverPersonId },
        });
    }
    return c.json(body.data);
  });

  app.get("/approvals", async (c) => {
    const rows = await db
      .select({ approval: approvals, agentName: agents.name })
      .from(approvals)
      .leftJoin(agents, eq(approvals.agentId, agents.id))
      .orderBy(desc(approvals.createdAt))
      .limit(50);
    // Only the people these approvals name, not everyone (S9).
    const ids = [
      ...new Set(rows.flatMap((r) => [r.approval.personId, r.approval.approverPersonId])),
    ];
    const people = ids.length
      ? await db.select().from(persons).where(inArray(persons.id, ids))
      : [];
    const name = (id: string) => people.find((p) => p.id === id)?.displayName ?? id;
    return c.json(
      rows.map(({ approval: a, agentName }) => ({
        id: a.id,
        agentName,
        forPerson: name(a.personId),
        approver: name(a.approverPersonId),
        summary: a.summary,
        status: a.status,
        createdAt: a.createdAt,
        approvedAt: a.approvedAt,
        resultRef: a.resultRef,
      })),
    );
  });

  return app;
}
