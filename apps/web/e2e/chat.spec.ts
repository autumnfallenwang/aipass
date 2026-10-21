/**
 * S8 validation, end to end and by clicks only: the admin adds a model,
 * tests it and gives it to an agent; Maria chats with it in the browser. The
 * chat is an ordinary AI app: it asks Maria first, every lookup is checked
 * and recorded by the gateway, and a scripted model stands in for a real one.
 * See docs/PLAN.md § S8.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { E2E } from "./env.ts";
import { ensureLogin, MARIA, signIn } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const FAKE = E2E.model;
let maria: Page;

async function asMaria(browser: Browser): Promise<Page> {
  if (maria) return maria;
  maria = await (await browser.newContext()).newPage();
  await maria.goto("/my-ais");
  await maria.getByLabel("Email").fill(MARIA.email);
  await maria.getByLabel("Password").fill(MARIA.password);
  await maria.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(maria).toHaveURL(/\/my-ais/);
  return maria;
}

/** Sends a message and waits for the answer to finish. */
async function ask(page: Page, text: string) {
  const before = await page.locator('[data-turn="assistant"]').count();
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
  const turn = page.locator('[data-turn="assistant"]').nth(before);
  await expect(turn).toHaveAttribute("data-done", "true");
  return turn;
}

async function openAgents(page: Page) {
  await signIn(page);
  await page.getByRole("link", { name: "Agents" }).click();
}

test("the admin adds a model, and Test shows it answers and calls tools", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "AI models" }).click();
  await page.getByRole("button", { name: "Add model" }).click();
  await page.getByLabel("Name").fill("Test model");
  await page.getByLabel("Base URL").fill(`${FAKE}/v1`);
  // Where data goes is the admin's call: there's no default.
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await page.getByRole("radio", { name: /Stays on your network/ }).check();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.locator('[data-model-connection="test-model"]');
  await expect(row).toContainText("Stays on your network");

  await row.getByRole("button", { name: "Test", exact: true }).click();
  const test1 = page.getByTestId("model-test");
  await expect(test1).toContainText("It answers, and offers 2 models.");
  await page.getByRole("button", { name: "Try", exact: true }).click();
  await expect(page.getByTestId("tool-call-result")).toContainText(
    "fake-model: it called the tool",
  );
  await page.getByRole("combobox", { name: "Model to test" }).click();
  await page.getByRole("option", { name: "fake-no-tools" }).click();
  await page.getByRole("button", { name: "Try", exact: true }).click();
  await expect(page.getByTestId("tool-call-result")).toContainText(
    "fake-no-tools: it answered without calling the tool",
  );
});

test("the admin gives the model to the Diabetes Coach", async ({ page }) => {
  await openAgents(page);
  await page.getByRole("button", { name: "Model for Diabetes Coach" }).click();
  await page.getByRole("combobox", { name: "Model: connection" }).click();
  await page.getByRole("option", { name: "Test model" }).click();
  await page.getByRole("combobox", { name: "Model: model" }).click();
  await page.getByRole("option", { name: "fake-model", exact: true }).click();
  await expect(page.getByText("What it reads stays on your network.")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Model for Diabetes Coach" })).toContainText(
    "fake-model · Test model",
  );
});

test("Maria allows the chat once, then asks for her A1c and gets it", async ({ page, browser }) => {
  await signIn(page);
  await ensureLogin(page, "maria", MARIA);
  const m = await asMaria(browser);
  await m
    .locator('[data-ai="diabetes-coach"]')
    .getByRole("link", { name: /Chat with/ })
    .click();
  await expect(m.getByTestId("chat-title")).toHaveText("Diabetes Coach");
  await expect(m.getByTestId("model-line").first()).toContainText(
    "Answers come from fake-model (Test model). What it reads stays on your network.",
  );
  await m.getByRole("link", { name: "Allow and start chatting" }).click();

  // The same consent page as any AI app.
  await expect(m.getByTestId("consent-title")).toHaveText("Diabetes Coach wants to act for you");
  await expect(m.getByText("It connects through aipass chat (built-in)")).toBeVisible();
  await m.getByRole("button", { name: "Allow" }).click();
  await expect(m).toHaveURL(/\/chat\/diabetes-coach$/);

  const turn = await ask(m, "What was my last A1c?");
  await expect(turn.locator("[data-step]")).toContainText("Lab results");
  await expect(turn.locator("[data-step]")).toContainText("checked by aipass");
  await expect(turn.getByTestId("answer")).toContainText("6.9 %");
  await expect(turn).toContainText("Answered by fake-model");
});

