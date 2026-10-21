# Use your own login

aipass has its own logins (email and password, passkeys). It can also trust the login system you already run: a hospital's identity provider, Keycloak, Okta, Entra ID, Google. Anything that speaks OpenID Connect works.

A trusted login system is a **connection**. It gives you two things:

1. **Sign-in.** People and admins click *Sign in with <your login>* on aipass's login page.
2. **Headless agents.** An agent with no browser (a nightly job, a server-side assistant) swaps the person's token from your login for an aipass pass. This is RFC 8693 token exchange.

Nothing else is trusted. A token from a login system the admin hasn't connected is refused.

## What a connection checks

A token from your login counts only when **all** of these hold:

| Check | If not |
|---|---|
| Its `iss` is an **enabled** connection | `untrusted issuer` |
| It is signed by that issuer's keys (aipass reads them from its discovery document) | `the subject token didn't verify` |
| Its `aud` includes the audience you set for the connection | `the subject token isn't for aipass` |
| It isn't expired | `the subject token expired` |
| It has `email` with `email_verified: true` | `no verified email` |
| That email belongs to an **existing** aipass login with a person | `nobody in aipass matches this identity` |
| It carries no `act`, `may_act` or `cnf` | `claims aipass doesn't accept` |

Notes on those checks:
- **The email match.** aipass never signs anyone up through a connection. The admin gives a person a login (*People → Give a login*) with the same email their hospital login uses. Signing in through the connection then links to that login.
- **The refused claims.** A token that already has an `act` is a delegated token, and aipass allows one hop only. `cnf` binds a token to a key aipass can't check here.

Disabling a connection (*Admin → Connections → Disable*) stops all of it on the next request: its sign-in button, any sign-in already under way, and token exchange for every agent.

## Add your login

1. **Register aipass as a client at your login system.** Use:
   - a confidential client with the authorization code flow and PKCE;
   - redirect URI `<your aipass origin>/api/auth/sso/callback/<connection-id>`. The connection id is the name you'll give it, lower-cased with dashes, e.g. `sunrise-clinic-login`;
   - scopes `openid email profile`.
2. **Make your tokens carry an audience for aipass.** For token exchange, the person's access token must have an `aud` that names aipass, e.g. `aipass`. In Keycloak this is an *audience mapper*. Ask your login team for the equivalent.
3. **In aipass, go to *Admin → Connections → Add connection*** and enter:
   - the name;
   - the issuer URL. aipass fetches `<issuer>/.well-known/openid-configuration`, and the issuer in it must match exactly;
   - the audience from step 2;
   - optionally the client from step 1, if you want sign-in.
4. **Give each person a login** with the email your login system has verified for them.

If your login system is on a private network (e.g. `keycloak.internal`, `10.x`, `localhost`), aipass trusts its origin for the sign-in redirect while the connection is enabled. A public one, like Google, needs no such trust.

## Headless agents: token exchange

On *Agents*, open the agent's **Apps** and click **Create a headless client**. aipass shows a client id and secret **once**. The agent authenticates with them. A public client (no secret) can't act for anyone.

The agent then asks for a pass:

```sh
curl -s https://aipass.example.org/api/auth/oauth2/token \
  -u "$AIPASS_CLIENT_ID:$AIPASS_CLIENT_SECRET" \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$PERSONS_TOKEN_FROM_YOUR_LOGIN" \
  -d subject_token_type=urn:ietf:params:oauth:token-type:access_token \
  -d resource=https://gateway.aipass.example.org/agents/diabetes-coach/mcp
```

The answer is a normal aipass pass, with no refresh token:
- `sub` is the person;
- `act.sub` is the agent;
- `aud` is that one agent's gateway URL;
- it lasts 5 minutes.

The client must be one the admin approved for that agent. One client can't ask for a pass to another agent's door (`invalid_target`).

Other things the endpoint accepts and refuses:
- `subject_token_type` may be an access token, an ID token or a JWT.
- `actor_token` isn't accepted. The agent proves who it is by authenticating as the client.

For Claude Code, [`scripts/exchange-header.sh`](../../scripts/exchange-header.sh) does this as a `headersHelper`. See [demo-s6](../demo-s6.md).

## Try it locally with Keycloak

```sh
docker compose -f deploy/compose.yaml --profile keycloak up -d --wait
```

This starts Keycloak 26 at http://localhost:8180 with the synthetic realm `sunrise`. The admin console login is `admin` / `admin-dev-only`.

Users:

| User | Password | Email | |
|---|---|---|---|
| `maria` | `maria-kc-password` | maria@example.org | verified |
| `john` | `john-kc-password` | john@example.org | verified |
| `mallory` | `mallory-kc-password` | mallory@example.org | **not** verified |

Clients:

| Client | What it is for |
|---|---|
| `aipass-login` (secret `aipass-login-dev-secret`) | sign-in |
| `coach-cli` | public; tokens carry `aud: aipass` |
| `other-app` | its tokens are *not* for aipass |

Add the connection:
- issuer `http://localhost:8180/realms/sunrise`;
- audience `aipass`;
- client `aipass-login`.

Then sign in as Maria with *Sign in with Sunrise Clinic login*.

## Google

Google works the same way. On Google Cloud, create an OAuth client (web application) with the redirect URI above. Then add the connection:
- issuer `https://accounts.google.com`;
- audience = that OAuth client's id. Google's ID tokens carry the client id as `aud`; exchange them with `subject_token_type=urn:ietf:params:oauth:token-type:id_token`;
- the client id and secret, for sign-in.

> The Google cell of the S6 matrix needs a Google Cloud OAuth client that only the project maintainer can create. It hasn't been run yet; see the [plan](../PLAN.md).
