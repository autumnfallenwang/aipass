/**
 * S5 acceptance tests A1–A8: the Diabetes Coach proposes "glucose 130",
 * Maria approves that exact change with her passkey (a Chrome virtual
 * authenticator), and only then is it written. See docs/PLAN.md § S5.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { asAgent } from "./agent.ts";
import { E2E, E2E_ENV } from "./env.ts";
import { MARIA, signIn } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const JOHN = { email: "john@sunrise-clinic.example", password: "john-e2e-password" };
const FHIR = E2E_ENV.FHIR_BASE_URL;
const sql = postgres(E2E_ENV.DATABASE_URL ?? "", { max: 1, onnotice: () => {} });

/** Gives a browser context a platform passkey authenticator; returns a switch for user verification. */
async function withPasskey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return (verified: boolean) =>
    cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: verified });
}

async function personPage(
  browser: import("@playwright/test").Browser,
  who: { email: string; password: string },
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const setUv = await withPasskey(context, page);
  await page.goto("/login?next=/my-ais");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My AIs" })).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  return { page, setUv };
}

/** The approval id and the exact commit arguments from a proposal's tool result. */
function parseProposal(text: string) {
  const args = JSON.parse(text.match(/with exactly: (\{.*\})/)?.[1] ?? "null") as Record<
    string,
    unknown
  > & {
    approval_id: string;
  };
  const url = text.match(/(http\S+\/approve\/\S+)/)?.[1] ?? "";
  return { args, url };
}

let maria: Awaited<ReturnType<typeof personPage>>;
let coach: Awaited<ReturnType<typeof asAgent>>;

test.afterAll(async () => {
  await coach?.close();
  // leave the shared synthetic FHIR server as the fixtures made it
  const tagged = (await (
    await fetch(
      `${FHIR}/Observation?patient=Patient/maria&_tag=https://aipass.dev/source|ai-proposed&_count=100`,
    )
  ).json()) as { entry?: { resource: { id: string } }[] };
  for (const e of tagged.entry ?? []) {
    await fetch(`${FHIR}/Provenance?target=Observation/${e.resource.id}`, { method: "DELETE" });
    await fetch(`${FHIR}/Observation/${e.resource.id}`, { method: "DELETE" });
  }
  await sql.end();
});

test("setup: Maria and John have logins and passkeys; Maria lets the coach propose labs", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "People" }).click();
  for (const [id, who] of [
    ["maria", MARIA],
    ["john", JOHN],
  ] as const) {
    const card = page.locator(`[data-person="${id}"]`);
    // wait until the card has loaded one way or the other
    await expect(
      card.getByText("Has a login").or(card.getByRole("button", { name: "Give a login" })),
    ).toBeVisible();
    if (await card.getByRole("button", { name: "Give a login" }).isVisible()) {
      await card.getByRole("button", { name: "Give a login" }).click();
      await page.getByLabel("Email").fill(who.email);
      await page.getByLabel("Temporary password").fill(who.password);
      await page.getByRole("button", { name: "Create login" }).click();
      await expect(card.getByText("Has a login")).toBeVisible();
    }
  }
  const put = await page.request.put(`${E2E.web}/api/admin/persons/maria/grants/diabetes-coach`, {
    data: { permissions: ["labs:read", "labs:propose"] },
    headers: { origin: E2E.web },
  });
  expect(put.ok()).toBe(true);
  maria = await personPage(browser, MARIA);
  coach = await asAgent("diabetes-coach", "maria");
});

test("A8: an approved write leaves the Observation, a Provenance (AI for Maria) and an AuditEvent", async () => {
  const proposed = await coach.call("propose_observation", {
    measure: "blood_glucose",
    value: 130,
  });
  expect(proposed.refused).toBe(false);
  expect(proposed.text).toContain("Proposed (nothing written yet): Blood glucose 130 mg/dL");
  const { args, url } = parseProposal(proposed.text);

  // Not yet approved: nothing can be written.
  const early = await coach.call("commit_change", args);
  expect(early.refused).toBe(true);
  expect(early.text).toContain("waiting for Maria's OK");

  await maria.page.goto(url);
  await expect(maria.page.getByTestId("approval-summary")).toContainText("Blood glucose 130 mg/dL");
  await maria.page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(maria.page.getByTestId("approval-status")).toHaveText("Approved");

  const written = await coach.call("commit_change", args);
  expect(written.refused).toBe(false);
  const ref = written.text.match(/\((Observation\/[^)]+)\)/)?.[1] ?? "";
  expect(ref).toMatch(/^Observation\//);

  const obs = (await (await fetch(`${FHIR}/${ref}`)).json()) as {
    valueQuantity: { value: number };
    subject: { reference: string };
  };
  expect(obs.valueQuantity.value).toBe(130);
  expect(obs.subject.reference).toBe("Patient/maria");

  const prov = (await (await fetch(`${FHIR}/Provenance?target=${ref}`)).json()) as {
    entry: {
      resource: { agent: { who: { reference: string }; onBehalfOf?: { reference: string } }[] };
    }[];
  };
  const agentOf = prov.entry[0]?.resource.agent[0];
  expect(agentOf?.who.reference).toBe("Device/aipass-agent-diabetes-coach");
  expect(agentOf?.onBehalfOf?.reference).toBe("Patient/maria");

  const audit = (await (await fetch(`${FHIR}/AuditEvent?entity=${ref}`)).json()) as {
    entry: {
      resource: { action: string; agent: { who: { reference: string }; requestor: boolean }[] };
    }[];
  };
  const ae = audit.entry[0]?.resource;
  expect(ae?.action).toBe("C");
  expect(ae?.agent.map((a) => a.who.reference)).toEqual([
    "Device/aipass-agent-diabetes-coach",
    "Patient/maria",
  ]);

  // A4: the same approval used twice.
  const again = await coach.call("commit_change", args);
  expect(again.refused).toBe(true);
  expect(again.text).toContain("this approval was already used");
});

