# aipass, in plain words

One example runs through the whole page. **Maria has diabetes. She lets an AI assistant help her with her health records.**

## The one line

> **Let AI help with your health records, on your terms: it sees only what you allow, asks before it changes anything, and you can stop it anytime.**

Short version: **a pass for AI in healthcare.**

## 1. What problem does it solve?

Today, connecting an AI to health records is **all-or-nothing and invisible**:

- **It opens everything.** The AI gets one key to Maria's whole record, therapy notes included. One developer wrote it plainly: *"for now we connect as the super admin."*
- **Nobody can tell who did what.** If the AI adds a wrong glucose value, the record says "some app did it", not "this AI, acting for Maria".
- **Approval can be faked.** In some tools, the "a human approved this" signal is a flag the AI can set itself.
- **Stopping it is crude.** Maria has to disconnect everything, and a key already handed out may keep working for a while.

With aipass:

- **Maria chooses what it can see.** Labs and medications yes, therapy notes no.
- **It must ask before changing anything.** Her phone shows *"Add glucose 130 mg/dL to your record?"* and she approves with her fingerprint.
- **Every action leaves a receipt.** *"AI read your A1c for Maria: allowed."* *"AI tried to read therapy notes: refused."*
- **She can stop it with one tap.** It stops on its very next step.

## 2. What's different from earlier FHIR agent tools?

| | Earlier tools | aipass |
|---|---|---|
| **Who gets permission** | The **app**, as a whole | **Each AI, for each person.** Maria's diet coach sees meals but not labs; her diabetes assistant sees labs |
| **How it knows who's asking** | A shared key, or a name the AI types in itself | A **pass that names both the AI and Maria**, checked on every request |
| **Changing records** | Read-only, writes with no approval, or an approval the AI could fake | Approved only with **Maria's own fingerprint or passkey**, tied to the exact change. Change one number and the approval is void |
| **The record's history** | "An app did this" | **"This AI, for Maria, added this, approved at 9:02"**, written into the medical record's own audit log |
| **Where it works** | One network, or one particular server | **Any login system, any FHIR server.** You host it yourself, and we never hold your data |
| **Proof it works** | "Trust us" | **A public test that grades it**: can the AI read the wrong patient? Can it approve itself? |

## 3. How is this IAM?

It *is* IAM (identity and access management), applied to a new kind of user. IAM has always handled two kinds of user: **people** and **apps**. An AI agent is a third kind: **it acts for a person, but makes its own decisions.** So both names have to be on every request.

| IAM idea | In aipass | Everyday example |
|---|---|---|
| **Identity** | The AI gets its own pass instead of using Maria's password | A contractor gets a visitor badge, not your house key |
| **Delegation** (OAuth token exchange, the `act` claim) | The pass says "this AI, acting for Maria" | A signed note: "My neighbour may collect my package" |
| **Least privilege** | Maria's rules: labs yes, therapy notes no | The note covers the package, not the whole house |
| **Step-up authentication** | A passkey for every change | The bank texts you a code before a big transfer |
| **Audit** | A receipt for every action, naming both the AI and Maria | A line on your bank statement: who, what, when |
| **Revocation** | Cancel the permission, and the AI stops on its next step | Cancelling a lost credit card |
