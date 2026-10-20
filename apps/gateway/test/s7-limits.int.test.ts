/** S7: rate limits at the gateway (ASVS V2.4.1), against real Postgres. */
import { receipts } from "@aipass/db";
import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, GATEWAY, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  process.env.GATEWAY_RATE_LIMIT = "4";
  process.env.GATEWAY_REFUSED_RATE_LIMIT = "3";
  h = await createHarness();
  await h.reset();
});
afterAll(async () => h?.close());

const receiptCount = async () => (await h.db.select({ n: count() }).from(receipts))[0]?.n ?? 0;

describe("rate limits", () => {
  it("a flood of bad passes is cut off before it reaches the audit trail", async () => {
    const before = await receiptCount();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await h.appFetch(`${GATEWAY}/agents/diabetes-coach/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer not-a-pass", "content-type": "application/json" },
        body: "{}",
      });
      statuses.push(res.status);
      if (res.status === 429) expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    // only the three that got through the limit were audited
    expect((await receiptCount()) - before).toBe(3);
  });

  it("one agent acting for one person is limited per minute; another person isn't affected", async () => {
    const maria = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "maria"));
    // connecting took calls of its own; keep calling until the limit answers
    let limited = false;
    for (let i = 0; i < 6 && !limited; i++) {
      try {
        await maria.call("search_labs");
      } catch (err) {
        limited = /429|rate/i.test(String(err));
      }
    }
    expect(limited).toBe(true);
    const john = await h.connect("diabetes-coach", await h.pass("diabetes-coach", "john"));
    expect((await john.call("search_labs")).isError).toBeDefined();
    await john.close();
  });
});
