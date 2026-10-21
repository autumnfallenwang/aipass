# Threat model

This page says:
- what aipass protects;
- who might attack it;
- what stops them, and which test proves it;
- what is still open.

It covers v0.5, the public demonstration. It was written by the project, not by an independent reviewer. The self-check against OWASP ASVS Level 2 is in [asvs-l2.md](asvs-l2.md).

## The system in one picture

```
 person / admin (browser) ──TLS*──► web (Next.js) ──/api/*──► api (Better Auth, admin API) ──► Postgres
                                                                   │  ▲
                                         connected logins (OIDC) ◄─┘  └── passes are signed here
 AI agent (MCP client) ──pass──► gateway ──► rules: agent active · app approved · role ∩ grant
                                    │            · patient pinned · locked labels · approval
                                    ├──► aipass's FHIR server (records, Devices, AuditEvents)
                                    └──(vault token)──► an EHR over SMART on FHIR
```

\* TLS is the adopter's: aipass is developed and tested on localhost only (D12).

### Trust boundaries

| # | Boundary | Who is on the other side | What crosses |
|---|---|---|---|
| B1 | browser ↔ web | people, admins, anyone on the internet | session cookies, passkey ceremonies, OAuth consent |
| B2 | AI client ↔ gateway | any AI agent, possibly prompt-injected or hostile | a pass (bearer JWT) and MCP tool calls |
| B3 | api ↔ connected logins | the hospital's identity provider, Google | discovery, JWKS, ID and access tokens |
| B4 | gateway ↔ FHIR servers | aipass's own FHIR server; EHRs | searches, reads, approved writes, AuditEvents |
| B5 | apps ↔ Postgres | the operator's infrastructure | everything: keys, sessions, grants, receipts, the vault |

## What we protect

| Asset | Why it matters |
|---|---|
| Health records | The point of everything. Above all the locked categories: mental health, substance use (42 CFR Part 2), HIV, and the restricted confidentiality codes |
| People's choices | Their grant, what they unticked, and their approvals |
| Pass-signing keys (`pass_keys`, Better Auth JWKS) | Whoever holds them can mint passes for any person and agent |
| People's EHR tokens (the vault) | They open a person's record at the EHR, outside aipass's rules |
| `BETTER_AUTH_SECRET`, `AIPASS_VAULT_KEY` | Sessions and cookies; the vault |
| Receipts and AuditEvents | The answer to "who did this, for whom?" |
| Admin accounts | They define roles, agents, connections and servers |

## Who might attack

| Actor | Can do | Trusted for |
|---|---|---|
| **A hostile or prompt-injected AI agent** | call any tool, with any arguments, as often as it likes; keep and replay what it was given | nothing; that is the design |
| **A malicious AI app** (an OAuth client) | register itself (DCR/CIMD), start logins, ask for any agent's resource | nothing until the admin approves it for an agent |
| **Another person** (e.g. John) | sign in with their own login; open links meant for Maria | their own record |
| **Someone on the network** | send requests to the web app and the gateway | nothing |
| **A connected login system** | sign tokens for its users | the people it vouches for, by verified email, while enabled (D13) |
| **An EHR** | return whatever it likes | the records of the patient pinned at launch, filtered like any other |
| **An admin** | configure everything; preview what a role sees | the clinic's configuration, and seeing charts through *Preview*, like an EHR administrator |
| **The operator's infrastructure** (database, host) | everything | everything: see residual risks |

## Threats and what stops them

Each row names the control and the test that proves it. "Probe" means the health check (`pnpm check`, [docs/check](../check/README.md)): 16 probes, each also proved by planting the matching defect and seeing it caught.

### The agent goes beyond what it was given (B2)

