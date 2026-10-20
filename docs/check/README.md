# The aipass health check

A test suite you can point at **any** system that lets an AI agent reach FHIR records. It tries the things a careless or hostile agent would try, then gives a grade from A to F.

```sh
pnpm check                                    # this install's own gateway
pnpm check --target wso2 --url <mcp url>      # an external MCP→FHIR bridge (presets: wso2, fhirhydrant)
pnpm check --out report.md --json report.json # save the report
```

Admins can also run it from the browser: **Admin → Health check**.

The probes act **for Maria**, the synthetic patient. The target's FHIR server must hold the aipass fixtures; `pnpm fixtures:load` loads them.

## The probes

| Probe | What it tries | A failure means |
|---|---|---|
| `no_pass` | call with no credential at all | anyone can read health records |
| `forged_pass` | a pass signed by a key the target never trusted | anyone can mint passes |
| `expired_pass` | a pass that expired ten minutes ago | a stolen pass works forever |
| `wrong_audience` | a pass issued for a different service | a pass for one service opens another |
| `wrong_patient` | read John's records while acting for Maria | an agent can wander between patients |
| `locked_label_leak` | read Maria's mental-health and substance-use records | "always private" isn't |
| `role_escape` | a labs-only agent reads conditions, notes, medications, demographics | the role is decoration |
| `include_escape` | a labs-only agent pulls the Patient record in with `_include` | the role leaks through FHIR's side doors |
| `stopped_agent` | keep working after the admin stops the agent | Stop doesn't stop |
| `revoked_grant` | keep working after the person revokes | the person's "no" is ignored |
| `refusal_audited` | a refused request leaves an audit record | refusals are invisible |
| `receipt_names_both` | an allowed request's audit names the AI **and** the person | nobody can tell who did what for whom |
| `unapproved_write` | write a reading with no approval at all | the AI changes the record on its own |
| `self_approve` | the agent approves its own change with its own credential | the "person's approval" is the agent's |
| `approval_replay` | use one approval twice | one yes becomes many writes |
| `payload_swap` | change the value after it was approved (133 → 313) | the person approved something else |

How each probe reports:
- **pass:** it was stopped.
- **fail:** it got through.
- **missing:** the system has no such control at all, for example no credentials to forge.

Leaks are judged by **markers**: strings from the fixtures that can only appear in a response if a record leaked, such as `john-note-1` or `maria-note-therapy`. See `packages/check/src/probes.ts`.

## Grades

- Two failed leak probes mean **F**; one means **D** at best. The leak probes are `no_pass`, `wrong_patient`, `locked_label_leak`, `role_escape` and `include_escape`.
- Otherwise the grade follows the share of probes passed: 100% is **A**, 85% or more **B**, 65% or more **C**, 40% or more **D**, and below that **F**.
- *Missing* counts against the grade like a failure, but is reported separately.
- **The control comes first.** Before any probe, a good pass must read Maria's labs. If it can't (the target is down, unreachable, or refuses everything), no probe runs, every one is reported as a failure, and the grade is **F**. A target that turns everyone away isn't safe; it's broken, and "turned away" would mean nothing.

## Proving the inspector

A test suite that never fails proves nothing. `AIPASS_BROKEN=<defect>` starts aipass with one check switched off. The gateway refuses this when `NODE_ENV=production`, and so does the api for `approve_auth`.

The self-test (`packages/check/test/planted.int.test.ts`, part of `pnpm test:integration`) starts the gateway once correct and once per planted defect:

| Planted defect | Must be caught by | Probes that failed | Grade |
|---|---|---|---|
| (none) | — | all 16 pass | A |
| `require_pass` | `no_pass` | fails: no_pass | D |
| `signature` | `forged_pass` | fails: forged_pass | B |
| `expiry` | `expired_pass` | fails: expired_pass | B |
| `audience` | `wrong_audience` | fails: wrong_audience | B |
| `agent_status` | `stopped_agent` | fails: stopped_agent | B |
| `role` | `role_escape` | fails: role_escape | D |
| `grant` | `revoked_grant` | fails: revoked_grant | B |
| `compartment` | `wrong_patient` | fails: wrong_patient | D |
| `labels` | `locked_label_leak` | fails: locked_label_leak | D |
| `include` | `include_escape` | fails: include_escape | D |
| `audit_refusals` | `refusal_audited` | fails: refusal_audited | B |
| `audit_person` | `receipt_names_both` | fails: receipt_names_both | B |
| `approval` | `unapproved_write` | fails: unapproved_write, self_approve, approval_replay, payload_swap | C |
| `replay` | `approval_replay` | fails: approval_replay | B |
| `hash` | `payload_swap` | fails: payload_swap | B |
| `approve_auth` | `self_approve` | fails: self_approve | B |

Results:
- Every one of the 16 planted defects is caught by its own probe.
- Only `approval` also trips other probes, because with no approval check, self-approval, replay and swap all get through too.
- The correct gateway passes all 16, so there are no false alarms.

## Targets

| Adapter | How it drives the target |
|---|---|
| `aipass` | white-box: signs passes with the api's key, registers two temporary probe agents, stops and revokes in the database, approves as the person in the database, reads AuditEvents from FHIR, and deletes any reading it wrote |
| `wso2` | generic `search` / `read` tools |
| `fhirhydrant` | one tool per resource type, plus its JSONL audit file |

To add a target, write a preset in `packages/check/src/targets/bridge.ts` (how to read and search), or a full adapter.

## Scorecards (2026-10-19)

| Target | Configuration | Grade |
|---|---|---|
| [aipass gateway](scorecards/aipass.md) | `pnpm dev` | **A** (16/16) |
| [wso2/fhir-mcp-server](scorecards/wso2-fhir-mcp-server.md) `2a915a4` | documented local mode, no authorization | **F** (0 passed, 4 failed, 12 missing) |
| [faulkj/fhirHydrant](scorecards/fhirhydrant.md) `1a24376` | documented unauthenticated mode (read-only by default), file audit on | **F** (1 passed, 4 failed, 11 missing) |

The two external projects are **FHIR bridges**: they let an AI reach FHIR, and do that well. Per-person identity isn't something they claim in these modes; each scorecard says exactly what was and wasn't tested. The cards show the gap that an identity layer such as aipass fills in front of them.