test("mental-health records stay private in the chat", async ({ browser }) => {
  const m = await asMaria(browser);
  const turn = await ask(m, "What medications am I on?");
  await expect(turn.getByTestId("answer")).toContainText("withheld");
  await expect(turn.getByTestId("answer")).not.toContainText(/sertraline/i);
});

test("the admin sees each lookup on Activity, made via the built-in chat", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Activity" }).click();
  const first = page.locator("[data-receipt]").first();
  await expect(first).toContainText("Diabetes Coach");
  await expect(first.getByTestId("via-app")).toHaveText("via aipass chat (built-in)");
});

test("the model never saw a pass or any other credential", async () => {
  const sent = JSON.stringify(await (await fetch(`${FAKE}/requests`)).json());
  expect(sent).toContain("6.9 %");
  // A pass is a JWT (eyJ…); nothing like one, or a bearer header, reached the model.
  expect(sent).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  expect(sent).not.toMatch(/bearer/i);
  expect(sent).not.toContain("refresh_token");
});

test("Stop works on the chat's very next lookup", async ({ page, browser }) => {
  await openAgents(page);
  const row = page.locator('tr[data-agent="diabetes-coach"]');
  await row.getByRole("button", { name: "Stop" }).click();
  await expect(row.locator('[data-status="stopped"]')).toBeVisible();

  const m = await asMaria(browser);
  const turn = await ask(m, "What was my last A1c?");
  await expect(turn.locator("[data-step]")).toContainText("refused by aipass");
  await expect(turn.getByTestId("answer")).toContainText("stopped");

  await row.getByRole("button", { name: "Resume" }).click();
  await expect(row.locator('[data-status="active"]')).toBeVisible();
});

test("withdrawing the built-in chat from an agent refuses its next lookup", async ({
  page,
  browser,
}) => {
  await openAgents(page);
  await page
    .locator('tr[data-agent="diabetes-coach"]')
    .getByRole("button", { name: "Apps" })
    .click();
  await page.getByRole("button", { name: "Remove aipass-chat" }).click();
  await expect(page.getByTestId("allowed-apps")).not.toContainText("aipass chat (built-in)");

  const m = await asMaria(browser);
  const turn = await ask(m, "What was my last A1c?");
  await expect(turn.getByTestId("answer")).toContainText(
    "this app isn't approved to act as Diabetes Coach",
  );

  await page.getByRole("button", { name: "Allow the built-in chat" }).click();
  await expect(page.getByTestId("allowed-apps")).toContainText("aipass chat (built-in)");
  const again = await ask(m, "What was my last A1c?");
  await expect(again.getByTestId("answer")).toContainText("6.9 %");
});

test("a role that keeps data on the network can't be given a cloud model", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "AI models" }).click();
  await page.getByRole("button", { name: "Add model" }).click();
  await page.getByLabel("Name").fill("Cloud test");
  await page.getByLabel("Base URL").fill(`${FAKE}/v1`);
  await page.getByRole("radio", { name: /Goes to a cloud provider/ }).check();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator('[data-model-connection="cloud-test"]')).toContainText(
    "Goes to a cloud provider",
  );

  await page.getByRole("link", { name: "Roles" }).click();
  await page.getByRole("link", { name: "Diabetes Coach" }).first().click();
  await page.getByRole("switch", { name: "Only models that keep data on your network" }).click();
  await page.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByText("Role saved")).toBeVisible();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Model for Diabetes Coach" }).click();
  await page.getByRole("combobox", { name: "Model: connection" }).click();
  await page.getByRole("option", { name: "Cloud test" }).click();
  await page.getByRole("combobox", { name: "Model: model" }).click();
  await page.getByRole("option", { name: "fake-model", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText(
      "the Diabetes Coach role only allows models that keep data on the clinic's network",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // Put the role back for the specs that follow.
  await page.getByRole("link", { name: "Roles" }).click();
  await page.getByRole("link", { name: "Diabetes Coach" }).first().click();
  await page.getByRole("switch", { name: "Only models that keep data on your network" }).click();
  await page.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByText("Role saved")).toBeVisible();
});

test("disconnecting the chat means Maria is asked again next time", async ({ browser }) => {
  const m = await asMaria(browser);
  await m.getByRole("button", { name: "Disconnect" }).click();
  await expect(m.getByTestId("chat-connect")).toBeVisible();
  await expect(m.getByLabel("Message")).toBeDisabled();
});