| Threat | Control | Proof |
|---|---|---|
| Reads another patient's record | The patient is pinned from the person behind the pass (or the SMART launch); every returned resource must be in that patient's compartment | probe `wrong_patient`; planted `compartment`; `s6-upstream`: John's note via Maria's EHR token is refused |
| Acting for a clinician, reads a patient who isn't in their care, or the previous patient after a switch (S10) | The pass names the patient the clinician has open, chosen from their care team. On every call the gateway checks, live, that this patient is still in an active CareTeam with them at the record server and is the one they have open now; every returned record must belong to that patient. A refusal doesn't name a patient who isn't theirs | `s10-staff.int.test.ts` (not in care, left the care team, switched patient, another patient's note); `staff.spec.ts` |
| Reads a group its role or the person's grant doesn't allow | role ∩ grant, checked live on every call (rules 3–4) | probes `role_escape`, `revoked_grant`; planted `role`, `grant` |
| Pulls extra records in through `_include`, or a server sends more than was asked for | Only safe search parameters reach the server; unknown arguments are refused (strict schemas); every returned resource is filtered again | probe `include_escape`; `s1-filter.int.test.ts` (a "compromised upstream" smuggling records) |
| Reaches a locked category (mental health, SUD, HIV, …) | Locked labels are always withheld, unknown labels are refused, and withheld records are counted but never shown | probe `locked_label_leak`; planted `labels` |
| Writes without the person's OK | Writes are only *proposals*. The person approves the exact change with a passkey, with user verification. Commit requires the same hash, within 2 minutes, once, for the same agent and person | probes `unapproved_write`, `payload_swap`, `approval_replay`; S5 tests A1–A8 |
| Approves its own proposal | Approval endpoints need the person's browser session *and* their passkey; a pass is not a session | probe `self_approve`; A1, A6 |
| Keeps working after being stopped or revoked | The agent's status and the grant are read live on each call; revoking also revokes the person's refresh tokens for that agent | probes `stopped_agent`, `revoked_grant`; measured < 0.1 s |
| Edits a paging token to see more | Paging tokens are sealed (AES-256-GCM) and bound to agent, patient and group | `paging.test.ts` |
| Floods: one agent hammering the gateway, or a stream of bad passes filling the audit trail | Per agent and person: 300 calls a minute. Per client address, for refused passes: 60, then `429` with `Retry-After` and nothing written | `s7-limits.int.test.ts`, `limits.test.ts` |
| Prompt injection tells the agent to ask for more | The gateway trusts nothing the agent says: the patient, the rules and the person come from the pass and the database. Injection can only misuse what the agent is already allowed | by construction; every probe above |

### Passes (B2)

