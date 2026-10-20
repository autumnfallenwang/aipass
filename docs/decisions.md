# Decisions

This page records **what has actually been decided**. Recommendations from the research belong under *Proposed* until someone decides them. Add new entries at the top.

## Decided

| # | Date | Decision | Why |
|---|---|---|---|
| D12 | 2026-10-19 | **Develop and test on localhost only.** aipass isn't deployed to the owner's own servers (no home k3s). Where it runs on the internet is the adopter's choice, so the project ships the pieces: Docker images and a compose file (S7), and optionally a Helm chart, but runs no deployment of its own | aipass is meant to be self-hosted by whoever adopts it, on the internet, not run as one of the owner's home services. Local runs are enough to build and validate every stage. Running a public instance would mean holding real health data, which this project never does |
| D11 | 2026-10-19 | **The admin decides which AI apps may act as which agent**, in aipass's own list (`agent_clients`). It is enforced twice: at the authorization server (Better Auth's per-client resource links, written when the client first appears) and live at the gateway (rule 2) | A shared client like Claude Code may act as several agents, and a newly registered app may act as none until approved. Keeping the list in aipass lets the admin approve an app before it has ever connected |
| D10 | 2026-10-19 | **One public origin.** People's browsers only talk to the web app, which passes `/api/*` through to the api. Better Auth's base URL, passkey relying party and (S3) OAuth issuer are all that origin | Cookies and passkeys are bound to an origin. One origin means no cross-site cookies, no CORS, and an issuer URL people can see in their address bar |
| D9 | 2026-10-19 | **One gateway URL per agent:** `/agents/{agent-id}/mcp`. That URL is the pass's audience and the OAuth `resource` (RFC 8707) | Claude Code uses one shared OAuth client id for every install (SP1), so the client id alone can't say *which* agent is calling. A per-agent audience also stops a pass for one agent being used at another |
| D8 | 2026-10-19 | **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`), protocol **2026-07-28**, with 2025-11-25 served as a stateless fallback | SP2: v2 is the stable line, implements 2026-07-28, and real Claude Code negotiates it. One server factory serves both protocol versions |
| D7 | 2026-10-19 | **Simple docs only.** One [`PLAN.md`](PLAN.md) is both the plan and the progress tracker; decisions stay here. No skill, task or milestone system | Fewer files means plan and tracker can't drift apart |
| D6 | 2026-10-19 | **Admin UI first.** Two layers: the **role** is the admin's ceiling; the **grant** is the person's "yes" inside it. Effective permission = role ∩ grant, checked live. **"Preview as this role"** (each AI sees its own version of the chart) is the centrepiece | The first user is a clinic or health-app admin. The per-person layer is what makes an agent act *for someone*, not just with a role |
| D5 | 2026-10-19 | **Stack:** Turborepo + pnpm, TypeScript, Hono + Zod, Next.js, Postgres + Drizzle, Better Auth 1.7, Vitest + Biome, the MCP TypeScript SDK (v2, see D8), `jose`. **No paid identity product in the core** | Free, open-source building blocks. Better Auth covers login, passkeys, SSO and the OAuth provider; we write the pass, the rules, the guard and the receipts |
| D4 | 2026-10-19 | **Working pitch:** *"Let AI help with your health records, on your terms: it sees only what you allow, asks before it changes anything, and you can stop it anytime."* | It's plain words a non-technical person can repeat |
| D3 | 2026-10-19 | **Name: `aipass`**, as a **public** GitHub repo | The name has to contain both "AI" and "pass" |
| D2 | 2026-10-15 | **Standalone and vendor-neutral.** Works with any login system (identity provider) and any FHIR server, and depends on no single vendor | The value is the IAM principle itself (named delegation, least privilege, live checks, receipts, revocation), not one vendor's implementation |
| D1 | 2026-10-15 | **Scope: IAM × AI agents × FHIR** | Agent delegation matters most where the data is most sensitive: health records |

## Proposed (from research, not yet decided)

| # | Proposal | Source |
|---|---|---|
| P1 | Ship as **open-source, self-hosted** software for developers and health-data platforms, **not** as a hosted consumer app. Never hold patient data | research |
| P2 | Use **SMART Permission Tickets** as the permission format rather than inventing one | research |
| P3 | Identity checks (wrong patient, replay, self-approval, …) ship as a public **test suite** alongside the gateway | PLAN S4 |
| P4 | Dates: v0.1 public by **2026-11-12**; at least one external fix or design partner by **2026-12-31** | PLAN §6 |

## Open questions

1. ~~First user~~ → the admin of a clinic or health app (D6).
2. ~~Read or write first~~ → read first; writes in PLAN S5.
3. ~~Language~~ → TypeScript (D5).
4. **Licence.** Fully open source (e.g. Apache-2.0) or open core? *Until this is decided the repo has no licence, so all rights are reserved by default.*

## Never

- Real patient data in this repo or its demos. Use synthetic data only (Synthea, public sandboxes).
- Any customer system, tenant, or configuration.
