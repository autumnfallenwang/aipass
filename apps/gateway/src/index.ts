import { serve } from "@hono/node-server";
import { Hono } from "hono";

const port = Number(process.env.GATEWAY_PORT ?? 3002);

const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok", service: "aipass-gateway" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.info(`aipass gateway listening on http://localhost:${info.port}`);
});
