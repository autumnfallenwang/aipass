import { createDb } from "@aipass/db";
import { FhirClient } from "@aipass/fhir";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { config } from "./config.ts";
import { syncOAuth } from "./oauth.ts";

const { db } = createDb(config.databaseUrl);
// Every agent is an OAuth resource; every approved app is linked to it.
await syncOAuth(db).catch((err: Error) => console.error(`OAuth sync failed: ${err.message}`));
const app = createApp({
  db,
  auth: createAuth(db),
  fhir: new FhirClient({ baseUrl: config.fhirBaseUrl }),
  remoteAddr: (c) => getConnInfo(c).remote.address,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`aipass api listening on http://localhost:${info.port}`);
});
