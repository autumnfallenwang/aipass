import { createDb, ensureAipassFhirServer, ensureChatClient, followAipassFhir } from "@aipass/db";
import { FhirClient } from "@aipass/fhir";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { config } from "./config.ts";
import { syncOAuth } from "./oauth.ts";

const { db } = createDb(config.databaseUrl);
// Every agent is an OAuth resource; every approved app is linked to it, the
// built-in chat (S8) included.
await syncOAuth(db).catch((err: Error) => console.error(`OAuth sync failed: ${err.message}`));
await ensureChatClient(db, config.gatewayUrl, config.publicUrl).catch((err: Error) =>
  console.error(`built-in chat client setup failed: ${err.message}`),
);
// aipass's own FHIR server is registered in the admin UI (D18). The settings
// only register it on a first start; after that the api follows the row.
await ensureAipassFhirServer(db, {
  baseUrl: config.fhirBaseUrl,
  authorization: config.fhirHeaders.authorization,
}).catch((err: Error) => console.error(`registering aipass's FHIR server failed: ${err.message}`));
const fhir = new FhirClient({ baseUrl: config.fhirBaseUrl, headers: config.fhirHeaders });
const following = followAipassFhir(db, (t) => fhir.repoint(t));
const app = createApp({
  db,
  auth: createAuth(db),
  fhir,
  onFhirServerChanged: following.refresh,
  remoteAddr: (c) => getConnInfo(c).remote.address,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`aipass api listening on http://localhost:${info.port}`);
});
