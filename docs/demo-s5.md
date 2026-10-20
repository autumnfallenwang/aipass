# Demo: the AI proposes, Maria approves with her passkey, then it's written

**What you'll see:**
1. The Diabetes Coach *proposes* "blood glucose 130 mg/dL". Nothing is written yet.
2. Maria opens the approval link and sees exactly that change. She approves with her passkey (fingerprint or face).
3. The coach commits it. The record gets the Observation and a Provenance saying the AI wrote it, for Maria, with her approval.

The demo uses synthetic data only, on localhost.

## 1. Start everything

```sh
pnpm dev
```

Maria's demo login is `maria@example.org` / `maria-demo-password`.

## 2. Give Maria a passkey

Sign in as Maria at http://localhost:3000/my-ais and click **Add a passkey**. A passkey works on localhost: browsers treat it as a secure origin.

**To approve with a real phone** without deploying anything (D12): add the passkey from Chrome on your laptop and choose *"Use a phone or tablet"*. Chrome shows a QR code; scan it with the phone, and the passkey lives on the phone. Approvals later work the same way: the laptop shows a QR code and the phone confirms with your fingerprint or face, over Bluetooth.

## 3. Ask Claude to add a reading

Use either connection from the earlier demos: OAuth ([demo-s3](demo-s3.md)) or the helper ([demo-s1](demo-s1.md)):

> *"I'm Maria. My blood glucose this morning was 130 mg/dL. Please add it to my record."*

Claude calls `propose_observation`. aipass then:
1. checks the coach may *propose* lab results (role ∩ Maria's grant);
2. builds the exact Observation;
3. hashes it (RFC 8785 canonical JSON, then sha256);
4. stores a pending approval and returns a link: `http://localhost:3000/approve/apr_…`.

The proposal waits 10 minutes.

## 4. Maria approves

The approval page shows *"Diabetes Coach wants to add this to Maria Santos's record: Blood glucose 130 mg/dL, measured …"*. **Approve with passkey** signs a challenge equal to `sha256(payload hash ‖ approval id ‖ nonce)`, with user verification required. Or she taps **Deny**.

Pending approvals also appear at the top of her "My AIs" page.

## 5. Claude commits

Tell Claude you approved. It calls `commit_change` with the same values. aipass re-hashes them, then checks the approval:
- it matches;
- it's approved, within 2 minutes;
- it's unused;
- it's for this agent and this person.

Only then does aipass write:
- the **Observation**;
- a **Provenance**: `author` = the AI's Device, `onBehalfOf` = Maria, `verifier` = Maria, and the approval id with its hash;
- an **AuditEvent**.

Receipt:

```
Diabetes Coach added 1 lab result for Maria Santos. Blood glucose 130 mg/dL, measured …. Approved by Maria Santos with a passkey.
```

## What was run on 2026-10-19

These steps were run with real Claude Code 2.1.301 (`claude -p`, then `--resume` in the same session), with Playwright playing Maria and a Chrome virtual authenticator standing in for her phone:

```sh
pnpm --filter @aipass/web exec tsx e2e/manual/approve.ts http://localhost:3000/approve/apr_…
```

| Step | Result |
|---|---|
| Propose | Claude proposed the reading and gave Maria the link. Unprompted, it pointed out that the default time ("now") wasn't "this morning" |
| Approve | Maria approved with the passkey |
| Commit | Claude, resumed, committed the reading. The Provenance read `author Device/aipass-agent-diabetes-coach → onBehalfOf Patient/maria`, `verifier Patient/maria`, `entity: approval apr_… (sha256 6cd44af5…)` |
| Before that | Maria's grant had been revoked earlier, and the first proposal was refused: *Maria hasn't agreed to proposals for lab results* |

## What can't get through (A1–A8)

These are automated in `apps/web/e2e/writes.spec.ts`:

| # | Attempt | Result |
|---|---|---|
| A1 | the agent calls the approve endpoint with its own pass | `401`: approvals need the person's browser session |
| A2 | an assertion without user verification | *passkey check failed*; stays pending |
| A3 | commit 310 after Maria approved 130 | *the change doesn't match what Maria approved*; nothing written |
| A4 | commit the same approval twice | *this approval was already used* |
| A5 | commit more than 2 minutes after approval | *the approval expired* |
| A6 | John opens Maria's approval | *Only Maria Santos can approve this*; `403` |
| A7 | Maria taps Deny | `REFUSED: … Maria said no.`; nothing written |
| A8 | an approved write | Observation + Provenance (AI for Maria) + AuditEvent (action `C`, AI and Maria) |

The health check (`pnpm check`) probes the same things from outside: `unapproved_write`, `self_approve`, `approval_replay`, `payload_swap`.
