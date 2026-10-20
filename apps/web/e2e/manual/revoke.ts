/** Plays Maria on "My AIs": revokes one agent. `tsx e2e/manual/revoke.ts diabetes-coach` */
import { chromium } from "@playwright/test";

const agent = process.argv[2] ?? "diabetes-coach";
const b = await chromium.launch();
const p = await b.newPage();
await p.goto("http://localhost:3000/login?next=/my-ais");
await p.getByLabel("Email").fill("maria@example.org");
await p.getByLabel("Password").fill("maria-demo-password");
await p.getByRole("button", { name: "Sign in", exact: true }).click();
const card = p.locator(`[data-ai="${agent}"]`);
await card.waitFor();
console.info("before:", await card.locator("[data-status]").textContent());
await card.getByRole("button", { name: "Revoke" }).click();
await card.getByRole("button", { name: "Yes, revoke" }).click();
await card.locator('[data-status="revoked"]').waitFor();
console.info("after:", await card.locator("[data-status]").textContent());
await b.close();
