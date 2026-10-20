// Checks a running `docker compose up` stack from outside (S7, CI): the web
// app answers, an admin can be created (or signs in), and the health check,
// run through the public origin, grades A. Plain Node, no dependencies.
//
//   node scripts/stack-check.mjs [http://localhost:3000]
const web = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
// On a fresh stack this account becomes the admin; on one that has an admin already, pass theirs.
const admin = {
  name: "Stack check",
  email: process.env.ADMIN_EMAIL ?? "stack-check@example.org",
  password: process.env.ADMIN_PASSWORD ?? "stack-check-password-1",
};

async function call(path, init = {}) {
  const res = await fetch(`${web}${path}`, {
    ...init,
    headers: { origin: web, "content-type": "application/json", ...init.headers },
  });
  return res;
}

const cookie = (res) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const health = await call("/health");
if (!health.ok) throw new Error(`web /health: ${health.status}`);

let res = await call("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify(admin) });
if (!res.ok) {
  res = await call("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  });
}
if (!res.ok) throw new Error(`couldn't sign in as the admin: ${res.status} ${await res.text()}`);

const checked = await call("/api/admin/check", {
  method: "POST",
  headers: { cookie: cookie(res) },
});
if (!checked.ok) {
  throw new Error(
    `running the check: ${checked.status} ${await checked.text()} (is this account the admin?)`,
  );
}
const report = await checked.json();
for (const r of report.results ?? [])
  console.info(`${r.status.padEnd(7)} ${r.id}${r.status === "pass" ? "" : `: ${r.detail}`}`);
console.info(`grade ${report.grade}`);
if (report.grade !== "A") process.exit(1);
