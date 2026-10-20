# aipass: development plan and progress

_This one file is both the plan and the tracker. When a stage changes state, update the **Progress** table and add a **Log** line in the same commit. Decisions live in [`decisions.md`](decisions.md); if this file disagrees with it, `decisions.md` wins._

---

## 1. What we're building, in one paragraph

A clinic admin decides what each AI agent may see and do (its **role**). The person an agent acts for, such as Maria the patient, agrees to it (her **grant**). The agent carries a short-lived **pass** that names both the agent and the person. Every request goes through the **gateway**, which re-checks the role, the grant and the record's sensitivity labels *live*. It shows the agent only its role's view of the chart, and it holds any change until the person approves it with their passkey. Each request leaves a **receipt**, in plain English and in the FHIR record's own audit log.

**Maria example used in every stage:**
- **Diabetes Coach:** labs, vitals, medications, conditions, visit notes, and her name and age; may *propose* a glucose reading.
- **Scheduling Assistant:** her name, phone number and appointments only.
- **Neither agent** ever sees anything labelled sensitive: her therapy notes, depression, antidepressant, past alcohol treatment, or her therapy appointments. The data is in [`fixtures/`](../fixtures/README.md).

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

**Testing levels:**
- Unit (Vitest): `packages/policy`, `packages/fhir`.
- Integration: gateway + api against HAPI in Docker.
- End-to-end (Playwright): admin UI, from S2.
- Health-check probes: the security regression suite, from S4.

---

## 5. Stages

Each stage has **Goal** (plain words), **Plan** (design plus anything to verify first), **Build** (work items), and **Validate** (tests, demo, and done-when).

### S0: Foundation and spikes · Oct 20–25

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

### S1: The guard, read-only · Oct 26 – Nov 3

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

### S2: Admin UI v1 · Nov 3–12 → **release v0.1 (public)**

**Goal:** the clinic admin runs everything from a browser. **"Preview as this role" shows Maria's chart exactly as each AI sees it.**

**Plan:**

| Screen | What it does |
|---|---|
| **Agents** | List, register, assign a role, **Stop/Resume**, last activity |
| **Roles** | The grid (group × See / Propose / Change), locked labels shown as always-off, patient field mask, **Preview as this role** (choose a test person) |
| **People** | Test persons and their grants (admin-managed until S3) |
| **Activity** | Receipts timeline, filterable by agent, person and decision. Each row shows the plain sentence and links to the FHIR AuditEvent |

- **Admin login:** Better Auth with email + passkey. The first user becomes admin.
- **Preview** runs the real gateway decision path in `preview` mode. It is marked as such in receipts and never counts as agent activity.
- **Registering an agent** also creates its FHIR `Device`.

**Build:**
- [ ] api: admin endpoints (CRUD agents/roles/persons/grants, receipts query), preview endpoint
- [ ] web: the 4 screens (Tailwind + shadcn/ui)
- [ ] gateway: preview mode
- [ ] README quickstart: clone → `pnpm dev` → log in → see the Maria demo
- [ ] Tag `v0.1.0`

**Validate (Playwright end-to-end):**
- [ ] Admin creates role "Scheduling Assistant" (appointments + name/phone) → preview of Maria shows **only** that
- [ ] Admin registers an agent with that role → Claude (S1 setup) sees only appointments
- [ ] Admin clicks **Stop** → Claude's next call is refused. Measure and record the time from click to refusal (prediction: < 1 s)
- [ ] Activity shows both the allowed and the refused calls, with correct sentences
- [ ] **Release check:** someone other than you follows the README to a working demo

---

### S3: Real agent login + the person's "yes" · Nov 13–24 → **v0.2**

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
- [ ] OAuth provider config, consent page, "My AIs" page
- [ ] Persons get real logins (Better Auth); the `persons` table is linked to the user
- [ ] Agent registration in admin issues or links an OAuth client
- [ ] Remove `headersHelper` from the default docs (keep it as the "headless agent" option)

**Validate:**
- [ ] Fresh Claude Code + gateway URL → browser login as Maria → consent → tools work, with zero manual token handling
- [ ] Maria unticks vitals → `search_vitals` refused "Maria hasn't agreed to vitals"; labs still work
- [ ] Revoke on "My AIs" → next call refused **and** the refresh token is rejected at the token endpoint
- [ ] A pass for Maria can't read John (compartment), and a pass minted for agent A is refused when agent B presents it (record whether DPoP binding is needed; prediction: needed)
- [ ] Tag `v0.2.0`

