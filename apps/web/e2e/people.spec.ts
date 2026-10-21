/**
 * S9 validation, end to end and by clicks only: the People page is a list
 * that pages, searches and filters; one person opens in a side panel; a
 * paused person's AIs are refused; people are added from a record picked in
 * a FHIR search; only the person can say yes (D19). See docs/PLAN.md § S9.
 */
import { DEMO } from "@aipass/db";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { asAgent } from "./agent.ts";
import { E2E_ENV } from "./env.ts";
import { signIn } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const BULK = 60;
/** Maria, John and Dr. Lee. */
const DEMO_PEOPLE = DEMO.persons.length;
const CARLO = "Carlo647 Kory651 Blanda868";
const sql = () => postgres(E2E_ENV.DATABASE_URL ?? "", { max: 1, onnotice: () => {} });

test.beforeAll(async () => {
  // 60 synthetic people (no records anywhere): enough to page through.
  const db = sql();
  await db.unsafe(`
    insert into persons (id, display_name, fhir_ref, is_test, status)
    select 'bulk-' || n, 'Bulk ' || lpad(n::text, 4, '0'), 'Patient/bulk-' || n, true,
           case when n % 10 = 0 then 'suspended' else 'active' end
    from generate_series(1, ${BULK}) n
    on conflict do nothing`);
  await db.end();
});

test.afterAll(async () => {
  const db = sql();
  await db.unsafe(`delete from persons where id like 'bulk-%' or display_name = '${CARLO}'`);
  await db.end();
});

const panel = (page: Page) => page.getByTestId("person-panel");
const paging = (page: Page) => page.getByTestId("people-paging");