test("A3: a payload changed after approval (130 → 310) is refused", async () => {
  const { args, url } = parseProposal(
    (await coach.call("propose_observation", { measure: "blood_glucose", value: 130 })).text,
  );
  await maria.page.goto(url);
  await maria.page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(maria.page.getByTestId("approval-status")).toHaveText("Approved");
  const swapped = await coach.call("commit_change", { ...args, value: 310 });
  expect(swapped.refused).toBe(true);
  expect(swapped.text).toContain("the change doesn't match what Maria approved");
  const written = await (
    await fetch(`${FHIR}/Observation?patient=Patient/maria&value-quantity=310`)
  ).json();
  expect((written as { total?: number }).total ?? 0).toBe(0);
});

test("A5: an approval older than 2 minutes is refused", async () => {
  const { args, url } = parseProposal(
    (await coach.call("propose_observation", { measure: "blood_glucose", value: 141 })).text,
  );
  await maria.page.goto(url);
  await maria.page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(maria.page.getByTestId("approval-status")).toHaveText("Approved");
  await sql`update approvals set approved_at = now() - interval '3 minutes' where id = ${args.approval_id}`;
  const late = await coach.call("commit_change", args);
  expect(late.refused).toBe(true);
  expect(late.text).toContain("the approval expired");
});

test("A7: Maria taps Deny; the receipt says she said no and nothing is written", async ({
  page,
}) => {
  const { args, url } = parseProposal(
    (await coach.call("propose_observation", { measure: "blood_glucose", value: 222 })).text,
  );
  await maria.page.goto(url);
  await maria.page.getByRole("button", { name: "Deny" }).click();
  await expect(maria.page.getByTestId("approval-status")).toHaveText("Denied");
  const r = await coach.call("commit_change", args);
  expect(r.refused).toBe(true);
  expect(r.text).toContain("Maria said no");
  const written = await (
    await fetch(`${FHIR}/Observation?patient=Patient/maria&value-quantity=222`)
  ).json();
  expect((written as { total?: number }).total ?? 0).toBe(0);
  await signIn(page);
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(
    page.locator("tr[data-receipt]", {
      hasText: "REFUSED: Diabetes Coach tried to add Maria Santos's lab results: Maria said no.",
    }),
  ).toHaveCount(1);
});

test("A1: the agent calling the approve endpoint with its own pass is refused", async () => {
  const proposed = await coach.call("propose_observation", {
    measure: "blood_glucose",
    value: 150,
  });
  const { args } = parseProposal(proposed.text);
  const pass = (await (
    await fetch(`${E2E.api}/dev/passes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "diabetes-coach", person: "maria" }),
    })
  ).json()) as { token: string };
  const res = await fetch(`${E2E.web}/api/person/approvals/${args.approval_id}/approve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pass.token}`,
      "content-type": "application/json",
      origin: E2E.web,
    },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(401);
  const still = await coach.call("commit_change", args);
  expect(still.text).toContain("waiting for Maria's OK");
});

test("A6: John can't approve Maria's change, with his session or his passkey", async ({
  browser,
}) => {
  const { args, url } = parseProposal(
    (await coach.call("propose_observation", { measure: "blood_glucose", value: 160 })).text,
  );
  const john = await personPage(browser, JOHN);
  await john.page.goto(url);
  await expect(john.page.getByText("Only Maria Santos can approve this.")).toBeVisible();
  await expect(john.page.getByRole("button", { name: "Approve with passkey" })).toHaveCount(0);
  const res = await john.page.request.post(
    `${E2E.web}/api/person/approvals/${args.approval_id}/approve`,
    {
      data: { response: { id: "x" } },
      headers: { origin: E2E.web },
    },
  );
  expect(res.status()).toBe(403);
  expect((await coach.call("commit_change", args)).text).toContain("waiting for Maria's OK");
});

test("A2: an approval without user verification is refused", async () => {
  const { args, url } = parseProposal(
    (await coach.call("propose_observation", { measure: "blood_glucose", value: 170 })).text,
  );
  await maria.setUv(false);
  // The browser itself refuses a "required" ceremony without verification, so
  // to test the *server's* check we relax what the page asks for and send the
  // unverified assertion anyway.
  await maria.page.route(`**/api/person/approvals/${args.approval_id}`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.options) body.options.userVerification = "discouraged";
    await route.fulfill({ response: res, json: body });
  });
  await maria.page.goto(url);
  await maria.page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(maria.page.getByText(/passkey check failed/i)).toBeVisible();
  await expect(maria.page.getByTestId("approval-status")).toHaveText("Waiting for your OK");
  await maria.setUv(true);
  await maria.page.unrouteAll();
  expect((await coach.call("commit_change", args)).text).toContain("waiting for Maria's OK");
});
