"use client";

import { Plus } from "lucide-react";
import { type SubmitEvent, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, type FhirServer, useApi } from "@/lib/api";

function AddServer({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", baseUrl: "", clientId: "", clientSecret: "", scope: "" });
  const [redirect, setRedirect] = useState<string | null>(null);
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    try {
      const made = await api<{ redirectUri: string }>("/admin/fhir-servers", {
        method: "POST",
        json: { ...f, clientSecret: f.clientSecret || undefined, scope: f.scope || undefined },
      });
      setRedirect(made.redirectUri);
      setF({ name: "", baseUrl: "", clientId: "", clientSecret: "", scope: "" });
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  const field = (k: keyof typeof f, label: string, type = "text", required = true) => (
    <div className="grid gap-2">
      <Label htmlFor={`srv-${k}`}>{label}</Label>
      <Input
        id={`srv-${k}`}
        type={type}
        required={required}
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
      />
    </div>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setRedirect(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add FHIR server
        </Button>
      </DialogTrigger>
      <DialogContent>
        {redirect ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Added</DialogTitle>
              <DialogDescription>
                Register this redirect URI with the server&apos;s SMART app, then set which agents
                read from it on the Agents page.
              </DialogDescription>
            </DialogHeader>
            <code className="rounded bg-muted p-2 text-xs" data-testid="redirect-uri">
              {redirect}
            </code>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Add a FHIR server</DialogTitle>
              <DialogDescription>
                An EHR that speaks SMART on FHIR (Epic, Cerner, any SMART server). Each person
                connects their own record once; aipass then reads it for their AIs under the same
                rules.
              </DialogDescription>
            </DialogHeader>
            {field("name", "Name")}
            {field("baseUrl", "FHIR base URL", "url")}
            {field("clientId", "SMART client ID")}
            {field("clientSecret", "SMART client secret (confidential apps)", "password", false)}
            {field("scope", "Scopes (leave empty for SMART v2 read + add readings)", "text", false)}
            <DialogFooter>
              <Button type="submit">Add</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function FhirServersPage() {
  const list = useApi<FhirServer[]>("/admin/fhir-servers");
  async function toggle(s: FhirServer) {
    await api(`/admin/fhir-servers/${s.id}/${s.enabled ? "disable" : "enable"}`, {
      method: "POST",
    });
    await list.reload();
  }
  return (
    <>
      <PageHeader
        title="FHIR servers"
        description="Where records live besides aipass's own server. The gateway is the SMART app: tokens stay in its vault, and agents never see them."
        actions={<AddServer onDone={list.reload} />}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>FHIR base URL</TableHead>
            <TableHead>Client</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(list.data ?? []).map((s) => (
            <TableRow key={s.id} data-server={s.id}>
              <TableCell className="font-medium">{s.name}</TableCell>
              <TableCell className="max-w-80 truncate font-mono text-xs" title={s.baseUrl}>
                {s.baseUrl}
              </TableCell>
              <TableCell className="text-xs">
                <span className="font-mono">{s.clientId}</span>{" "}
                {s.confidential ? "(confidential)" : "(public)"}
              </TableCell>
              <TableCell className="text-right">
                <Badge variant={s.enabled ? "secondary" : "outline"} className="mr-2">
                  {s.enabled ? "On" : "Off"}
                </Badge>
                <Button size="sm" variant="outline" onClick={() => toggle(s)}>
                  {s.enabled ? "Switch off" : "Switch on"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
