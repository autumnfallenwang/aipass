# Ping × IAM × FHIR × AI agents: research brief for the brainstorm (round 1)

> **Historical research note**, kept as written on 2026-10-15 and lightly edited to remove private lab details. Working names here (Permission Slip, Slip Gateway…) predate the project name **aipass**. Current decisions live in [`decisions.md`](decisions.md).


| | |
|---|---|
| **Date** | 2026-10-15 |
| **Question** | Can we combine our PAIC/Ping agent-delegation work with FHIR and MCP, borrowing ideas from HealthClaw rather than its code? |
| **Inputs** | [`01-healthclaw-evaluation.md`](01-healthclaw-evaluation.md) · the HealthClaw repo (the tested commit and upstream `main`) · our earlier Ping lab rounds (private notes, not published) · live read-only probes · web research on standards, regulation and vendors |
| **Labels** | **[V]** primary source checked · **[S]** secondary or snippet only · **[I]** inference · **[local]** measured on this machine today |

This is input for a brainstorm, not a decision. Routes are in §4 and open questions in §5.

---

## 0. The short version

- **Yes, the pieces fit, and they fit at a specific seam.** HealthClaw's guardrails are good where they handle *data*: redaction, deterministic engines, AuditEvent, testable grades. They are weak where they handle *identity*: who the human is, who the agent is, and what proves a human approved. That second area is exactly what our Ping rounds measured.
- **The healthcare standards world has no actor concept yet.**
  - SMART App Launch 2.2 has no `act` claim and no token exchange.
  - Provenance's `onBehalfOf` covers one level only, and AuditEvent has no `onBehalfOf` at all.
  - The only healthcare RFC 8693 profile is **SMART Permission Tickets**, a draft. Its proposal 008 puts the delegate in `actor_token` and caps delegation at **one level**.
  - Nobody currently puts "agent X acting for human Y" into a FHIR access token.
- **Regulation is getting ahead of the specs.** The HTI-5 proposed rule would define EHI "access/use" to include "autonomous AI systems" and names MCP [V]. CMS-0057-F's payer APIs are due 2027-01-01 [V]. Neither comes with an agent-authentication profile.
- **Ping has the delegation machinery but no healthcare packaging.**
  - Identity for AI is GA, PingFederate 13.1 does ID-JAG, and PingGateway ships an MCP gateway.
  - Ping does not productize SMART on FHIR: no docs page and no reference implementation [S/V].
- **In healthcare, the "leave Ping" step on Permission Slip's roadmap reverses.** Payers and health systems already run enterprise IAM; Ping claims 8 of the top 10 healthcare orgs [S]. Staying on Ping becomes a feature.

---

## 1. What we have (ours, measured)

| Asset | What it gives a FHIR project | State |
|---|---|---|
| `ping-platform` VM (AM/DS/IDM 8.1.1 + PingGateway 2026.6.0, realm `alpha`) | The only live AI-agent substrate we control; snapshots `platform-ui-complete` etc. | **Shut off** [local]; last booted ~09-03; `infra/platform-up.sh` |
| `permission-slip/` (gateway, slips, receipts, kill switch) | The pattern: pass = delegated token, slip = live permission re-read on every call, receipt = plain-English sentence, plus a fine-grained per-argument rule layer | Round 1 done 2026-08-10. **Step 2 was "wrap as an MCP server", the step this project would be** |
| R2/R3: privilege gate | Fail-closed; scope bounded by `permissions[].values`; **fail-open if `type` ≠ scope**; custom scopes did not survive exchange (returned `read`) | Measured, decompiled |
| R5: `rs/server.py` | Delegation-aware enforcement point: introspect → aud → scope → classify DELEGATED/DIRECT/AUTONOMOUS | 192 lines; the template for a FHIR front door |
| R6: `attribute.sh` | "Attributable at issuance, **blind at use**"; `actorId` empty on every real AI-agent exchange; no join from issuance to use | The reason FHIR-side receipts matter |
| R7: `agentctl` | inventory/scan (11 checks)/attest/revoke (immediate via the resource-owner grant DELETE)/rotate | Working |
| idjag-check v0.1 + `idjag-lab` verifier | 12 delegation cases, target seam, forge corpus | July; uncommitted |

