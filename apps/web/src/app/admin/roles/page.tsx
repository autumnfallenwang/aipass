"use client";

import { GROUP_TITLES } from "@aipass/shared";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type SubmitEvent, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api, type Role, useApi } from "@/lib/api";

function NewRole() {
  const router = useRouter();
  const [name, setName] = useState("");

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    try {
      const r = await api<Role>("/admin/roles", {
        method: "POST",
        json: { name, description: null, rules: [], patientFields: [] },
      });
      router.push(`/admin/roles/${r.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New role
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New role</DialogTitle>
            <DialogDescription>
              A role starts with nothing allowed. You choose what to turn on next.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="role-name">Name</Label>
            <Input id="role-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function RolesPage() {
  const roles = useApi<Role[]>("/admin/roles");
  return (
    <>
      <PageHeader
        title="Roles"
        description="A role is the ceiling: the most an AI with that role may ever do. A person can agree to less, never more."
        actions={<NewRole />}
      />
      <div className="grid gap-4 md:grid-cols-2">
        {(roles.data ?? []).map((r) => (
          <Link key={r.id} href={`/admin/roles/${r.id}`}>
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader>
                <CardTitle>{r.name}</CardTitle>
                {r.description && <CardDescription>{r.description}</CardDescription>}
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1">
                {r.rules.filter((x) => x.read || x.propose || x.write).length === 0 && (
                  <span className="text-sm text-muted-foreground">Nothing allowed yet</span>
                )}
                {r.rules
                  .filter((x) => x.read || x.propose || x.write)
                  .map((x) => (
                    <Badge key={x.group} variant="secondary">
                      {GROUP_TITLES[x.group]}
                      {x.propose ? " · propose" : ""}
                      {x.write ? " · change" : ""}
                    </Badge>
                  ))}
                <span className="ml-auto text-xs text-muted-foreground">
                  {r.agentCount ?? 0} agent{r.agentCount === 1 ? "" : "s"}
                </span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
