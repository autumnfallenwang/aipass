/**
 * S10 validation, end to end and by clicks only: an agent acts for a staff
 * member, on the patient she has open (D21). Dr. Lee picks a patient in her
 * care, agrees on the normal consent page, and chats about that patient only.
 * Her care team is in fixtures/staff/lee.json: Maria and Carlo, not John.
 * See docs/PLAN.md § S10.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { asAgent } from "./agent.ts";
import { E2E } from "./env.ts";
import { ensureLogin, signIn } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const LEE = { email: "lee@example.org", password: "lee-e2e-password" };
const MARIA = "Maria Elena Santos";
const CARLO = "Carlo647 Kory651 Blanda868";
let lee: Page;

async function asLee(browser: Browser): Promise<Page> {
  if (lee) return lee;
  lee = await (await browser.newContext()).newPage();
  await lee.goto("/my-ais");
  await lee.getByLabel("Email").fill(LEE.email);
  await lee.getByLabel("Password").fill(LEE.password);
  await lee.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(lee).toHaveURL(/\/my-ais/);
  return lee;
}

async function ask(page: Page, text: string) {
  const before = await page.locator('[data-turn="assistant"]').count();
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
  const turn = page.locator('[data-turn="assistant"]').nth(before);
  await expect(turn).toHaveAttribute("data-done", "true");
  return turn;
}

async function openPatient(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Patient you have open" }).click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("combobox", { name: "Patient you have open" })).toContainText(name);
}

test("the admin gives the Visit Assistant a model and a login for Dr. Lee", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "AI models" }).click();
  await page.getByRole("button", { name: "Add model" }).click();
  await page.getByLabel("Name").fill("Staff test model");
  await page.getByLabel("Base URL").fill(`${E2E.model}/v1`);
  await page.getByRole("radio", { name: /Stays on your network/ }).check();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator('[data-model-connection="staff-test-model"]')).toBeVisible();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Model for Visit Assistant" }).click();
  await page.getByRole("combobox", { name: "Model: connection" }).click();
  await page.getByRole("option", { name: "Staff test model" }).click();
  await page.getByRole("combobox", { name: "Model: model" }).click();
  await page.getByRole("option", { name: "fake-model", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Model for Visit Assistant" })).toContainText(
    "fake-model",
  );
  await ensureLogin(page, "lee", LEE);
});

test("Dr. Lee agrees once, picks a patient in her care, and asks about her", async ({
  browser,
}) => {
  const p = await asLee(browser);
  await p
    .locator('[data-ai="visit-assistant"]')
    .getByRole("link", { name: /Chat with/ })
    .click();
  await expect(p.getByTestId("chat-title")).toHaveText("Visit Assistant");
  await p.getByRole("link", { name: "Allow and start chatting" }).click();

  // The same consent page as any AI app, saying it works on the patient she has open.
  await expect(p.getByTestId("consent-title")).toHaveText("Visit Assistant wants to act for you");
  await expect(p.getByTestId("staff-note")).toContainText("the patient you have open");
  await p.getByRole("button", { name: "Allow" }).click();
  await expect(p).toHaveURL(/\/chat\/visit-assistant$/);

  // No patient open yet: nothing can be asked.
  await expect(p.getByTestId("choose-patient")).toBeVisible();
  await expect(p.getByLabel("Message")).toBeDisabled();

  // Her care team comes from the record system: Maria and Carlo, not John.
  await p.getByRole("combobox", { name: "Patient you have open" }).click();
  await expect(p.getByRole("option")).toHaveCount(2);
  await expect(p.getByRole("option", { name: /John/ })).toHaveCount(0);
  await p.keyboard.press("Escape");

  await openPatient(p, MARIA);
  const turn = await ask(p, "What was the last A1c?");
  await expect(turn.locator("[data-step]")).toContainText("checked by aipass");
  await expect(turn.getByTestId("answer")).toContainText("6.9 %");
  await expect(turn.getByTestId("answer")).toContainText(
    `${MARIA}, the patient Dr. Grace Lee has open`,
  );
});

test("switching patient starts a new conversation, about that patient only", async ({
  browser,
}) => {
  const p = await asLee(browser);
  await openPatient(p, CARLO);
  await expect(p.locator('[data-turn="assistant"]')).toHaveCount(0);
  const turn = await ask(p, "Any medications?");
  await expect(turn.getByTestId("answer")).toContainText(`${CARLO}, the patient Dr. Grace Lee`);
  await expect(turn.getByTestId("answer")).not.toContainText("6.9 %");

  // Back to Maria: her conversation is still hers.
  await openPatient(p, MARIA);
  await expect(p.locator('[data-turn="assistant"]')).toHaveCount(1);
  await expect(p.getByTestId("answer")).toContainText("6.9 %");
});

test("another patient's record is refused: not the patient in context", async () => {
  // Plays the AI with a pass for Dr. Lee, which names the patient she has open (Maria).
  const ai = await asAgent("visit-assistant", "lee");
  const john = await ai.call("get_notes", { id: "john-note-1" });
  expect(john.refused).toBe(true);
  expect(john.text).toContain("REFUSED: not the patient in context.");
  const therapy = await ai.call("get_notes", { id: "maria-note-therapy" });
  expect(therapy.text).toContain("REFUSED: mental-health records are always private.");
  await ai.close();
});

test("Activity names both: the clinician the AI acted for, and the patient", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.locator("[data-receipt]").first()).toBeVisible();
  const read = page.locator("[data-receipt]").filter({
    hasText: `Visit Assistant read 3 lab results for Dr. Grace Lee (patient: ${MARIA})`,
  });
  await expect(read).toHaveCount(1);
  await expect(read.getByTestId("via-app")).toHaveText("via aipass chat (built-in)");
  await expect(
    page.locator("[data-receipt]").filter({ hasText: "not the patient in context" }).first(),
  ).toBeVisible();
});
