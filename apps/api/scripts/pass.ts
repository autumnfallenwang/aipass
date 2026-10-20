/**
 * Mints a dev pass (S1). For Claude Code's `headersHelper`, use `--header`,
 * which prints the JSON header object it expects.
 *
 *   pnpm pass --agent diabetes-coach --person maria
 *   pnpm pass --agent diabetes-coach --person maria --ttl 60 --header
 */
import { parseArgs } from "node:util";
import { createDb } from "@aipass/db";
import { config } from "../src/config.ts";
import { mintPass, PassError } from "../src/pass.ts";

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    person: { type: "string" },
    ttl: { type: "string" },
    header: { type: "boolean", default: false },
  },
});

if (!values.agent || !values.person) {
  console.error(
    "usage: pnpm pass --agent <agent-id> --person <person-id> [--ttl seconds] [--header]",
  );
  process.exit(2);
}

const { db, close } = createDb(config.databaseUrl);
try {
  const pass = await mintPass(db, {
    agentId: values.agent,
    personId: values.person,
    ttlSeconds: values.ttl ? Number(values.ttl) : undefined,
  });
  process.stdout.write(
    values.header
      ? `${JSON.stringify({ Authorization: `Bearer ${pass.token}` })}\n`
      : `${pass.token}\n`,
  );
} catch (err) {
  console.error(err instanceof PassError ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
