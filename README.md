# aipass

**A pass for AI in healthcare.**

Let AI help with your health records, on your terms: it sees only what you allow, asks before it changes anything, and you can stop it anytime.

## What it does

- **Gives each AI its own pass**, naming the AI and the person it acts for. The AI never uses the person's password.
- **Checks the rules on every request**: the clinic's role for that AI, the person's own "yes", and the record's sensitivity labels. Example: "labs yes, therapy notes never".
- **Shows the admin exactly what each AI sees.** "Preview as this role" opens a person's chart through the same checks the AI goes through.
- **Writes a receipt for every request**, refusals included. Each one is a plain-English sentence plus an AuditEvent in the FHIR record's own audit log, naming both the AI and the person.
- **Stops instantly.** When the admin clicks Stop, the AI's very next call is refused (measured: under 0.1 s).
- *Coming next:* the person's own consent and "My AIs" page (S3), and changes that wait for the person's passkey (S5). See the [plan](docs/PLAN.md).

It works with any login system (identity provider) and any FHIR server, and you host it yourself.

## Try it (about 5 minutes)

You need Node 22+ (24 LTS recommended), pnpm 10 and Docker. All data is synthetic.

```sh
git clone https://github.com/autumnfallenwang/aipass.git
cd aipass
pnpm install
pnpm dev
```

`pnpm dev` does the following:
1. Starts Postgres and a HAPI FHIR server. HAPI takes about a minute on first start.
2. Loads the synthetic patients.
3. Creates the demo: two AI agents (a Diabetes Coach and a Scheduling Assistant), their roles, and Maria's agreement to both.
4. Runs the apps.

Then:

1. Open **http://localhost:3000**. The first account you create becomes the admin.
2. **Agents** lists both AIs. Each has its own gateway URL.
3. **Roles → Scheduling Assistant** shows the role. Pick **Maria Santos** as the test person, and the panel on the right shows **her chart as that AI sees it**:
   - her name, her phone number and two appointments;
   - her therapy appointment withheld (*mental-health records are always private*);
   - everything else hidden (*not in the Scheduling Assistant role*).
4. Connect a real AI. [`docs/demo-s1.md`](docs/demo-s1.md) shows Claude Code reading Maria's A1c, being refused her therapy notes, and being cut off when you click **Stop**.
5. **Activity** shows a receipt for every request. **Verify chain** checks that none has been edited or removed.

`pnpm smoke` checks that every service is healthy.

| Service | URL |
|---|---|
| Admin UI (web) | http://localhost:3000 |
| api (behind the web app at `/api`) | http://localhost:3001 |
| gateway: what AI clients talk to | http://localhost:3002/agents/{agent-id}/mcp |
| HAPI FHIR | http://localhost:8080/fhir |

## How it fits together

```
 Admin / person (browser) ──► web (Next.js) ──/api──► api (Hono + Better Auth) ──► Postgres
 AI client (MCP) ──pass──► gateway (Hono + MCP) ──► checks role ∩ grant ∩ labels, live ──► FHIR server
                                    └──► receipt + AuditEvent for every call
```

| Folder | What it is |
|---|---|
| `apps/web` | Admin UI (Next.js, shadcn/ui) |
| `apps/api` | Logins, admin API, pass signing, preview |
| `apps/gateway` | The door AI clients use: one MCP endpoint per agent |
| `packages/policy` | The decision rule, in plain TypeScript with no framework |
| `packages/fhir` | FHIR helpers: groups, labels, patient compartment, audit records |
| `packages/db` | Database schema, hash-chained receipts, demo seed |
| `fixtures/` | Synthetic patients (Maria, John, two Synthea patients) |

## Tests

```sh
pnpm test               # unit tests
pnpm test:integration   # gateway and api against Postgres and HAPI (needs `pnpm services:up`)
pnpm test:e2e           # the admin UI in a real browser, plus an MCP client playing the AI
```

## Status

**v0.1** (admin UI). The plan, progress and decisions are in [`docs/`](docs/); start with [the plan](docs/PLAN.md).

No licence has been chosen yet, so all rights are reserved for now (see [decisions](docs/decisions.md)).
