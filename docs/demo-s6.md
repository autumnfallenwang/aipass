# Demo: a headless AI, the hospital's login, records from the EHR

**What you'll see:**
1. The Diabetes Coach runs with no browser. It swaps Maria's token from her hospital's login for a 5-minute aipass pass (RFC 8693 token exchange).
2. It reads Maria's record from **the hospital's EHR** over SMART on FHIR, through the same rules: her A1c yes, her therapy note never.
3. Maria disconnects her EHR record, and the AI's next request is refused. The admin disables the hospital's login, and no new pass can be had.

It all runs on localhost (D12), with synthetic data only:
- **Keycloak** stands in for the hospital's login;
- **the SMART launcher** stands in for the EHR. It sits in front of the same synthetic HAPI.

## 1. Start everything

```sh
pnpm services:up:all     # Postgres, HAPI, Keycloak (realm "sunrise"), the SMART launcher
pnpm dev
```

## 2. Set it up as the admin

At http://localhost:3000, signed in as the admin:

1. **Connections → Add connection.** Enter:
   - name *Sunrise Clinic login*;
   - issuer `http://localhost:8180/realms/sunrise`;
   - audience `aipass`.

   See [use your own login](guides/own-login.md).
2. **FHIR servers → Add FHIR server.** Enter:
   - name *Sunrise EHR*;
   - the URL from `pnpm smart:url`;
   - client `aipass`, secret `launcher-dev-secret`.

   See [use your own FHIR server](guides/own-fhir-server.md).
3. **Agents → Diabetes Coach → Records from:** *Sunrise EHR*.
4. **Agents → Diabetes Coach → Apps → Create a headless client.** Copy the client id and secret; they are shown once.

## 3. Maria connects her EHR record

Sign in as Maria (`maria@example.org` / `maria-demo-password`). On **My AIs**, *Your records elsewhere* lists Sunrise EHR. Click **Connect**.

The launcher skips the EHR's own sign-in, so Maria comes straight back: *Connected*. Her tokens are now in aipass's vault. Nobody can read them back out, and no AI ever gets them.

## 4. Run Claude Code as the headless coach

```sh
export AIPASS_CLIENT_ID=…  AIPASS_CLIENT_SECRET=…
claude --mcp-config deploy/claude/coach-headless.json --strict-mcp-config
```

`deploy/claude/coach-headless.json` uses [`scripts/exchange-header.sh`](../scripts/exchange-header.sh) as the `headersHelper`. For this demo only, the helper gets Maria's hospital token from the dev Keycloak realm. In real use the agent already holds the person's token, as `AIPASS_SUBJECT_TOKEN`. It then exchanges that token for a pass:
- `sub` is Maria;
- `act.sub` is the Diabetes Coach;
- `aud` is the coach's gateway URL only;
- it lasts 300 s.

## What was run on 2026-10-20

These steps were run with real **Claude Code 2.1.301** (`claude -p`). The demo used a fresh database, and the setup went through the same api calls the admin and Maria's browser make.

| Step | Result |
|---|---|
| The exchanged pass | `iss http://localhost:3000/api/auth`, `sub user-maria`, `act {sub: diabetes-coach}`, `aud …/agents/diabetes-coach/mcp`, `patient maria`, 300 s |
| *"I'm Maria. What were my last A1c results? Then: please summarize my therapy notes."* | A1c 6.9 % (Sep 28), 7.4 % (May 20), 8.1 % (Jan 15). The visit note was summarised. For the therapy note, Claude said: *"Your record has a mental-health note, but aipass always keeps mental-health records private, so I can't see what it says."* |
| Receipts | `Diabetes Coach read 3 lab results for Maria Santos.` and `Diabetes Coach read 1 visit note for Maria Santos. 1 record was withheld (mental-health records are always private).` |
| AuditEvent | The three A1c Observations are identified as `https://aipass.dev/fhir-server/sunrise-ehr` / `Observation/maria-a1c-1…3`, by server id and not by URL. The agents are the coach's Device, then Maria |
| Maria clicks **Disconnect**, then asks again | Claude: *"aipass refused the request because you haven't connected a record at Sunrise EHR yet."* It tried the patient summary too, and that was refused the same way. Receipt: `REFUSED: … Maria hasn't connected a record at Sunrise EHR.` |
| The admin disables *Sunrise Clinic login* | The helper fails with `invalid_grant: untrusted issuer: http://localhost:8180/realms/sunrise`, so no new pass |

## The matrix

The plan asks for each combination of login and records:
- the S1 call works (the coach reads Maria's A1c);
- the whole health check is green.

| | aipass's FHIR (HAPI) | EHR over SMART (launcher) | Epic sandbox (read) |
|---|---|---|---|
| **aipass's own login** | ✅ S1 call, check A 16/16 | ✅ S1 call, check A 16/16 | ⏸ needs an Epic app registration (owner) |
| **Hospital login (Keycloak)** | ✅ S1 call, check A 16/16 | ✅ S1 call, check A 16/16 · real Claude Code (above) | ⏸ |
| **Google** | ⏸ needs a Google OAuth client (owner) | ⏸ | ⏸ |

The four local cells run on every CI build: [`apps/web/e2e/matrix.spec.ts`](../apps/web/e2e/matrix.spec.ts). Each one runs:
- the S1 call with a pass from that cell's login;
- the full check, with the probe agents reading from that cell's FHIR server and getting their good passes the same way.

The deliberately bad passes (expired, forged, wrong audience, other patient) are still made locally in every cell.

## What can't get through

Each of these is an automated test:

| Attempt | Result | Test |
|---|---|---|
| A token from a login nobody connected | `untrusted issuer` | `apps/api/test/exchange.int.test.ts` |
| A connected issuer's name, signed with another key | `didn't verify` | same |
| Maria's token minted for another app (`aud` isn't aipass) | `isn't for aipass` | same |
| The exchange without the agent authenticating, or with a wrong secret | `401 invalid_client` | same |
| A subject token carrying `act`, `may_act` or `cnf` | refused, naming the claim | same |
| An unverified email; someone with no aipass login | refused | same, plus e2e sign-in |
| A pass for an agent this client isn't approved for | `invalid_target` | same |
| `actor_token`, or an unsupported subject token type | `invalid_request` | same |
| Signing in through a disabled connection, even mid-flight | refused | api + e2e |
| A coach call when Maria hasn't connected her EHR record | refused (rule 4) | `apps/gateway/test/s6-upstream.int.test.ts` |
| John's note, which the EHR would return to Maria's token | refused (rule 5): the patient is pinned from the launch | same |
| Maria's sealed tokens copied onto John's row | won't open; refused | same |
| An expired upstream token | refreshed once, sealed again; a failed refresh means *reconnect* | same |
| An upstream token, refresh token, client secret or the launcher's settings in any tool result, response header, receipt, AuditEvent or log line | never found | same |
| Someone else finishing Maria's launch, or reusing it | refused; single use | `apps/api/test/smart.int.test.ts` |
