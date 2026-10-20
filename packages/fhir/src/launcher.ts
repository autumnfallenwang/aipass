/**
 * The SMART launcher (`docker compose --profile smart up -d`) simulates an
 * EHR's SMART server in front of aipass's HAPI. Its FHIR base URL carries the
 * simulation settings. This builds one for a standalone patient launch where
 * the "EHR login" is skipped and lands on `patient` (local dev and tests only).
 */
export function smartLauncherFhirUrl(p: {
  /** e.g. http://localhost:8090 */
  launcher: string;
  patient: string;
  clientId: string;
  clientSecret: string;
}): string {
  const sim = [
    3, // patient-standalone
    p.patient,
    "", // provider
    "", // encounter
    1, // skip_login
    1, // skip_auth
    0, // sim_ehr
    "", // scope (any)
    "", // redirect_uris (any)
    p.clientId,
    p.clientSecret,
    "", // auth_error
    "", // jwks_url
    "", // jwks
    1, // confidential-symmetric
    2, // PKCE always
    "", // fhir_server (the launcher's default: aipass's HAPI)
  ];
  const blob = Buffer.from(JSON.stringify(sim), "utf8").toString("base64url");
  return `${p.launcher.replace(/\/$/, "")}/v/r4/sim/${blob}/fhir`;
}