**Measured today [local]:**
- **Our PAIC sandbox tenant** has moved to **AM 9.0.0-SNAPSHOT (build 2026-10-05)** and still returns **501 "OAuth 2.0 for AI Agents is not enabled"** on `realm-config/agents/AIAgent` and the `aiagent` well-known (both read-only GETs).
- Ping's rapid-channel changelog for **2026-10-05 (FRAAS-35825)** reads: *"Fixed an issue where enabling AI agents on some existing tenants reported success but didn't enable the feature"* [V]. Retrying the enable on that tenant might now work. **It is a one-way tenant write, so it is not done.**
- **AM 8.1.1 jar** contains OIDC **CIBA** (`BackChannelGrantTypeHandler`, `oauth2/ciba/*`). It also contains **RFC 9396 `authorization_details`** (`AuthorizationDetailsProcessor`), which requires a **remote consent service** configured on the client. That is the Open-Banking-style "approve this specific thing" pattern. Seen as class strings only; behaviour untested.
- **PingGateway 2026.6.0 on the VM ships `openig-mcp`:** `McpValidationFilter`, `McpProtectionFilter`, `McpAuditFilter`, `McpStaticResourceMetadataHandler` (RFC 9728), `OAuth2AccessTokenValidationFilter`, `WwwAuthenticateAdapterFilter`. **Ping's own MCP gateway is already on our hardware.** Ping marks its interface "Evolving" [V].
- **Claude Code `headersHelper`** runs a script on each MCP connection and again on a 401/403 to produce headers [V, docs]. That script is where "the agent exchanges the human's login for a pass" can live without patching the MCP client.

---

## 2. HealthClaw through an identity lens

### 2.1 ⚠ The evaluated commit is stale
- The repo's default branch is `chore/dependabot-pillow-bodyparser`, which points at `2b7984a` (2026-07-21). A fresh clone lands there [V].
- **`main` is 498 commits ahead** (3 behind). v2.0.0, "the synthetic-beta release", shipped 2026-09-24, and the last push was today [V].

Status of the report's findings on `main`, from a **static read only, not re-run**:

| # | Finding at `2b7984a` | On `main` |
|---|---|---|
| 1 | Human-approved writes can't complete over MCP | **Redesigned.** The MCP tools now say "never set X-Human-Confirmed yourself", and the agent must stop at 428 and tell the person. The gap is now a design stance, not a bug |
| 2 | Step-up token replay on writes | **Probably still present.** Create and update call `require_grant(scope=WRITE, …)` without `consume_nonce` (default `False`); only the Curatr path consumes. No open issue found |
| 3 | Refusals not audited | **Addressed.** `outcome='failure'` audits are added on refusal paths, plus `_audit_refusal` in `r6/access.py` |
| 4 | Conformance `detail` on passing checks | **Fixed.** Split into `on_failure` |

→ Before sharing the report anywhere, re-run against `main` or add a dated "tested commit" caveat.

