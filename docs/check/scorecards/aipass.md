# Scorecard: aipass gateway

**Scope:** this repository's gateway at the S4 commit, run with `pnpm dev` (Postgres, HAPI FHIR, the synthetic fixtures). The check uses the white-box adapter: it signs passes with the api's own key, registers two temporary probe agents, and stops and revokes them in the database.

**Grade: A**: 16 passed, 0 failed, 0 missing.

| | |
|---|---|
| Target | aipass gateway |
| Version | v0.2.0-2-g39808b8-dirty |
| Date | 2026-10-20T03:21:42.795Z |
| Rerun | `pnpm check` |

| Probe | What it tries | Result | Detail |
|---|---|---|---|
| `no_pass` | call with no credential at all | ✅ pass | turned away: unauthorized |
| `forged_pass` | a pass signed by a key the target never trusted | ✅ pass | turned away: unauthorized |
| `expired_pass` | a pass that expired ten minutes ago | ✅ pass | turned away: unauthorized |
| `wrong_audience` | a pass issued for a different service | ✅ pass | turned away: unauthorized |
| `wrong_patient` | read John's records while acting for Maria | ✅ pass | nothing of John's came back |
| `locked_label_leak` | read Maria's mental-health and substance-use records | ✅ pass | no PSY / ETH / 42CFRPart2 record came back |
| `role_escape` | with a labs-only agent, read conditions, notes, medications and demographics | ✅ pass | nothing outside labs came back |
| `include_escape` | pull the Patient record into a labs search with `_include` | ✅ pass | no demographics (refused) |
| `stopped_agent` | keep working after the admin stops the agent | ✅ pass | turned away (refused) |
| `revoked_grant` | keep working after the person revokes | ✅ pass | turned away (refused) |
| `refusal_audited` | check that a refused request leaves an audit record | ✅ pass | audited: REFUSED: Health check (all groups) tried to read Maria Santos's visit notes: mental-health records are always private. |
| `receipt_names_both` | check that an allowed request's audit record names both the AI and the person | ✅ pass | names the AI (Device) and Maria (requestor) |
| `unapproved_write` | write a reading into Maria's record without anyone approving it | ✅ pass | turned away (refused) |
| `self_approve` | the agent approves its own proposed change with its own credential | ✅ pass | the approval endpoint refused the agent (401); commit refused |
| `approval_replay` | use one approval twice | ✅ pass | second use refused (refused) |
| `payload_swap` | change the value after it was approved (133 → 313) | ✅ pass | refused (refused) |

**How the grade works.** Each probe either passes, fails (it got through), or is *missing* (the target has no such control at all).
- Probes that can leak data are wrong_patient, locked_label_leak, role_escape, include_escape and no_pass. Two such failures mean **F**; one means **D** at best.
- Otherwise the grade follows the share of probes passed: 100% is **A**, 85% or more **B**, 65% or more **C**, 40% or more **D**, and below that **F**.
- *Missing* counts against the grade like a failure, but is reported separately: it means "this system doesn't try", not "this system tried and failed".

The probes run on synthetic data only (aipass `fixtures/`).

**Self-test.** `packages/check/test/planted.int.test.ts` starts the gateway 13 times: once correct, and once with each defect from `apps/gateway/src/broken.ts`. Each of the 16 planted defects is caught by its own probe; the correct gateway passes all 16. See [the check README](../README.md#proving-the-inspector).
