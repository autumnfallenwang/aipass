# Standalone product (IAM × AI agents × FHIR): round 2 research, plan, brainstorm

> **Historical research note**, kept as written on 2026-10-15 and lightly edited to remove private lab details. Working names here (Permission Slip, Slip Gateway…) predate the project name **aipass**. Current decisions live in [`decisions.md`](decisions.md).


| | |
|---|---|
| **Date** | 2026-10-15 |
| **Ask** | Take the IAM point of view, **drop Ping**, and build a standalone product that works in any environment. One line per product for a non-technical person. A new plan and brainstorm. |
| **Builds on** | [`02-research-round1-ping-fhir-agents.md`](02-research-round1-ping-fhir-agents.md), [`01-healthclaw-evaluation.md`](01-healthclaw-evaluation.md), the Permission Slip prototype (private lab) |
| **Research** | 4 parallel lenses (competitors and redundancy, building blocks, FHIR reach and law, buyer pain), plus my spot-checks |
| **Labels** | **[V]** primary source checked · **[S]** secondary or snippet · **[I]** my inference |

---

## 0. Plain-language one-liners

> **The whole idea:** *A permission slip for AI in healthcare. You decide what each AI may see or do with your health records. It must ask before changing anything, it leaves a receipt for everything, and you can cancel it at any time.*

| Product (working name) | What we do, for a non-technical person | What we solved |
|---|---|---|
| **Slip Gateway** (the core) | "We put a gatekeeper between AI assistants and medical records: the AI only sees what you allowed, can't change anything without your OK, and leaves a receipt every time." | Giving an AI your health data used to be all-or-nothing and invisible. Now it's specific, visible, and you can take it back instantly. |
| **Slip Pass** (the badge issuer) | "Every AI gets a visitor badge that says which AI it is, who sent it, and what it may do, and the badge expires in minutes." | AI tools used to share one master key. Now each carries its own short-lived, named pass. |
| **Slip Receipts** | "Every time an AI looks at or touches a record, one plain sentence says which AI, for whom, what, and whether it was allowed, and it's written into the medical record's own audit log." | Hospitals and patients can finally answer "which AI did this, and on whose behalf?" |
| **Slip Check** (the inspector) | "We test AI health apps like a building inspector: can the AI see the wrong patient, reuse an old approval, or approve itself? Then we publish the grade." | Nobody has to take "it's secure" on trust any more. |

⚠ **The name "Permission Slip" is taken.** Consumer Reports has used it since 2023 for a privacy-agent app, which has now "joined DeleteMe" [V]. Keep *permission slip* as the metaphor and pick a different product name (§5, Q5).

---

## 1. Can it be standalone? Yes, and the seam already exists

Permission Slip was built with Ping isolated in **one file**. `gateway/trust.py` exposes `validate · slip_scopes · permissions_for · grant · revoke`, and its README step 4 already said "replace PingBackend with our own issuer". Going standalone means writing that second backend, and changing what the gateway sits in front of: FHIR instead of toy notes.

**What "any environment" means concretely:**

| Axis | How we support "any" |
|---|---|
| **Human's identity provider** (Okta, Entra, Ping, Google, Keycloak, an EHR's SMART AS) | We are a plain **OIDC relying party** to whatever they run. We never ship an IdP. |
| **The agent** (Claude, ChatGPT, a custom MCP agent) | It is identified by a **CIMD URL** (Client ID Metadata Document, preferred by the MCP 2026-07-28 spec [V]) plus a DPoP key. It gets a pass from our token-exchange-only STS. |
| **Enterprises that already do delegation** (Ping/PingFed `act`, Entra `xms_act_fct`, ID-JAG) | Adapters: accept their delegated tokens instead of ours. **Ping becomes one adapter**, and our VM is its test bench. |
| **FHIR server** (Epic, Oracle, HAPI, Medplum, Azure/Google/AWS) | The gateway is a confidential SMART client. It holds the patient's upstream refresh token in its own vault, so the agent never sees it, and it pins the patient from the launch context. |
| **AI clients** | MCP 2026-07-28 server: PRM (RFC 9728), audience check, no token passthrough [V]. Approval uses `input_required` + URL elicitation [S]. |
| **Deployment** | `docker compose up`. Self-hosted, so **we never hold PHI**. |

---

## 2. What round 2 found

