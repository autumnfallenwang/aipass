/**
 * Plays Maria approving a proposed change with a passkey (a Chrome virtual
 * authenticator stands in for her phone). Not part of CI.
 *
 *   pnpm --filter @aipass/web exec tsx e2e/manual/approve.ts <approve-url> [--deny]
 */
import { chromium } from "@playwright/test";

const url = process.argv[2];
if (!url) throw new Error("usage: approve.ts <approve-url> [--deny]");
const deny = process.argv.includes("--deny");
const origin = new URL(url).origin;

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
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
await page.goto(`${origin}/login?next=${encodeURIComponent(new URL(url).pathname)}`);
await page.getByLabel("Email").fill(process.env.PERSON_EMAIL ?? "maria@example.org");
await page.getByLabel("Password").fill(process.env.PERSON_PASSWORD ?? "maria-demo-password");
await page.getByRole("button", { name: "Sign in", exact: true }).click();
await page.getByTestId("approval-summary").waitFor();
console.info("Maria sees:", await page.getByTestId("approval-summary").textContent());
if (deny) {
  await page.getByRole("button", { name: "Deny" }).click();
} else {
  // this browser's passkey is new, so Maria adds it first (once), then approves
  if (await page.getByRole("button", { name: "Add a passkey first" }).isVisible()) {
    await page.getByRole("button", { name: "Add a passkey first" }).click();
  }
  await page.getByRole("button", { name: "Approve with passkey" }).click();
}
await page
  .getByTestId("approval-status")
  .filter({ hasText: deny ? "Denied" : "Approved" })
  .waitFor();
console.info("Status:", await page.getByTestId("approval-status").textContent());
await browser.close();
