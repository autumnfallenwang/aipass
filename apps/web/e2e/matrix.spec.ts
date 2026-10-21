/**
 * S6: "any login, any FHIR server". Each cell of {aipass's own login, the
 * hospital's login (Keycloak)} × {aipass's FHIR server, an EHR over SMART
 * (the SMART launcher)} runs the S1 call (the coach reads Maria's labs) and
 * the whole health check, which must come back A.
 *
 * Google and Epic need registrations only the project owner can make; their
 * cells are run by hand (docs/demo-s6.md).
 */
import { aipassTarget, CHECK_AGENTS, runChecks } from "@aipass/check";
import { createDb } from "@aipass/db";
import { smartLauncherFhirUrl } from "@aipass/fhir";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { withPass } from "./agent.ts";
import { E2E, E2E_ENV } from "./env.ts";
import { ensureLogin, MARIA, signIn } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://localhost:8180/realms/sunrise";
const LAUNCHER = process.env.SMART_LAUNCHER_URL ?? "http://localhost:8090";
const EHR = smartLauncherFhirUrl({
  launcher: LAUNCHER,
  patient: "maria",
  clientId: "aipass",
  clientSecret: "launcher-dev-secret",
});
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";

const { db, close } = createDb(E2E_ENV.DATABASE_URL);
test.afterAll(async () => close());

let admin: Page;
const clients = new Map<string, { clientId: string; clientSecret: string }>();

/** Maria's token from the hospital's login (a password grant stands in for her signing in there). */
async function hospitalToken(): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "coach-cli",
      username: "maria",
      password: "maria-kc-password",
      scope: "openid",
    }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** A headless agent swaps Maria's hospital token for a pass (RFC 8693). */
async function exchangeFor(request: APIRequestContext, agentId: string): Promise<string> {
  let client = clients.get(agentId);
  if (!client) {
    const made = await request.post(`${E2E.web}/api/admin/agents/${agentId}/headless-client`);
    expect(made.status()).toBe(201);
    client = (await made.json()) as { clientId: string; clientSecret: string };
    clients.set(agentId, client);
  }
  const res = await fetch(`${E2E.web}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      subject_token: await hospitalToken(),
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: `${E2E.gateway}/agents/${agentId}/mcp`,
    }),
  });
  const body = (await res.json()) as { access_token?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.access_token ?? "";
}

async function devPass(agentId: string): Promise<string> {
  const res = await fetch(`${E2E.api}/dev/passes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: agentId, person: "maria" }),
  });
  return ((await res.json()) as { token: string }).token;
}

/** The S1 call: the coach reads Maria's A1c. */
async function coachReadsLabs(pass: string) {
  const agent = await withPass("diabetes-coach", pass);
  const r = await agent.call("search_labs", { code: "4548-4" });
  await agent.close();
  expect(r.refused, r.text).toBe(false);
  expect(r.text).toContain("Hemoglobin A1c");
  expect(r.text).toContain("6.9 %");
}

/** The whole health check against this cell; every probe must pass. */
async function checkIsGreen(cell: { fhirServerId?: string; exchange?: boolean }) {
  // The check registers its probe agents afresh each run, so their clients are new too.
  for (const a of Object.values(CHECK_AGENTS)) clients.delete(a.id);
  const report = await runChecks(
    aipassTarget({
      db,
      gatewayUrl: E2E.gateway,
      passIssuer: E2E.api,
      fhirBaseUrl: E2E_ENV.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir",
      publicUrl: E2E.api,
      fhirServerId: cell.fhirServerId,
      goodCredential: cell.exchange ? (id: string) => exchangeFor(admin.request, id) : undefined,
    }),
  );
  const notPassed = report.results.filter((r) => r.status !== "pass");
  expect(notPassed.map((r) => `${r.id}: ${r.status} ${r.detail}`)).toEqual([]);
  expect(report.grade).toBe("A");
}