### 2.1 Redundancy verdict: **YELLOW** (consumer side ≈ RED)
- **The consumer pipe is taken.** HealthEx feeds Claude, Copilot, Meta and AskMD. Its consent is a **(data type × sensitivity) tuple**, for example "labs yes, HIV-related no" [V, docs.healthex.io]. Permission is checked per request, and patients get a retrieval log [V]. b.well feeds ChatGPT Health, Google and Perplexity.
  - None of them gives **different scopes per agent**, **receipts on the AI's side**, or **write approval** [V, by absence].
  - A third party found HealthEx's MCP grant to be a single `patient/*.read` [S].
- **Generic per-human agent gateways exist, with no FHIR awareness:**
  - Permit.io MCP Gateway: read/write/destructive tiers, revocation on next call [V].
  - Clawvisor (YC, 283★): standing tasks plus a per-call purpose check [V].
  - Auth0: CIBA plus RAR [S].
  - Scalekit is the only agent-auth vendor with SMART on FHIR in the user's context, but it has no `act`, no AuditEvent and no write approval [V].
- **Medplum and Aidbox MCP let agents create, update and delete with no approval at all** [V].
- **The slip format is being standardized:** SMART Permission Tickets (RFC 8693, `actor_token` delegation in proposal 008; a reference implementation exists) [V]. → **Implement it; don't invent a format.**
- **The open slice** is a vendor-neutral enforcement point in front of an organization's *own* FHIR or MCP endpoint and *own* IdP. It combines four things nobody ships together:
  1. Agent and human both in the token, with the live grant re-checked on every call, including sensitivity labels.
  2. **Approval bound to the hash of the exact FHIR write.**
  3. **FHIR AuditEvent and Provenance naming both agent and human**, plus a plain-English receipt.
  4. Per-agent revocation by the human.
- **It is a feature-sized gap.** Epic Agent Factory (wider availability in 2027), Okta Agent Gateway, Scalekit or HealthEx could each close it.

### 2.2 Pull: who is asking for exactly this
- **CHAI agentic best-practice guide (2026-07-29) [V, quote checked]:**
  - *"a consent-scope object propagate[s] through every tool call and handoff, and a downstream analytics agent must decline work the patient never consented to"*
  - *"Require authenticated human attestation before agent output is committed to the EHR."*

  That is our spec, written by the industry's AI-governance body.
