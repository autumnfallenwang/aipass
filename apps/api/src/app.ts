import type { Db } from "@aipass/db";
import { type Context, Hono } from "hono";
import * as z from "zod";
import { config } from "./config.ts";
import { publicJwks } from "./keys.ts";
import { mintPass, PassError } from "./pass.ts";

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function createApp(deps: { db: Db; remoteAddr?: (c: Context) => string | undefined }) {
  const { db } = deps;
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "aipass-api" }));

  app.get("/.well-known/jwks.json", async (c) => {
    c.header("cache-control", "public, max-age=60");
    return c.json(await publicJwks(db));
  });

  // Dev passes (S1): only when AIPASS_DEV_PASSES=1, and only from this machine.
  app.post("/dev/passes", async (c) => {
    if (!config.devPasses) return c.json({ error: "dev passes are disabled" }, 404);
    if (!isLoopback(deps.remoteAddr?.(c))) return c.json({ error: "loopback only" }, 403);
    const body = z
      .object({
        agent: z.string(),
        person: z.string(),
        ttl: z.number().int().positive().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected {agent, person, ttl?}" }, 400);
    try {
      const pass = await mintPass(db, {
        agentId: body.data.agent,
        personId: body.data.person,
        ttlSeconds: body.data.ttl,
      });
      return c.json(pass);
    } catch (err) {
      if (err instanceof PassError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  return app;
}
