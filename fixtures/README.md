# fixtures

**Synthetic data only.** None of these people exist.

| File | Who | Why it's here |
|---|---|---|
| `maria.json` | Maria Santos (`Patient/maria`) | The demo patient. Hand-written so every rule has a case |
| `john.json` | John Carter (`Patient/john`) | The "someone else" for wrong-patient tests. Has an `HIV`-labelled condition |
| `synthea/carlo.json` | A Synthea patient | Realistic, unlabelled background data |
| `synthea/georgianna.json` | A Synthea patient | Realistic, unlabelled background data |

Each file is a FHIR R4 `transaction` bundle of `PUT`s with fixed ids, so loading it twice changes nothing:

```sh
pnpm fixtures:load        # FHIR_BASE_URL defaults to http://127.0.0.1:8080/fhir
```

## What Maria's record holds

| Group | Records | Labelled (always private) |
|---|---|---|
| labs | 3 × A1c, fasting glucose, LDL | none |
| vitals | blood pressure, weight | none |
| medications | metformin, lisinopril, **sertraline** | sertraline: `PSY` |
| conditions | type 2 diabetes, hypertension, **depression**, **alcohol use disorder (in remission)** | depression: `PSY`; alcohol: `ETH` + `42CFRPart2` |
| notes | diabetes visit note, **therapy session note** | therapy note: `PSY` + `R` |
| appointments | diabetes follow-up, eye exam, **therapy session** | therapy session: `PSY` |
| demographics | name, phone, email, birth date, address, MRN | — |

Labels sit in `meta.security`, using the HL7 codes:
- `v3-ActCode`: `PSY`, `ETH`, `42CFRPart2`, `HIV`
- `v3-Confidentiality`: `R`

## Regenerating the Synthea patients

```sh
java -jar synthea-with-dependencies.jar -s 20261019 -cs 20261019 -p 2 -a 35-65 -r 20261001 \
  --exporter.baseDirectory=./out --exporter.fhir.export=true \
  --exporter.hospital.fhir.export=false --exporter.practitioner.fhir.export=false \
  --exporter.years_of_history=3 --generate.only_alive_patients=true Massachusetts
pnpm tsx scripts/trim-synthea.ts out/fhir/Carlo647_*.json fixtures/synthea/carlo.json
pnpm tsx scripts/trim-synthea.ts out/fhir/Georgianna701_*.json fixtures/synthea/georgianna.json
```

- Synthea build: `master-branch-latest` as of 2026-10-19.
- `trim-synthea.ts` keeps only Patient, lab and vital Observations, Conditions, MedicationRequests and DocumentReferences.
- It also drops references to encounters, practitioners and organizations.
