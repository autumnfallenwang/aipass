# Who did this, for whom? Identity for AI agents on FHIR

*aipass v1.0, October 2026. Synthetic data only.*

An AI assistant reads a patient's lab results, or adds a blood-glucose reading to their record. Afterwards, three questions have to have clear answers:

1. **Who did it?** Which AI, not just "an app".
2. **For whom?** Which person it was acting for, and whether that person had said yes.
3. **Under what rules?** What it was allowed to see, and what it was stopped from seeing.

Healthcare already has strong building blocks:
- **SMART on FHIR** for app logins;
- **FHIR AuditEvent and Provenance** for recording who touched a record;
- **security labels** for sensitive categories.

What's missing is a way to say *"this AI, acting for this person, within this person's choices"*, and to enforce that on every request, not only at login. aipass is a small, self-hosted service that does that, in front of any FHIR server and with any login system.

## The pass

Every request an AI makes carries a **pass**, a short-lived signed token:

| Claim | Meaning |
|---|---|
| `sub` | the person the AI acts for |
| `act.sub` | the AI agent itself (RFC 8693's actor claim) |
| `aud` | that one agent's door: `/agents/{agent}/mcp` |
| `patient` | whose record |
| `exp` | 5 minutes at most |

An AI never holds the person's password or their EHR token, and a pass only opens one agent's door. Passes come from three places:
- **an OAuth login**, where the person consents and can untick anything;
- **token exchange**, where a headless agent swaps the person's token from the hospital's own login;
- **a helper script**, for local demos.

Claude Code connects with nothing but the agent's URL.

## The rules, live, on every call

The gateway decides each request again from current state:

1. **The pass is valid.** A trusted issuer, the right audience, not expired.
2. **The agent is active, and the app is approved** for this agent.
3. **The clinic's role** for this AI allows this kind of record.
4. **The person's own grant** allows it too. Effective access is *role ∩ grant*.
5. **Every returned record is in this patient's compartment**, so another patient's record can't come back.
6. **Locked labels are always withheld:** mental health, substance use, HIV, restricted. Unknown labels are refused.
7. **Changes need the person's approval.** An AI may only *propose*. The person sees exactly that change and approves it with their passkey. The commit must match it byte for byte, within two minutes, once.

Stopping an agent or revoking a grant takes effect on the next call. We measured it at under a tenth of a second.

## The receipts

Every request leaves a plain-English receipt, refusals included:

> Diabetes Coach read 3 lab results for Maria Santos.
>
> REFUSED: Diabetes Coach tried to read Maria Santos's visit notes: mental-health records are always private.

It also leaves a FHIR **AuditEvent** in the record's own audit log. Its agents are the AI (a Device) and the person (the requestor), and it carries the pass's id.

An approved write also gets a FHIR **Provenance**:
- the author is the AI;
- it acted *on behalf of* the person;
- the verifier is whoever approved;
- it carries the approval id and the hash of exactly what was approved.

The receipts are hash-chained, and *Verify chain* finds an edited or deleted one.

## Any login, any FHIR server

**Your login.** The admin connects the hospital's login system (any OpenID Connect provider). People sign in with it. A headless agent can then exchange the person's token for a pass. aipass accepts a token from a login system only when:
- an enabled connection issued it, signed with that issuer's keys;
- it is for aipass's audience;
- its email is verified and matches an existing aipass login.

There's no sign-up this way. A token that already names another actor is refused: one hop only.

**Your EHR.** An agent can read from an EHR over SMART on FHIR. Each person connects their record once (a standalone patient launch), and the gateway keeps their token in a vault:
- sealed with AES-256-GCM, bound to that person and server;
- with the patient pinned from the launch.

Every rule above still applies, record by record. The agent never sees the token, and never sees the EHR's address either.

## How we know it holds: the health check

Claims like these are easy to make, so the project ships a **health check**: `pnpm check`. It tries 16 ways past an agent→FHIR system:
- no pass, a forged pass, an expired one, one for another service;
- another patient's records, locked labels, escaping a role through `_include`;
- a stopped agent, a revoked grant;
- whether refusals are audited, and whether the audit names both parties;
- a write with no approval, approving one's own proposal, replaying an approval, swapping the payload after approval.

Two things keep the check honest:
1. **Each probe is proved by planting the matching defect in aipass** (`AIPASS_BROKEN=…`). The check must catch each one and only that one. All 16 are caught.
2. **It runs a control first.** A good pass must be able to read the person's labs. Otherwise no probe runs and the grade is F, so a system that's down or refuses everything can't look safe.

### Scorecards

The same check, run against aipass and against two open-source FHIR→MCP servers, each in its documented local mode:

| Target | Configuration tested | Grade | Passed | Failed | Missing |
|---|---|---|---|---|---|
| [aipass](check/scorecards/aipass.md) | `pnpm dev`, the white-box adapter | **A** | 16 | 0 | 0 |
| [wso2/fhir-mcp-server](check/scorecards/wso2-fhir-mcp-server.md) | `2a915a4`, `FHIR_SERVER_DISABLE_AUTHORIZATION=True` | **F** | 0 | 4 | 12 |
| [faulkj/fhirHydrant](check/scorecards/fhirhydrant.md) | `1a24376`, `FHIR_AUTH=none` | **F** | 1 | 4 | 11 |

**These cards test one configuration each, not the projects as a whole.** Both servers do what they say: they expose FHIR to an AI faithfully, and with their own authorization on, the EHR's token decides what a caller may see. What the cards show is what a FHIR→MCP bridge does *on its own*. It has no idea of a person, a role, a sensitivity label or an agent, so the identity probes get through or have nothing to test. That gap is what aipass fills, in front of a bridge like these or instead of one.

aipass gets an A in every cell of its own test matrix:
- both login paths (aipass's login and a hospital login over token exchange);
- both FHIR paths (its own server and an EHR over SMART);
- the container stack from a clean machine.

## What building it taught us

- **One OAuth client id can't tell agents apart.** Claude Code uses the same client id on every install. So the agent is named by the URL it calls, and that URL is the pass's audience.
- **Refusals should be sentences.** When the gateway says *why* ("mental-health records are always private"), the AI passes it on to the person accurately and doesn't retry. Every refusal is written to be read by a person.
- **The AI asks for more than you expect.** Asked for an A1c, Claude also asked for the patient summary. Roles need to say what each AI is for, not what it might want.
- **Test what "turned away" means.** Our own container stack first graded C: the check couldn't reach the gateway, and some probes "passed" because nothing came back. Hence the control.
- **URLs can carry secrets.** The local SMART simulator keeps its client secret in its URL, so aipass never repeats an upstream URL to an agent, in the audit trail, or in a log.

## What it doesn't do (yet)

- **Passes are bearer tokens** for up to five minutes. Sender-constrained tokens (DPoP) would close that window once agent clients support them.
- **The operator is trusted.** Whoever controls the database and keys controls aipass. Keys in a KMS, and receipts anchored outside, would narrow that.
- **The Google login and Epic's sandbox are documented but not yet run.** Both need registrations only the project owner can make.
- **The rules are plain TypeScript**, and the grant format is aipass's own. Policy engines (Cedar) and SMART Permission Tickets were considered. Neither is needed yet: the rules fit on one page and are tested line by line.

See the [threat model](security/threat-model.md) and the [ASVS Level 2 self-check](security/asvs-l2.md) for the full list.

## Try it

```sh
git clone https://github.com/autumnfallenwang/aipass.git && cd aipass
docker compose up        # under 2 minutes from a clean Docker on our test machine
```

Open http://localhost:3000. The first account is the admin. Maria's synthetic record is already there.

The [README](../README.md) has the developer setup, and [docs/](.) has the demos: an AI reading through the rules, OAuth with consent, approved changes, a headless agent on a hospital login.
