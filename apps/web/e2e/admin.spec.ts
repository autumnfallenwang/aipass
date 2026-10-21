/**
 * S2 validation, end to end: a browser drives the admin UI; an MCP client
 * plays the AI agent against the real gateway. See docs/PLAN.md § S2.
 */
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { asAgent } from "./agent.ts";
import { ADMIN, signIn } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test("the first account on a fresh install becomes the admin", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("Create the admin account")).toBeVisible();
  await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/admin\/agents/);
  await expect(page.getByRole("cell", { name: /Diabetes Coach/ }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: /Scheduling Assistant/ }).first()).toBeVisible();
});

test("admin creates a role (appointments + name/phone) and the preview of Maria shows only that", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "Roles" }).click();
  await page.getByRole("button", { name: "New role" }).click();
  await page.getByLabel("Name").fill("Front Desk");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/admin\/roles\/front-desk/);

  await page.getByRole("switch", { name: "Appointments: See" }).click();
  await page.getByRole("switch", { name: "Patient details: See" }).click();
  await page.getByRole("checkbox", { name: "Name" }).click();
  await page.getByRole("checkbox", { name: "Phone" }).click();
  // locked records can't be switched on
  await expect(
    page.getByRole("switch", { name: "Mental health: always off" }).first(),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByText("Role saved")).toBeVisible();

  await page.getByRole("combobox", { name: "Test person" }).click();
  await page.getByRole("option", { name: "Maria Santos" }).click();
  const preview = page.getByTestId("preview");
  const section = (g: string) => preview.locator(`section[data-group="${g}"]`);

  await expect(section("appointments")).toHaveAttribute("data-decision", "allow");
  await expect(section("appointments")).toContainText("Diabetes follow-up");
  await expect(section("appointments")).toContainText("Diabetic eye exam");
  await expect(section("appointments")).not.toContainText("Therapy");
  await expect(section("appointments")).toContainText("mental-health records are always private");

  await expect(section("demographics")).toHaveAttribute("data-decision", "allow");
  await expect(section("demographics")).toContainText("Maria Elena Santos");
  await expect(section("demographics")).toContainText("555-0142");
  for (const hidden of ["1972-03-14", "maria.santos@example.org", "Harbor View", "SC-100234"]) {
    await expect(section("demographics")).not.toContainText(hidden);
  }
  for (const g of ["labs", "vitals", "medications", "conditions", "notes"]) {
    await expect(section(g)).toHaveAttribute("data-decision", "refuse");
    await expect(section(g)).toContainText("not in the Front Desk role");
  }
});

test("admin registers an agent with that role; the agent sees only appointments; Stop cuts it off on the next call", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Register agent" }).click();
  await page.getByLabel("Name").fill("Front Desk Bot");
  await page.getByLabel("What it does").fill("Answers the clinic phone line.");
  await page.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: "Front Desk" }).click();
  await page.getByRole("button", { name: "Register", exact: true }).click();
  const row = page.locator('tr[data-agent="front-desk-bot"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("/agents/front-desk-bot/mcp");

  // Maria (a test person: the admin may set her grants, D19) gets the new agent.
  await page.getByRole("link", { name: "People" }).click();
  await page.getByRole("button", { name: "Open Maria Santos" }).click();
  await page.getByTestId("person-panel").getByRole("tab", { name: /^AIs/ }).click();
  await page.getByRole("combobox", { name: "Let an agent act for Maria Santos" }).click();
  await page.getByRole("option", { name: "Front Desk Bot" }).click();
  await expect(page.locator('[data-grant="maria:front-desk-bot"]')).toContainText("Agreed");
  await page.keyboard.press("Escape");

  const agent = await asAgent("front-desk-bot", "maria");
  const appts = await agent.call("list_appointments");
  expect(appts.refused).toBe(false);
  expect(appts.text).toContain("Diabetes follow-up");
  expect(appts.text).not.toContain("Therapy session");
  const labs = await agent.call("search_labs");
  expect(labs.refused).toBe(true);
  expect(labs.text).toContain("not in the Front Desk role");

  // Stop, then measure how long until the agent's call is refused.
  await page.getByRole("link", { name: "Agents" }).click();
  const stop = row.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  const clicked = Date.now();
  await stop.click();
  let refusedAfter = -1;
  for (let i = 0; i < 100; i++) {
    const r = await agent.call("list_appointments");
    if (r.refused) {
      expect(r.text).toContain("agent stopped by admin");
      refusedAfter = Date.now() - clicked;
      break;
    }
  }
  writeFileSync("test-results/stop-latency.txt", `${refusedAfter} ms\n`);
  test.info().annotations.push({ type: "stop → refusal", description: `${refusedAfter} ms` });
  expect(refusedAfter).toBeGreaterThan(0);
  expect(refusedAfter).toBeLessThan(1000);
  await expect(row.getByText("Stopped")).toBeVisible();
  await agent.close();
});

test("Activity shows the allowed and the refused calls with the right sentences", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "Activity" }).click();
  await page.getByRole("combobox", { name: "Filter by agent" }).click();
  await page.getByRole("option", { name: "Front Desk Bot" }).click();
  const rows = page.locator("tr[data-receipt]");
  await expect(
    rows
      .filter({
        hasText:
          "Front Desk Bot read 2 appointments for Maria Santos. 1 record was withheld (mental-health records are always private).",
      })
      .first(),
  ).toBeVisible();
  await expect(
    rows.filter({
      hasText:
        "REFUSED: Front Desk Bot tried to read Maria Santos's lab results: not in the Front Desk role.",
    }),
  ).toHaveCount(1);
  await expect(
    rows
      .filter({
        hasText:
          "REFUSED: Front Desk Bot tried to read Maria Santos's appointments: agent stopped by admin.",
      })
      .first(),
  ).toBeVisible();
  await expect(
    rows
      .filter({ hasText: "agent stopped by admin" })
      .first()
      .getByRole("link", { name: /AuditEvent/ }),
  ).toBeVisible();
  // previews are hidden unless asked for
  await expect(rows.filter({ hasText: "PREVIEW" })).toHaveCount(0);

  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText("Receipt chain intact")).toBeVisible();
});

test("the admin can add a passkey and sign in with it", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await signIn(page);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/\/admin\/agents/);
});
