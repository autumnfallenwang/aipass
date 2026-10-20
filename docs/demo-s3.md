# Demo: Claude connects with just the gateway URL; Maria decides

**What you'll see:**
1. Claude Code is given only the Diabetes Coach's gateway URL. It finds the login on its own.
2. Maria signs in and sees exactly what the coach is asking for. She unticks vital signs.
3. Claude reads her A1c but is refused her blood pressure: *Maria hasn't agreed to vital signs*.
4. Maria revokes the coach on her "My AIs" page. The coach's next request is refused, and its refresh token stops working.

The demo uses synthetic data only. Allow about 10 minutes.

## 1. Start everything

```sh
pnpm install
pnpm dev
```

The demo seed gives Maria and John logins. These are synthetic people, local only:

| Person | Email | Password |
|---|---|---|
| Maria Santos | `maria@example.org` | `maria-demo-password` |
| John Carter | `john@example.org` | `john-demo-password` |

It also approves **Claude Code** to connect as either demo agent. An admin can see and change this under **Agents → Apps**.

## 2. Connect Claude Code

```sh
claude mcp add --transport http aipass-coach http://localhost:3002/agents/diabetes-coach/mcp
claude mcp login aipass-coach        # or /mcp inside Claude Code
```

What happens:
1. The gateway answers `401`, pointing to its Protected Resource Metadata.
2. That metadata names the authorization server: `http://localhost:3000/api/auth`.
3. Claude Code identifies itself with its Client ID Metadata Document (CIMD) and asks for a token for this agent's URL (RFC 8707 `resource`), using PKCE.
4. A browser opens on the aipass sign-in page. Sign in as **Maria**.
5. The consent page says *"Diabetes Coach wants to act for you. Approved by Sunrise Clinic as a Diabetes Coach."* It lists what the clinic's role allows, each item with its own tick box, and says what the coach will never see.
6. **Untick "see your vital signs"**, then click **Allow**.

Claude Code now holds a 5-minute access token. That token *is* the pass:
- `sub` is Maria's login;
- `act.sub` is `diabetes-coach`;
- `patient` is `maria`;
- `aud` is the coach's gateway URL.

It refreshes the token itself. You never handle a token.

## 3. Ask

| You say | What happens |
|---|---|
| *"I'm Maria. What was my last A1c, and my last blood pressure?"* | A1c 6.9% (Sep 28). Blood pressure is refused: *Maria hasn't agreed to vital signs* |

Receipts (`pnpm admin receipts`):

```
Diabetes Coach read 1 lab result for Maria Santos.
REFUSED: Diabetes Coach tried to read Maria Santos's vital signs: Maria hasn't agreed to vital signs.
```

## 4. Maria takes it back

1. Open http://localhost:3000/my-ais, signed in as Maria. You'll see each AI that may act for her, what it may do, and its recent requests, including the refused one.
2. Click **Revoke**, then **Yes, revoke**.
3. Ask Claude again. The coach is refused:
   - If its access token is still valid, it is refused *Maria hasn't agreed to lab results*.
   - Its refresh tokens were revoked at the same moment, so once the token expires Claude Code can't get a new one. It has to ask Maria again.

## What we measured on 2026-10-19

These steps were run against real Claude Code 2.1.301, with Playwright playing Maria's browser:

```sh
pnpm --filter @aipass/web exec tsx e2e/manual/claude-oauth-login.ts --dir <empty dir> --untick "see your vital signs"
pnpm --filter @aipass/web exec tsx e2e/manual/revoke.ts diabetes-coach
```

| Step | Result |
|---|---|
| Client | Claude Code used CIMD: `https://claude.ai/oauth/claude-code-client-metadata` |
| Ask | *"What was my last A1c, and my last blood pressure?"*: 6.9%. Blood pressure refused: *Maria hasn't agreed to vital signs* |
| Revoke | All 7 of Claude Code's refresh tokens for the coach were revoked. Its next connection carried no valid pass, and its aipass tools disappeared |

## Agents without a browser

[demo-s1.md](demo-s1.md) still works. A headless agent can get a pass from `headersHelper` instead of OAuth. Token exchange for headless agents comes in S6.

## Automated version

`pnpm test:e2e` runs `apps/web/e2e/oauth.spec.ts`. An MCP client that knows only the gateway URL goes through discovery, dynamic client registration and PKCE, while a browser plays the admin and Maria. It checks:
- an unapproved app is refused;
- the consent page and the unticked vitals;
- the token's claims;
- a pass for one agent is refused at another's door;
- a pass for Maria can't read John;
- withdrawing the app;
- revoking (next call refused, refresh token `invalid_grant`).