test.beforeAll(async ({ browser }) => {
  admin = await (await browser.newContext()).newPage();
  await signIn(admin);
  await ensureLogin(admin, "maria", MARIA);
  // the hospital's login, trusted (the connections spec may have added it already)
  const added = await admin.request.post(`${E2E.web}/api/admin/connections`, {
    data: { name: "Sunrise Clinic login", issuer: KEYCLOAK, audience: "aipass" },
  });
  expect([201, 409]).toContain(added.status());
});

test.afterAll(async () => {
  // leave the coach on aipass's own server for the specs that follow
  await admin?.request.patch(`${E2E.web}/api/admin/agents/diabetes-coach`, {
    data: { fhirServerId: null },
  });
});

test("cell: aipass login × aipass FHIR (the S1 demo, then the check)", async () => {
  await coachReadsLabs(await devPass("diabetes-coach"));
  await checkIsGreen({});
});

test("cell: hospital login × aipass FHIR (token exchange, then the check)", async () => {
  // the admin gives the coach headless credentials, shown once
  await admin.getByRole("link", { name: "Agents" }).click();
  await admin
    .locator('tr[data-agent="diabetes-coach"]')
    .getByRole("button", { name: "Apps" })
    .click();
  await admin.getByRole("button", { name: "Create a headless client (token exchange)" }).click();
  const shown = admin.getByTestId("headless-secret");
  await expect(shown).toContainText("client_secret:");
  const text = (await shown.textContent()) ?? "";
  clients.set("diabetes-coach", {
    clientId: text.match(/client_id: (\S+?)client_secret/)?.[1] ?? "",
    clientSecret: text.match(/client_secret: (\S+)/)?.[1] ?? "",
  });
  await admin.keyboard.press("Escape");

  await coachReadsLabs(await exchangeFor(admin.request, "diabetes-coach"));
  await checkIsGreen({ exchange: true });
});

test("the admin adds the clinic's EHR and points the coach at it", async () => {
  await admin.getByRole("link", { name: "FHIR servers" }).click();
  await admin.getByRole("button", { name: "Add an EHR" }).click();
  await admin.getByLabel("Name").fill("Sunrise EHR");
  await admin.getByLabel("FHIR base URL").fill(EHR);
  await admin.getByLabel("SMART client ID").fill("aipass");
  await admin.getByLabel("SMART client secret (confidential apps)").fill("launcher-dev-secret");
  await admin.getByRole("button", { name: "Add", exact: true }).click();
  await expect(admin.getByTestId("redirect-uri")).toHaveText(`${E2E.web}/api/person/fhir/callback`);
  await admin.getByRole("button", { name: "Done" }).click();
  await expect(admin.locator('tr[data-server="sunrise-ehr"]')).toContainText("On");

  await admin.getByRole("link", { name: "Agents" }).click();
  await admin.getByRole("combobox", { name: "Records for Diabetes Coach" }).click();
  await admin.getByRole("option", { name: "Sunrise EHR" }).click();
  await expect(admin.getByRole("combobox", { name: "Records for Diabetes Coach" })).toHaveText(
    "Sunrise EHR",
  );
});

test("Maria connects her record at the EHR from My AIs", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login?next=/my-ais");
  await page.getByLabel("Email").fill(MARIA.email);
  await page.getByLabel("Password").fill(MARIA.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const card = page.getByTestId("records-elsewhere").locator('[data-server="sunrise-ehr"]');
  await card.getByRole("link", { name: "Connect" }).click();
  // the EHR's own sign-in (skipped by the launcher) sends her straight back
  await expect(page).toHaveURL(`${E2E.web}/my-ais`);
  await expect(page.getByText("Connected. Your AIs can read that record now")).toBeVisible();
  await expect(card.getByText("Connected")).toBeVisible();
});

test("cell: aipass login × EHR over SMART (the S1 demo, then the check)", async () => {
  await coachReadsLabs(await devPass("diabetes-coach"));
  await checkIsGreen({ fhirServerId: "sunrise-ehr" });
});

test("cell: hospital login × EHR over SMART (token exchange, then the check)", async () => {
  await coachReadsLabs(await exchangeFor(admin.request, "diabetes-coach"));
  await checkIsGreen({ fhirServerId: "sunrise-ehr", exchange: true });
});
