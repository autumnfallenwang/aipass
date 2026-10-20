/**
 * S3 validation, end to end: an MCP client that only knows the gateway URL
 * gets a pass through OAuth (discovery, registration, PKCE); Maria signs in,
 * sees what the AI asks for, unticks vitals, and later revokes it.
 * See docs/PLAN.md § S3.
 */
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "./env.ts";
import { MARIA, signIn } from "./helpers.ts";
import { CALLBACK, claimsOf, oauthAgent } from "./oauth-agent.ts";

test.describe.configure({ mode: "serial" });

const coach = oauthAgent("diabetes-coach");

async function signInAsMaria(page: Page) {
  await page.getByLabel("Email").fill(MARIA.email);
  await page.getByLabel("Password").fill(MARIA.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("the admin gives Maria a login", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "People" }).click();
  const maria = page.locator('[data-person="maria"]');
  await maria.getByRole("button", { name: "Give a login" }).click();
  await page.getByLabel("Email").fill(MARIA.email);
  await page.getByLabel("Temporary password").fill(MARIA.password);
  await page.getByRole("button", { name: "Create login" }).click();
  await expect(maria.getByText("Has a login")).toBeVisible();
});

test("an app the admin hasn't approved can't get a pass for the agent", async () => {
  const url = await coach.start();
  expect(new URL(url).searchParams.get("resource")).toBe(
    `${E2E.gateway}/agents/diabetes-coach/mcp`,
  );
  expect(coach.clientId()).toBeTruthy();
  // Better Auth refuses the resource before anyone signs in or consents, and
  // sends the app back an RFC 8707 error.
  // (A browser gets a 302; a script gets the same answer as {redirect, url}.)
  const res = await fetch(url, { redirect: "manual" });
  const location =
    res.headers.get("location") ?? ((await res.json()) as { url?: string }).url ?? "";
  expect(location.startsWith(CALLBACK)).toBe(true);
  expect(new URL(location).searchParams.get("error")).toBe("invalid_target");
});

test("Maria consents (unticking vitals) once the admin approves the app; the tools work with zero manual token handling", async ({
  page,
  browser,
}) => {
  // Admin: allow the newly registered app to act as the Diabetes Coach.
  await signIn(page);
  await page
    .locator('tr[data-agent="diabetes-coach"]')
    .getByRole("button", { name: "Apps" })
    .click();
  await page.getByRole("combobox", { name: "Allow a registered app" }).click();
  await page.getByRole("option", { name: /aipass e2e client/ }).click();
  await expect(page.getByTestId("allowed-apps")).toContainText(coach.clientId());

  // Maria, in her own browser: sign in, see the request, untick vitals, allow.
  const url = await coach.start();
  const maria = await (await browser.newContext()).newPage();
  let callback = "";
  await maria.route(`${CALLBACK}**`, async (route) => {
    callback = route.request().url();
    await route.fulfill({ body: "ok" });
  });
  await maria.goto(url);
  await expect(maria.getByText("An AI app is asking to act for you")).toBeVisible();
  await signInAsMaria(maria);
  await expect(maria.getByTestId("consent-title")).toHaveText(
    "Diabetes Coach wants to act for you",
  );
  await expect(maria.getByText("Approved by Sunrise Clinic as a Diabetes Coach")).toBeVisible();
  await expect(maria.getByText("It will never see mental-health")).toBeVisible();
  await maria.getByRole("checkbox", { name: "see your vital signs" }).click();
  await maria.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => callback).toContain("code=");

  await coach.finish(callback);
  const labs = await coach.call("search_labs", { code: "4548-4" });
  expect(labs.refused).toBe(false);
  expect(labs.text).toContain("6.9 %");
  const vitals = await coach.call("search_vitals");
  expect(vitals.refused).toBe(true);
  expect(vitals.text).toContain("Maria hasn't agreed to vital signs");
});

test("the access token is the pass: Maria + the coach, the coach's door only, 5 minutes", async () => {
  const c = claimsOf(coach.accessToken());
  expect(c.iss).toBe(`${E2E.web}/api/auth`);
  expect(c.act).toEqual({ sub: "diabetes-coach" });
  expect(c.patient).toBe("maria");
  expect([c.aud].flat()).toContain(`${E2E.gateway}/agents/diabetes-coach/mcp`);
  expect((c.exp as number) - (c.iat as number)).toBe(300);
  expect(c.client_id).toBe(coach.clientId());
});

test("a pass minted for one agent is refused at another agent's door", async () => {
  const res = await fetch(`${E2E.gateway}/agents/scheduling-assistant/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coach.accessToken()}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error_description: string }).error_description).toBe(
    "wrong audience",
  );
});

test("a pass for Maria can't read John", async () => {
  const r = await coach.call("get_notes", { id: "john-note-1" });
  expect(r.refused).toBe(true);
  expect(r.text).toContain("not Maria's record");
});

test("when the admin withdraws the app, its next call is refused", async ({ page }) => {
  await signIn(page);
  await page
    .locator('tr[data-agent="diabetes-coach"]')
    .getByRole("button", { name: "Apps" })
    .click();
  await page.getByRole("button", { name: `Remove ${coach.clientId()}` }).click();
  await expect(page.getByTestId("allowed-apps")).not.toContainText(coach.clientId());
  const r = await coach.call("search_labs");
  expect(r.refused).toBe(true);
  expect(r.text).toContain("this app isn't approved to act as Diabetes Coach");
  // put it back for the next test
  await page.getByRole("combobox", { name: "Allow a registered app" }).click();
  await page.getByRole("option", { name: /aipass e2e client/ }).click();
  await expect(page.getByTestId("allowed-apps")).toContainText(coach.clientId());
  expect((await coach.call("search_labs")).refused).toBe(false);
});

test("Maria revokes on My AIs: the next call is refused and the refresh token stops working", async ({
  browser,
}) => {
  const maria = await (await browser.newContext()).newPage();
  await maria.goto("/my-ais");
  await signInAsMaria(maria);
  const card = maria.locator('[data-ai="diabetes-coach"]');
  await expect(card.locator('[data-status="active"]')).toBeVisible();
  await expect(card.getByRole("checkbox", { name: "see your vital signs" })).not.toBeChecked();
  await expect(card).toContainText(
    "REFUSED: Diabetes Coach tried to read Maria Santos's vital signs",
  );
  await card.getByRole("button", { name: "Revoke" }).click();
  await card.getByRole("button", { name: "Yes, revoke" }).click();
  await expect(card.locator('[data-status="revoked"]')).toBeVisible();

  const r = await coach.call("search_labs");
  expect(r.refused).toBe(true);
  expect(r.text).toContain("Maria hasn't agreed to lab results");

  const res = await fetch(`${E2E.web}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: coach.refreshToken(),
      client_id: coach.clientId(),
    }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  await coach.close();
});
