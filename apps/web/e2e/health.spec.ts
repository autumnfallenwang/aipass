/**
 * S4: the admin runs the health check against this install's own gateway
 * from the browser, and every probe passes.
 */
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

test("the admin runs the health check and gets an A", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Health check" }).click();
  await page.getByRole("button", { name: "Run the check" }).click();
  await expect(page.getByTestId("grade")).toHaveText("A", { timeout: 30_000 });
  await expect(page.locator("tr[data-probe]")).toHaveCount(16);
  await expect(page.locator('tr[data-probe][data-status="pass"]')).toHaveCount(16);
  // the probe agents are cleaned up afterwards
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByText("Health check (all groups)")).toHaveCount(0);
});
