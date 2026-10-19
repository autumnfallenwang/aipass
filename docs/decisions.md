# Decisions

This page records **what has actually been decided**. Recommendations from the research belong under *Proposed* until someone decides them. Add new entries at the top.

## Decided

| # | Date | Decision | Why |
|---|---|---|---|
| D5 | 2026-10-19 | **Working pitch:** *"Let AI help with your health records, on your terms: it sees only what you allow, asks before it changes anything, and you can stop it anytime."* | It's plain words a non-technical person can repeat. See [`00-the-idea-in-plain-words.md`](00-the-idea-in-plain-words.md) |
| D4 | 2026-10-19 | **Name: `aipass`**, as a **public** GitHub repo | The name has to contain both "AI" and "pass" |
| D3 | 2026-10-15 | **Standalone and vendor-neutral.** No dependency on Ping or any single vendor. It works with any login system (identity provider) and any FHIR server; vendors such as Ping become optional adapters | The value is the IAM principle itself (named delegation, least privilege, live checks, receipts, revocation), not one vendor's implementation |
| D2 | 2026-10-15 | **Take ideas, not code, from HealthClaw Guardrails** | It is a strong reference design for health-data guardrails, but weak on identity. See [`01-healthclaw-evaluation.md`](01-healthclaw-evaluation.md) |
| D1 | 2026-10-15 | **Scope: IAM × AI agents × FHIR** | It's where our agent-delegation research meets a domain with real stakes: health records |

## Proposed (from research, not yet decided)

| # | Proposal | Source |
|---|---|---|
| P1 | Ship as **open-source, self-hosted** software for developers and health-data platforms, **not** as a hosted consumer app. Never hold patient data | [round 2](03-research-round2-standalone-plan.md) §2.4, §3 |
| P2 | Use **SMART Permission Tickets** as the permission format rather than inventing one | round 2 §2.1 |
| P3 | **Read path first.** Real write approval is only possible in sandboxes or business-to-business pilots | round 2 §2.4 |
| P4 | Identity checks (wrong patient, replay, self-approval, …) ship as a public **test suite** alongside the gateway | round 1 Route B; round 2 Phase 2 |
| P5 | Building blocks: a token-exchange-only issuer (node-oidc-provider or zitadel/oidc), Cedar for the rules, passkeys (WebAuthn) for approvals, MCP spec 2026-07-28 | round 2 §2.5 |
| P6 | Dates: v0.1 public by **2026-11-12**; at least one external fix or design partner by **2026-12-31** | round 2 §4 |

## Open questions

1. **First user.** Developers building health AI agents, health-data platforms, health systems or payers, or patients?
2. **Read or write first?**
3. **Language.** TypeScript (richest MCP and OIDC libraries) or Go (single binary)?
4. **Licence.** Fully open source (e.g. Apache-2.0) or open core? *Until this is decided the repo has no licence, so all rights are reserved by default.*

## Never

- Real patient data in this repo or its demos. Use synthetic data only (Synthea, public sandboxes).
- Any customer system, tenant, or configuration.
