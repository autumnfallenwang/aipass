# Use your own FHIR server

aipass reads records from two kinds of FHIR server.

1. **aipass's own server.** This is any FHIR R4 server you point it at. By default it holds the records, the agents' Device resources, and the AuditEvent for every request.
2. **Other servers over SMART on FHIR.** An EHR (Epic, Oracle Health, any SMART server) where each person connects their own record once. An agent can be set to read from one of these instead.

The rules are the same either way: role ∩ grant, the patient compartment, locked labels, approvals and receipts. Only where the records come from changes.

## aipass's own server

Set `FHIR_BASE_URL` for the api and the gateway. If the server wants a credential, set `FHIR_AUTHORIZATION` to the whole header value, e.g. `Bearer …`. That is the gateway's own credential: agents never see it.

The server must:
- accept FHIR R4 search, read and create;
- let aipass write `AuditEvent`, `Device` and, for approved changes, `Observation` and `Provenance`.

Records need FHIR security labels (`meta.security`) for the locked categories to be recognised. See [`fixtures/README.md`](../../fixtures/README.md).

## An EHR over SMART on FHIR

The **gateway is the SMART app**:
- each person signs in at the EHR once (a SMART standalone patient launch with PKCE);
- their tokens go straight into aipass's **vault**, sealed with AES-256-GCM and bound to that person and that server;
- the patient is pinned from the launch;
- the gateway uses the token to call that EHR, and refreshes it when it's due.

Agents never see the token, and never see the EHR's address either:
- tool results show records by `Type/id`;
- the audit trail names them by the server's aipass id.

### Set it up

1. **Register aipass as a SMART app at the EHR.** Use:
   - a patient-facing, standalone launch;
   - a confidential client if the EHR allows it;
   - redirect URI `<your aipass origin>/api/person/fhir/callback`;
   - scopes: by default aipass asks for `launch/patient openid fhirUser offline_access patient/*.rs patient/Observation.c patient/Provenance.c` (SMART v2). For an EHR that uses SMART v1 scopes, enter them when adding the server, e.g. `launch/patient openid fhirUser offline_access patient/*.read`.
2. **Add the server in aipass:** *Admin → FHIR servers → Add FHIR server*, with:
   - its FHIR base URL. aipass reads `<base>/.well-known/smart-configuration` for the endpoints;
   - the client id and secret. The secret is sealed in the vault and never shown again.
3. **Point agents at it.** On *Agents*, change the agent's **Records from** to the server.
4. **People connect their record.** On *My AIs*, *Your records elsewhere* lists each EHR their AIs read from. **Connect** takes them to the EHR's own sign-in and back.

Until a person connects, an agent's request for them is refused: *"Maria hasn't connected a record at Sunrise EHR."* Other failures are refused too, never answered from somewhere else:
- the refresh fails: *"the connection to Sunrise EHR expired; Maria needs to reconnect"*;
- the admin switches the server off;
- a vault entry was moved to another person.

People can **Disconnect** at any time.

### Production notes

- **Vault key.** Set `AIPASS_VAULT_KEY` (32+ characters) for the api and the gateway. In production they refuse to start without it. To change it:
  1. Set the new key as `AIPASS_VAULT_KEY` and the old one as `AIPASS_VAULT_KEY_PREVIOUS`, for both, and restart them. Both keys now open sealed values; only the new one seals.
  2. Run `pnpm vault:rotate` with the same two variables. It re-seals every connection and client secret with the new key, and lists anything no key opens.
  3. Remove `AIPASS_VAULT_KEY_PREVIOUS`.
- **Writes.** Approved changes are written to the EHR with the person's token, with a Provenance that names the AI by identifier. If the EHR doesn't accept the write, aipass reports *"nothing was written"* and the approval can be used again.
- **Admin previews.** *Preview as this role* reads aipass's own server only. It never uses a person's connected record.

## Try it locally with the SMART launcher

```sh
docker compose -f deploy/compose.yaml --profile smart up -d --wait
pnpm smart:url      # prints the simulated EHR's FHIR base URL, for Maria
```

The [SMART launcher](https://github.com/smart-on-fhir/smart-launcher-v2) plays the EHR, in front of aipass's own HAPI.

Add a FHIR server with:
- that base URL;
- client id `aipass`;
- secret `launcher-dev-secret`.

The launcher skips its own login, so **Connect** on Maria's *My AIs* comes straight back connected.

> The launcher keeps its settings, client secret included, in its URL. That is a quirk of the simulator, and part of why aipass doesn't repeat upstream URLs in tool results, audit records or logs.

## Epic's sandbox

1. Register a patient-facing app at [fhir.epic.com](https://fhir.epic.com) with the redirect URI above and the scopes Epic lists (SMART v1, read).
2. Add it with:
   - base URL `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4`;
   - your client id;
   - those scopes.
3. Connect with one of Epic's sandbox patients.

> The Epic cell of the S6 matrix needs an Epic app registration that only the project owner can make. It hasn't been run yet; see the [plan](../PLAN.md).
