"use client";

import { GROUP_TITLES } from "@aipass/shared";
import { EyeOff, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Person, type Preview, type PreviewGroup, useApi } from "@/lib/api";

export type PreviewTarget = { roleId: string } | { agentId: string };

function RecordLine({ r }: { r: Record<string, string | number> }) {
  const { ref: _ref, ...rest } = r;
  const entries = Object.entries(rest).filter(([k]) => k !== "status");
  return (
    <li className="flex flex-wrap gap-x-3 gap-y-0.5 border-b py-1.5 text-sm last:border-0">
      {entries.map(([k, v]) => (
        <span key={k}>
          <span className="text-muted-foreground">{k}:</span> {String(v).slice(0, 140)}
        </span>
      ))}
    </li>
  );
}

function GroupCard({ g }: { g: PreviewGroup }) {
  return (
    <section
      className="rounded-lg border p-3"
      data-group={g.group}
      data-decision={g.decision}
      aria-label={GROUP_TITLES[g.group]}
    >
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-medium">{GROUP_TITLES[g.group]}</h3>
        {g.decision === "allow" ? (
          <Badge variant="secondary">{g.records.length} visible</Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            <EyeOff /> hidden
          </Badge>
        )}
      </div>
      {g.decision === "refuse" ? (
        <p className="text-sm text-muted-foreground">{g.reason}</p>
      ) : (
        <>
          {g.records.length === 0 && <p className="text-sm text-muted-foreground">No records.</p>}
          <ul>
            {g.records.map((r) => (
              <RecordLine key={String(r.ref)} r={r} />
            ))}
          </ul>
          {g.withheld.count > 0 && (
            <p
              className="mt-2 flex items-center gap-1 text-xs text-amber-700"
              data-withheld={g.withheld.count}
            >
              <Lock className="size-3" /> {g.withheld.count} withheld:{" "}
              {g.withheld.reasons.join("; ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Choose a test person, see their chart exactly as the agent (or role) would. */
export function PreviewPanel({ target }: { target: PreviewTarget }) {
  const persons = useApi<Person[]>("/admin/persons");
  const [personId, setPersonId] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(target);

  useEffect(() => {
    if (!personId && persons.data?.[0]) setPersonId(persons.data[0].id);
  }, [persons.data, personId]);

  useEffect(() => {
    if (!personId) return;
    setPreview(null);
    setError(null);
    api<Preview>("/admin/preview", { method: "POST", json: { ...JSON.parse(key), personId } })
      .then(setPreview)
      .catch((e: Error) => setError(e.message));
  }, [key, personId]);

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Label>Test person</Label>
        <Select value={personId} onValueChange={setPersonId}>
          <SelectTrigger className="w-56" aria-label="Test person">
            <SelectValue placeholder="Choose a person" />
          </SelectTrigger>
          <SelectContent>
            {(persons.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!preview && !error && <p className="text-sm text-muted-foreground">Loading the chart…</p>}
      {preview && (
        <div className="grid gap-2 sm:grid-cols-2" data-testid="preview">
          {preview.groups.map((g) => (
            <GroupCard key={g.group} g={g} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PreviewDialog(props: {
  title: string;
  description: string;
  target: PreviewTarget;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <PreviewPanel target={props.target} />
      </DialogContent>
    </Dialog>
  );
}
