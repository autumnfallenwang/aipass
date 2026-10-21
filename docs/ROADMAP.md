# Roadmap

aipass is an independent open-source project. A new release comes about every quarter, plus security fixes as needed.

| Phase | Period | Focus | Milestone |
|---|---|---|---|
| 1. Build | June 2026 – Sept 2027 | Add the four core functions, release by release | Public demonstration (Oct 2026); version 1.0 (Q3 2027) |
| 2. Test | Oct 2027 – mid-2028 | Prove it works with real record systems and resists misuse | Full test suite passes on at least two public healthcare test servers, every release |
| 3. Pilot | mid-2028 – 2029 | Make it easy for vendors and clinics to adopt; run pilots | At least three pilot deployments (target) |
| 4. Expand and sustain | 2030 – May 2031 | More record systems and identity platforms; co-maintainers | Pilot reports published; outside co-maintainers active |

The four core functions:
1. each AI agent gets its own identity, tied to the staff member or patient it acts for;
2. it is limited to what its task needs;
3. every access is recorded;
4. it needs a person's approval before changing a record.

The public demonstration does all four on synthetic data. The build stages and their tests are in [PLAN.md](PLAN.md).

## Between now and version 1.0

- **Staff members at an EHR.** Today an agent acts for a clinician on aipass's own FHIR server, for a patient they pick in aipass ([demo](demo-s10.md)). Next: the clinician's own sign-in at an EHR (a SMART provider launch), and the patient taken from the EHR's launch context.
- **A published access-record format**, so other tools can read aipass's receipts and AuditEvents.
- **A HIPAA Security Rule control mapping**: which safeguards aipass covers, how, and with which test as proof.
- **Test cases for agents misled by hidden instructions in a document** (prompt injection), added to the health check.
- **The open security items from the [ASVS self-check](security/asvs-l2.md)**: admin MFA, session lifetimes, password checks.
- **Validation against a real EHR sandbox (Epic) and a hosted identity provider (Google).**
- **No terminal.** Everything a person or an admin does happens in the browser; the only command is starting aipass ([PLAN S11](PLAN.md)).
