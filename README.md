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

**Pre-code.** The research and decisions so far are in [`docs/`](docs/). Start with [the idea in plain words](docs/00-the-idea-in-plain-words.md).

Demos use synthetic data only.