### 2.2 Identity seams (file:line refs in the teardown notes; the `main` specs are saved in the scratchpad)
- **Tenant** comes from the `X-Tenant-Id` header.
- **The engine has no human principal.** Only the CareAgents app logs a person in, with a passkey; the engine sees a service token plus `X-Agent-Id: careagents`.
- **The agent** is a free-text `X-Agent-Id` header.
- **The MCP server** uses one shared `MCP_AUTH_TOKEN`. On stdio/SSE, tool *arguments* can override tenant and token, so **the model picks its own tenant**.
- **The step-up token** is an HMAC over `{tid, sub, nonce, scope?, aud?, op?}` with no human, no patient and no `act`. On stdio the agent can mint its own (`fhir_get_token`).
- **The action rail's `/confirm`** accepts any tenant-bound token, so the agent can approve its own action. `approved_via` comes from the request body.
- **`Permission $evaluate`** matches action codes only and ignores subject. Permit wins, so deny-overrides is not honoured. Anyone holding a token can author a Permission.
- **There is no patient compartment;** reads are tenant-wide (#891).
- **AuditEvent** has one agent with `who.display` only, and **no `onBehalfOf` anywhere in the code.**
- **SHARP (EHR pass-through)** forwards the SMART token without validating it, and every user of one EHR shares one tenant.

### 2.3 Where upstream is heading (main, `docs/specs/2026-08-16-*`)
- **Human-gate spec.** *"An approval is out-of-band iff no combination of credentials the agent legitimately holds can produce it."* It defines properties H1–H6 and binds approvals to a payload digest. Its own text admits the review page fails H6.
- **MCP-authorization spec.** It covers RFC 9728/8707/7662/9207, CareAgents as the consent front door, and dropping the argument overrides.
- **It explicitly declined RFC 8693:** *"the more standard shape; not chosen because it adds a grant type and a second audience"* (§13.6). It also admits *"Flask cannot verify that the CareAgents account owns tenant_id"* (§13.3).
- **Roadmap items that match our work:**
  - "Granular SMART v2 scopes per tool"
  - "Caregiver/consent model… proxy access"
  - **"Standing approvals for recurring low-risk actions"**, which is what a permission slip is.
- **Relevant open issues:**
  - #234 "ship a versioned guardrail spec + threat model"
  - #401 "Conformance cannot grade read auth, and that is the gap a skeptical adopter finds first" (closed)
  - #214 (header-based clinical gate)
  - #891 (tenant-wide reads)
- **Author:** Eugene Vestel (FHIR IQ). 31 stars, 67 open issues; the project is very active.

### 2.4 Ideas worth taking (not code)
1. **Guardrails you can grade** (A–F, runnable as a script, an endpoint, an MCP tool, or in CI).
2. **Propose → commit split** for writes. The agent can propose but never approve.
3. **The H1–H6 out-of-band test** as acceptance criteria for any approval we build.
4. **Payload-digest binding of approvals** (cf. RFC 9396 `authorization_details`).
5. **Deterministic engines decide and the LLM explains.** This is not identity, but it shapes which tools are safe to expose.
6. **Provenance on every patient-approved change** (Curatr).

---

## 3. The standards and market map

### 3.1 Standards
| Thing | Status | What it means for us |
|---|---|---|
| SMART App Launch **2.2.0** | Published 2024-04 [V] | v2 scopes (`patient/Observation.rs?category=…laboratory`), Backend Services. **No actor, no token exchange**; introspection shows one `client_id` + `fhirUser` + launch context |
| SMART `organization-identity` branch | Draft, unmerged (Aug–Sep 2026) [V] | Client-asserted `organization` claim, "on whose behalf", single level |
| **SMART Permission Tickets** (Argonaut) | Pre-ballot IG v0.1.0 [V] | Issuer-signed ticket redeemed **via RFC 8693**. **Proposal 008** (2026-08-05, draft for discussion): delegate in `actor_token`, *"issued token MAY carry an `act` claim"*, **depth 1; chains out of scope**. Mentions no agents |
| UDAP / FAST Security | US STU2 published; STU3 ballot 2026 [V] | `hl7-b2b` extension: `subject_name/id/role`, `organization_id`, **`purpose_of_use`**, `consent_reference`; single level, client-asserted. TEFCA IAS endpoints must support it by 2027-07-01 |
| AI Transparency on FHIR | Ballot 2026-Jan; STU1 pending [V/S] | Records **AI-authored data** (`AIProvenance`, `AIDevice`). **Not AI reads or tool calls**; excludes guardrails |
| `Provenance.agent` | Normative in R6 build [V] | `who` + `onBehalfOf`, meaning `act.sub` → `who` and `sub` → `onBehalfOf`. **One level.** R6 forbids a Device as `onBehalfOf`: an agent may act but may not be the principal |
| `AuditEvent.agent` | R4/R6 [V] | **No `onBehalfOf`.** Delegation is only expressible as multiple agents plus the `requestor` flag (IHE BALP's OAuth profile uses parallel client and user agents, with jti in `policy`) |
| Data Access Policies IG (`Permission`) | Incubator, informative [V] | Describes **a middleware proxy enforcing fine-grained policy beyond SMART scopes**, which is the HealthClaw/Permission Slip architecture, named by HL7 itself |
| Consent (R6) | Normative [V] | `provision.actor` can reference a Device, so a patient can grant or deny a specific AI |
| HL7 COIN (agent-to-agent) | Connectathon track [S] | "None of the connectathon agents supported authentication"; Mandel's DevDays notes list agent identity, delegated authority, purpose of use and auditable turns as needs |

### 3.2 Regulation (US unless noted)
- **HTI-5 (proposed, 2025-12-29; not final).**
  - Its §171.102 revision says "access/use" include *"automated means… including, without limitation, autonomous AI systems"* [V].
  - It cites MCP as an emerging standard to combine with FHIR [V].
  - It also proposes dropping privacy and security certification criteria such as MFA (d)(13) [V via report; not re-read].
- **CMS-0057-F (final).** Patient Access, Provider Access, Payer-to-Payer (opt-in) and Prior Auth APIs are due **2027-01-01**; SMART is the floor [V]. Payer and Medicaid-adjacent.
- **CMS Interoperability Framework** (updated 2026-08-06). It requires IAL2/AAL2, purpose of use on every query, and **"Delegated model supported" (criterion 7)**, with "Conversational AI" a named category. There are no agent-specific technical requirements [V via report].
- **TEFCA IAS SOP v3.0** (2026-08-03). Requires an IAL2 claims token in all IAS requests; no AI provisions [V via report].
- **HIPAA Security Rule.** The NPRM is not final; final action is targeted for 07/2027 [S].
- **EU EHDS.** General application 2027-03-26; the EU Health Data API ballot is system-to-system and leaves out delegation [V via report].

### 3.3 Vendors
- **Ping:**
  - Identity for AI is GA (PAIC rapid channel 2026-03-30; regular channel 2026-07-31) [V].
  - CIMD came 2026-09-14, but **CIMD clients get no delegated exchange or privileges** [V].
  - "Audience members can introspect" came 2026-09-14 (OPENAM-27658) [V].
  - **PAIC can issue tokens with `authorization_details`** (OPENAM-26474) [V].
  - PingFederate 13.1 issues and redeems **ID-JAG** [V].
  - PingGateway MCP gateway [V].
  - **No SMART on FHIR docs or reference implementation** [S, negative unverified]. Epic touchpoints: an Epic provisioning connector, and MyChart identity verification listed in Epic Toolbox (2026-07-28) [V/S].
- **Others:**
  - Okta has a SMART reference implementation, but no healthcare XAA partners [V].
  - Auth0's healthcare-agents blog (2026-05) never mentions FHIR [V].
  - Entra Agent ID uses `xms_act_fct`; the Azure FHIR service is not documented as agent-aware [S].
  - Epic's agents run in-house; Epic's sandbox advertises the token-exchange grant [V via report].
  - Google and AWS FHIR MCP servers use one service identity, and no end-user identity propagates [V].
  - Scalekit added SMART connectors (standalone launch) [V].
- **FHIR MCP servers** (WSO2, Medplum, Flexpa, Momentum, jmandel's health-record-mcp (archived), Google, AWS, HealthClaw): at best per-user SMART, where the *app* is the client. **None puts an agent-plus-human `act` chain into the token** [V/I].

---

## 4. Routes

Each route below: what it is, the first slice, what it would prove, and what it risks. The routes are composable; §4.6 shows how.

### Route A — "Permission Slip for FHIR" (product)
Permission Slip's step 2 (MCP), done in a real domain instead of notes and messages.

```
Claude (MCP client) ── headersHelper: agent exchanges the human's login for a PASS (RFC 8693, act.sub = agent)
   │
   ▼
[PingGateway 2026.6 MCP filters]     ← protocol layer: RFC 9728 metadata, token validation, MCP audit (Ping-native, optional)
   │
   ▼
fhir-slip MCP server (ours)          ← FHIR-aware layer
   • validate pass: sub = patient/member, act = agent, aud = us
   • re-read the live SLIP every call (privilege and/or FHIR Consent)
   • per-argument rules: own compartment only · categories allowed · deny security labels
     (e.g. 42 CFR Part 2 / mental-health tags) · "never Condition writes"
   • writes: propose → human approves on THEIR channel (CIBA, or RAR via remote consent) → single-use commit
   • RECEIPT = plain-English line + FHIR AuditEvent (agent + human as parallel agents, jti in policy)
             + Provenance.agent{who = agent Device, onBehalfOf = Patient} for writes
   ▼
HAPI FHIR (Synthea synthetic patients)   ← never real PHI, never a customer tenant
```

- **First slice (~1 week):**
  - Read-only. One synthetic patient.
  - Three tools: `my_labs`, `my_meds`, `my_conditions`.
  - Per-argument rule: "labs yes, behavioural health no".
  - The receipt is written as an AuditEvent.
  - The kill switch is proven against a live Claude session.
- **Proves:** an off-the-shelf agent (Claude) reads health data under a revocable, human-specific, per-argument permission that the FHIR record itself can attribute. Today nobody does this end to end (§3.3).
- **Risks:**
  - It turns into "build a health app" (scope creep).
  - SMART semantics may fight AM's exchange (see Route C's experiments).
  - Demo-ware with no user.

### Route B — "Identity probes" for agent→FHIR guardrails (verification)
idjag-check's lineage, applied where HealthClaw's own conformance is weakest: one shallow auth probe, and nothing on wrong patient, replay, self-mint, self-approval or spoofed agent.

- **Probe set (each one is a delegation belief that can be measured wrong):**
  - wrong patient in the same tenant
  - token for tenant A with header B
  - write-token replay
  - agent self-mints a write token
  - agent self-approves its own action
  - spoofed agent ID
  - read without auth on a protected tenant
  - refusals are audited
  - revocation latency at the point of use
  - the agent+human chain survives into AuditEvent/Provenance
- **Targets:** HealthClaw `main`, our Route A gateway, and maybe Medplum or WSO2's FHIR MCP.
- **First slice (~1 week):** 5 probes against HealthClaw `main` on synthetic data. Results go in a dated report, and the replay finding goes in an upstream issue.
- **Proves:** that this work changes someone's system. **This is the fastest path to your own falsifier**: *"by end-2026 one deployment changed something because this work measured its delegation belief wrong."* It is 2.5 months to the deadline, the upstream team ships daily, and it has asked for exactly this (#234, #401).
- **Risks:**
  - It is HealthClaw-shaped and small.
  - The upstream team may not engage.
  - It is mitigated by also grading our own gateway (the reference) and one other server.

### Route C — "SMART-shaped delegation on Ping" (the expertise/standards spine)
Make Ping's AI-agent exchange emit a token a FHIR server could understand. Line it up with Permission Tickets' RFC 8693 shape, and write the guide Ping doesn't have.

- **Discriminating experiments (predict before you run, as in R2/R3):**
  1. **Do SMART v2 scope strings survive AM's AI-agent exchange?** R3 saw custom scopes collapse to `read`. If they collapse, SMART scopes have to live in the slip and be enforced at the gateway rather than in the token. That decides Route A's whole design.
  2. **Can a `patient`/`fhirUser` launch-context claim be put on an exchanged token?** Test the access-token-modification script on the AI-agent exchange path, or decompile to see whether the script runs there at all.
  3. **CIBA as the out-of-band approval.** Does a CIBA-approved token pass HealthClaw's H1–H6 test as written?
  4. **RAR via remote consent:** approval bound to `authorization_details` that hold the exact FHIR write (resource hash). Compare it to HealthClaw's payload digest.
  5. **Depth 2:** caregiver → agent → patient. RFC 8693 nests `act`, but Permission Tickets, SMART and Provenance are all depth 1. RFC 8693 §4.1 says prior actors are informational, so the gateway must check the caregiver relationship from live data (RelatedPerson + Consent), not from the token. Nobody models this case.
- **Output:** a profile note, plus Ping config, plus test cases, plus a Deviations-style table of "what Ping doesn't document for SMART".
- **Proves:** the IAM-expert claim (your niche), and it gives you something to say in the Permission Tickets discussion (proposal 008, depth 1, no agents).
- **Risks:**
  - Pure research again, which is your stated failure mode. Pair it with A or B so every experiment lands in something running.

### Route D — "Member's assistant on a payer API" (payer anchor)
- **What it is:** CMS-0057-F Patient Access (CARIN Blue Button `ExplanationOfBenefit`, `Coverage`), due 2027-01-01.
  - The member logs in through Ping CIAM, the way payers actually deploy it.
  - Their AI assistant gets a pass, and consent is revocable.
  - Purpose of use goes in every receipt, per the CMS Framework.
- **Proves:** a scenario every US payer must support by 2027, in a demo built on synthetic data.
- **Risks:**
  - The confidentiality line: synthetic data and our own VM only, never a customer tenant or customer config.
  - It drifts toward consulting collateral rather than a standalone thing.

### Route E — Write it up (visibility)
- **Working titles:**
  - "SMART has no actor"
  - "Where the agent disappears: mapping RFC 8693 `act` onto FHIR Provenance and AuditEvent"
  - "What an MCP-to-FHIR guardrail gets right and what identity has to replace"
- **Cost:** cheap, and it pairs with B or C. Its value depends on having measured something first.

### 4.6 How they compose (one possible order, not a decision)
1. **B first:** 1–2 weeks, external signal, aimed at the falsifier.
2. **A in parallel:** the read-only slice, and the reference target for B's probes.
3. **C's experiments 1–2** as soon as the VM is up: they decide A's token design.
4. **E** once A+B have data.
5. **D** only if the work context makes it useful.

### 4.7 Not worth building (the kill list for this round)
- **Our own FHIR server, PHI redaction, or clinical engines.** All commodity or already done well upstream.
- **A fork of HealthClaw**, or competing with it. Contributing is cheaper and gives better signal.
- **"AI transparency" for AI-authored data.** HL7 already covers it.
- **A from-scratch SMART authorization server.** Okta has a reference implementation; the gap is *agent delegation*, not SMART itself.
- **Anything on a customer tenant**, or with real PHI.
- **The sandbox-tenant enable retry**, unless you decide to: it is a one-way tenant write.

---

## 5. Open questions for the brainstorm
1. **Who is the human in the story?** Patient, member, clinician or caregiver. This picks consumer CIAM vs workforce, `patient/` vs `user/` scopes, and whether ID-JAG/EMA (workforce) or plain exchange (consumer) applies.
2. **What does "PAIC-based" mean to you?** The real tenant (blocked: one write away from maybe working), or the VM (8.1.1, works today, with the portability contract)?
3. **What is the goal: product (A), expertise and standards (C), visibility and signal (B/E), or work relevance (D)?**
4. **HealthClaw: ally or reference?** Filing issues and probes upstream is the fastest external signal; staying independent keeps the work yours.
5. **Who is "the agent", identity-wise?** The MCP client (Claude, via `headersHelper` doing the exchange), or the gateway? If the gateway does the exchange, the gateway becomes the actor and the receipt lies. This has to be settled before Route A's first line of code.
6. **Where does the slip live?** In IDM (`alpha_aiagentprivilege`, as today), as a FHIR `Consent` (healthcare-native, patient-readable), or both with one projected from the other?
7. **Token carries SMART scopes, or gateway enforces them?** Experiment C1 decides this.

---

## 6. Sources (primary unless noted)
- HealthClaw: github.com/aks129/HealthClawGuardrails (`main` and `2b7984a`); specs `docs/specs/2026-08-16-human-gate.md`, `…-mcp-authorization.md`; ROADMAP.md
- SMART 2.2: hl7.org/fhir/smart-app-launch/STU2.2/ (scopes-and-launch-context, backend-services); org-identity branch: github.com/HL7/smart-app-launch/tree/organization-identity
- Permission Tickets: build.fhir.org/ig/jmandel/smart-permission-tickets-wip/ · proposal 008: github.com/jmandel/smart-permission-tickets-wip/…/proposal-008-delegation-statements.md
- UDAP B2B: build.fhir.org/ig/HL7/fhir-udap-security-ig/b2b.html
- AI Transparency: build.fhir.org/ig/HL7/aitransparency-ig/ · Provenance: build.fhir.org/provenance.html · BALP: profiles.ihe.net/ITI/BALP/
- Data Access Policies: build.fhir.org/ig/HL7/data-access-policies/fineGrainPatientAccess.html
- HTI-5: federalregister.gov/d/2025-23896 · CMS-0057-F fact sheet: cms.gov · CMS Interop Framework: cms.gov/initiatives/health-technology-ecosystem/overview/interoperability-framework
- Ping: docs.pingidentity.com/pingoneaic/release-notes/rapid-channel-changelog.html · …/identity-for-ai/ai-agent-identities.html · PingFederate 13.1 release notes · docs.pingidentity.com/pinggateway/2026/mcp/
- Claude Code MCP: code.claude.com/docs/en/mcp.md (`headersHelper`, OAuth, CIMD)
- Working copies (cloned specs, Federal Register text, upstream `main` files) were saved in this session's scratchpad. That folder is temporary, so copy anything worth keeping.