- **CMS Interoperability Framework:** consent preferences travel with each transaction (#5), purpose of use on every query (#22), access-control and consent enforcement (#24), audit records (#25) [V]. **All voluntary.**
- **TEFCA IAS SOP:** "express documented consent… in a secured auditable log", plus revocation inside the app [V].
- **Developer signals:**
  - wso2/fhir-mcp-server **#47**, "Enforce SMART on FHIR scopes at the MCP tool layer", was closed after the maintainer suggested handling it *"at the gateway level"* [V]. That gateway is us.
  - medplum #9537: "for now we connect **as the super admin**" [V/S].

### 2.3 Counter-evidence (steelman; this is why it's YELLOW, not GREEN)
- **No buyer has shown they'll pay.**
  - Consumers' fears are about HIPAA coverage and resale, not scope granularity (KFF 2026-03: 77% concerned about AI privacy) [V].
  - Most AI health users upload records straight into general chatbots: 74% use general tools (Rock Health) [V].
- **Where the money is (business to business, treatment/payment/operations), HIPAA doesn't require patient permission**, and Epic is building agents natively.
- **No regulator is forcing it:** no OCR action specific to AI, and the HIPAA Security Rule overhaul has slipped to 07/2027 [S].
- **No documented incident would have been stopped by a permission slip** [S].
- **Developers' biggest pain is EHR app registration, not consent** [V].

### 2.4 Reach and law: what a standalone product can actually touch
- **Read access is legally broad:**
  - Certified EHRs must register any patient-chosen app within about 15 business days and may not demand a BAA [V].
  - Epic patient apps are free; **read-only** USCDI apps auto-sync to orgs with auto-download on in about 12 h [V].
  - Payers may refuse an app only for security risk [V].
- **Writes are closed on the consumer path.** (g)(10) is read-only, and Epic auto-sync requires read-only [V]. → Write approval is real only in **sandbox, patient-generated data, or a business-to-business pilot**.
- **Law depends on custody:**
  - Hosting a consumer app means the FTC Health Breach Notification Rule (an unauthorized *disclosure* counts as a breach), Washington's MHMDA, California's CMIA and IAL2.
  - Selling to a provider or payer means becoming a business associate (BAA, SOC 2/HITRUST, 6–18-month reviews).
  - **Open-source, self-hosted software means the operator carries it and we hold no PHI** [V/S].
- **Free paths to data, in order:**
  1. SMART launcher + Synthea + HAPI
  2. Epic sandbox (`fhircamila`)
  3. Blue Button 2.0 sandbox
  4. **Your own records (n=1)** via a read-only Epic patient app
- **42 CFR Part 2** (compliance date Feb 16, 2026): honor DS4P security labels, default-deny substance-use, mental-health and HIV data unless the patient explicitly allows it, and never strip labels [S].

### 2.5 Building blocks (adopt vs build)
| Need | Adopt | Why |
|---|---|---|
| Token-exchange-only STS (pass = `sub` human, `act.sub` agent, `aud` gateway, `cnf.jkt`, `slip_id`/`slip_ver`) | **node-oidc-provider** (TS; DPoP, PAR, RAR, CIBA built in; token exchange via custom grant) [V] · alt **zitadel/oidc** (Go, single binary) [V] | Keycloak 26.8 delegation is still *preview*; Ory has no RFC 8693; Dex has no actor [V] |
| Slip → rules with plain-English reasons | **Cedar** (each rule carries `@reason("…")`; `cedar-for-agents` generates schemas from MCP tools; SymCC can prove pass ⊆ slip) [V] | Every refusal comes with an explanation, which is the receipt |
| Gateway ↔ policy API | **OpenID AuthZEN 1.0** (Final, Jan 2026) [V] | Lets agentgateway or ext_authz users call our rules |
| Approvals bound to the payload | **WebAuthn L3** (W3C Rec 2026-08-25) with challenge = H(canonical FHIR write ‖ approval_id ‖ nonce), on our approval page; CIBA+RAR for enterprises [V] | No credential the agent holds can produce it, which passes HealthClaw's H1–H6 test |
| Receipts | Hash-chained table → FHIR **AuditEvent** (agent + human as parallel agents, jti in `policy`) + **Provenance**.agent{who=agent, onBehalfOf=patient} for writes | The receipt lives in the FHIR record itself |
| MCP | official MCP SDK, spec 2026-07-28 [V] | CIMD, PRM, no passthrough |
| Optional host | **agentgateway v1.6.0** (Linux Foundation; CEL over tool args; ext_authz) [V] | Distribution: "drop our policy into the gateway you already run" |

**Build ourselves** (this is the product): the exchange grant, the slip→Cedar compiler, FHIR→Cedar entities, the response filter, approval binding, the vault and receipts.

**Top hard problems:**
1. Trusting subject tokens from arbitrary IdPs.
2. Enforcing a slip across FHIR's whole query surface (`_include`, `$everything`, Bundles, paging), which needs response filtering, not only pre-checks.
3. Canonicalizing FHIR so that what was approved is exactly what executes.
4. Revocation that also covers upstream refresh tokens and in-flight tasks.
5. What "the agent" is (CIMD URL? instance key?), and multi-hop delegation.

---

## 3. Product shape (where the research points)

**An open-source, self-hostable "permission layer" for AI agents on FHIR, for developers and health-data platforms. Not a consumer app.**

```
human (any IdP) ──login──▶ slip-web ── signs a SLIP (Permission-Ticket shaped) · passkey enrolled
agent (Claude / any MCP client, identified by CIMD + DPoP)
   └─ exchanges human's login ──▶ slip-sts ── PASS (5 min): sub=human, act.sub=agent, aud=gateway, slip_ver
        │
        ▼
   slip-gateway (MCP server + FHIR proxy)
     verify pass offline · read slip LIVE · Cedar rules (+@reason) · filter responses by compartment/category/labels
     writes: propose → input_required → approval page (passkey, challenge = H(payload)) → single-use commit
     receipts: plain English + AuditEvent + Provenance(onBehalfOf)
        │  upstream SMART token from the vault (agent never sees it)
        ▼
   any FHIR server (HAPI+Synthea → Epic sandbox → your own records)
```


---

## 4. Plan (ship-first; respects our own kill rules)

Today is Thu 2026-10-15. **Kill rule:** v0.1 must be public within 4 weeks (by **2026-11-12**), and two weeks of research with no commits means stop. **Falsifier:** by **2026-12-31** some deployment must have changed something because of this work.

| Phase | Dates | Build | Done when |
|---|---|---|---|
| **0. Decide** | Oct 16–18 | Name placeholder, language, first user, licence (§5) | 4 answers written down |
| **1. Read path, any IdP** | Oct 19 – Nov 1 | HAPI + Synthea; `slip-sts` (exchange only); `slip-gateway` as MCP server (PRM, live slip, Cedar + `@reason`, label filtering); receipts as AuditEvent; Claude via `headersHelper` | A real Claude reads labs, is **refused a mental-health note with a plain-English reason**, and is cut off on its next call after revoke. **Same demo works with 2 different IdPs** (e.g. Keycloak + Google/Entra), which proves "any environment" |
| **2. Slip Check v0.1** | Oct 27 – Nov 12 | 6–8 identity probes: wrong patient, replay, agent mints its own token, agent self-approves, spoofed agent, refusal audited, revocation latency, chain present in AuditEvent | Scorecard for our gateway, **HealthClaw `main`**, **WSO2 fhir-mcp-server**, **Medplum MCP**; repo public; HealthClaw replay issue filed |
| **3. Write approval** | Nov 13–30 | propose → `input_required` → passkey approval over H(payload) → single-use commit; Provenance.onBehalfOf | An agent cannot write without the human's passkey, and an edited payload is refused after approval |
| **4. Real-world interop** | Dec 1–20 | Epic sandbox standalone launch + vault; **Permission Tickets** redemption; **Ping adapter** on our VM; optionally your own records (n=1) | Same gateway, 3 FHIR sources, 3 IdP families |
| **5. Signal** | Nov → Dec 31 | Write-up ("SMART has no actor"); 5 conversations: HealthClaw maintainer · Permission Tickets/Argonaut · a consent network (HealthEx/Flexpa) · a write-capable agent startup | At least 1 upstream fix or 1 design partner by Dec 31 |

**Pivot and stop rules:**
- **Not public by Nov 12:** cut to Phase 1 only and ship.
- **HealthEx, Scalekit or Okta ship per-agent `act` plus payload-bound FHIR write approval:** drop the gateway and keep **Slip Check** (verification ages better than features).
- **Zero design-partner interest after 5 conversations:** keep it as open-source reference and portfolio, and stop the product framing.
- **Never:** a hosted consumer app, holding PHI, or touching customer tenants.

---

## 5. Brainstorm questions

1. **First user.**
   - (a) Developers building health AI agents: open-source gateway plus SDK.
   - (b) Consent networks and health-data platforms: an embeddable component.
   - (c) Health systems and payers: an in-house pilot.
   - (d) Patients.

   *Research points to a + b; c later; not d.*
2. **Lead with read or with write?** Write approval is the most unclaimed slice but is real only in business-to-business settings. Read is easy to reach but more crowded.
3. **Adopt SMART Permission Tickets as the slip format from day one?** *Recommended: yes.*
4. **Language and runtime.**
   - TypeScript: node-oidc-provider + the MCP TS SDK + `jose`. *My lean for v0.1.*
   - Go: a single binary (zitadel/oidc + cedar-go + go-webauthn), better for "docker run anywhere".
5. **Name.** "Permission Slip" is taken. Directions: a badge or pass metaphor, a receipt or countersign metaphor, or a health-specific coinage. *Avoid the overused "X for agents", "valet key" and "guardrails".*
6. **Licence and posture.** Fully open source (Apache-2.0) to earn trust and standards credibility, or open core (paid hosted approvals and receipts later)?

---

## 6. Sources (key ones; full lists in the agent notes)
- CHAI agentic guide: chai.org/blog/coalition-for-health-ai-chai-releases-new-agentic-best-practice-guide-and-testing
- HealthEx consent scopes: docs.healthex.io/key-concepts · Claude healthcare: anthropic.com/news/healthcare-life-sciences
- SMART Permission Tickets: build.fhir.org/ig/jmandel/smart-permission-tickets-wip/ · reference implementation github.com/jmandel/smart-permission-tickets-ri
- Clawvisor: github.com/clawvisor/clawvisor · Permit.io MCP gateway: docs.permit.io/permit-mcp-gateway · Scalekit: scalekit.com/blog/oauth-delegated-authorization-healthcare-agents
- Medplum on-behalf-of: medplum.com/docs/auth/on-behalf-of · WSO2 #47: github.com/wso2/fhir-mcp-server/issues/47
- MCP spec 2026-07-28: github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification/2026-07-28
- agentgateway v1.6.0: github.com/agentgateway/agentgateway · Cedar: github.com/cedar-policy · AuthZEN 1.0: openid.net · WebAuthn L3: w3.org/TR/webauthn-3
- 45 CFR 170.404; 42 CFR 422.119; 16 CFR 318 (FTC HBNR); RCW 19.373 (WA MHMDA); 42 CFR 2.32; HTI-5 (FR 2025-23896)
- Epic patient-facing apps: fhir.epic.com/Documentation?docId=patientfacingfhirapps · TEFCA IAS SOPs: rce.sequoiaproject.org
- KFF AI health poll 2026-03-25 · Rock Health 2026-03-23 · Consumer Reports Permission Slip (name collision): joindeleteme.com/permission-slip/
