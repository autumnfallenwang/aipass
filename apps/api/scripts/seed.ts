/**
 * Seeds the Maria demo:
 * - two roles and two agents, plus a FHIR Device per agent;
 * - Maria and John, their grants, and a demo login for each;
 * - Claude Code approved to connect as either agent.
 *
 *   pnpm db:seed            # adds what's missing
 *   pnpm db:seed --reset    # puts the demo back to its starting state
 *
 * Demo logins (synthetic people, local only):
 *   maria@example.org / maria-demo-password
 *   john@example.org  / john-demo-password
 */
import { accounts, createDb, type Db, DEMO, persons, seedDemo, users } from "@aipass/db";
import { buildDevice, FhirClient } from "@aipass/fhir";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { config } from "../src/config.ts";
import { syncOAuth } from "../src/oauth.ts";

export const DEMO_LOGINS = [
  { personId: "maria", email: "maria@example.org", password: "maria-demo-password" },
  { personId: "john", email: "john@example.org", password: "john-demo-password" },
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

const reset = process.argv.includes("--reset");
const { db, close } = createDb(config.databaseUrl);
try {
  await seedDemo(db, { reset });
  await seedLogins(db);
  await syncOAuth(db);
  const fhir = new FhirClient({ baseUrl: config.fhirBaseUrl });
  for (const a of DEMO.agents) await fhir.update(buildDevice({ ...a, status: "active" }));
  console.info(reset ? "demo reset" : "demo seeded");
} finally {
  await close();
}
