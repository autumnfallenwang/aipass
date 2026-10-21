/**
 * The demo (synthetic people, local only):
 * - three roles and three agents, plus a FHIR Device per agent;
 * - Maria and John (patients), Dr. Lee (a clinician, S10), their grants, and a
 *   demo login for each;
 * - Claude Code and the built-in chat approved to connect as any demo agent;
 * - a model for the chat, if your local env names one (see seedDevModels).
 *
 * Demo logins:
 *   maria@example.org / maria-demo-password
 *   john@example.org  / john-demo-password
 *   lee@example.org   / lee-demo-password
 */
import {
  accounts,
  agents,
  aipassFhirTarget,
  type Db,
  DEMO,
  ensureAipassFhirServer,
  ensureChatClient,
  type ModelDataLocation,
  modelConnections,
  persons,
  seal,
  seedDemo,
  users,
  vaultKey,
} from "@aipass/db";
import { buildDevice, FhirClient } from "@aipass/fhir";
import { hashPassword } from "better-auth/crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { config } from "./config.ts";
import { syncOAuth } from "./oauth.ts";

export const DEMO_LOGINS = [
  { personId: "maria", email: "maria@example.org", password: "maria-demo-password" },
  { personId: "john", email: "john@example.org", password: "john-demo-password" },
  { personId: "lee", email: "lee@example.org", password: "lee-demo-password" },
];

/**
 * Person logins are written directly with role "person", so they can never
 * take the "first account becomes admin" slot.
 */
async function seedLogins(db: Db): Promise<void> {
  for (const l of DEMO_LOGINS) {
    const [person] = await db.select().from(persons).where(eq(persons.id, l.personId));
    if (!person || person.userId) continue;
    let [user] = await db.select().from(users).where(eq(users.email, l.email));
    if (!user) {
      const id = `user-${l.personId}`;
      const now = new Date();
      [user] = await db
        .insert(users)
        .values({
          id,
          name: person.displayName,
          email: l.email,
          emailVerified: true,
          role: "person",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await db.insert(accounts).values({
        id: `acct-${l.personId}`,
        accountId: id,
        providerId: "credential",
        userId: id,
        password: await hashPassword(l.password),
        createdAt: now,
        updatedAt: now,
      });
    }
    if (user) await db.update(persons).set({ userId: user.id }).where(eq(persons.id, person.id));
  }
}

/**
 * A model for the demo agents' built-in chat (S8), from your local env, so the
 * repo names no endpoint. Without AIPASS_DEV_MODEL_URL nothing is added and
 * the admin adds one on the AI models page.
 *
 *   AIPASS_DEV_MODEL_URL=…/v1  AIPASS_DEV_MODEL=<model id>
 *   AIPASS_DEV_MODEL_NAME=…    AIPASS_DEV_MODEL_KEY=…    AIPASS_DEV_MODEL_DATA=network|cloud (default cloud)
 *   AIPASS_DEV_FALLBACK_URL=…/v1  AIPASS_DEV_FALLBACK_MODEL=…  (e.g. a local Ollama; data stays on the network)
 */
export async function seedDevModels(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const key = vaultKey();
  async function upsert(
    id: string,
    name: string,
    url: string,
    data: ModelDataLocation,
    apiKey?: string,
  ) {
    const values = {
      name,
      baseUrl: url.replace(/\/+$/, ""),
      dataLocation: data,
      apiKeySealed: apiKey ? seal(key, apiKey, `model|${id}`) : null,
    };
    await db
      .insert(modelConnections)
      .values({ id, ...values })
      .onConflictDoUpdate({ target: modelConnections.id, set: values });
  }
  const ids = DEMO.agents.map((a) => a.id);
  if (env.AIPASS_DEV_MODEL_URL && env.AIPASS_DEV_MODEL) {
    await upsert(
      "dev-model",
      env.AIPASS_DEV_MODEL_NAME ?? "Dev model",
      env.AIPASS_DEV_MODEL_URL,
      env.AIPASS_DEV_MODEL_DATA === "network" ? "network" : "cloud",
      env.AIPASS_DEV_MODEL_KEY,
    );
    // Only agents with no model yet: an admin's choice is kept.
    await db
      .update(agents)
      .set({ modelConnectionId: "dev-model", model: env.AIPASS_DEV_MODEL })
      .where(and(inArray(agents.id, ids), isNull(agents.modelConnectionId)));
  }
  if (env.AIPASS_DEV_FALLBACK_URL && env.AIPASS_DEV_FALLBACK_MODEL) {
    await upsert(
      "dev-fallback",
      env.AIPASS_DEV_FALLBACK_NAME ?? "Local model",
      env.AIPASS_DEV_FALLBACK_URL,
      "network",
    );
    await db
      .update(agents)
      .set({ fallbackConnectionId: "dev-fallback", fallbackModel: env.AIPASS_DEV_FALLBACK_MODEL })
      .where(and(inArray(agents.id, ids), isNull(agents.fallbackConnectionId)));
  }
}

/** Adds whatever of the demo is missing, or (`reset`) puts it back to its starting state. */
export async function seedDemoAll(
  db: Db,
  opts: { fhirBaseUrl: string; fhirHeaders?: Record<string, string>; reset?: boolean },
): Promise<void> {
  await seedDemo(db, { reset: opts.reset });
  await seedLogins(db);
  await seedDevModels(db);
  await syncOAuth(db);
  await ensureChatClient(db, config.gatewayUrl, config.publicUrl);
  await ensureAipassFhirServer(db, {
    baseUrl: opts.fhirBaseUrl,
    authorization: opts.fhirHeaders?.authorization,
  });
  // The agents' Devices go to aipass's FHIR server as registered.
  const target = await aipassFhirTarget(db);
  const fhir = new FhirClient(target ?? { baseUrl: opts.fhirBaseUrl, headers: opts.fhirHeaders });
  for (const a of DEMO.agents) await fhir.update(buildDevice({ ...a, status: "active" }));
}
