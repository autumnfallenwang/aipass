"use client";

import { Stethoscope } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type CareTeam, type OpenPatientRef, useApi } from "@/lib/api";

/**
 * The patient a staff member has open with one AI (S10, D21). The choices are
 * their care team at the record system; every pass the AI gets names the one
 * picked, and the gateway refuses any other patient's record.
 */
export function OpenPatient({
  agentId,
  current,
  onChanged,
  disabled,
}: {
  agentId: string;
  current: OpenPatientRef | null;
  onChanged: (patient: OpenPatientRef) => void;
  disabled?: boolean;
}) {
  const care = useApi<CareTeam>("/person/patients");
  const patients = care.data?.patients ?? [];

  async function choose(ref: string) {
    try {
      const r = await api<{ patient: OpenPatientRef }>(`/person/ais/${agentId}/patient`, {
        method: "PUT",
        json: { ref },
      });
      onChanged(r.patient);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="open-patient">
      <Stethoscope className="size-4 text-muted-foreground" />
      <span className="text-muted-foreground">Patient you have open:</span>
      <Select value={current?.ref ?? ""} onValueChange={choose} disabled={disabled}>
        <SelectTrigger className="w-72" aria-label="Patient you have open">
          <SelectValue placeholder="Choose a patient in your care" />
        </SelectTrigger>
        <SelectContent>
          {patients.map((p) => (
            <SelectItem key={p.ref} value={p.ref}>
              {p.name ?? p.ref}
              {p.birthDate ? ` · born ${p.birthDate}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {care.data && patients.length === 0 && (
        <span className="text-muted-foreground">
          No patients in your care at the record system.
        </span>
      )}
    </div>
  );
}
