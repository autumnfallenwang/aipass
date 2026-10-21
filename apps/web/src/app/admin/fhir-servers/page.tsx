"use client";

import { CheckCircle2, Database, FlaskConical, Pencil, Plus, XCircle } from "lucide-react";
import { type SubmitEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, type FhirServer, type FhirTest, useApi } from "@/lib/api";

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
          <Plus /> Add an EHR
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
              <DialogTitle>Add an EHR</DialogTitle>
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

/** aipass's own server: its name, address and the credential aipass signs in with. */
function EditOwnServer(props: { server: FhirServer; onClose: () => void; onSaved: () => void }) {
  const { server } = props;
  const [name, setName] = useState(server.name);
  const [baseUrl, setBaseUrl] = useState(server.baseUrl);
  const [authorization, setAuthorization] = useState("");
  const [removeCredential, setRemoveCredential] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/admin/fhir-servers/${server.id}`, {
        method: "PATCH",
        json: {
          name,
          ...(baseUrl !== server.baseUrl ? { baseUrl } : {}),
          ...(removeCredential ? { authorization: null } : authorization ? { authorization } : {}),
        },
      });
      toast.success("Saved. Every service uses it within a few seconds.");
      props.onSaved();
      props.onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Edit {server.name}</DialogTitle>
            <DialogDescription>
              aipass&apos;s own FHIR server: agents read records here unless they&apos;re pointed at
              an EHR, and every audit record is written here. A new address must answer as FHIR
              before it&apos;s saved.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="own-name">Name</Label>
            <Input id="own-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="own-url">FHIR base URL</Label>
            <Input
              id="own-url"
              type="url"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="own-auth">Authorization header (if the server wants one)</Label>
            <Input
              id="own-auth"
              type="password"
              autoComplete="off"
              placeholder={server.hasCredential ? "Set. Leave empty to keep it" : "e.g. Bearer …"}
              value={authorization}
              disabled={removeCredential}
              onChange={(e) => setAuthorization(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              aipass&apos;s own credential, stored sealed. Agents never see it.
            </p>
            {server.hasCredential && (
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={removeCredential}
                  onCheckedChange={(on) => setRemoveCredential(on === true)}
                />
                Remove the credential
              </Label>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Checking…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TestServer({ server, onClose }: { server: FhirServer; onClose: () => void }) {
  const [r, setR] = useState<FhirTest | null>(null);
  useEffect(() => {
    api<FhirTest>(`/admin/fhir-servers/${server.id}/test`, { method: "POST" })
      .then(setR)
      .catch((e: Error) => setR({ ok: false, error: e.message }));
  }, [server.id]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Test {server.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{server.baseUrl}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm" data-testid="fhir-test">
          {!r && <p className="text-muted-foreground">Asking it what it is…</p>}
          {r && !r.ok && (
            <p className="flex gap-2 text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" /> {r.error}
            </p>
          )}
          {r?.ok && (
            <>
              <p className="flex gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                It answers as FHIR {r.fhirVersion ?? "(version not given)"}
                {r.software ? `, ${r.software}` : ""} ({r.ms} ms).
              </p>
              {r.patients !== null && <p>It holds {r.patients} patient records.</p>}
              {r.smart !== null && (
                <p className={r.smart ? "" : "text-destructive"}>
                  {r.smart
                    ? "Its SMART configuration is there, so people can connect their records."
                    : "It doesn't publish a SMART configuration, so people can't connect their records."}
                </p>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FhirServersPage() {
  const list = useApi<FhirServer[]>("/admin/fhir-servers");
  const [testing, setTesting] = useState<FhirServer | null>(null);
  const [editing, setEditing] = useState<FhirServer | null>(null);
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
        description="Where records live. aipass's own server holds the records agents read by default, the agents' Device records and the audit log. EHRs are read over SMART: tokens stay in the gateway's vault, and agents never see them."
        actions={<AddServer onDone={list.reload} />}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>FHIR base URL</TableHead>
            <TableHead>How aipass signs in</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(list.data ?? []).map((s) => (
            <TableRow key={s.id} data-server={s.id} data-kind={s.kind}>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  {s.name}
                  {s.kind === "aipass" && (
                    <Badge variant="secondary">
                      <Database /> aipass&apos;s own
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="max-w-80 truncate font-mono text-xs" title={s.baseUrl}>
                {s.baseUrl}
              </TableCell>
              <TableCell className="text-xs">
                {s.kind === "aipass" ? (
                  s.hasCredential ? (
                    "With aipass's own credential"
                  ) : (
                    "No credential"
                  )
                ) : (
                  <>
                    SMART, client <span className="font-mono">{s.clientId}</span>{" "}
                    {s.confidential ? "(confidential)" : "(public)"}
                  </>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Badge variant={s.enabled ? "secondary" : "outline"}>
                    {s.kind === "aipass" ? "Always on" : s.enabled ? "On" : "Off"}
                  </Badge>
                  <Button size="sm" variant="outline" onClick={() => setTesting(s)}>
                    <FlaskConical /> Test
                  </Button>
                  {s.kind === "aipass" ? (
                    <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                      <Pencil /> Edit
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => toggle(s)}>
                      {s.enabled ? "Switch off" : "Switch on"}
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {testing && <TestServer server={testing} onClose={() => setTesting(null)} />}
      {editing && (
        <EditOwnServer server={editing} onClose={() => setEditing(null)} onSaved={list.reload} />
      )}
    </>
  );
}
