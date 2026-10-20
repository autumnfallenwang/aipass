import { serve } from "@hono/node-server";
import { Hono } from "hono";

const port = Number(process.env.API_PORT ?? 3001);

const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok", service: "aipass-api" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.info(`aipass api listening on http://localhost:${info.port}`);
});
