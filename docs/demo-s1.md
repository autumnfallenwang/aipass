# Demo: a real Claude, through the guard

**What you'll see:**
1. Claude reads Maria's A1c results.
2. Claude is refused her therapy notes and tells her why.
3. The admin stops the agent, and the next call is refused.

The demo uses synthetic data only. Allow about 10 minutes.

## 1. Start everything

```sh
pnpm install
pnpm dev          # Postgres + HAPI FHIR, synthetic patients, demo roles, then the apps
```

On a first run Docker also pulls the HAPI image (about 600 MB).

## 2. Connect Claude Code as the Diabetes Coach

This demo uses no login. Claude Code fetches a short-lived **pass** with `headersHelper`:
- `deploy/claude/coach.json` connects Claude to **one** agent, the Diabetes Coach.
- `scripts/pass-header.sh` mints the pass. It names Maria (`sub`) and the Diabetes Coach (`act.sub`), lasts 5 minutes, and only opens the Diabetes Coach's door (`aud`).
- When a pass expires, the gateway answers 401 and Claude Code runs the helper again. We measured this: the new call carried a new pass.

*(S3 adds a real login, so Claude Code needs only the gateway URL; see the [plan](PLAN.md). The helper stays useful for agents with no browser.)*

Run Claude Code **from the repo root**, so that the helper's relative path works. Claude asks you to approve each aipass tool the first time; say yes.

```sh
claude --mcp-config deploy/claude/coach.json --strict-mcp-config
```

## 3. Three prompts, in one session

| You say | What happens | Receipt (`pnpm admin receipts`) |
|---|---|---|
| *"I'm Maria. What were my last A1c results?"* | Claude answers: 6.9% (Sep 28), 7.4% (May 20), 8.1% (Jan 15) | `Diabetes Coach read 3 lab results for Maria Santos.` |
| *"Summarize my therapy notes."* | Claude shows the diabetes visit note. It says one other record exists but is private: mental-health records are always withheld | `Diabetes Coach read 1 visit note for Maria Santos. 1 record was withheld (mental-health records are always private).` |
| Stop the agent: in another terminal run `pnpm admin agent stop diabetes-coach`, or click **Stop** on the Agents page at http://localhost:3000. Then ask the A1c question again | Claude says the request was refused: *agent stopped by admin* | `REFUSED: Diabetes Coach tried to read Maria Santos's lab results: agent stopped by admin.` |

Undo the stop with `pnpm admin agent resume diabetes-coach` or **Resume** in the UI.

**Without an interactive session.** `claude -p` runs one prompt at a time and remembers nothing between runs. So put "I'm Maria" in every prompt, and pre-approve the tools:

```sh
claude -p "I'm Maria. What were my last A1c results?" \
  --mcp-config deploy/claude/coach.json --strict-mcp-config --allowedTools "mcp__aipass-coach"
```

Every line also appears in the FHIR server's own audit log. Each AuditEvent names the AI (`Device/aipass-agent-diabetes-coach`) and Maria (`Patient/maria`, requestor):

```sh
curl -s 'http://localhost:8080/fhir/AuditEvent?agent=Device/aipass-agent-diabetes-coach&_sort=-date&_count=3'
```

## 4. Try the other agent

The Scheduling Assistant only sees Maria's name, phone number and appointments. It also doesn't see her therapy appointment, which is labelled `PSY`:

```sh
claude -p "I'm Maria. When is my next appointment, and what's my A1c?" \
  --mcp-config deploy/claude/scheduler.json --strict-mcp-config --allowedTools "mcp__aipass-scheduler"
```

Claude lists the diabetes follow-up (Nov 5) and the eye exam (Dec 3). It says one more appointment is private. It is refused the A1c: *not in the Scheduling Assistant role*.

## What the receipts' "rule" numbers mean

Every refusal names the first rule that failed:

| Rule | Check |
|---|---|
| 0 | the check itself failed (a server didn't answer), so nothing was released |
| 1 | the pass is valid |
| 2 | the agent is active (and, from S3, the app is approved for it) |
| 3 | the role allows it |
| 4 | the person agreed |
| 5 | it's the person's own record |
| 6 | the record has no locked label |
| 7 | (changes, S5) the person approved this exact change |

## Automated version

Every row of the S1 validation table is a test:

```sh
pnpm test               # policy + FHIR helpers + paging (unit)
pnpm test:integration   # gateway against Postgres + HAPI, using a real MCP client
```
