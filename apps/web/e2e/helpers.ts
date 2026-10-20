import { expect, type Page } from "@playwright/test";
import { E2E } from "./env.ts";

export const ADMIN = {
  name: "Ada Admin",
  email: "admin@sunrise-clinic.example",
  password: "correct horse battery",
};
/** Same email as Maria's account in the stand-in hospital login (Keycloak), so the two link. */
export const MARIA = { email: "maria@example.org", password: "maria-e2e-password" };

/** Gives a person an aipass login through the admin UI, unless they already have one. */
export async function ensureLogin(
  page: Page,
  personId: string,
  who: { email: string; password: string },
) {
  await page.getByRole("link", { name: "People" }).click();
  const card = page.locator(`[data-person="${personId}"]`);
  await expect(
    card.getByText("Has a login").or(card.getByRole("button", { name: "Give a login" })),
  ).toBeVisible();
  if (await card.getByRole("button", { name: "Give a login" }).isVisible()) {
    await card.getByRole("button", { name: "Give a login" }).click();
    await page.getByLabel("Email").fill(who.email);
    await page.getByLabel("Temporary password").fill(who.password);
    await page.getByRole("button", { name: "Create login" }).click();
  }
  await expect(card.getByText("Has a login")).toBeVisible();
}

/** Signs the admin in, creating the account first on a fresh install. */
export async function signIn(page: Page) {
  const { needsAdmin } = (await (await fetch(`${E2E.api}/api/setup`)).json()) as {
    needsAdmin: boolean;
  };
  await page.goto("/login");
  if (needsAdmin) await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page
    .getByRole("button", { name: needsAdmin ? "Create account" : "Sign in", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/agents/);
}
