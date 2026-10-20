/**
 * S6: a hospital's own login (Keycloak, the stand-in) as a trusted
 * connection. People sign in with it and land on their own aipass account,
 * linked by a verified email. Needs `docker compose --profile keycloak up -d`.
 */
import { expect, test } from "@playwright/test";
import { E2E } from "./env.ts";
import { ensureLogin, MARIA, signIn } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://localhost:8180/realms/sunrise";

test("the admin connects the hospital's login", async ({ page }) => {
  await signIn(page);
  await ensureLogin(page, "maria", MARIA);
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByLabel("Name").fill("Sunrise Clinic login");
  await page.getByLabel("Issuer URL").fill(KEYCLOAK);
  await page.getByLabel("Audience its tokens carry for aipass").fill("aipass");
  await page.getByLabel("Sign-in client ID (optional)").fill("aipass-login");
  await page.getByLabel("Sign-in client secret (optional)").fill("aipass-login-dev-secret");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const row = page.locator('tr[data-connection="sunrise-clinic-login"]');
  await expect(row).toContainText("Trusted");
  await expect(row).toContainText("yes");
});

test("Maria signs in with the hospital's login and lands on her own My AIs", async ({
  browser,
}) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with Sunrise Clinic login" }).click();
  await expect(page).toHaveURL(/localhost:8180\/realms\/sunrise/);
  await page.getByLabel(/username/i).fill("maria");
  await page.getByLabel("Password", { exact: true }).fill("maria-kc-password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(`${E2E.web}/my-ais`);
  await expect(page.getByText("may act for Maria Santos")).toBeVisible();
});

for (const [who, username, password, code] of [
  [
    "someone whose email the hospital hasn't verified",
    "mallory",
    "mallory-kc-password",
    "email_not_verified",
  ],
  ["someone with no aipass login", "john", "john-kc-password", "no_account"],
] as const) {
  test(`${who} is not let in`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in with Sunrise Clinic login" }).click();
    await page.getByLabel(/username/i).fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(new RegExp(`error=${code}`));
    const me = await page.request.get(`${E2E.web}/api/me`);
    expect(me.status()).toBe(401);
  });
}

test("disabling the connection stops a sign-in already under way", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin);
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with Sunrise Clinic login" }).click();
  await expect(page).toHaveURL(/localhost:8180\/realms\/sunrise/);
  // the admin switches it off while Maria is at the hospital's login page
  const off = await admin.request.post(
    `${E2E.web}/api/admin/connections/sunrise-clinic-login/disable`,
  );
  expect(off.status()).toBe(200);
  await page.getByLabel(/username/i).fill("maria");
  await page.getByLabel("Password", { exact: true }).fill("maria-kc-password");
  await page.getByRole("button", { name: /sign in/i }).click();
  // Keycloak is on an internal host, so its origin stops being trusted first
  // (discovery_failed); for a public login, the resolver refuses it
  // (connection_disabled, tested in the api's exchange tests).
  await expect(page).toHaveURL(/error=(discovery_failed|connection_disabled)/);
  expect((await page.request.get(`${E2E.web}/api/me`)).status()).toBe(401);
  // and its button is gone
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in with Sunrise Clinic login" })).toHaveCount(
    0,
  );
  await admin.request.post(`${E2E.web}/api/admin/connections/sunrise-clinic-login/enable`);
});
