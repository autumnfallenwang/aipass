# Scorecard: faulkj/fhirHydrant

**Scope.** This tests one configuration, not the project as a whole:
- **Version:** commit `1a24376`, 2026-09-14.
- **Mode:** the documented unauthenticated mode, `FHIR_AUTH=none`, Streamable HTTP, with `FHIR_AUDIT_SINK=file` so its audit could be checked.
- **Data:** the aipass synthetic fixtures in HAPI FHIR v8.12.0-2.

What this configuration means:
- The project's production auth is SMART Backend Services. That is a *system-level* token: the server reads on its own behalf, not for one person.
- Its optional `MCP_AUTHZ=entra` gates tools per caller. That mode needs a Microsoft Entra tenant and wasn't tested.

**What the result means.**
- fhirHydrant is careful about FHIR itself: it checks the server's capabilities, can gate operations, and writes audit events that stay light on personal health information.
- It has no notion of a person, a role or a sensitivity label, so the identity probes get through.
- Its audit events record each tool call but not who made it or for whom. That's why `receipt_names_both` fails rather than being missing.

**Grade: F**: 0 passed, 4 failed, 8 missing.

| | |
|---|---|
| Target | faulkj/fhirHydrant |
| Version | faulkj/fhirHydrant@1a24376, FHIR_AUTH=none, FHIR_AUDIT_SINK=file |
| Date | 2026-10-20T02:56:39.866Z |
| Rerun | `pnpm check --target fhirhydrant --url http://127.0.0.1:8102/mcp --audit-file ./audit.jsonl` |

| Probe | What it tries | Result | Detail |
|---|---|---|---|
| `no_pass` | call with no credential at all | ❌ fail | anyone can read Maria's labs (maria-a1c-, 6.9) |
| `forged_pass` | a pass signed by a key the target never trusted | ⬜ missing | the target checks no credentials (see no_pass) |
| `expired_pass` | a pass that expired ten minutes ago | ⬜ missing | the target checks no credentials (see no_pass) |
| `wrong_audience` | a pass issued for a different service | ⬜ missing | the target checks no credentials (see no_pass) |
| `wrong_patient` | read John's records while acting for Maria | ❌ fail | John's data came back (john-note-1, Annual physical, john-a1c-1, 9.4) |
| `locked_label_leak` | read Maria's mental-health and substance-use records | ❌ fail | labelled records came back (maria-note-therapy, Therapy session, maria-cond-depression, maria-cond-alcohol, Alcohol use disorder, Depression, maria-med-sertraline, Sertraline, maria-appt-therapy) |
| `role_escape` | with a labs-only agent, read conditions, notes, medications and demographics | ⬜ missing | the target can't limit an agent to part of the record |
| `include_escape` | pull the Patient record into a labs search with `_include` | ⬜ missing | the target can't limit an agent to part of the record, so there is no view to escape |
| `stopped_agent` | keep working after the admin stops the agent | ⬜ missing | there is no way to stop one agent |
| `revoked_grant` | keep working after the person revokes | ⬜ missing | the person has no permission to revoke |
| `refusal_audited` | check that a refused request leaves an audit record | ⬜ missing | the target refused nothing here (see locked_label_leak), so there was no refusal to audit |
| `receipt_names_both` | check that an allowed request's audit record names both the AI and the person | ❌ fail | audit names only: nobody |
| `self_approve` | the agent approves its own change | — | arrives with approved changes (S5) |
| `approval_replay` | use one approval twice | — | arrives with approved changes (S5) |
| `payload_swap` | change the payload after it was approved | — | arrives with approved changes (S5) |

**How the grade works.** Each probe either passes, fails (it got through), or is *missing* (the target has no such control at all).
- Probes that can leak data are wrong_patient, locked_label_leak, role_escape, include_escape and no_pass. Two such failures mean **F**; one means **D** at best.
- Otherwise the grade follows the share of probes passed: 100% is **A**, 85% or more **B**, 65% or more **C**, 40% or more **D**, and below that **F**.
- *Missing* counts against the grade like a failure, but is reported separately: it means "this system doesn't try", not "this system tried and failed".

The probes run on synthetic data only (aipass `fixtures/`).

**To reproduce:**

```sh
git clone https://github.com/faulkj/fhirHydrant && cd fhirHydrant && git checkout 1a24376
npm ci && npm run build
FHIR_AUTH=none FHIR_SERVER_URL=http://127.0.0.1:8080/fhir PORT=8102 BIND_HOST=127.0.0.1 MCP_TRANSPORT=http \
  FHIR_AUDIT_SINK=file FHIR_AUDIT_FILE=$PWD/audit.jsonl node bin/server.js
# in aipass, with `pnpm services:up && pnpm fixtures:load` done:
pnpm check --target fhirhydrant --url http://127.0.0.1:8102/mcp --audit-file <that audit.jsonl>
```
