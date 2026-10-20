import { createDb } from "@aipass/db";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp } from "./app.ts";
import { config } from "./config.ts";

const { db } = createDb(config.databaseUrl);
const app = createApp({
  db,
  remoteAddr: (c) => getConnInfo(c).remote.address,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`aipass api listening on http://localhost:${info.port}`);
});
