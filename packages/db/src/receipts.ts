import { createHash } from "node:crypto";
import { asc, desc, sql } from "drizzle-orm";
import { newId } from "./ids.ts";
import type { Db } from "./index.ts";
import { receipts } from "./schema.ts";

export type NewReceipt = Omit<
  typeof receipts.$inferInsert,
  "id" | "seq" | "prevHash" | "hash" | "ts"
> & {
  id?: string;
  ts?: Date;
};

export const GENESIS_HASH = "0".repeat(64);

/** The fields a receipt hash covers, in a fixed order. */
function hashInput(r: Omit<typeof receipts.$inferSelect, "seq" | "hash">): string {
  return JSON.stringify([
    r.id,
    r.ts.toISOString(),
    r.agentId,
    r.personId,
    r.tool,
    r.action,
    r.group,
    r.target,
    r.decision,
    r.rule,
    r.code,
    r.reason,
    r.sentence,
    r.count,
    r.withheld,
    r.passJti,
    r.mode,
    r.auditEventId,
    r.prevHash,
    // Added in S8: only when present, so receipts written before still verify.
    ...(r.clientId ? [r.clientId] : []),
  ]);
}

export function receiptHash(r: Omit<typeof receipts.$inferSelect, "seq" | "hash">): string {
  return createHash("sha256").update(hashInput(r)).digest("hex");
}

// Any fixed number: serialises appends so the chain has no forks.
const CHAIN_LOCK = 4_242_001;

/** Appends a receipt to the hash chain. */
export async function appendReceipt(db: Db, input: NewReceipt) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CHAIN_LOCK})`);
    const [last] = await tx
      .select({ hash: receipts.hash })
      .from(receipts)
      .orderBy(desc(receipts.seq))
      .limit(1);
    const row = {
      id: input.id ?? newId("rcpt"),
      ts: input.ts ?? new Date(),
      agentId: input.agentId,
      personId: input.personId ?? null,
      tool: input.tool ?? null,
      action: input.action,
      group: input.group ?? null,
      target: input.target ?? null,
      decision: input.decision,
      rule: input.rule ?? null,
      code: input.code ?? null,
      reason: input.reason ?? null,
      sentence: input.sentence,
      count: input.count ?? 0,
      withheld: input.withheld ?? 0,
      passJti: input.passJti ?? null,
      mode: input.mode ?? "live",
      auditEventId: input.auditEventId ?? null,
      clientId: input.clientId ?? null,
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const hash = receiptHash(row);
    const [saved] = await tx
      .insert(receipts)
      .values({ ...row, hash })
      .returning();
    if (!saved) throw new Error("receipt insert returned nothing");
    return saved;
  });
}

/** Re-walks the whole chain. Returns the first broken receipt id, or null when intact. */
export async function verifyReceiptChain(db: Db): Promise<string | null> {
  const rows = await db.select().from(receipts).orderBy(asc(receipts.seq));
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prevHash !== prev || receiptHash(r) !== r.hash) return r.id;
    prev = r.hash;
  }
  return null;
}
