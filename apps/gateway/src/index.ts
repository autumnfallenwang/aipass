import { createDb } from "@aipass/db";
import { serve } from "@hono/node-server";
import { createGateway } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { db } = createDb(config.databaseUrl);
const { app } = createGateway({ db, config });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`aipass gateway listening on http://localhost:${info.port}`);
  console.info(`  agents at ${config.gatewayUrl}/agents/<agent-id>/mcp`);
});