async function openPeople(page: Page) {
  await signIn(page);
  await page.getByRole("link", { name: "People" }).click();
  await expect(paging(page)).toContainText("of");
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

test("the list pages through everyone, 25 at a time", async ({ page }) => {
  await openPeople(page);
  const total = BULK + DEMO_PEOPLE;
  await expect(paging(page)).toContainText(`1–25 of ${total}`);
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(paging(page)).toContainText(`26–50 of ${total}`);
  await expect(page).toHaveURL(/page=2/);
  await choose(page, "People per page", "100 per page");
  await expect(paging(page)).toContainText(`1–${total} of ${total}`);
});

test("search finds people by name and by record id, and lives in the URL", async ({ page }) => {
  await openPeople(page);
  await page.getByLabel("Search people").fill("Bulk 0042");
  await expect(paging(page)).toContainText("1–1 of 1");
  await expect(page.locator("tbody")).toContainText("Bulk 0042");
  await expect(page).toHaveURL(/q=Bulk/);
  await page.reload();
  await expect(paging(page)).toContainText("1–1 of 1");
  await page.getByLabel("Search people").fill("Patient/maria");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("Maria Santos");
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(paging(page)).toContainText(`of ${BULK + DEMO_PEOPLE}`);
});

test("filters: paused people, and who an AI may act for", async ({ page }) => {
  await openPeople(page);
  await choose(page, "Filter by status", "Paused");
  await expect(paging(page)).toContainText(`1–${BULK / 10} of ${BULK / 10}`);
  await choose(page, "Filter by status", "Any status");
  // Only people the AI is allowed for right now: Maria allows the Scheduling
  // Assistant (she revoked the coach in the OAuth spec); John never allowed it.
  await choose(page, "Filter by AI", "Allowed: Scheduling Assistant");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("Maria Santos");
});

test("a person opens in a side panel: records at each server, login, AIs, activity", async ({
  page,
}) => {
  await openPeople(page);
  await page.getByLabel("Search people").fill("Maria");
  await page.getByRole("button", { name: "Open Maria Santos" }).click();
  await expect(page).toHaveURL(/person=maria/);
  const p = panel(page);
  await expect(p.getByRole("heading", { name: "Maria Santos", exact: true })).toBeVisible();
  await expect(p.locator('[data-record="aipass"]')).toContainText("Patient/maria");
  // The matrix spec connected her record at the EHR, with its own sign-in.
  await expect(p.locator('[data-record="sunrise-ehr"]')).toContainText("Connected by Maria");
  await p.getByRole("tab", { name: "Login" }).click();
  await expect(p.getByTestId("login-info")).toContainText("maria@example.org");
  await p.getByRole("tab", { name: /^AIs/ }).click();
  await expect(p.locator('[data-grant="maria:diabetes-coach"]')).toBeVisible();
  await p.getByRole("tab", { name: "Activity" }).click();
  await expect(p.locator("[data-receipt]").first()).toBeVisible();
});

test("pausing a person refuses their AIs on the very next call", async ({ page }) => {
  const coach = await asAgent("diabetes-coach", "john");
  expect((await coach.call("search_labs")).refused).toBe(false);

  await openPeople(page);
  await page.getByLabel("Search people").fill("John");
  await page.getByRole("button", { name: "Open John Carter" }).click();
  await panel(page).getByRole("button", { name: "Pause" }).click();
  await expect(panel(page)).toContainText("Paused: every AI acting for John is refused");
  const r = await coach.call("search_labs");
  expect(r.refused).toBe(true);
  expect(r.text).toContain("John's access is paused by the clinic");

  await panel(page).getByRole("button", { name: "Resume" }).click();
  await expect(panel(page)).toContainText("checked as usual");
  expect((await coach.call("search_labs")).refused).toBe(false);
  await coach.close();
});

test("a person is added from a record picked in a FHIR search, never a typed id", async ({
  page,
}) => {
  await openPeople(page);
  await page.getByRole("button", { name: "Add person" }).click();
  await page.getByLabel("Search records").fill("Santos");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(
    page.getByTestId("record-results").locator('[data-ref="Patient/maria"]'),
  ).toContainText("Already Maria Santos");

  await page.getByLabel("Search records").fill("Carlo");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: `Choose ${CARLO}` }).click();
  await expect(page.getByLabel("Name")).toHaveValue(CARLO);
  await page.getByRole("button", { name: `Add ${CARLO}` }).click();
  await expect(panel(page).getByRole("heading", { name: CARLO, exact: true })).toBeVisible();
  await expect(panel(page).locator('[data-record="aipass"]')).toContainText(
    "Picked by the admin from that server",
  );
});

test("only the person can say yes: the admin can't set a real person's AIs (D19)", async ({
  page,
}) => {
  await openPeople(page);
  await page.getByLabel("Search people").fill("Carlo");
  await page.getByRole("button", { name: `Open ${CARLO}` }).click();
  await panel(page).getByRole("tab", { name: /^AIs/ }).click();
  await expect(panel(page)).toContainText("Only Carlo647 can agree to what an AI may do for them");
  await expect(
    panel(page).getByRole("combobox", { name: `Let an agent act for ${CARLO}` }),
  ).toHaveCount(0);
});

test("removing a person: confirm with their name; they're gone from the list", async ({ page }) => {
  await openPeople(page);
  await page.getByLabel("Search people").fill("Carlo");
  await page.getByRole("button", { name: `Open ${CARLO}` }).click();
  const remove = panel(page).getByRole("button", { name: "Remove" });
  await expect(remove).toBeDisabled();
  await panel(page).getByLabel("Type their name to confirm").fill(CARLO);
  await remove.click();
  await expect(page.getByText(`${CARLO} removed`)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("tbody")).toContainText("No one matches.");
});

test("the role preview picks its test person by searching", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Roles" }).click();
  await page.getByRole("link", { name: "Diabetes Coach" }).first().click();
  await page.getByRole("combobox", { name: "Test person" }).click();
  await page.getByLabel("Search: Test person").fill("John");
  await page.getByRole("option", { name: "John Carter" }).click();
  await expect(page.getByRole("combobox", { name: "Test person" })).toHaveText("John Carter");
  await expect(page.getByTestId("preview")).toBeVisible();
});
