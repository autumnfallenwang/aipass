# aipass: development plan and progress

_This file tracks the build stages of the public demonstration. The multi-year plan is in [ROADMAP.md](ROADMAP.md). This one file is both the plan and the tracker. When a stage changes state, update the **Progress** table and add a **Log** line in the same commit. Decisions live in [`decisions.md`](decisions.md); if this file disagrees with it, `decisions.md` wins._

---

## 1. What we're building, in one paragraph

A clinic admin decides what each AI agent may see and do (its **role**). The person an agent acts for, such as Maria the patient, agrees to it (her **grant**). The agent carries a short-lived **pass** that names both the agent and the person. The person an agent acts for can be a staff member (Practitioner) or a patient (Patient). Every request goes through the **gateway**, which re-checks the role, the grant and the record's sensitivity labels *live*. It shows the agent only its role's view of the chart, and it holds any change until the person approves it with their passkey. Each request leaves a **receipt**, in plain English and in the FHIR record's own audit log.

**Maria example used in every stage:**
- **Diabetes Coach:** labs, vitals, medications, conditions, visit notes, and her name and age; may *propose* a glucose reading.
- **Scheduling Assistant:** her name, phone number and appointments only.
- **Neither agent** ever sees anything labelled sensitive: her therapy notes, depression, antidepressant, past alcohol treatment, or her therapy appointments. The data is in [`fixtures/`](../fixtures/README.md).

**Dr. Lee example (from S10):** the **Visit Assistant** acts for Dr. Grace Lee, a clinician. It reads the labs, conditions, medications and visit notes of the patient she has open, only while that patient is in her care team, and may propose a reading, which she approves. Maria's sensitive records stay private from it too.

---

## 2. Architecture

```
          Admin (browser)            Maria (phone/browser)
                │                          │  consent · approve · my AIs
                ▼                          ▼
        ┌──────────────── apps/web (Next.js) ────────────────┐
        └───────────────────────┬────────────────────────────┘
                                ▼
        ┌──────────────── apps/api (Hono) ───────────────────┐
        │ Better Auth: admin + person login, passkeys,        │
        │   OAuth provider for AI clients (S3)                │
        │ agents · roles · grants · approvals · receipts API  │
        │ pass issuer + JWKS (S1 dev passes, S3 real, S6 RFC 8693)│
        └───────────────────────┬────────────────────────────┘
                                │ Postgres (Drizzle)
  Claude / any MCP client       │
        │  pass (Bearer)        │ live reads: agent? role? grant?
        ▼                       ▼
        ┌──────────────── apps/gateway (Hono) ───────────────┐
        │ MCP server per agent: /agents/{id}/mcp              │
        │ verify pass · policy · role view filter             │
        │ propose→approve→commit (S5) · receipts + AuditEvent  │
        └───────────────────────┬────────────────────────────┘
                                ▼
                 FHIR server: HAPI (local) → Epic sandbox (S6)
```

### Repo layout

```
aipass/
  apps/web          Next.js App Router: admin UI + 3 person pages
  apps/api          Hono + Better Auth 1.7: the "front office"
  apps/gateway      Hono + MCP TS SDK v2: the "door guard" (the only thing AI clients talk to)
  packages/shared   Zod schemas + types shared by all apps
  packages/db       Drizzle schema, migrations, hash-chained receipts, demo seed (api and gateway both use it)
  packages/policy   pure TypeScript decision engine: NO framework imports, so it can be tested on its own
  packages/fhir     FHIR helpers: resource groups, labels, patient compartment, AuditEvent/Provenance builders
  packages/check    health-check probes + CLI (S4)
  fixtures/         synthetic patients only (Maria + a few Synthea patients)
  deploy/compose.yaml   Postgres + HAPI FHIR (+ Keycloak in S6)
  docs/             plan, decisions, the idea (docs/research/ is local-only, git-ignored)
```

**Stack:**
- Turborepo + pnpm
- TypeScript 6.0 everywhere (Node 24 LTS in CI)
- Hono + Zod
- Next.js
- Postgres + Drizzle
- Better Auth 1.7
- `jose`
- MCP TypeScript SDK v2: `@modelcontextprotocol/server` 2.3 (protocol 2026-07-28, with 2025-11-25 served as a stateless fallback)
- `@simplewebauthn/server` (S5)
- Vitest + Biome
- Playwright (S2+)

