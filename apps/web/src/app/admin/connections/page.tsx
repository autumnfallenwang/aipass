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
import { api, useApi } from "@/lib/api";

type Connection = {
  id: string;
  name: string;
  issuer: string;
  audience: string;
  ssoProviderId: string | null;
  enabled: boolean;
};

function AddConnection({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    name: "",
    issuer: "",
    audience: "aipass",
    clientId: "",
    clientSecret: "",
  });
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    try {
      await api("/admin/connections", {
        method: "POST",
        json: {
          name: f.name,
          issuer: f.issuer,
          audience: f.audience,
          ...(f.clientId
            ? { clientId: f.clientId, clientSecret: f.clientSecret || undefined }
            : {}),
        },
      });
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  const field = (k: keyof typeof f, label: string, type = "text", required = false) => (
    <div className="grid gap-2">
      <Label htmlFor={`conn-${k}`}>{label}</Label>
      <Input
        id={`conn-${k}`}
        type={type}
        required={required}
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
      />
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add connection
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Connect a login system</DialogTitle>
            <DialogDescription>
              Any OpenID Connect provider: a hospital&apos;s own login, Google, Keycloak… aipass
              reads its keys from discovery. Add a client to let people and admins sign in with it.
            </DialogDescription>
          </DialogHeader>
          {field("name", "Name", "text", true)}
          {field("issuer", "Issuer URL", "url", true)}
          {field("audience", "Audience its tokens carry for aipass", "text", true)}
          {field("clientId", "Sign-in client ID (optional)")}
          {field("clientSecret", "Sign-in client secret (optional)", "password")}
          <DialogFooter>
            <Button type="submit">Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ConnectionsPage() {
  const list = useApi<Connection[]>("/admin/connections");
  async function toggle(c: Connection) {
    await api(`/admin/connections/${c.id}/${c.enabled ? "disable" : "enable"}`, { method: "POST" });
    await list.reload();
  }
  return (
    <>
      <PageHeader
        title="Connections"
        description="Login systems aipass trusts. Their tokens can be exchanged for passes (headless agents), and people can sign in with them. Nothing else is trusted."
        actions={<AddConnection onDone={list.reload} />}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Issuer</TableHead>
            <TableHead>Audience</TableHead>
            <TableHead>Sign-in</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(list.data ?? []).map((c) => (
            <TableRow key={c.id} data-connection={c.id}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell className="font-mono text-xs">{c.issuer}</TableCell>
              <TableCell className="font-mono text-xs">{c.audience}</TableCell>
              <TableCell>{c.ssoProviderId ? "yes" : "token exchange only"}</TableCell>
              <TableCell className="text-right">
                <Badge variant={c.enabled ? "secondary" : "outline"} className="mr-2">
                  {c.enabled ? "Trusted" : "Disabled"}
                </Badge>
                <Button size="sm" variant="outline" onClick={() => toggle(c)}>
                  {c.enabled ? "Disable" : "Enable"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
