import { expect, type Page } from "@playwright/test";
import { E2E } from "./env.ts";

export const ADMIN = {
  name: "Ada Admin",
  email: "admin@sunrise-clinic.example",
  password: "correct horse battery",
};
export const MARIA = { email: "maria@sunrise-clinic.example", password: "maria-e2e-password" };

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
