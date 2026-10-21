import { createDb, ensureAipassFhirServer, followAipassFhir } from "@aipass/db";
import { FhirClient } from "@aipass/fhir";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createGateway } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { db } = createDb(config.databaseUrl);
// aipass's own FHIR server is registered in the admin UI (D18). The settings
// only register it on a first start; after that the gateway follows the row.
const fhir = new FhirClient({ baseUrl: config.fhirBaseUrl, headers: config.fhirHeaders });
await ensureAipassFhirServer(db, {
  baseUrl: config.fhirBaseUrl,
  authorization: config.fhirHeaders.authorization,
}).catch((err: Error) => console.error(`registering aipass's FHIR server failed: ${err.message}`));
followAipassFhir(db, (t) => fhir.repoint(t));
const { app } = createGateway({
  db,
  config,
  fhir,
  remoteAddr: (c) => getConnInfo(c).remote.address,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`aipass gateway listening on http://localhost:${info.port}`);
  console.info(`  agents at ${config.gatewayUrl}/agents/<agent-id>/mcp`);
});
