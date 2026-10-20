# Demo S1: a real Claude, through the guard

**What you'll see:**
1. Claude reads Maria's A1c results.
2. Claude is refused her therapy notes and tells her why.
3. The admin stops the agent, and the next call is refused.

The demo uses synthetic data only.

## 1. Start everything

```sh
pnpm install
pnpm dev          # Postgres + HAPI FHIR, synthetic patients, demo roles, then the apps
```

## 2. Connect Claude Code

There's no login yet: S3 adds OAuth. Instead, Claude Code fetches a short-lived **pass** with `headersHelper`.
- `deploy/claude/mcp-dev-pass.json` holds the config.
- `scripts/pass-header.sh` mints the pass. It names Maria (`sub`) and the Diabetes Coach (`act.sub`), lasts 5 minutes, and only opens the Diabetes Coach's door (`aud`).
- When a pass expires, the gateway answers 401 and Claude Code runs the helper again. We measured this: the new call carried a new pass.

Run Claude Code from the repo root, so that the helper's relative path works:

```sh
claude --mcp-config deploy/claude/mcp-dev-pass.json --strict-mcp-config
```

## 3. Three prompts

| You say | What happens | Receipt (`pnpm admin receipts`) |
|---|---|---|
| *"I'm Maria. What were my last A1c results?"* | Claude answers: 6.9% (Sep 28), 7.4% (May 20), 8.1% (Jan 15) | `Diabetes Coach read 3 lab results for Maria Santos.` |
| *"Summarize my therapy notes."* | Claude shows the diabetes visit note. It says one other record exists but is private: mental-health records are always withheld | `Diabetes Coach read 1 visit note for Maria Santos. 1 record was withheld (mental-health records are always private).` |
| In another terminal: `pnpm admin agent stop diabetes-coach`. Then ask again | Claude says the request was refused: *agent stopped by admin* | `REFUSED: Diabetes Coach tried to read Maria Santos's lab results: agent stopped by admin.` |

Undo the stop with `pnpm admin agent resume diabetes-coach`.

Every line also appears in the FHIR server's own audit log. Each AuditEvent names the AI (`Device/aipass-agent-diabetes-coach`) and Maria (`Patient/maria`, requestor):

```sh
curl -s 'http://localhost:8080/fhir/AuditEvent?agent=Device/aipass-agent-diabetes-coach&_sort=-date&_count=3'
```

## 4. Try the other agent

The Scheduling Assistant only sees Maria's name, phone number and appointments. It also doesn't see her therapy appointment, which is labelled `PSY`:

```sh
claude --mcp-config deploy/claude/mcp-dev-pass.json --strict-mcp-config \
  -p "I'm Maria. When is my next appointment, and what's my A1c?"
```

Claude lists the diabetes follow-up and the eye exam. It is refused the A1c: *not in the Scheduling Assistant role*.

## What was run on 2026-10-19

The three prompts above, through `claude -p` (Claude Code 2.1.301), against this repo at the S1 commit. The exact answers are in the PLAN log.

## Automated version

Every row of the S1 validation table is a test:

```sh
pnpm test               # policy + FHIR helpers + paging (unit)
pnpm test:integration   # gateway against Postgres + HAPI, using a real MCP client
```
