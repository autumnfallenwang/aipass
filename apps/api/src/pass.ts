import { randomUUID } from "node:crypto";
import { agents, type Db, persons } from "@aipass/db";
import { agentUrl, PASS_MAX_SECONDS } from "@aipass/shared";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { config, passIssuer } from "./config.ts";
import { activeKey, PASS_ALG } from "./keys.ts";

export class PassError extends Error {}

/** `Patient/maria` → `maria`. Practitioners carry no patient pin. */
export function patientIdOf(fhirRef: string): string | undefined {
  const m = fhirRef.match(/^Patient\/(.+)$/);
  return m?.[1];
}

/**
 * Mints a pass: a short-lived JWT naming the person (`sub`) and the agent
 * (`act.sub`), whose audience is that agent's own gateway URL.
 */
export async function mintPass(
  db: Db,
  opts: { agentId: string; personId: string; ttlSeconds?: number; extra?: Record<string, unknown> },
): Promise<{ token: string; jti: string; expiresAt: number }> {
  const ttl = Math.min(opts.ttlSeconds ?? PASS_MAX_SECONDS, PASS_MAX_SECONDS);
  if (ttl <= 0) throw new PassError("ttl must be positive");
  const [agent] = await db.select().from(agents).where(eq(agents.id, opts.agentId)).limit(1);
  if (!agent) throw new PassError(`no agent "${opts.agentId}"`);
  const [person] = await db.select().from(persons).where(eq(persons.id, opts.personId)).limit(1);
  if (!person) throw new PassError(`no person "${opts.personId}"`);

  const { kid, key } = await activeKey(db);
  const jti = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const patient = patientIdOf(person.fhirRef);
  const token = await new SignJWT({
    ...opts.extra,
    act: { sub: agent.id },
    ...(patient ? { patient } : {}),
  })
    .setProtectedHeader({ alg: PASS_ALG, kid, typ: "at+jwt" })
    .setIssuer(passIssuer())
    .setSubject(person.id)
    .setAudience(agentUrl(config.gatewayUrl, agent.id))
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(jti)
    .sign(key);
  return { token, jti, expiresAt: now + ttl };
}
