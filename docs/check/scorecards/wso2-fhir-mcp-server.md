# Scorecard: wso2/fhir-mcp-server

**Scope.** This tests one configuration, not the project as a whole:
- **Version:** commit `2a915a4` (v0.10.0), 2026-10-12.
- **Mode:** the documented local mode, `FHIR_SERVER_DISABLE_AUTHORIZATION=True`, Streamable HTTP.
- **Data:** the aipass synthetic fixtures in HAPI FHIR v8.12.0-2.

What this configuration means:
- The project's own authorization is OAuth against the FHIR server (SMART). In that mode, which patients and records a caller may see is decided by the EHR's token, not by the bridge. That mode wasn't tested here.
- So this card shows what a FHIR→MCP bridge does *on its own*. It isn't a judgement of the project's OAuth mode.

**What the result means.** The bridge does what it says: it exposes FHIR to an AI faithfully, through generic `search` and `read` tools. It has no notion of a person, a role, a sensitivity label or an agent, so every identity probe gets through or has nothing to test. That is the gap aipass is built to fill, in front of a bridge like this or instead of one.

**Grade: F**: 0 passed, 3 failed, 9 missing.

| | |
|---|---|
| Target | wso2/fhir-mcp-server |
| Version | wso2/fhir-mcp-server@2a915a4 (v0.10.0), FHIR_SERVER_DISABLE_AUTHORIZATION=True |
| Date | 2026-10-20T02:56:37.923Z |
| Rerun | `pnpm check --target wso2 --url http://127.0.0.1:8101/mcp` |

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
| `refusal_audited` | check that a refused request leaves an audit record | ⬜ missing | the target writes no audit record we can read |
| `receipt_names_both` | check that an allowed request's audit record names both the AI and the person | ⬜ missing | the target writes no audit record we can read |
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
git clone https://github.com/wso2/fhir-mcp-server && cd fhir-mcp-server && git checkout 2a915a4
uv sync
FHIR_SERVER_BASE_URL=http://127.0.0.1:8080/fhir FHIR_SERVER_DISABLE_AUTHORIZATION=True \
  FHIR_MCP_HOST=127.0.0.1 FHIR_MCP_PORT=8101 .venv/bin/fhir-mcp-server --transport streamable-http
# in aipass, with `pnpm services:up && pnpm fixtures:load` done:
pnpm check --target wso2 --url http://127.0.0.1:8101/mcp
```