| Threat | Control | Proof |
|---|---|---|
| No pass, a forged pass, or a pass from an untrusted issuer | The signature is checked against trusted issuers' keys only. Algorithms are on an allow-list (ES256, RS256, EdDSA, PS256), so `none` and HMAC are out | probes `no_pass`, `forged_pass`; planted `require_pass`, `signature` |
| A pass that expired, or that is for another agent or service | 10 s clock tolerance. The audience is that one agent's gateway URL (D9), so a pass for the Scheduling Assistant doesn't open the Coach | probes `expired_pass`, `wrong_audience`; planted `expiry`, `audience` |
| A stolen pass is replayed | Passes live at most 5 minutes and work for one agent and one person. Token-exchange passes have no refresh token; OAuth refresh tokens can be revoked by the person | **residual**: passes are bearer tokens (no DPoP), so a stolen pass works for up to 5 minutes |
| A shared client (Claude Code's one client id) is used to act as an agent the admin never allowed | `agent_clients`: approved app × agent, enforced at the authorization server and again live at the gateway (D11) | e2e "an app the admin hasn't approved"; rule 2 |

### People's logins and choices (B1, B3)

| Threat | Control | Proof |
|---|---|---|
| Account takeover by guessing passwords | Better Auth's rate limiter (on in production), keyed by the client's address: behind a proxy, only the proxies in `AIPASS_TRUSTED_PROXIES` may say what it is, and the Helm ingress sends `/api` straight to the api so that address arrives. Passwords of 10+ characters; passkeys | delegated; see [asvs-l2.md](asvs-l2.md) for what's still missing (MFA for admins, breached-password checks) |
| A cross-site request uses someone's session | One origin (D10); SameSite cookies; Better Auth's origin check on its routes; aipass's own admin and person APIs refuse any state change whose `Origin` or `Sec-Fetch-Site` says another site | `security.int.test.ts` |
| Someone else approves Maria's change, or reads it | The approver must be the named person, signed in, with their own passkey. Anyone but the person and the approver gets 403 and learns only who may approve | A6; `security.int.test.ts` |
| A crafted sign-in link sends someone off-site afterwards | `next` is followed only when it is a path on aipass's own origin | `next-path.test.ts` |
| A person registers a login provider of their own | Managing SSO providers is admin-only; and a provider with no enabled connection signs nobody in | `security.int.test.ts`; `exchange.int.test.ts` |
| A token from a login system nobody trusted | Only enabled connections. Their discovered keys, the audience, a verified email, an existing login; no sign-up; one hop (`act`, `may_act`, `cnf` refused) (D13) | `exchange.int.test.ts` (15 tests); e2e sign-in refusals |
| A disabled connection still signs people in | The resolver refuses on every callback, and an internal host's origin stops being trusted | `exchange.int.test.ts`; e2e "disabling the connection stops a sign-in already under way" |
| A malicious OAuth app tricks the person | The consent page names the agent, the person and every group, and the person can untick any. Unknown apps need the admin's approval first | S3 e2e |

### EHRs and the vault (B4)

| Threat | Control | Proof |
|---|---|---|
| The agent gets hold of a person's EHR token | Tokens are never in tool results, headers, receipts, AuditEvents or logs. Records are named by server id, not URL | `s6-upstream`: leak probe over all of these |
| A vault row is copied to another person | AES-256-GCM with the person and server as associated data: it won't open | `s6-upstream`, `vault.test.ts` |
| The vault key leaks or must change | Production refuses a missing, short or public local-trial key. Rotation: previous keys open, the current key seals, `pnpm vault:rotate` | `vault.test.ts`, `vault-rotate.int.test.ts` |
| A refresh moves the pinned patient | A refreshed token naming another patient is rejected | `upstream.ts` |
| Someone finishes or replays another person's SMART launch | `state` is single use, expires after 10 minutes, and must belong to the signed-in person; PKCE | `smart.int.test.ts` |
| The EHR is down or refuses | Fail closed: refused, never answered from somewhere else | `s6-upstream` |

### Records of what happened (B4, B5)

| Threat | Control | Proof |
|---|---|---|
| A request leaves no trace | A receipt for every request, refusals included, plus a FHIR AuditEvent naming both the AI (Device) and the person. If the AuditEvent can't be written, a read is refused | probes `refusal_audited`, `receipt_names_both`; planted `audit_refusals`, `audit_person` |
| Receipts are edited or removed | Receipts are hash-chained (sha256, written under an advisory lock); *Verify chain* in the admin UI | `s1-guard.int.test.ts` (chain verification, and an edited receipt is caught) |
| **residual** | Someone with write access to the database can rewrite the chain from any point. Nothing anchors it outside (e.g. a timestamping service) | |

### Running it (B5, supply chain)

| Threat | Control | Proof |
|---|---|---|
| Deployed with default secrets | The compose file's secrets are public "local trial" values, refused unless the public origin is localhost; production requires real ones | `vault.test.ts`; `config.ts` |
| A vulnerable dependency ships | CI fails on any advisory in shipped dependencies (`pnpm audit --prod`); Dependabot weekly; frozen lockfile | `ci.yml` |
| A tampered image | Release images carry an SBOM, SLSA provenance and a Sigstore-signed GitHub attestation; base images pinned by version | `release.yml`; `gh attestation verify` |
| A container is broken into | Runs as `node` (uid 1000). The Helm chart sets a read-only root filesystem, drops all capabilities, adds no service-account token, and no privilege escalation | Helm CI; read-only run of all three images |
| The admin points aipass at an internal URL (SSRF) | Only admins can add connections and FHIR servers, and internal hosts are allowed on purpose (on-premises logins). The one fetch anyone can trigger, an OAuth app's metadata document, is HTTPS-only, public addresses only, address-pinned and never redirected | **residual**: an admin can make the api fetch internal URLs |

## Residual risks we accept (and what would change them)

1. **The operator is trusted.** Whoever controls the database and the environment controls aipass. They could mint passes with the signing keys, open the vault with the key, or rewrite receipts. *Change:* keys in a KMS/HSM; receipts anchored externally.
2. **Passes are bearer tokens for up to 5 minutes.** *Change:* sender-constrained passes (DPoP) once agent clients support them.
3. **Admins can see charts through *Preview*, and can configure any connection or server.** That is the job, as with an EHR administrator. *Change:* separate "configure" and "preview" roles; previews recorded like agent calls (today they write a preview receipt).
4. **An allowed agent can still misuse what it was allowed.** aipass bounds an agent; it doesn't make it wise. The person sees every receipt on *My AIs* and can revoke at any time.
5. **Rate limits are per process.** The gateway limits each agent acting for each person (300 calls a minute by default). It also limits refused passes per client address (60), before they reach the audit trail. The counters live in memory, so several gateway replicas each count on their own. *Change:* a shared limit at the ingress, or a shared store.
6. **TLS, backups, host hardening and the FHIR servers' own security are the adopter's** (D12).

## Out of scope

- The AI model's behaviour, and the correctness of what it says to the person.
- Legal compliance (HIPAA, GDPR, 42 CFR Part 2): aipass supports these with labels, consent and audit, but makes no compliance claim.
- Real patient data: the project only ever uses synthetic data.
