import type { FhirClient } from "./client.ts";
import { normaliseRef } from "./compartment.ts";
import type { Resource } from "./types.ts";

/** A patient in a staff member's care, as the record system says. */
export type CarePatient = {
  ref: string;
  name: string | null;
  birthDate: string | null;
  gender: string | null;
};

/** A FHIR HumanName as one line. */
export function humanName(r: Resource): string | null {
  const n = (r.name as { text?: string; given?: string[]; family?: string }[] | undefined)?.[0];
  if (!n) return null;
  return n.text ?? ([...(n.given ?? []), n.family].filter(Boolean).join(" ") || null);
}

type CareTeam = Resource & {
  status?: string;
  subject?: { reference?: string };
  participant?: { member?: { reference?: string } }[];
};

/**
 * The patients in a staff member's care (S10, D21), read from the record
 * system itself: the active CareTeams that list them as a participant. aipass
 * keeps no list of who treats whom. The server's search is checked again here,
 * so a team that doesn't name them, or isn't active, never counts.
 */
export async function careTeamOf(
  fhir: FhirClient,
  practitionerRef: string,
  only?: string,
): Promise<CarePatient[]> {
  const params = new URLSearchParams({
    participant: practitionerRef,
    status: "active",
    _include: "CareTeam:subject",
    _count: "200",
  });
  if (only) params.set("subject", only);
  const bundle = await fhir.search("CareTeam", params);
  const resources = (bundle.entry ?? []).flatMap((e) => (e.resource ? [e.resource] : []));
  const patients = new Map(
    resources.filter((r) => r.resourceType === "Patient").map((p) => [`Patient/${p.id}`, p]),
  );
  const refs = new Set<string>();
  for (const r of resources) {
    if (r.resourceType !== "CareTeam") continue;
    const team = r as CareTeam;
    const subject = normaliseRef(team.subject?.reference);
    const listed = (team.participant ?? []).some(
      (p) => normaliseRef(p.member?.reference) === practitionerRef,
    );
    if (team.status === "active" && listed && subject?.startsWith("Patient/")) refs.add(subject);
  }
  return [...refs]
    .map((ref) => {
      const p = patients.get(ref);
      return {
        ref,
        name: p ? humanName(p) : null,
        birthDate: (p?.birthDate as string | undefined) ?? null,
        gender: (p?.gender as string | undefined) ?? null,
      };
    })
    .sort((a, b) => (a.name ?? a.ref).localeCompare(b.name ?? b.ref));
}
