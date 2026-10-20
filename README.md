# aipass

**A pass for AI in healthcare.**

Let AI help with your health records, on your terms: it sees only what you allow, asks before it changes anything, and you can stop it anytime.

## What it does

- **Gives each AI its own pass**, naming the AI and the person it acts for. The AI never uses the person's password.
- **Checks the rules on every request**: the clinic's role for that AI, the person's own "yes", and the record's sensitivity labels. Example: "labs yes, therapy notes never".
- **Shows the admin exactly what each AI sees.** "Preview as this role" opens a person's chart through the same checks the AI goes through.
- **Writes a receipt for every request**, refusals included. Each one is a plain-English sentence plus an AuditEvent in the FHIR record's own audit log, naming both the AI and the person.
- **Stops instantly.** When the admin clicks Stop, the AI's very next call is refused (measured: under 0.1 s).
- **Lets the person decide.** An AI app signs in with OAuth. The person sees exactly what it asks for, can untick anything, and can revoke it later on their "My AIs" page.
- **Checks itself, and others.** `pnpm check` tries 16 ways past an agent→FHIR system and grades it, for example the wrong patient, a forged pass, a mental-health record, or an `_include` side door. It is proven by planting each defect in aipass, and has been run against two open-source FHIR MCP servers: [docs/check](docs/check/README.md).
- **Asks before changing anything.** An AI may only *propose* a change. The person sees exactly that change and approves it with their passkey. Only then is it written, with a FHIR Provenance saying the AI wrote it, for whom, and with whose approval: [docs/demo-s5.md](docs/demo-s5.md).
- **Works with your login and your EHR.**
  - **Your login.** People and admins sign in with the hospital's own login, through any OpenID Connect provider the admin connects. Agents with no browser swap the person's token for a pass (RFC 8693 token exchange).
  - **Your EHR.** Agents can read from an EHR over SMART on FHIR. Each person connects their record once, and their token stays locked in aipass's vault: no AI ever sees it.
  - Guides: [use your own login](docs/guides/own-login.md), [use your own FHIR server](docs/guides/own-fhir-server.md), and a [demo with a headless Claude](docs/demo-s6.md).

It works with any login system (identity provider) and any FHIR server, and you host it yourself. The project itself is developed and tested on localhost only: it runs no hosted instance, and where you deploy it is up to you.

## Try it (about 5 minutes)

You need Node 22+ (24 LTS recommended), pnpm 10 and Docker. All data is synthetic.

```sh
git clone https://github.com/autumnfallenwang/aipass.git
cd aipass
pnpm install
pnpm dev
```

`pnpm dev` does the following:
1. Starts Postgres and a HAPI FHIR server. On a first run Docker pulls the HAPI image (about 600 MB); after that HAPI starts in under a minute.
2. Loads the synthetic patients.
3. Creates the demo: two AI agents (a Diabetes Coach and a Scheduling Assistant), their roles, and Maria's agreement to both.
4. Runs the apps.

Then:

1. Open **http://localhost:3000**. The first account you create becomes the admin.
2. **Agents** lists both AIs. Each has its own gateway URL.
3. **Roles → Scheduling Assistant** shows the role. Pick **Maria Santos** as the test person, and the panel on the right shows **her chart as that AI sees it**:
   - her name, her phone number and two appointments;
   - "1 withheld: *mental-health records are always private*" (that is her therapy appointment);
   - everything else hidden (*not in the Scheduling Assistant role*).
4. Connect a real AI with just its gateway URL. In [`docs/demo-s3.md`](docs/demo-s3.md), Claude Code signs in through aipass and Maria consents. She unticks vital signs, and later revokes the AI on her "My AIs" page. Her demo login is `maria@example.org` / `maria-demo-password`.
   *(For agents without a browser, [`docs/demo-s1.md`](docs/demo-s1.md) uses a short-lived pass from a helper script instead.)*
5. **Activity** shows a receipt for every request. **Verify chain** checks that none has been edited or removed.

While `pnpm dev` runs, `pnpm smoke` in a second terminal checks that every service is healthy.

To try another login system and an EHR, also start the local stand-ins: `pnpm services:up:all` adds Keycloak (a hospital's login) and the SMART launcher (an EHR). [demo-s6](docs/demo-s6.md) walks through it.

| Service | URL |
|---|---|
| Admin UI (web) | http://localhost:3000 |
| api (behind the web app at `/api`) | http://localhost:3001 |
| gateway: what AI clients talk to | http://localhost:3002/agents/{agent-id}/mcp |
| HAPI FHIR | http://localhost:8080/fhir |
| Keycloak, realm `sunrise` (optional) | http://localhost:8180 |
| SMART launcher, a simulated EHR (optional) | http://localhost:8090 |

## How it fits together

```
 Admin / person (browser) ──► web (Next.js) ──/api──► api (Hono + Better Auth) ──► Postgres
 AI client (MCP) ──pass──► gateway (Hono + MCP) ──► checks role ∩ grant ∩ labels, live ──► FHIR server
                                    │                                        └─(vault token)──► an EHR over SMART
                                    └──► receipt + AuditEvent for every call
 Your login (OIDC) ──► sign-in, and token exchange for headless agents
```

| Folder | What it is |
|---|---|
| `apps/web` | Admin UI (Next.js, shadcn/ui) |
| `apps/api` | Logins, admin API, pass signing, preview |
| `apps/gateway` | The door AI clients use: one MCP endpoint per agent |
| `packages/policy` | The decision rule, in plain TypeScript with no framework |
| `packages/fhir` | FHIR helpers: groups, labels, patient compartment, audit records |
| `packages/db` | Database schema, hash-chained receipts, demo seed |
| `packages/check` | The health check: probes, target adapters, grades |
| `fixtures/` | Synthetic patients (Maria, John, two Synthea patients) |

## Tests

```sh
pnpm test               # unit tests
pnpm test:integration   # gateway and api against Postgres, HAPI, Keycloak and the SMART launcher (needs `pnpm services:up:all`)
pnpm test:e2e           # the admin UI in a real browser, plus an MCP client playing the AI (also needs `services:up:all`)
pnpm check              # the health check against your running gateway
```

## Status

**v0.4** (any OpenID Connect login, token exchange for headless agents, and EHRs over SMART on FHIR through a vault). Before that: OAuth login for AI apps, the person's consent and "My AIs", and passkey-approved changes. The plan, progress and decisions are in [`docs/`](docs/); start with [the plan](docs/PLAN.md).

No licence has been chosen yet, so all rights are reserved for now (see [decisions](docs/decisions.md)).
