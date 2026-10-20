# aipass

**A pass for AI in healthcare.**

Let AI help with your health records, on your terms: it sees only what you allow, asks before it changes anything, and you can stop it anytime.

## What it will do

- **Gives each AI its own pass**, naming the AI and the person it acts for. The AI never uses the person's password.
- **Checks the person's rules on every request.** Example: "labs yes, therapy notes no".
- **Asks the person before any change**, using their passkey, tied to the exact change.
- **Writes a receipt for every action** in plain English and in the FHIR record's own audit log.
- **Stops instantly** when the person cancels the permission.

It works with any login system (identity provider) and any FHIR server, and you host it yourself.

## Status

**Early development.** The plan, progress and decisions are in [`docs/`](docs/). Start with [the plan](docs/PLAN.md).

Demos use synthetic data only.

## Run it locally

You need Node 22+ (24 LTS recommended), pnpm 10 and Docker.

```sh
pnpm install
pnpm dev      # starts Postgres + HAPI FHIR, loads the synthetic patients, then runs the apps
pnpm smoke    # in another terminal: checks that everything is healthy
```

| Service | URL |
|---|---|
| Admin UI (web) | http://localhost:3000 |
| api | http://localhost:3001 |
| gateway | http://localhost:3002 |
| HAPI FHIR | http://localhost:8080/fhir |

On first start, HAPI takes about a minute to boot. `pnpm dev` waits for it.
