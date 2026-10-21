# Demo: Dr. Lee's AI works on the patient she has open

**What you'll see:**
1. Dr. Grace Lee, a clinician, opens **Chat** with the Visit Assistant. It asks her first, on the same consent page as any AI app.
2. She picks the patient she has open. The choices are her care team at the record system: Maria and Carlo. John isn't in her care, so he isn't offered.
3. She asks about Maria's labs and gets them. Maria's mental-health records stay private from Dr. Lee's AI too.
4. She switches to Carlo, and a new conversation starts. Going back to Maria brings back Maria's conversation.
5. **Activity** shows each lookup naming both people: *for Dr. Grace Lee (patient: Maria Elena Santos)*.

Everything here is clicks in the browser; the only command is starting aipass. The demo uses synthetic data only, on localhost.

## 1. Start everything

```sh
pnpm dev
```

The demo includes Dr. Lee (`Practitioner/lee`) with a demo login, the Visit Assistant, and her care teams (`fixtures/staff/lee.json`).

## 2. Give the Visit Assistant a model (admin)

Open http://localhost:3000 and sign in as the admin.

1. Add a model on **AI models**, as in [demo-s8](demo-s8.md#2-add-a-model-admin), unless your local `.env` already names one.
2. **Agents → Model** in the Visit Assistant row: choose the connection and the model, then **Save**.
3. Optional: **People → Dr. Grace Lee**. Her record is a `Practitioner`, her login is `lee@example.org`, and on **AIs** the Visit Assistant may read labs, conditions, medications and visit notes, and propose a reading.

## 3. Chat (Dr. Lee)

In another browser (or a private window), sign in at http://localhost:3000/my-ais as `lee@example.org` / `lee-demo-password`.

1. On the Visit Assistant card, click **Chat with Visit Assistant**.
2. **Allow and start chatting.** The consent page says *it works on the patient you have open, and only while that patient is in your care*. Click **Allow**.
3. **Patient you have open:** the list is her care team, read from the FHIR server's `CareTeam`s. Pick **Maria Elena Santos**. Until she picks one, nothing can be asked.
4. Ask **What was the last A1c?** You see *Lab results · checked by aipass*, then 6.9 %, from *Maria Elena Santos, the patient Dr. Grace Lee has open*.
5. Ask **What medications is she on?** Metformin and lisinopril, plus a note that one record was withheld because *mental-health records are always private*.
6. Switch the patient to **Carlo647 Kory651 Blanda868**. The conversation starts fresh: nothing about Maria carries over. Switch back to Maria, and her conversation is still there.

## 4. What the admin sees

**Activity** lists each lookup as *Visit Assistant read 3 lab results for Dr. Grace Lee (patient: Maria Elena Santos)*, via aipass chat (built-in). The receipt names the patient's record. The FHIR AuditEvent names Dr. Lee (`Practitioner/lee`) as the requestor and Maria as the patient.

## What can't happen

Each of these is a refusal with a receipt:

- **Another patient's record**, even one the AI names by id: *not the patient in context*.
- **A patient who isn't in her care**, or who has left it since: *not one of Dr. Lee's patients*. The refusal doesn't say who the patient is.
- **The previous patient**, after she switches: an AI still holding a pass for Maria gets *Dr. Lee has another patient open now* on its next call.
- **No patient open**: *no patient selected*.

In a clinic, the care team lives in the record system (the EHR). aipass only reads it, on every call.

## What's checked automatically

- `apps/web/e2e/staff.spec.ts` runs the steps above by clicks, with a scripted model standing in for a real one, and plays an AI asking for John's note.
- `apps/gateway/test/s10-staff.int.test.ts` checks each refusal above against the real gateway, Postgres and HAPI. It also checks the receipt and AuditEvent, and a proposed reading that Dr. Lee approves, whose Provenance says it was for her and whose Observation is Maria's.
- `apps/api/test/staff.int.test.ts`: her care team, opening only a patient in it, and every pass naming the patient she has open.
