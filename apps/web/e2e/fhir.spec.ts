/**
 * D18, end to end and by clicks only: aipass's own FHIR server is registered
 * like everything else. It's listed, tested and edited on the FHIR servers
 * page, a bad address is refused before it's saved, and an edit reaches the
 * running api without a restart. See docs/decisions.md D18.
 */
import { expect, type Page, test } from "@playwright/test";
import { asAgent } from "./agent.ts";
import { E2E_ENV } from "./env.ts";
import { signIn } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const FHIR = E2E_ENV.FHIR_BASE_URL ?? "http://127.0.0.1:8080/fhir";
const own = (page: Page) => page.locator('tr[data-kind="aipass"]');

async function openFhirServers(page: Page) {
  await signIn(page);
  await page.getByRole("link", { name: "FHIR servers" }).click();
}

async function edit(page: Page, fields: { name?: string; baseUrl?: string }) {
  await own(page).getByRole("button", { name: "Edit" }).click();
  if (fields.name !== undefined) await page.getByLabel("Name").fill(fields.name);
  if (fields.baseUrl !== undefined) await page.getByLabel("FHIR base URL").fill(fields.baseUrl);
  await page.getByRole("button", { name: "Save" }).click();
}

test("aipass's own FHIR server is registered, listed first, and always on", async ({ page }) => {
  await openFhirServers(page);
  const row = page.locator("tbody tr").first();
  await expect(row).toHaveAttribute("data-kind", "aipass");
  await expect(row).toContainText("aipass's FHIR server");
  await expect(row).toContainText("aipass's own");
  await expect(row).toContainText(FHIR);
  await expect(row).toContainText("Always on");
  await expect(row.getByRole("button", { name: "Switch off" })).toHaveCount(0);
});

test("Test says it answers as FHIR, and how many patients it holds", async ({ page }) => {
  await openFhirServers(page);
  await own(page).getByRole("button", { name: "Test" }).click();
  await expect(page.getByTestId("fhir-test")).toContainText("It answers as FHIR 4.0.1");
  await expect(page.getByTestId("fhir-test")).toContainText(/It holds \d+ patient records/);
});

test("an address that doesn't answer as FHIR is refused, and nothing changes", async ({ page }) => {
  await openFhirServers(page);
  await edit(page, { baseUrl: "http://127.0.0.1:9/fhir" });
  await expect(page.getByText("that server didn't answer as FHIR")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.reload();
  await expect(own(page)).toContainText(FHIR);
});

test("its name, as registered, is what the Agents page shows", async ({ page }) => {
  await openFhirServers(page);
  await edit(page, { name: "Clinic records (HAPI)" });
  await expect(own(page)).toContainText("Clinic records (HAPI)");
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("combobox", { name: "Records for Diabetes Coach" })).toHaveText(
    "Clinic records (HAPI)",
  );
  await page.getByRole("link", { name: "FHIR servers" }).click();
  await edit(page, { name: "aipass's FHIR server" });
  await expect(own(page)).toContainText("aipass's FHIR server");
});

test("a new address reaches the running api without a restart", async ({ page }) => {
  // The same HAPI under another name, so the record and the audit log stay put.
  const moved = FHIR.replace("127.0.0.1", "localhost");
  await openFhirServers(page);
  await edit(page, { baseUrl: moved });
  await expect(own(page)).toContainText(moved);
  // One request, so Activity has an AuditEvent to link to.
  const coach = await asAgent("diabetes-coach", "maria");
  expect((await coach.call("search_labs", { code: "4548-4" })).refused).toBe(false);
  await coach.close();
  await page.getByRole("link", { name: "Activity" }).click();
  const link = page.getByRole("link", { name: "AuditEvent" }).first();
  await expect(link).toHaveAttribute("href", new RegExp(`^${moved}/AuditEvent/`));

  await page.getByRole("link", { name: "FHIR servers" }).click();
  await edit(page, { baseUrl: FHIR });
  await expect(own(page)).toContainText(FHIR);
});
