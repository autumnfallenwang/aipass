import type { Reference, Resource } from "./types.ts";

/**
 * Normalises a reference to `Type/id`. Absolute URLs and `_history` suffixes
 * are reduced; anything that doesn't look like a literal reference returns null.
 */
export function normaliseRef(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = ref.match(/(?:^|\/)([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function patientRef(r: unknown): string | null {
  const n = normaliseRef((r as Reference | undefined)?.reference);
  return n?.startsWith("Patient/") ? n : null;
}

/**
 * Every patient a record points at. A record in Maria's compartment points
 * at Maria and only Maria. Unknown shapes return [] (and are refused).
 */
export function patientRefsOf(r: Resource): string[] {
  const refs = new Set<string>();
  const add = (x: string | null) => {
    if (x) refs.add(x);
  };
  switch (r.resourceType) {
    case "Patient":
      if (r.id) refs.add(`Patient/${r.id}`);
      break;
    case "Appointment": {
      const participants = (r.participant as { actor?: Reference }[] | undefined) ?? [];
      for (const p of participants) add(patientRef(p.actor));
      break;
    }
    default:
      add(patientRef(r.subject));
      add(patientRef(r.patient));
  }
  // A subject that names something other than a Patient (a Group, say) is not
  // in anyone's compartment as far as we're concerned.
  const subject = normaliseRef((r.subject as Reference | undefined)?.reference);
  if (subject && !subject.startsWith("Patient/")) refs.add(subject);
  return [...refs];
}
