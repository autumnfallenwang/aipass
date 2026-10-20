/**
 * Prints the FHIR base URL of the local SMART launcher's simulated EHR
 * (`docker compose -f deploy/compose.yaml --profile smart up -d`), for a
 * standalone patient launch that skips the EHR's login and lands on a patient.
 * Paste it into Admin → FHIR servers. Local development only.
 *
 *   pnpm smart:url            # Maria, client "aipass" / "launcher-dev-secret"
 *   pnpm smart:url --patient john
 */
import { parseArgs } from "node:util";
import { smartLauncherFhirUrl } from "../packages/fhir/src/launcher.ts";

const { values } = parseArgs({
  options: {
    patient: { type: "string", default: "maria" },
    launcher: {
      type: "string",
      default: process.env.SMART_LAUNCHER_URL ?? "http://localhost:8090",
    },
    "client-id": { type: "string", default: "aipass" },
    "client-secret": { type: "string", default: "launcher-dev-secret" },
  },
});

process.stdout.write(
  `${smartLauncherFhirUrl({
    launcher: values.launcher ?? "",
    patient: values.patient ?? "maria",
    clientId: values["client-id"] ?? "",
    clientSecret: values["client-secret"] ?? "",
  })}\n`,
);
