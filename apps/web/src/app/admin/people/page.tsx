"use client";

import { ACTION_TITLES, GROUP_TITLES, type Group, type Permission } from "@aipass/shared";
import { Plus } from "lucide-react";
import { type SubmitEvent, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { type Agent, api, type Grant, type Person, type Role, useApi } from "@/lib/api";

function permTitle(p: Permission): string {
  const [g, a] = p.split(":") as [Group, keyof typeof ACTION_TITLES];
  return `${GROUP_TITLES[g]}${a === "read" ? "" : ` (${ACTION_TITLES[a].toLowerCase()})`}`;
}

function AddPerson({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ displayName: "", fhirRef: "Patient/" });
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    try {
      await api("/admin/persons", { method: "POST", json: form });
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus /> Add test person
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a test person</DialogTitle>
            <DialogDescription>
              Synthetic data only. Link them to a Patient (or Practitioner) in the FHIR server.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="person-name">Name</Label>
            <Input
              id="person-name"
              required
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="person-ref">FHIR reference</Label>
            <Input
              id="person-ref"
              required
              value={form.fhirRef}
              onChange={(e) => setForm({ ...form, fhirRef: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button type="submit">Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GrantRow(props: {
  person: Person;
  grant: Grant;
  ceiling: Permission[];
  onChange: () => void;
}) {
  const { person, grant, ceiling } = props;
  const outside = grant.permissions.filter((p) => !ceiling.includes(p));

  async function set(permissions: Permission[]) {
    try {
      await api(`/admin/persons/${person.id}/grants/${grant.agentId}`, {
        method: "PUT",
        json: { permissions },
      });
      props.onChange();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function status(verb: "revoke" | "restore") {
    await api(`/admin/persons/${person.id}/grants/${grant.agentId}/${verb}`, { method: "POST" });
    toast.success(
      verb === "revoke"
        ? `${grant.agentName} can no longer act for ${person.displayName}`
        : "Restored",
    );
    props.onChange();
  }

  return (
    <div className="rounded-lg border p-3" data-grant={`${person.id}:${grant.agentId}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="font-medium">{grant.agentName}</div>
        <div className="flex items-center gap-2">
          <Badge variant={grant.status === "active" ? "secondary" : "destructive"}>
            {grant.status === "active" ? "Agreed" : "Revoked"}
          </Badge>
          {grant.status === "active" ? (
            <Button size="sm" variant="destructive" onClick={() => status("revoke")}>
              Revoke
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => status("restore")}>
              Restore
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {ceiling.map((p) => (
          <Label key={p} className="flex items-center gap-2 font-normal">
            <Checkbox
              disabled={grant.status !== "active"}
              checked={grant.permissions.includes(p)}
              onCheckedChange={(on) =>
                set(on ? [...grant.permissions, p] : grant.permissions.filter((x) => x !== p))
              }
            />
            {permTitle(p)}
          </Label>
        ))}
        {ceiling.length === 0 && (
          <span className="text-sm text-muted-foreground">
            The agent&apos;s role allows nothing.
          </span>
        )}
      </div>
      {outside.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Also agreed, but outside the role (so never used): {outside.map(permTitle).join(", ")}
        </p>
      )}
    </div>
  );
}

export default function PeoplePage() {
  const persons = useApi<Person[]>("/admin/persons");
  const agents = useApi<Agent[]>("/admin/agents");
  const roles = useApi<Role[]>("/admin/roles");
  const ceilingOf = (agentId: string) => {
    const roleId = agents.data?.find((a) => a.id === agentId)?.roleId;
    return roles.data?.find((r) => r.id === roleId)?.permissions ?? [];
  };

  async function addGrant(person: Person, agentId: string) {
    await api(`/admin/persons/${person.id}/grants/${agentId}`, {
      method: "PUT",
      json: { permissions: ceilingOf(agentId) },
    });
    await persons.reload();
  }

  return (
    <>
      <PageHeader
        title="People"
        description="Who agents act for, and what each person agreed to. Until people sign in themselves (S3), the admin manages test persons here."
        actions={<AddPerson onDone={persons.reload} />}
      />
      <div className="grid gap-4">
        {(persons.data ?? []).map((p) => {
          const without = (agents.data ?? []).filter(
            (a) => !p.grants.some((g) => g.agentId === a.id),
          );
          return (
            <Card key={p.id} data-person={p.id}>
              <CardHeader>
                <CardTitle>{p.displayName}</CardTitle>
                <CardDescription className="font-mono">{p.fhirRef}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                {p.grants.map((g) => (
                  <GrantRow
                    key={g.id}
                    person={p}
                    grant={g}
                    ceiling={ceilingOf(g.agentId)}
                    onChange={persons.reload}
                  />
                ))}
                {p.grants.length === 0 && (
                  <p className="text-sm text-muted-foreground">No agent may act for this person.</p>
                )}
                {without.length > 0 && (
                  <Select onValueChange={(agentId) => addGrant(p, agentId)} value="">
                    <SelectTrigger
                      className="w-64"
                      aria-label={`Let an agent act for ${p.displayName}`}
                    >
                      <SelectValue placeholder="Let another agent act for them…" />
                    </SelectTrigger>
                    <SelectContent>
                      {without.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
