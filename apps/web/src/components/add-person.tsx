"use client";

import { Plus, Search } from "lucide-react";
import { type SubmitEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type FhirServer, useApi } from "@/lib/api";

type Found = {
  ref: string;
  name: string | null;
  birthDate: string | null;
  gender: string | null;
  identifier: string | null;
  takenBy: { id: string; displayName: string } | null;
};
type Results = { total: number | null; next: string | null; items: Found[] };

/**
 * Adds a person from a record picked at a FHIR server (S9, D19): the admin
 * searches, never types an id, and a record already someone's says whose.
 */
export function AddPerson({ onAdded }: { onAdded: (personId: string) => void }) {
  const servers = useApi<FhirServer[]>("/admin/fhir-servers");
  const own = (servers.data ?? []).find((s) => s.kind === "aipass");
  const [open, setOpen] = useState(false);
  const [serverId, setServerId] = useState("");
  const [type, setType] = useState<"Patient" | "Practitioner">("Patient");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [picked, setPicked] = useState<Found | null>(null);
  const [name, setName] = useState("");
  const [isTest, setIsTest] = useState(false);
  const [busy, setBusy] = useState(false);
  const server = serverId || own?.id || "";

  function reset() {
    setQ("");
    setResults(null);
    setPicked(null);
    setName("");
    setIsTest(false);
  }

  async function search(e?: SubmitEvent, page?: string) {
    e?.preventDefault();
    setBusy(true);
    try {
      const qs = new URLSearchParams({
        type,
        ...(page ? { page } : q.trim() ? { q: q.trim() } : {}),
      });
      const r = await api<Results>(`/admin/fhir-servers/${server}/patients?${qs}`);
      setResults(page && results ? { ...r, items: [...results.items, ...r.items] } : r);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!picked) return;
    setBusy(true);
    try {
      const made = await api<{ id: string; displayName: string }>("/admin/persons", {
        method: "POST",
        json: { serverId: server, ref: picked.ref, displayName: name || undefined, isTest },
      });
      toast.success(`${made.displayName} added`);
      setOpen(false);
      reset();
      onAdded(made.id);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chosen = (servers.data ?? []).find((s) => s.id === server);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add person
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a person</DialogTitle>
          <DialogDescription>
            Find their record and pick it. A person is always linked to a real record, never to a
            typed id.
          </DialogDescription>
        </DialogHeader>

        {!picked ? (
          <form onSubmit={search} className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              <Select
                value={server}
                onValueChange={(v) => {
                  setServerId(v);
                  setResults(null);
                }}
              >
                <SelectTrigger className="w-56" aria-label="Server to search">
                  <SelectValue placeholder="Server" />
                </SelectTrigger>
                <SelectContent>
                  {(servers.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id} disabled={s.kind !== "aipass"}>
                      {s.name}
                      {s.kind !== "aipass" ? " (people connect their own)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={(v) => setType(v as "Patient" | "Practitioner")}>
                <SelectTrigger className="w-40" aria-label="Kind of record">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Patient">Patients</SelectItem>
                  <SelectItem value="Practitioner">Practitioners</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="Search records"
                placeholder="Name, or an identifier such as an MRN"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <Button type="submit" variant="outline" disabled={busy || !server}>
                <Search /> Search
              </Button>
            </div>
            {chosen?.kind === "smart" && (
              <p className="text-xs text-muted-foreground">
                aipass can&apos;t search {chosen.name}: people connect their own record there, from
                My AIs.
              </p>
            )}
            {results && (
              <div
                className="max-h-80 overflow-y-auto rounded-md border"
                data-testid="record-results"
              >
                {results.items.map((r) => (
                  <div
                    key={r.ref}
                    data-ref={r.ref}
                    className="flex items-center justify-between gap-2 border-b p-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{r.name ?? "(no name)"}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {[r.ref, r.birthDate, r.gender, r.identifier].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {r.takenBy ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Already {r.takenBy.displayName}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Choose ${r.name ?? r.ref}`}
                        onClick={() => {
                          setPicked(r);
                          setName(r.name ?? "");
                        }}
                      >
                        Choose
                      </Button>
                    )}
                  </div>
                ))}
                {results.items.length === 0 && (
                  <p className="p-3 text-muted-foreground">No records match.</p>
                )}
                {results.next && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={() => search(undefined, results.next ?? undefined)}
                  >
                    More
                  </Button>
                )}
              </div>
            )}
          </form>
        ) : (
          <div className="grid gap-3">
            <div className="rounded-md border p-3">
              <div className="font-mono text-xs text-muted-foreground">{picked.ref}</div>
              <div className="text-xs text-muted-foreground">
                {[picked.birthDate, picked.gender, picked.identifier].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-person-name">Name</Label>
              <Input id="new-person-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Label className="flex items-start gap-2 font-normal">
              <Checkbox checked={isTest} onCheckedChange={(on) => setIsTest(on === true)} />
              <span>
                A test person (synthetic, for demos and checks). Only for test persons can you set
                what an AI may do; everyone else decides that themselves.
              </span>
            </Label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPicked(null)}>
                Back
              </Button>
              <Button onClick={add} disabled={busy}>
                Add {name || "person"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