---

### S4: Health check (the inspector) · Nov 24 – Dec 3

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
- [ ] probes + CLI + JSON/Markdown report + admin screen
- [ ] target adapters: the aipass gateway + at least 2 open-source agent→FHIR projects

**Validate:**
- [ ] 100% of planted defects caught; 0 false alarms on the correct gateway
- [ ] Published scorecards for at least 2 external targets (pinned commit, date, exact command)
- [ ] At least 1 issue filed with a project where the suite found a gap

---

### S5: Changes with the person's approval · Dec 3–17 → **v0.3**

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
- [ ] approvals table + api endpoints + approve page + admin Approvals screen
- [ ] gateway tools + hashing + commit checks + Provenance
- [ ] Check probes `self_approve`, `approval_replay`, `payload_swap` switched on

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

- [ ] Manual demo on a real phone
- [ ] Tag `v0.3.0`

---

### S6: Works in any environment · Dec 17 – Jan 14 → **v0.4**

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
- [ ] Connections (admin screen + api)
- [ ] `/token` exchange grant
- [ ] SMART client + vault in the gateway
- [ ] FHIR target config (multiple servers)

**Validate:**
- [ ] Matrix of {built-in login, Keycloak, Google} × {HAPI, Epic sandbox (read)}: the S1 demo works and **the Check suite is green** on every cell
- [ ] Token exchange negative tests: untrusted issuer, wrong audience, missing actor authentication and an unknown claim are all refused
- [ ] Probe: no upstream token ever appears in any tool result, header or log
- [ ] Tag `v0.4.0`

---

### S7: Hardening and v1.0 · Jan 14 – Feb

**Goal:** something an organization could trial safely, and a story others can cite.

**Build and validate:**
- [ ] Threat model doc; OWASP ASVS L2 self-check; dependency audit; signed releases (GitHub provenance)
- [ ] Docker images + `docker compose up` from a clean machine in < 10 min (time it)
- [ ] Optional, evidence-driven:
  - SMART **Permission Tickets** as the grant format
  - **Cedar**, if the rules have outgrown plain TypeScript
  - a Helm chart for Kubernetes deploys
- [ ] Write-up: "Who did this, for whom? Identity for AI agents on FHIR", with S4 scorecards
- [ ] Tag `v1.0.0`

---

## 6. Risks and stop rules

| Risk | Watch for | Response |
|---|---|---|
| A library can't do what we assumed | SP1–SP4 fail | Use the fallback written in S0; never patch libraries |
| FHIR leaks through a side door | `include_escape`/`role_escape` probes | Block first and allow later. Response filtering is mandatory, not optional |
| Scope creep (becoming a health app) | Work that isn't in a stage | Out of scope: clinical features, connectors, a consumer app |
| A larger vendor ships the same thing first | Vendor release notes | Keep the **Check** suite as our anchor; verification outlives features |
| Research drift | 2 weeks with no commits | Stop and ship whatever exists |

**Dates we hold ourselves to:**
- **v0.1 public:** 2026-11-12.
- **By 2026-12-31:** at least one external fix (an upstream issue acted on) or one design partner. If neither happens, keep aipass as an open-source reference and stop the product framing.

---

## 7. Progress

| Stage | State | Dates | Note |
|---|---|---|---|
| S0 Foundation + spikes | ✅ done | Oct 19 | all 4 spikes answered; SP2 changed the MCP SDK (D8), SP1 led to one URL per agent (D9) |
| S1 The guard (read-only) | ✅ done | Oct 19 | all validation rows automated; real Claude Code demo run |
| S2 Admin UI v1 → v0.1 | 🟡 next | Nov 3–12 | public release |
| S3 Real login + person's yes → v0.2 | ⬜ | Nov 13–24 | |
| S4 Health check | ⬜ | Nov 24 – Dec 3 | external scorecards |
| S5 Approved changes → v0.3 | ⬜ | Dec 3–17 | |
| S6 Any environment → v0.4 | ⬜ | Dec 17 – Jan 14 | |
| S7 Hardening → v1.0 | ⬜ | Jan 14 – Feb | |

_States: ⬜ not started · 🟡 in progress · ✅ done · ❌ blocked (say by what)._

## 8. Log

_Newest first. One line per real event: a stage state change, a spike result, a prediction miss, a decision. This is not a diary._

| Date | Event |
|---|---|
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
