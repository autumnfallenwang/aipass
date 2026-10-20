/**
 * Admin actions from the terminal (the admin UI arrives in S2).
 *
 *   pnpm admin agent stop diabetes-coach
 *   pnpm admin agent resume diabetes-coach
 *   pnpm admin grant revoke maria diabetes-coach
 *   pnpm admin grant restore maria diabetes-coach
 *   pnpm admin receipts [n]
 */
import { agents, createDb, grants, receipts } from "@aipass/db";
import { and, desc, eq } from "drizzle-orm";
import { config } from "../src/config.ts";

const [what, verb, a, b] = process.argv.slice(2);
const { db, close } = createDb(config.databaseUrl);

async function run(): Promise<string> {
  if (what === "agent" && (verb === "stop" || verb === "resume") && a) {
    const status = verb === "stop" ? "stopped" : "active";
    const r = await db.update(agents).set({ status }).where(eq(agents.id, a)).returning();
    return r.length ? `agent ${a} is now ${status}` : `no agent ${a}`;
  }
  if (what === "grant" && (verb === "revoke" || verb === "restore") && a && b) {
    const r = await db
      .update(grants)
      .set(
        verb === "revoke"
          ? { status: "revoked", revokedAt: new Date() }
          : { status: "active", revokedAt: null },
      )
      .where(and(eq(grants.personId, a), eq(grants.agentId, b)))
      .returning();
    return r.length ? `grant ${a} → ${b} is now ${r[0]?.status}` : `no grant ${a} → ${b}`;
  }
  if (what === "receipts") {
    const n = Number(verb ?? 10);
    const rows = await db.select().from(receipts).orderBy(desc(receipts.seq)).limit(n);
    return rows
      .reverse()
      .map((r) => `${r.ts.toISOString()}  ${r.decision.padEnd(6)}  ${r.sentence}`)
      .join("\n");
  }
  process.exitCode = 2;
  return "usage: pnpm admin agent stop|resume <agent> | grant revoke|restore <person> <agent> | receipts [n]";
}

try {
  console.info(await run());
} finally {
  await close();
}
