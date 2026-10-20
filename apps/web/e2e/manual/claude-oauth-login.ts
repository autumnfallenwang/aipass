/**
 * Real Claude Code, real OAuth: connects Claude Code to an agent with only the
 * gateway URL, and plays the person in a real browser (sign in, untick what
 * they don't want, Allow). Not part of CI: it needs the `claude` CLI.
 *
 *   pnpm --filter @aipass/web exec tsx e2e/manual/claude-oauth-login.ts \
 *     --dir <scratch dir> --name aipass-coach --agent diabetes-coach \
 *     --email maria@example.org --password maria-demo-password --untick "see your vital signs"
 */
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: a } = parseArgs({
  options: {
    dir: { type: "string" },
    name: { type: "string", default: "aipass-coach" },
    agent: { type: "string", default: "diabetes-coach" },
    gateway: { type: "string", default: "http://localhost:3002" },
    email: { type: "string", default: "maria@example.org" },
    password: { type: "string", default: "maria-demo-password" },
    untick: { type: "string", multiple: true, default: [] },
    headed: { type: "boolean", default: false },
  },
});
if (!a.dir) throw new Error("--dir is required (Claude Code's local MCP config is per directory)");
const cwd = a.dir;
const claude = (...args: string[]) => spawnSync("claude", args, { cwd, encoding: "utf8" });

claude("mcp", "remove", a.name, "-s", "local");
const added = claude(
  "mcp",
  "add",
  "--scope",
  "local",
  "--transport",
  "http",
  a.name,
  `${a.gateway}/agents/${a.agent}/mcp`,
);
console.info(added.stdout.trim().split("\n")[0]);

// `script` gives `claude mcp login` a terminal; we read its output and can type into it.
const login = spawn("script", ["-qfec", `claude mcp login ${a.name} --no-browser`, "/dev/null"], {
  cwd,
  env: { ...process.env, COLUMNS: "2000" },
});
let out = "";
const authorizeUrl = await new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no authorize URL in:\n${out}`)), 60_000);
  login.stdout.on("data", (d: Buffer) => {
    // Strip terminal escapes, including OSC 8 hyperlinks (which repeat the URL).
    out += d
      .toString()
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\r/g, "");
    const m = out.match(/(http:\/\/\S+\/api\/auth\/oauth2\/authorize\?\S+)/);
    if (m?.[1]) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
});
console.info("Claude Code asked to authorize:", `${authorizeUrl.slice(0, 120)}…`);
const params = new URL(authorizeUrl).searchParams;
console.info(`  client_id=${params.get("client_id")}  resource=${params.get("resource")}`);

const browser = await chromium.launch({ headless: !a.headed });
const page = await browser.newPage();
let callback: string | null = null;
// Claude Code listens on the redirect URI; we also catch it, in case it doesn't.
await page.route(/\/callback\?/, async (route) => {
  callback = route.request().url();
  await route.fulfill({ status: 200, body: "aipass test: callback captured" });
});
await page.goto(authorizeUrl);
await page.getByLabel("Email").fill(a.email);
await page.getByLabel("Password").fill(a.password);
await page.getByRole("button", { name: "Sign in", exact: true }).click();
await page.getByTestId("consent-title").waitFor();
console.info("Consent page:", await page.getByTestId("consent-title").textContent());
for (const label of a.untick) await page.getByRole("checkbox", { name: label }).click();
await page.getByRole("button", { name: "Allow" }).click();
for (let i = 0; i < 100 && !callback; i++) await page.waitForTimeout(100);
await browser.close();
if (!callback) throw new Error("the browser never reached the callback");
console.info("Callback:", (callback as string).replace(/code=[^&]+/, "code=…"));

login.stdin.write(`${callback}\r`);
const done = await new Promise<boolean>((resolve) => {
  const t = setTimeout(() => resolve(false), 30_000);
  const check = () => {
    if (/Authenticated with/.test(out)) {
      clearTimeout(t);
      resolve(true);
    }
  };
  login.stdout.on("data", check);
  check();
});
login.kill();
console.info(
  done
    ? `Claude Code: authenticated with "${a.name}"`
    : `Claude Code did not finish:\n${out.slice(-800)}`,
);
process.exit(done ? 0 : 1);