**Dev ports:** web 3000 · api 3001 · gateway 3002 · HAPI 8080 · Postgres **5433** (not 5432, so it doesn't collide with other local Postgres instances).

**One gateway URL per agent.** Each agent the admin registers gets its own MCP endpoint, `http://gateway/agents/{agent-id}/mcp`, and that URL is the pass's audience (`aud`). A pass for one agent can't be used at another agent's door, and an AI client that shares one OAuth client id across all installs (Claude Code does) still lands on a specific agent.

---

## 3. Core concepts and data model

| Concept | Plain words | Table (Drizzle) | Key fields |
|---|---|---|---|
| **Agent** | One AI the clinic lets in | `agents` | id, name, oauth_client_id (S3), role_id, status (`active`/`stopped`), fhir_device_id, created_by |
| **Role** | The ceiling: what that kind of AI may ever do | `roles` | id, name, rules[] = {group, read, propose, write}, patient_fields (field mask), locked_labels[] |
| **Person** | Who the agent acts for | `persons` (+ Better Auth user from S3) | id, display_name, fhir_ref (`Patient/…` or `Practitioner/…`) |
| **Grant** | The person's "yes", inside the role | `grants` | person_id, agent_id, groups[] (⊆ role), status, granted_at, revoked_at |
| **Pass** | The short-lived badge the agent carries | not stored (only its `jti` appears in receipts) | JWT: iss, `sub`=person, `act.sub`=agent, `aud`=that agent's gateway URL, `patient`, exp ≤ 5 min, jti |
| **Approval** (S5) | The person's OK for one exact change | `approvals` | id, agent_id, person_id, action, payload_hash, status (`pending`/`approved`/`used`/`denied`/`expired`), expires_at |
| **Receipt** | One line per request | `receipts` | ts, agent_id, person_id, action, target, decision, reason, pass_jti, prev_hash, hash, auditevent_id |

**Resource groups** are the words an admin sees, mapped to FHIR:

| Group | FHIR |
|---|---|
| labs | `Observation?category=laboratory` |
| vitals | `Observation?category=vital-signs` |
| medications | `MedicationRequest`, `MedicationStatement` |
| conditions | `Condition` |
| appointments | `Appointment` |
| demographics | `Patient`, filtered by `patient_fields` |
| notes | `DocumentReference` |

**Locked labels** (always refused, whatever the role says) are read from `meta.security`:

| Label | Means |
|---|---|
| `PSY` | mental health |
| `ETH` / `42CFRPart2` | substance use |
| `HIV` | HIV-related |
| `R` | restricted |

**The decision rule** lives in `packages/policy`, and every refusal names the *first* rule that failed:

```
ALLOW only if:
  1. the pass is valid (signature, aud = this gateway, not expired)
  2. the agent is active              → else "agent stopped by admin"
  3. the role permits group+action    → else "not in the Diabetes Coach role"
  4. the person's grant permits it    → else "Maria hasn't agreed to vitals"
  5. the resource is in the person's patient compartment → else "not Maria's record"
  6. no locked label on the resource  → else "mental-health records are always private"
  7. (writes) a matching, unused approval exists → else "waiting for Maria's OK"
```

The **AI agent in FHIR** is a `Device` resource, created when the agent is registered (the same choice the HL7 AI Transparency IG makes):
- **AuditEvent:** agent[0] = Device (the AI), agent[1] = Patient/Practitioner with `requestor: true`, `policy` = pass jti.
- **Provenance** (for writes): `agent.who` = Device, `agent.onBehalfOf` = Patient.

---

## 4. Rules for the whole project

1. **Synthetic data only.** No real patient data, ever: in the repo, in demos, or in screenshots. No customer systems.
2. **Fail closed.** Unknown field, unknown label, unknown group, or an error while checking all mean *refuse*. (Silently accepting something unknown is how access gets widened by accident.)
3. **Every request leaves a receipt**, refusals included.
4. **The agent never sees an upstream credential.** The gateway never passes the agent's token through to FHIR.
5. **Live checks.** Agent status, role and grant are read on every call, so "Stop" works on the next request.
6. **Write the prediction before running a validation**, and log any surprise in the Log.
7. **Each stage ends with a demo someone else could re-run** from the README.
8. **Localhost only (D12).** Everything is developed, demoed and validated on `localhost`. There's no deployment to the maintainer's servers (no home k3s). Deployment pieces (images, compose, Helm) are built for adopters to run where they choose.
9. **Web UI only (D17).** Everything an admin or a person does with aipass happens in the browser: registering and connecting AIs, trying them, looking things up. The only command is starting aipass. A demo, guide or test step that needs a terminal is a bug.

**Testing levels:**
- Unit (Vitest): `packages/policy`, `packages/fhir`.
- Integration: gateway + api against HAPI in Docker.
- End-to-end (Playwright): admin UI, from S2.
- Health-check probes: the security regression suite, from S4.
- Models: a scripted fake OpenAI-compatible server in tests and CI, so results never depend on a model. Real models only by hand, on localhost (S8).
- From S9, every demo and guide is also a Playwright run, by clicks only.

---

## 5. Stages

Each stage has **Goal** (plain words), **Plan** (design plus anything to verify first), **Build** (work items), and **Validate** (tests, demo, and done-when).

### S0: Foundation and spikes

**Goal:** an empty but running skeleton, and answers to the four "does the library really do that?" questions *before* we depend on them.

**Plan: spikes, each with a written prediction:**

| # | Question | Prediction | Fallback if wrong | Result (2026-10-19) |
|---|---|---|---|---|
| SP1 | Can Claude Code connect to Better Auth 1.7's OAuth provider (DCR or CIMD + PKCE), and can we put our own claims (`act`, `patient`) into the access token? | Yes to both. The package ships DCR/CIMD, DPoP and PRM (checked v1.7.11 locally) | api mints our pass in its own endpoint after OAuth; Claude fetches it via `headersHelper` | ✅ **Yes.** Real Claude Code 2.1.301 used **CIMD** (`client_id=https://claude.ai/oauth/claude-code-client-metadata`) + PKCE S256 + RFC 8707 `resource`. Better Auth issued a JWT whose `act` and `patient` came from an `extensions[].claims.accessToken` contributor, with a 300 s TTL set per resource. The login was driven headlessly with `claude mcp login --no-browser`. **Surprise:** every Claude Code install shares one client id, which led to one gateway URL per agent (§2) |
| SP2 | Does the MCP TS SDK serve Streamable HTTP, and at which protocol, with elicitation? | v1.32.1: yes for 2025-11-25; 2026-07-28 **not** in the SDK yet | Target 2025-11-25; add 2026-07-28 when the SDK ships it | ❌ **Prediction wrong (for the better).** SDK **v2** (`@modelcontextprotocol/server` 2.3.1) is now the stable line and implements **2026-07-28**. `createMcpHandler` serves 2026-07-28 and falls back to stateless 2025-11-25 from the same server factory. Real Claude Code negotiated 2026-07-28 (`server/discover`) and `headersHelper` worked. Elicitation (`input_required`) is in the protocol, but headless `claude -p` gives no human answer and retries to the 10-round limit, so S5 returns an approval link instead |
| SP3 | Does HAPI FHIR (Docker) accept `Device`/`AuditEvent`/`Provenance` writes and search by `_security`? | Yes | Filter labels in the gateway after fetch (we do this anyway) | ✅ **Yes.** HAPI v8.12.0-2 accepted all three. `_security=…\|PSY` and `_security:not=…` both work, and `AuditEvent?agent=Device/…` and `?patient=` both find the event. The gateway still filters after fetch (rule 2: fail closed) |
| SP4 | Can we build fixtures: Maria (our hand-written demo patient) + Synthea patients, with a `PSY`-labelled note and an `ETH`-labelled condition? | Yes, with a load script | Hand-written bundles | ✅ **Yes.** Maria and John are hand-written; 2 Synthea patients are trimmed by `scripts/trim-synthea.ts` (seed 20261019). `pnpm fixtures:load` loads all 4 in about 1.5 s and is idempotent |

**Build:**
- [x] Turborepo + pnpm monorepo: `apps/{web,api,gateway}`, `packages/{shared,policy,fhir}`, Biome, Vitest, tsconfig
- [x] `deploy/compose.yaml`: Postgres + HAPI FHIR R4; `pnpm dev` starts everything (services → fixtures → apps)
- [x] `fixtures/` + `pnpm fixtures:load` (Maria, John, 2 Synthea patients; labelled therapy note + substance-use condition)
- [x] GitHub Actions: lint, typecheck and unit tests on every push; integration job with Postgres + HAPI (started from `deploy/compose.yaml`, so CI and local use one definition)
- [x] Spike results SP1–SP4 recorded in the table above and in the Log

**Validate:**
- [x] A fresh clone, then `pnpm i && pnpm dev`, gives all apps healthy (`/health` 200) and HAPI returns Maria (`pnpm smoke` checks all four). Measured: **27 s** from `pnpm dev` to all healthy, with containers and volume removed first
- [x] CI is green on `main` (both jobs, first push)
- [x] All four spikes answered; the consequences are written into S1 (one URL per agent), S3 (CIMD first) and S5 (approval link)

---

### S1: The guard, read-only

**Goal:** a real Claude reads Maria's labs through the gateway, is refused her therapy note with a plain-English reason, and is cut off on its next call when stopped. There's no UI yet; roles, agents and grants come from a seed script.

**Plan:**
- **The pass:** api signs JWTs with its own key and publishes `/.well-known/jwks.json`. A dev command mints passes: `pnpm pass --agent diabetes-coach --person maria`. The pass's `aud` is that agent's own gateway URL. Claude Code gets one through a `headersHelper` script that calls this command (SP2 confirmed `headersHelper` works with the gateway).
- **Gateway order:** verify the pass offline (signature, aud, exp) → read agent/role/grant live → decide → fetch from FHIR with the gateway's own credential → **filter the response** to the role view → write a receipt.
- **The FHIR query surface is the hard part.** Block `$everything`, `_include`/`_revinclude` across groups, chained search and GraphQL in S1. Paging links must keep the filter (they are re-checked on each page).
- **MCP tools:**

  | Tool | Purpose |
  |---|---|
  | `get_patient_summary` | demographics, through the field mask |
  | `search_labs` | labs group |
  | `search_vitals` | vitals group |
  | `list_medications` | medications group |
  | `list_conditions` | conditions group |
  | `list_appointments` | appointments group |
  | `get_notes` | exists to demonstrate refusals |

**Build:**
- [x] `packages/policy`: `decideRequest` (rules 1–4) and `decideResource` (rules 3, 5, 6) → `{decision, rule, code, reason}`; rule 0 = the check itself failed (refuse); table-driven tests
- [x] `packages/fhir`: group↔FHIR mapping, label reader, compartment check, field mask, simplified records, receipt sentence, AuditEvent/Provenance/Device builders, FHIR client that only calls its own base URL
- [x] `packages/db` + api: Drizzle schema (agents, roles, persons, grants, receipts, pass keys); hash-chained receipts; seed with the two Maria roles; JWKS at `/.well-known/jwks.json`; `pnpm pass`; `pnpm admin` (stop/resume agent, revoke/restore grant, show receipts)
- [x] gateway: MCP server per agent (`/agents/{id}/mcp`, SDK v2), the 7 tools with strict argument schemas, pass verification, live checks, response filter on every record and every page, encrypted paging tokens, receipts + AuditEvent to HAPI (an allowed read with no AuditEvent is refused: fail closed)
- [x] gateway returns `401` with `WWW-Authenticate` pointing to its Protected Resource Metadata (RFC 9728) when the pass is missing or invalid, and writes a receipt for it
- [x] [`docs/demo-s1.md`](demo-s1.md): the exact steps to rerun the demo

**Validate:**

| Case | Expected |
|---|---|
| Coach → Maria's labs | ALLOW |
| Coach → Maria's therapy note (`PSY`) | REFUSE "mental-health records are always private" |
| Scheduling → Maria's labs | REFUSE "not in the Scheduling Assistant role" |
| Scheduling → Maria's patient summary | ALLOW, **name + phone only** |
| Coach → John's labs (pass is for Maria) | REFUSE "not Maria's record" |
| Coach stopped, then calls again | REFUSE "agent stopped by admin" on the **next** call |
| Grant revoked, then calls again | REFUSE "Maria hasn't agreed" |
| Expired / wrong-aud / tampered / missing pass | 401 + PRM pointer |
| `_include` or `$everything` trying to reach other groups | refused or filtered; nothing outside the role leaves |

- [x] Every row above is an automated test: 31 policy + 27 FHIR + 5 paging unit tests, and 28 gateway integration tests against Postgres + HAPI with a real MCP client (`apps/gateway/test/s1-*.int.test.ts`). Extra cases: a forged `patient` claim, a direct read of John's note, a FHIR server that smuggles in other patients/labels/groups/types, edited and moved page tokens, MCP 2025-11-25 fallback
- [x] **Every refused call has a receipt** and an AuditEvent naming both the AI (`Device`, requestor false, `policy` = pass jti) and Maria (requestor true); the receipt hash chain verifies
- [x] Manual demo with real Claude Code 2.1.301 (`claude -p`, headersHelper), three prompts. A1c: answered 6.9 / 7.4 / 8.1%. Therapy notes: showed the visit note and said one record is private (mental health). Agent stopped: *"refused … agent stopped by admin"*. Scheduling Assistant: two appointments, the therapy session withheld, A1c refused (*not in the Scheduling Assistant role*)

---

### S2: Admin UI v1 → **release v0.1 (public)**

**Goal:** the clinic admin runs everything from a browser. **"Preview as this role" shows Maria's chart exactly as each AI sees it.**

**Plan:**

| Screen | What it does |
|---|---|
| **Agents** | List, register, assign a role, **Stop/Resume**, last activity |
| **Roles** | The grid (group × See / Propose / Change), locked labels shown as always-off, patient field mask, **Preview as this role** (choose a test person) |
| **People** | Test persons and their grants (admin-managed until S3) |
| **Activity** | Receipts timeline, filterable by agent, person and decision. Each row shows the plain sentence and links to the FHIR AuditEvent |

- **Admin login:** Better Auth with email + passkey. The first user becomes admin.
- **One public origin (D10):** the browser only talks to the web app; Next.js passes `/api/*` through to the api. Cookies, passkeys and (S3) the OAuth issuer all live on that one origin.
- **Preview** runs the real gateway decision path in `preview` mode. The api asks with a 60 s request signed by its own key, for the gateway's `/internal/preview` only. It is marked as such in receipts, writes no AuditEvent, and never counts as agent activity.
- **Registering an agent** also creates its FHIR `Device`.

**Build:**
- [x] api: Better Auth (email + password, passkeys; the first account becomes admin), admin endpoints (agents, roles, persons/grants, receipts + chain check), preview endpoint. Admin-only: 401 when signed out, 403 for a person account (`apps/api/test/admin.int.test.ts`)
- [x] web: the 4 screens (Tailwind + shadcn/ui), login with first-admin setup, "Add a passkey"
- [x] gateway: preview mode (same `Guard.read`, plus a role override; receipts only)
- [x] README quickstart: clone → `pnpm dev` → log in → see the Maria demo
- [x] Tag `v0.1.0`

**Validate (Playwright end-to-end, `apps/web/e2e/admin.spec.ts`, 5 tests):**
- [x] Admin creates a role (appointments + name/phone; called "Front Desk" because the seed already has a Scheduling Assistant) → preview of Maria shows **only** that: 2 appointments with the therapy session withheld, name + phone, and the 5 other groups hidden
- [x] Admin registers an agent with that role → it sees only appointments. Checked by the test's MCP client and by real Claude Code: it listed name, phone and 2 appointments; labs, medications, notes, conditions and vitals were each refused *not in the Front Desk role*
- [x] Admin clicks **Stop** → the agent's next call is refused. Measured from click to refusal: **49 ms, 89 ms, 38 ms** over three runs (prediction: < 1 s ✅)
- [x] Activity shows both the allowed and the refused calls, with correct sentences and AuditEvent links; previews are hidden unless asked for; the chain verifies
- [x] Also: an admin adds a passkey and signs in with it (Chrome virtual authenticator)
- [x] **Release check:** an independent AI review agent with no prior context followed only the README from a fresh clone, with containers and volume removed, to a working demo. **PASS**: 31 s to healthy; all three Claude prompts and the Stop behaved as documented. It reported 9 doc and UI problems, all fixed before the tag (the worst: demo §4 gave Claude both agents, so the Scheduling Assistant example didn't refuse). *A run by a person is still wanted*

---

### S3: Real agent login + the person's "yes" → **v0.2**

**Goal:** Claude connects with just the gateway URL, with no helper script. Maria logs in, sees what the Diabetes Coach is asking for (within the clinic's ceiling), can untick things, and can revoke from her own page.

**Plan:**
- api becomes the OAuth authorization server for AI clients (Better Auth OAuth provider; SP1 result).
  - **Client identity:** CIMD where the client supports it (Claude Code does: SP1), DCR as fallback.
  - **Which agent:** the client asks for a token for one agent's gateway URL (RFC 8707 `resource`). The api only issues it if the admin linked that client to that agent (Better Auth `enforcePerClientResources`).
  - **Flow:** authorization code + PKCE.
  - **Access token** = the pass: `sub`=Maria, `act.sub`=agent, `aud`=gateway, ≤ 5 min. Refresh tokens are revocable.
- **Consent page** (person-facing): *"Diabetes Coach (approved by Sunrise Clinic) wants to: see your labs ☑, vitals ☑, medications ☑, propose glucose readings ☑."* Maria can untick, and the result is stored as her grant.
- **"My AIs" page** (person-facing): each agent, what it may do, its last activity, and **Revoke**.
- gateway PRM advertises api as its authorization server.

**Build:**
- [x] OAuth provider config: Better Auth `oauthProvider` + `jwt` + `cimd`, DCR on, `enforcePerClientResources`, one resource per agent with a 300 s access token. A claims extension adds `act.sub` (from the resource) and `patient` (from the person linked to the login). Discovery is at `/.well-known/oauth-authorization-server/api/auth` on the public origin. Consent page (`/consent`) and "My AIs" page (`/my-ais`)
- [x] Persons get real logins: the admin's **Give a login**, or the demo seed (`maria@example.org`). The first account becomes admin only while no admin exists, so seeding person logins can't take the admin slot
- [x] Agent registration links OAuth clients. aipass keeps its own list of *which apps may act as which agent* (`agent_clients`, D11) and writes Better Auth's client↔resource link when the client appears (a CIMD client only appears on its first visit). Registering an agent can allow Claude Code in one click; **Agents → Apps** manages the rest. The gateway also checks the list live (rule 2: *this app isn't approved to act as …*)
- [x] `headersHelper` moved out of the default docs: [demo-s3.md](demo-s3.md) is the main path, and [demo-s1.md](demo-s1.md) is the "agent without a browser" option

**Validate** (`apps/web/e2e/oauth.spec.ts`, 8 tests, plus real Claude Code):
- [x] Fresh Claude Code + gateway URL → browser login as Maria → consent → tools work, with zero manual token handling. Real Claude Code 2.1.301: `claude mcp add` + `claude mcp login` used CIMD, PKCE and `resource`; Playwright played Maria's browser (`e2e/manual/claude-oauth-login.ts`)
- [x] Maria unticks vitals → `search_vitals` refused *"Maria hasn't agreed to vital signs"*; labs still work. Real Claude: A1c 6.9%, blood pressure refused with that reason
- [x] Revoke on "My AIs" → next call refused (*Maria hasn't agreed to lab results*) **and** the refresh token is rejected at the token endpoint (`invalid_grant`). With real Claude Code, all 7 of its refresh tokens for the coach were revoked, and its next connection had no valid pass
- [x] A pass for Maria can't read John (*not Maria's record*), and a token minted for agent A is refused at agent B's door (`401 wrong audience`). **DPoP: prediction ("needed") wrong for this case.** The per-agent audience (D9) already stops cross-agent replay. Claude Code registers with `dpop_bound_access_tokens: false`, so requiring DPoP would lock it out. DPoP remains useful against a stolen token used by a *different* client; Better Auth can require it per resource, which becomes an opt-in per agent in S7
- [x] Also: an app the admin hasn't approved is refused at the authorization server (`invalid_target`), and withdrawing an approved app refuses its next call at the gateway
- [x] Tag `v0.2.0`

---

### S4: Health check (the inspector)

**Goal:** a test suite anyone can run against any agent→FHIR system, giving a grade. We run it on ourselves and on others, and publish the results.

**Plan:**
- `packages/check`: probes + CLI (`pnpm check --target <url> --profile mcp-fhir`) + the admin **Health check** screen.
- **Probes (v1):**

  | Probe | What it tries |
  |---|---|
  | `wrong_patient` | read another patient's record |
  | `no_pass` | call with no pass |
  | `expired_pass` | call with an expired pass |
  | `wrong_audience` | use a pass meant for a different service |
  | `stopped_agent` | keep working after the admin stops the agent |
  | `revoked_grant` | keep working after the person revokes |
  | `locked_label_leak` | read a mental-health or substance-use record |
  | `role_escape` | read outside the role's view |
  | `include_escape` | pull other data types in through `_include` |
  | `refusal_audited` | check that a refusal leaves an audit record |
  | `receipt_names_both` | check that the receipt names both the AI and the person |
  | `self_approve` | the agent approves its own change (S5) |
  | `approval_replay` | reuse an approval (S5) |
  | `payload_swap` | change the payload after it was approved (S5) |

- **Prove the inspector itself:** a `--broken <check>` flag on our gateway disables one check at a time, and every probe must catch its own planted defect.
- **Report:** an A–F grade plus a table per probe, with the target's exact version, the date, and the command to rerun it.

**Build:**
- [x] probes + CLI + JSON/Markdown report + admin screen. 12 probes now (`forged_pass` added to the list above); the 3 approval probes switch on in S5. `pnpm check`, **Admin → Health check**, `packages/check`. Leaks are judged by fixture markers
- [x] target adapters: the aipass gateway (white-box: signs passes, registers two temporary probe agents, stops/revokes, reads AuditEvents) + a generic MCP→FHIR bridge adapter with presets for `wso2/fhir-mcp-server` and `faulkj/fhirHydrant`
- [x] planted defects: `AIPASS_BROKEN=<defect>` switches off one check each (12 defects, refused in production) — [docs/check/README.md](check/README.md#proving-the-inspector)

**Validate:**
- [x] 100% of planted defects caught (12/12, each by its own probe and no other); 0 false alarms on the correct gateway (12/12 pass, grade A). Automated in `packages/check/test/planted.int.test.ts`
- [x] Published scorecards for at least 2 external targets (pinned commit, date, exact command): [wso2/fhir-mcp-server `2a915a4`](check/scorecards/wso2-fhir-mcp-server.md) **F**, [faulkj/fhirHydrant `1a24376`](check/scorecards/fhirhydrant.md) **F**, and [aipass](check/scorecards/aipass.md) **A**. Each card states the mode tested and what it does *not* judge (both projects document these as local/unauthenticated modes)
- [ ] ⏸ **At least 1 issue filed: waiting for the maintainer.** Two feature-request drafts are ready (label withholding for wso2; caller identity in audit events for fhirHydrant). Filing them posts under the maintainer's name on other people's projects, so the maintainer decides

---

### S5: Changes with the person's approval → **v0.3**

**Goal:** the Diabetes Coach *proposes* "glucose 130 mg/dL". Maria's phone shows exactly that, she approves with her fingerprint, and only then is it written, with a FHIR record that it was the AI, for Maria, with her approval.

**Plan:**
- **Tools:** `propose_observation` and `commit_change(approval_id)`.
- **Proposal step:** validate the resource → canonicalize (RFC 8785 JSON over normalized FHIR) → hash → create a `pending` approval → return an approval link **in the tool result** (SP2: headless clients can't answer elicitation, and a passkey needs a real page anyway).
- **Approve page:**
  - shows the change in plain words;
  - WebAuthn assertion with user verification, where challenge = H(payload_hash ‖ approval_id ‖ nonce);
  - uses the passkey Maria registered under Better Auth (spike SP5 at the start of this stage: can `@simplewebauthn/server` verify against Better Auth's stored credentials? Prediction: yes).
- **Commit step:** re-hash the body, then check it matches, is unused, is unexpired (2 min), and was approved by the person the pass names → write to FHIR, plus a Provenance with `onBehalfOf` = Maria and an AuditEvent.
- **Admin Approvals screen:** which actions need approval, and who approves (the patient, or a named clinician).
- **Acceptance tests A1–A8.** The rule behind them: *an approval is real only if nothing the agent holds can produce it.*

**Build:**
- [x] **SP5 answered: yes.** Better Auth stores each passkey's credential id, public key (base64) and counter, and itself verifies with `@simplewebauthn/server`. aipass verifies approvals against the same rows with `@simplewebauthn/server` 14, but with `requireUserVerification: true` (Better Auth's own sign-in doesn't require it)
- [x] approvals + approval_rules tables; api endpoints (approver's list, details plus a challenge, approve, deny; a browser session only, never a pass); `/approve/[id]` page; pending approvals and "Add a passkey" on "My AIs"; admin **Approvals** screen (who approves, per role and group: the patient or a named person, plus recent approvals)
- [x] gateway tools `propose_observation` and `commit_change`. The agent names a measure and a value, never raw FHIR: a small catalog (blood glucose, body weight) with ranges. RFC 8785 canonical JSON → sha256; challenge = sha256(hash ‖ approval id ‖ nonce); the approval is used atomically; Provenance (`author` = AI Device, `onBehalfOf` = Maria, `verifier` = approver, entity = approval id and hash) + AuditEvent. The proposal waits 10 min; the commit must come within 2 min of approval. The role grid's **Change** permission stays reserved: every write goes through an approval (rule 7)
- [x] Check probes `self_approve`, `approval_replay`, `payload_swap` switched on, plus `unapproved_write`. Four more planted defects (`approval`, `replay`, `hash`, and `approve_auth` in the api), all caught

**Validate (A1–A8):**

| # | Test | Expected |
|---|---|---|
| A1 | Agent calls the approve endpoint with its own pass | refused |
| A2 | Approval without user verification | refused |
| A3 | Payload changed after approval (130 → 310) | commit refused |
| A4 | Same approval used twice | second commit refused |
| A5 | Approval older than 2 minutes | refused |
| A6 | John's passkey approves Maria's change | refused |
| A7 | Maria taps **Deny** | receipt "REFUSED: Maria said no"; nothing written |
| A8 | Approved write | Observation + Provenance(`who`=AI Device, `onBehalfOf`=Maria) + AuditEvent all present |

- [x] All of A1–A8 automated in `apps/web/e2e/writes.spec.ts` (Chrome virtual authenticator). A2 rewrites the page's options so an unverified assertion actually reaches the server, because the browser refuses a "required" ceremony on its own
- [x] Real Claude Code 2.1.301: proposed glucose 130; Maria approved with a (virtual) passkey; the resumed session committed it; Provenance as above ([demo-s5.md](demo-s5.md))
- [ ] ⏸ **Manual demo on a real phone: waiting for the maintainer.** It needs a person and a phone. It works on localhost through Chrome's cross-device passkeys (a QR code, then Bluetooth), with no deployment (D12); steps in [demo-s5.md](demo-s5.md#2-give-maria-a-passkey)
- [x] Tag `v0.3.0`

---

### S6: Works in any environment → **v0.4**

**Goal:** prove the "any login system, any FHIR server" promise. A hospital's own login (Keycloak as stand-in), plus Google, plus a real EHR sandbox (Epic) for reads.

**Plan:**
- **External identity providers.** Admin adds a **Connection** (issuer + JWKS), and only trusted issuers are accepted. Persons and admins can log in with that provider (Better Auth SSO / generic OIDC).
- **Token exchange (RFC 8693)** for headless agents: the agent presents the person's token from a trusted provider (`subject_token`) and authenticates as itself (`actor`). The api issues a pass with `act`. It fails closed on untrusted issuers, wrong audience, or unknown claims.
- **Upstream FHIR via SMART:**
  - The gateway is a SMART client to the Epic sandbox (standalone patient launch).
  - The upstream refresh token is stored encrypted in a **vault** table, keyed by (person, FHIR server).
  - The patient is pinned from the launch context.
  - The agent never sees the upstream token.
- `deploy/compose.yaml` gains a Keycloak profile; the README gains "use your own login" and "use your own FHIR server" guides.

**Build:**
- [x] Connections (admin screen + api), with sign-in through them (Better Auth SSO): linked by verified email to an existing login only (D13)
- [x] `/token` exchange grant (RFC 8693), as a Better Auth extension grant; headless clients from the agent's Apps dialog
- [x] SMART client + vault in the gateway (D14); people connect their record from My AIs
- [x] FHIR target config (multiple servers): *FHIR servers* page, and *Records from* per agent
- [x] Guides: [use your own login](guides/own-login.md), [use your own FHIR server](guides/own-fhir-server.md); compose profiles `keycloak` and `smart` (the SMART launcher plays the EHR locally)

**Validate:**
- [x] Matrix, the local cells: {aipass login, Keycloak} × {HAPI, EHR over SMART (launcher)}: the S1 call works and the Check is A (16/16) in all four, on every CI build. Real Claude Code ran in the Keycloak × SMART cell: [demo-s6](demo-s6.md)
- [ ] ⏸ Matrix, the maintainer's cells: Google (needs a Google Cloud OAuth client) and the Epic sandbox (needs an Epic app registration). The steps are in the guides
- [x] Token exchange negative tests: untrusted issuer, wrong key, wrong audience, missing or wrong actor authentication, `act`/`may_act`/`cnf`, unverified email, unknown person, unapproved agent, `actor_token` and unsupported token types are all refused
- [x] Probe: no upstream token, refresh token, client secret or launcher settings ever appear in any tool result, response header, receipt, AuditEvent or log (`s6-upstream.int.test.ts`)
- [x] Tag `v0.4.0`

---

### S7: Hardening → **v0.5**

**Goal:** a demonstration hardened enough for others to run and check: containers, signed releases, security docs, and a story others can cite. Ready for organizations to trial is version 1.0, on the [roadmap](ROADMAP.md).

**Build and validate:**
- [x] [Threat model](security/threat-model.md): assets, actors, trust boundaries, each threat with its control and proof, and the residual risks
- [x] [OWASP ASVS 5.0 Level 2 self-check](security/asvs-l2.md): all 253 L1+L2 requirements, each with evidence
- [x] Dependency audit: `pnpm audit --prod` gates CI (clean); Dependabot for npm, Actions and Docker. One dev-only advisory is left (braces, via the shadcn CLI; no fix published)
- [x] Signed releases: `release.yml` publishes the images with an SBOM, SLSA provenance and a Sigstore-signed GitHub attestation. Verified with `gh attestation verify` on an `edge` build. Per amended D12 it runs by hand only; v0.5.0 is released as source
- [x] Docker images + `docker compose up` from a clean machine in under 10 min: **114 s**, timed in an empty Docker-in-Docker from a fresh `git clone`, with the health check graded A inside it. CI runs the same on every push. Nothing is deployed (D12)
- [x] Vault key rotation: `AIPASS_VAULT_KEY_PREVIOUS` + `pnpm vault:rotate`
- [x] Optional, evidence-driven:
  - SMART **Permission Tickets**: not adopted (D15); no adopter needs a portable grant format yet
  - **Cedar**: not adopted (D15); the rules still fit on one page and are tested line by line
  - a Helm chart for adopters: `deploy/helm/aipass`, linted and schema-checked in CI, not deployed (D12)
- [x] Write-up: [Who did this, for whom? Identity for AI agents on FHIR](writeup.md), with the scorecards
- [x] Tag `v0.5.0` (first tagged `v1.0.0`; see the Log)

---

### S8: Built-in chat and model connections → **v0.6**

**Goal:** a person can use an AI on their record, and an admin can set it up and try it, all in the browser. The model is a choice: any OpenAI-compatible endpoint (D16).

**Plan:**
- **Model connections** (admin, *AI models* page): name, base URL, an optional API key (sealed in the vault, like FHIR server secrets), the models it offers (read from its `/models`), and **where it runs**: on your network, or in the cloud. A **Test** button lists the models and makes one small tool call.
- **Each agent gets a model** (a connection and a model) and an optional fallback. A role can require on-network models only: choosing a model is choosing where the person's data goes.
- **The built-in chat is an ordinary AI app.** It's registered as an OAuth client, approved per agent like any other app (D11), and gets its pass through the person's normal consent. It has no shortcut into the gateway or the database.
- **`packages/chat`** (no framework): an OpenAI-format model client, an MCP client, and the loop. The gateway's tools become the model's tools; each tool call the model makes goes to the gateway with the pass; results go back until the model answers. It's served from apps/api and streamed to the browser.
- **The person sees the steps in plain words:** what the AI looked up, what was refused and why (the gateway's own reason), and any change going to the approval flow (S5).
- **Not a health app.** No clinical features: it's a reference client that shows the guard working. Adopters can use it or bring their own AI.
- **Dev setup:** the seed adds a model connection only if `AIPASS_DEV_MODEL_URL` (and `AIPASS_DEV_MODEL`) is set in your local env; the repo names no private endpoint. Nothing in CI calls a real model.

**Build:**
- [x] `model_connections` table + api (add, edit, remove, sealed key, test) + the admin *AI models* page. Where data goes is the admin's choice, with no default: an endpoint on the network can forward to a hosted model
- [x] Agent → model, plus fallback, on the Agents page; an on-network-only option on the role, checked when a model is chosen and again on every message (fail closed)
- [x] The built-in chat as a registered public client (`aipass-chat`, PKCE), approved per agent from the agent's Apps dialog; the demo seed approves it for both agents
- [x] `packages/chat`: model client (chat completions + tools, streaming), MCP client, the loop (step limit, timeouts, fail closed on an unknown tool), fallback when the first model can't be reached
- [x] The *Chat* page for people (from My AIs, plus "More AIs you can chat with"), showing steps, refusals and approval links. The conversation lives in the browser tab; aipass keeps no transcript
- [x] aipass's own FHIR server is registered too (D18): listed first on *FHIR servers*, with Test and Edit (name, address, sealed credential; a new address must answer as FHIR first), never switched off; registered from `FHIR_BASE_URL` on a first start, then followed live by the api and gateway. Vault rotation now also re-seals it, model keys and the chat's tokens
- [x] Receipts name the app that held the pass, read from the pass itself ("via aipass chat (built-in)" on Activity), and it's in the hash for new receipts only, so older ones still verify. The model isn't in the receipt, since only the chat knows it; the chat shows which model answered

**Validate:**
- [x] Unit: tool conversion; the loop (step limit, a refused call, a model error, an unknown tool); the model client against recorded responses (19 tests)
- [x] Integration: chat ↔ real gateway ↔ HAPI, with a scripted fake model (`s8-chat.int.test.ts`, 6 tests)
- [x] End-to-end (Playwright), clicks only (`chat.spec.ts`, 10 tests): the admin adds a model, tests it, gives it to the Diabetes Coach; Maria opens Chat, agrees, asks for her A1c and gets it; her mental-health medication stays private; the lookup shows in Activity via the chat; the model never received a pass or other credential; Stop and withdrawing the app each refuse the next lookup; a network-only role refuses a cloud model; disconnecting means she's asked again
- [ ] By hand on localhost: a real model through an OpenAI-compatible endpoint, and a local Ollama as the fallback (maintainer)
- [x] Tag `v0.6.0` (with S9 and S10)

---

### S9: People at scale → **v0.6**

**Goal:** the People page works for a clinic, not three demo patients: a list you can search, filter and page through, one person at a time in a side panel, people added by picking their record from a FHIR server, and consent that only the person can give (D19).

**Plan:**
- **A person** is one human: a login, and their records, each at a FHIR server. The record at aipass's own server is picked by the admin from a search of that server (no typed ids); a record at an EHR over SMART is linked only by the person's own sign-in there (aipass can't search an EHR). Records are never merged by name or birth date: a wrong-patient match is what aipass exists to stop. One record belongs to one person.
- **Consent (D19):** a grant is the person's "yes". For real people the admin can revoke; only test persons (the demo, synthetic people) can have grants set by the admin, and those are recorded as set by the admin.
- **Suspend:** the clinic can pause a person; every AI acting for them is refused on its next call (rule 4).
- **API:** `GET /admin/persons` searches (name, email, record id), filters (server, login, AI, status), sorts and pages; `GET /admin/persons/:id` is one person's detail; a patient search on aipass's own server; suspend, rename, remove (off-board: grants, chat links, vault entries, login and tokens go; receipts stay).
- **UI:** the People page is only the list (filters in the URL). A row opens the person's side panel: Overview, Login, AIs, Activity, Approvals. Every other place that picked from all people (role preview, approval rules, Activity's filter) gets the same search-as-you-type picker.

**Build:**
- [x] Data: person status and test flag, grants `setBy`, one person per record (aipass's server and EHRs), indexes (migration 0008; the demo's Maria and John are test persons)
- [x] Policy: a suspended person is refused (rule 4, "Maria's access is paused by the clinic")
- [x] API (`people.ts`): search/filter/sort/page, detail, patient search on aipass's own server, add from a record, pause, rename, remove; admin grants only for test persons, and an admin revoke also stops the AI's refresh tokens
- [x] UI: the list (filters in the URL), the side panel (Overview, Login, AIs, Activity, Approvals), Add person from a FHIR search, the shared person picker in the role preview, approval rules and Activity

**Validate:**
- [x] Unit: the suspend rule
- [x] Integration (`people.int.test.ts`, 13 tests): 5,002 people, every list 5–28 ms; one person per record (aipass's server and EHRs); consent rules; removal takes the login and keeps the receipts
- [x] End-to-end, clicks only (`people.spec.ts`, 9 tests): page, search (in the URL), filter, open a person (records at both servers, login, AIs, activity), pause (the agent's next call is refused, then works again), add from a FHIR search ("Already Maria Santos" for hers), only the person can say yes, remove, and the role preview's search picker
- [x] Tag `v0.6.0` (with S8 and S10)

---

### S10: Staff members → **v0.6**

**Goal:** an agent can act for a staff member, not only a patient (D21). Dr. Lee, a clinician, uses the Visit Assistant on the patient she has open. It sees only that patient, only while the patient is in her care, and never a locked record.

**Plan:**
- **A staff member** is a person whose record is a `Practitioner` at aipass's own FHIR server, added like anyone else (S9: *Add person → Practitioners*).
- **Her care team comes from the record system:** the active `CareTeam`s at aipass's FHIR server that list her as a participant. aipass keeps no list of who treats whom.
- **The patient she has open** is picked in the browser from her care team: on the Chat page, or on My AIs for an outside AI app. It's stored per person and agent. Every pass the agent gets for her names that patient (`patient`, as in SMART's patient launch context). Switching patient starts a new conversation, so one patient's answers can't carry into another's.
- **Rule 5 for a staff member, live on every call:**
  - the pass names a patient ("no patient selected");
  - that patient is still in her care ("not one of Dr. Lee's patients"; the refusal doesn't name a patient who isn't hers);
  - it's the patient she has open now ("Dr. Lee has another patient open now");
  - each record belongs to that patient ("not the patient in context").

  Rules 1–4 and 6–7 are unchanged: the grant is her own "yes" (D19), locked labels are refused, and she approves a proposed change with her passkey.
- **Records name both people:**
  - the receipt ("… for Dr. Grace Lee, from Maria Santos's record");
  - the AuditEvent (agent[1] = `Practitioner/lee` as the requestor; the patient as the entity);
  - a change's Provenance (`onBehalfOf` = `Practitioner/lee`; the Observation's subject is the patient).
- **Demo data (synthetic):**
  - Dr. Grace Lee (`Practitioner/lee`), with Maria and Carlo in her care and John not;
  - the Visit Assistant role: labs (read and propose), conditions, medications, visit notes, plus name, birth date and sex so she can confirm whose chart it is.
- **Not yet** (see the [roadmap](ROADMAP.md)): staff records at an EHR (a SMART provider launch), and the patient taken from an EHR's launch context.

**Build:**
- [x] Fixture `staff/lee.json` (the Practitioner and her CareTeams, loaded after the patients); demo seed: the Visit Assistant agent and role, Dr. Lee as a test person with a demo login
- [x] `patient_contexts` (migration 0009). The pass's `patient` comes from it for OAuth, token exchange and dev passes
- [x] Gateway: the staff checks in rule 5, live; receipts name the patient; refusals say "Dr. Lee", not "Dr."
- [x] API: her care team, and choosing the open patient (from her care team only)
- [x] UI: the patient picker on Chat and My AIs; the consent and approval pages say which patient

**Validate:**
- [x] Unit: names with a title; the rule-5 wording for staff members; receipt sentences; a care team counts only when active and naming her (10 tests)
- [x] Integration (`s10-staff.int.test.ts`, 9 tests; `staff.int.test.ts` in the api, 6 tests: her care team, opening only a patient in it, every pass naming the open patient):
  - Dr. Lee reads Maria's labs (allowed; the receipt and AuditEvent name both);
  - John's note is refused (not the patient in context);
  - Maria's therapy note is refused (mental-health);
  - a pass for John is refused (not in her care);
  - no patient selected;
  - a switched patient;
  - a proposed reading approved by Dr. Lee, with its Provenance
- [x] End-to-end, clicks only (`staff.spec.ts`, 5 tests): Dr. Lee picks Maria, agrees, asks for her labs and gets them; switching to Carlo starts a new conversation; John's record is refused; Activity names both
- [x] Demo: [demo-s10.md](demo-s10.md), clicks only
- [ ] By hand on localhost: Dr. Lee with a real model (maintainer)
- [x] Tag `v0.6.0` (with S8 and S9)

---

### S11: No terminal → **v0.7**

**Goal:** nothing a person does with aipass needs a terminal (D17). The only command left is starting it: `docker compose up`, or `pnpm dev` for developers.

**Plan:** every terminal step today, and where it goes.

| Today, in a terminal | In the web UI |
|---|---|
| `claude mcp add` + `claude mcp login` | the built-in chat (S8), and a **Connect your own AI** page per agent: its URL, plus the steps to do in that app's own settings |
| `pnpm pass`, `scripts/pass-header.sh`, `exchange-header.sh`, `curl` | the chat, and *Preview as this role*. The scripts stay as test fixtures only, out of every demo and guide |
| `pnpm admin` (stop/resume, revoke/restore, receipts) | already on Agents, People and Activity; the CLI is retired |
| `pnpm check` | the Health page (already there); the CLI stays for checking *other* systems from CI |
| `pnpm smart:url` | shown on the FHIR servers page in dev |
| `pnpm vault:rotate` | a **Re-seal secrets** button, once the new key is set (the key itself stays in the deployment's settings) |
| `curl` for a request's AuditEvent | a link from Activity |

AI apps like claude.ai connect through their own cloud, so they can only reach an aipass at a public address, which is the adopter's deployment. On localhost the built-in chat is the way in.

**Build:**
- [ ] Connect your own AI page
- [ ] FHIR servers page shows the dev launcher URL; Activity links each AuditEvent; Re-seal secrets button
- [ ] Retire `pnpm admin`; move the pass scripts under test fixtures
- [ ] Rewrite the demos (s1, s3, s5, s6) and the guides as clicks

**Validate:**
- [ ] Every demo and guide runs in Playwright by clicks only
- [ ] Someone who isn't a developer follows the README path in a browser (maintainer)
- [ ] Tag `v0.7.0`

---

## 6. Risks and stop rules

| Risk | Watch for | Response |
|---|---|---|
| A library can't do what we assumed | SP1–SP4 fail | Use the fallback written in S0; never patch libraries |
| FHIR leaks through a side door | `include_escape`/`role_escape` probes | Block first and allow later. Response filtering is mandatory, not optional |
| Scope creep (becoming a health app) | Work that isn't in a stage | Out of scope: clinical features, connectors, a consumer app |
| Research drift | 2 weeks with no commits | Stop and ship whatever exists |

**Release cadence:** a new release about every quarter, plus security fixes as needed. Milestones are in [ROADMAP.md](ROADMAP.md).

---

## 7. Progress

| Stage | State | Dates | Note |
|---|---|---|---|
| S0 Foundation + spikes | ✅ done | Oct 19 | all 4 spikes answered; SP2 changed the MCP SDK (D8), SP1 led to one URL per agent (D9) |
| S1 The guard (read-only) | ✅ done | Oct 19 | all validation rows automated; real Claude Code demo run |
| S2 Admin UI v1 → v0.1 | ✅ done | Oct 19 | v0.1.0 tagged; release check by an independent AI review agent (a run by a person is still wanted) |
| S3 Real login + person's yes → v0.2 | ✅ done | Oct 19 | real Claude Code over OAuth; v0.2.0 |
| S4 Health check | ✅ done | Oct 19 | 12/12 planted defects caught; 2 external scorecards; filing issues waits for the maintainer |
| S5 Approved changes → v0.3 | ✅ done | Oct 19 | A1–A8 green; real Claude proposed → passkey → commit; a real-phone run waits for the maintainer |
| S6 Any environment → v0.4 | ✅ done | Oct 20 | 4 local matrix cells green incl. the full check; real Claude Code as a headless agent; Google and Epic cells wait for the maintainer's registrations |
| S7 Hardening → v0.5 | ✅ done | Oct 20 | containers (114 s from a clean Docker), signed releases, Helm chart, threat model, ASVS L2 self-check, write-up |
| S8 Built-in chat + model connections → v0.6 | 🟡 in progress | Oct 21 | v0.6.0 tagged; the maintainer's hand test is left |
| S9 People at scale → v0.6 | 🟡 in progress | Oct 21 | v0.6.0 tagged; the maintainer's UI test is left |
| S10 Staff members → v0.6 | 🟡 in progress | Oct 21 | v0.6.0 tagged (D21); the maintainer's hand test is left |
| S11 No terminal → v0.7 | ⬜ not started | after S10 | web UI only (D17) |

_States: ⬜ not started · 🟡 in progress · ✅ done · ❌ blocked (say by what)._

## 8. Log

_Newest first. One line per real event: a stage state change, a spike result, a prediction miss, a decision. This is not a diary._

| Date | Event |
|---|---|
| 2026-10-21 | **v0.6.0 tagged:** S8, S9 and S10 released together, with the licence and the roadmap. CI green, including `docker compose up`. The maintainer's hand tests stay open, so the three stages stay in progress |
| 2026-10-21 | **S10 built.** Prediction held: the care-team check adds 3.9 ms to a read (median 12.6 → 16.5 ms, local HAPI), and the S1–S9 suites needed only the demo's people count changed (two specs). Surprise: the record system names her *Maria Elena Santos* while aipass's person list says *Maria Santos*; a staff member's receipts use the record's name, since that's the record touched. The Visit Assistant also reads visit notes, so a direct read of another patient's record has a tool to be refused through. Unit 154, integration 134, end-to-end 62 green |
| 2026-10-21 | **Prediction (S10, before building):** checking the care team on every call adds under 25 ms to a read (median, local HAPI). The S1–S9 suites pass with only the demo's counts changed (three agents and three people instead of two) |
| 2026-10-21 | **S10 Staff members planned (maintainer):** an agent can act for a clinician, on the patient she has open (D21). "No terminal" moves to S11 |
| 2026-10-21 | **Licence: Apache-2.0 (D20).** Roadmap added ([ROADMAP.md](ROADMAP.md)); §6's dates are replaced by the release cadence |
| 2026-10-21 | Renamed tag v1.0.0 → v0.5.0. "v1.0" here meant "all build stages done"; the public version 1.0 is the production-ready release in the roadmap (Q3 2027). Code unchanged. S8 and S9, planned as v1.1 and v1.2, ship as v0.6 with S10 |
| 2026-10-21 | **S9 built.** Prediction held: over 5,002 people every list query took 5–28 ms (limit 50 ms) on b-tree indexes. Surprise: the new one-person-per-EHR-record index now stops, in the database, the "Maria's tokens copied to John" case that S6 only caught at the seal; that test now checks both. Unit 144, integration 119, end-to-end 57 green |
| 2026-10-21 | **Prediction (S9, before building):** with 5,000 people, the list query with any one filter stays under 50 ms on plain b-tree indexes (no trigram search) |
| 2026-10-21 | **S9 People at scale planned (owner):** the People page was one card per person with every grant, loaded at once; a person had one typed `Patient/…` ref; and the admin could set anyone's consent. "No terminal" moves to S10 |
| 2026-10-21 | **D18 (owner): everything registered.** aipass's own FHIR server was only an env setting, invisible in the UI. It's now a registered entry like the EHRs, edited on the FHIR servers page and followed live. Found on the way: vault rotation skipped the S8 secrets (model keys, chat tokens); fixed and tested |
| 2026-10-21 | **Surprise (S8):** in the full end-to-end run the chat's sign-in sometimes landed back on My AIs. The consent page sent the browser to the callback twice: Better Auth's client already follows `{redirect: true}` and our `followRedirect` did it again, so a first, cancelled request spent the one-time launch. Fixed `followRedirect` (this also affected other apps' consent, harmlessly so far), and the chat's callback now tolerates a repeat. 43/43 end-to-end green |
| 2026-10-21 | **S8 built.** AI models page, a model per agent with a fallback, the built-in chat as an ordinary OAuth app, receipts naming the app. Unit 19, integration 6 and end-to-end 10 new tests green. The answer streams (NDJSON) through the web app's `/api` rewrite with no workaround. No prediction was written first, against rule 6 |
| 2026-10-21 | **Owner: web UI only, models are a choice** (D16, D17). S8 (built-in chat and model connections) and S10 (no terminal, then numbered S9) planned. Tests and CI use a fake model; real models are tried by hand on localhost |
| 2026-10-20 | **ASVS L2 self-check:** 85 met, 73 partly, 29 not met, 49 N/A, 17 delegated (of 253). The first pass found and we fixed: CSRF on aipass's own APIs, approvals readable by any signed-in user, SSO providers registrable by anyone, an open redirect after sign-in, a spoofable client address for sign-in limits, discovery following redirects, and missing security logs. Top open gaps: admin MFA, session lifetimes, password checks |
| 2026-10-20 | **D12 amended (owner):** we're early, so no more time goes into CI/CD or deployment. The files stay, used for localhost test runs and the dev loop only. No k3s; the image release runs by hand only |
| 2026-10-20 | **S7 ✅ v1.0.0.** D15 (how aipass ships; Cedar and Permission Tickets not adopted yet). Owner-gated items are still open: filing the S4 issues, a person's README run, the real-phone passkey, and the Google and Epic cells |
| 2026-10-20 | **Surprise:** the first container stack graded C. The api reached the gateway at its public URL, which inside a container isn't the gateway, and some probes "passed" because nothing came back. Fixes: `GATEWAY_INTERNAL_URL`, and the check now runs a control first (no allowed read means no probes, grade F) |
| 2026-10-20 | **Prediction:** "`docker compose up` from a clean machine in < 10 min". Actual: 114 s (empty Docker-in-Docker, fresh clone, all images pulled and built). Bundling the servers with esbuild meant no `node_modules` at run time; images are 248–300 MB, of which 242 MB is the Node base |
| 2026-10-20 | **S6 ✅ v0.4.0.** D13 (connections, one hop, no sign-up), D14 (the gateway is the SMART app; the vault). Real Claude Code exchanged Maria's Keycloak token for a pass and read her A1c from the EHR; disconnecting her record and disabling the login each stopped it |
| 2026-10-20 | **Surprise:** the SMART launcher keeps its settings, client secret included, in its FHIR URL. Records from another server are now named by server id in the audit trail, agents see only `Type/id`, and no FHIR error message carries a URL |
| 2026-10-20 | **Surprise (Better Auth SSO 1.7.11):** it won't fetch discovery from private hosts unless their origin is trusted; it ignores `email_verified` unless `trustEmailVerified` is on; and a `resolveUser` hook needs an adapter with transactions. Trusted origins now come from enabled connections on internal hosts, read per request, and fall back to our own origin when the database isn't there yet (CI starts the api before the e2e database exists) |
| 2026-10-20 | **Surprise (tests):** the e2e reset didn't clear the new tables, so a leftover connection from the previous run made a "create" test pass on old data. The reset now clears them, and the test waits for the dialog to close |
| 2026-10-19 | **S5 ✅ v0.3.0.** SP5: yes (same passkey rows; we add required user verification). 16 probes, 16 planted defects, all caught; scorecards updated (wso2 wrote a reading with no approval; fhirHydrant is read-only by default) |
| 2026-10-19 | **Surprise:** HAPI reuses cached search results for about a minute. After tests deleted records, a "newest first" page still listed them, which hid Maria's A1c from a probe. The dev compose file now sets `reuse_cached_search_results_millis: 0`, and the check cleans up every reading it writes |
| 2026-10-19 | **D12:** develop and test on localhost only; no deployment to the owner's k3s. Deployment artifacts are for adopters |
| 2026-10-19 | **S4 ✅** The inspector catches all 12 planted defects one-to-one and raises no false alarms. Scorecards: aipass A, wso2/fhir-mcp-server F, fhirHydrant F (in their documented local modes). Issue drafts are ready; filing waits for the owner. the-momentum/fhir-mcp-server was set aside: it needs Pinecone, a LOINC account and an embedding model to run |
| 2026-10-19 | **S3 ✅ v0.2.0.** Real Claude Code connected with only the gateway URL (CIMD + PKCE + `resource`), Maria consented without vitals, and the gateway refused vitals with her reason. Revoking on "My AIs" ended the session. 13 e2e tests green |
| 2026-10-19 | **Prediction miss (S3):** DPoP isn't needed against cross-agent replay; the per-agent audience handles it. Claude Code doesn't use DPoP |
| 2026-10-19 | **Surprise:** a CIMD client exists in Better Auth only after its first visit, so the admin's "allow this app" can't be a foreign key up front. aipass keeps its own list and links on Better Auth's `onClientCreated` (D11). Also: Turbopack dev went into an "HMR hash mismatch" reload loop after many file changes; a clean `.next` fixed it |
| 2026-10-19 | **S2 ✅ v0.1.0.** Release check (fresh clone, README only, independent agent): PASS. Its fixes: one Claude config per agent (`deploy/claude/coach.json`, `scheduler.json`), permission prompts and `-p` flags documented, rule numbers explained in the doc and on hover in Activity, the chain result stays on screen, the preview starts on the person most agents act for |
| 2026-10-19 | **S2 built.** Stop → refusal measured at 38–89 ms. E2E runs on its own ports (4000–4002), database (`aipass_e2e`) and Next build folder, next to `pnpm dev`. One public origin (D10) |
| 2026-10-19 | **S1 ✅** 63 unit + 32 integration tests green; real Claude Code demo matches the plan |
| 2026-10-19 | **Surprise:** Claude Code runs `headersHelper` once per connection and again only after a 401. Measured: with a 5 s pass, the call after expiry got `401 expired`, then a fresh pass (new jti) succeeded. Lowered clock-skew tolerance from 30 s to 10 s, which had let an expired pass through |
| 2026-10-19 | **Surprise (demo):** asked for A1c, Claude also called `get_patient_summary` and was refused. The coach role now includes demographics, masked to name, birth date and gender |
| 2026-10-19 | Unknown tool arguments (e.g. `_include`) were being silently dropped; they are now refused (strict schemas, rule 2: fail closed). The paging token was signed but readable, which exposed the FHIR address, so it is now encrypted (AES-256-GCM) |
| 2026-10-19 | **S0 ✅** Fresh clone with no containers or volume → `pnpm dev` → all healthy in 27 s; CI green. Web typecheck now runs `next typegen` first, so `next-env.d.ts` is no longer committed |
| 2026-10-19 | **S0 started.** Postgres moved to host port 5433 (5432 collides with other local Postgres). TypeScript 6.0.3, not 7.0 (TS 7 is the native port with no JS API yet, which Next.js type-checking needs) |
| 2026-10-19 | **SP4 ✅** Maria + John hand-written, 2 Synthea patients trimmed; load is idempotent (~1.5 s) |
| 2026-10-19 | **SP3 ✅** HAPI v8.12.0-2 takes Device/AuditEvent/Provenance; `_security` and `_security:not` searches work |
| 2026-10-19 | **SP2 ❌ prediction miss (good news):** MCP SDK v2 (`@modelcontextprotocol/server` 2.3.1) implements 2026-07-28 and Claude Code 2.1.301 negotiates it. We switch to v2 (D8). Headless elicitation loops, so S5 uses an approval link |
| 2026-10-19 | **SP1 ✅** Claude Code → Better Auth 1.7.11 via CIMD + PKCE + `resource`; `act`/`patient` claims added by an OAuth-provider extension. Shared CIMD client id → one gateway URL per agent (D9) |
| 2026-10-19 | Plan written. Stack, admin-first UI and one-file tracking decided (D5–D7). MCP TS SDK 1.32.1 found to cover protocol 2025-11-25 but not yet 2026-07-28 → SP2 |
