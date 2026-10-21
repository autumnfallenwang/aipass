"use client";

import {
  ACTION_TITLES,
  firstName,
  GROUP_TITLES,
  type Group,
  type Permission,
} from "@aipass/shared";
import { FileText, KeyRound, Pause, Play, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { type SubmitEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { timeAgo } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Agent, api, type PersonDetail, type Receipt, type Role, useApi } from "@/lib/api";

const first = firstName;

function permTitle(p: Permission): string {
  const [g, a] = p.split(":") as [Group, keyof typeof ACTION_TITLES];
  return `${GROUP_TITLES[g]}${a === "read" ? "" : ` (${ACTION_TITLES[a].toLowerCase()})`}`;
}

function Overview(props: { p: PersonDetail; onChange: () => void; onRemoved: () => void }) {
  const { p } = props;
  const [name, setName] = useState(p.displayName);
  const [confirm, setConfirm] = useState("");

  async function patch(json: Record<string, unknown>, done: string) {
    try {
      await api(`/admin/persons/${p.id}`, { method: "PATCH", json });
      toast.success(done);
      props.onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove() {
    try {
      const r = await api<{ receiptsKept: number }>(`/admin/persons/${p.id}`, {
        method: "DELETE",
      });
      toast.success(
        `${p.displayName} removed. Their ${r.receiptsKept} receipt${r.receiptsKept === 1 ? "" : "s"} stay in Activity.`,
      );
      props.onRemoved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <h3 className="font-medium">Records</h3>
        {p.records.map((r) => (
          <div
            key={`${r.serverId}:${r.ref}`}
            className="flex items-start gap-2 rounded-md border p-3"
            data-record={r.serverId}
          >
            <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="font-medium">{r.serverName}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">{r.ref}</div>
              <div className="text-xs text-muted-foreground">
                {r.linkedBy === "admin"
                  ? "Picked by the admin from that server"
                  : `Connected by ${first(p.displayName)}, with that server's own sign-in`}
              </div>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Records at an EHR are only ever connected by the person. aipass never matches records by
          name or birth date.
        </p>
      </section>

      <section className="grid gap-2">
        <h3 className="font-medium">Access</h3>
        {p.status === "active" ? (
          <div className="flex items-center justify-between gap-2 rounded-md border p-3">
            <span>Every AI acting for {first(p.displayName)} is checked as usual.</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patch(
                  { status: "suspended" },
                  `${p.displayName} paused. Every AI acting for them is refused from its next call.`,
                )
              }
            >
              <Pause /> Pause
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-300 p-3">
            <span>Paused: every AI acting for {first(p.displayName)} is refused.</span>
            <Button
              size="sm"
              onClick={() => patch({ status: "active" }, `${p.displayName} resumed.`)}
            >
              <Play /> Resume
            </Button>
          </div>
        )}
      </section>

      <form
        className="grid gap-2"
        onSubmit={(e: SubmitEvent) => {
          e.preventDefault();
          void patch({ displayName: name }, "Renamed.");
        }}
      >
        <Label htmlFor="person-name">Name</Label>
        <div className="flex gap-2">
          <Input id="person-name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" variant="outline" disabled={!name.trim() || name === p.displayName}>
            Save
          </Button>
        </div>
      </form>

      <section className="grid gap-2 rounded-md border border-destructive/30 p-3">
        <h3 className="font-medium text-destructive">Remove {p.displayName}</h3>
        <p className="text-xs text-muted-foreground">
          Their AI permissions, connected records, chats and login go. Their receipts stay:
          they&apos;re the audit trail. Type their name to confirm.
        </p>
        <div className="flex gap-2">
          <Input
            aria-label="Type their name to confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <Button variant="destructive" disabled={confirm !== p.displayName} onClick={remove}>
            <Trash2 /> Remove
          </Button>
        </div>
      </section>
    </div>
  );
}

function LoginTab({ p, onChange }: { p: PersonDetail; onChange: () => void }) {
  const [form, setForm] = useState({ email: "", password: "" });
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    try {
      await api(`/admin/persons/${p.id}/login`, { method: "POST", json: form });
      toast.success(`${p.displayName} can now sign in, consent, chat and see "My AIs"`);
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  if (p.login) {
    return (
      <div className="grid gap-2 rounded-md border p-3" data-testid="login-info">
        <Badge variant="secondary" className="w-fit">
          Has a login
        </Badge>
        <p>
          <span className="text-muted-foreground">Email:</span> {p.login.email}
        </p>
        <p>
          <span className="text-muted-foreground">Passkeys:</span> {p.login.passkeys}
        </p>
        <p>
          <span className="text-muted-foreground">Since:</span>{" "}
          {new Date(p.login.createdAt).toLocaleDateString()}
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-3">
      <p className="text-muted-foreground">
        With a login, {first(p.displayName)} decides what each AI may do for them, chats with them,
        and can revoke them. Give them a temporary password.
      </p>
      <div className="grid gap-2">
        <Label htmlFor="login-email">Email</Label>
        <Input
          id="login-email"
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="login-password">Temporary password</Label>
        <Input
          id="login-password"
          type="password"
          minLength={10}
          required
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </div>
      <Button type="submit" className="justify-self-start">
        <KeyRound /> Create login
      </Button>
    </form>
  );
}

function AisTab({ p, onChange }: { p: PersonDetail; onChange: () => void }) {
  const agents = useApi<Agent[]>("/admin/agents");
  const roles = useApi<Role[]>("/admin/roles");
  const without = (agents.data ?? []).filter((a) => !p.grants.some((g) => g.agentId === a.id));
  const ceilingOf = (agentId: string) => {
    const roleId = agents.data?.find((a) => a.id === agentId)?.roleId;
    return roles.data?.find((r) => r.id === roleId)?.permissions ?? [];
  };

  async function call(path: string, init: { method: string; json?: unknown }, done?: string) {
    try {
      await api(`/admin/persons/${p.id}/grants/${path}`, init);
      if (done) toast.success(done);
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="grid gap-3">
      {!p.isTest && (
        <p className="rounded-md bg-muted p-3 text-muted-foreground">
          Only {first(p.displayName)} can agree to what an AI may do for them, on the consent page
          or My AIs. You can revoke it.
        </p>
      )}
      {p.grants.map((g) => (
        <div key={g.id} className="rounded-lg border p-3" data-grant={`${p.id}:${g.agentId}`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="font-medium">{g.agentName}</div>
              <div className="text-xs text-muted-foreground">
                {g.setBy === "person"
                  ? `Agreed by ${first(p.displayName)}`
                  : "Set by the admin (test person)"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={g.status === "active" ? "secondary" : "destructive"}>
                {g.status === "active" ? "Agreed" : "Revoked"}
              </Badge>
              {g.status === "active" ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    call(
                      `${g.agentId}/revoke`,
                      { method: "POST" },
                      `${g.agentName} can no longer act for ${p.displayName}`,
                    )
                  }
                >
                  Revoke
                </Button>
              ) : (
                p.isTest && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => call(`${g.agentId}/restore`, { method: "POST" }, "Restored")}
                  >
                    Restore
                  </Button>
                )
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {g.ceiling.map((perm) =>
              p.isTest ? (
                <Label key={perm} className="flex items-center gap-2 font-normal">
                  <Checkbox
                    disabled={g.status !== "active"}
                    checked={g.permissions.includes(perm)}
                    onCheckedChange={(on) =>
                      call(g.agentId, {
                        method: "PUT",
                        json: {
                          permissions: on
                            ? [...g.permissions, perm]
                            : g.permissions.filter((x) => x !== perm),
                        },
                      })
                    }
                  />
                  {permTitle(perm)}
                </Label>
              ) : (
                <span
                  key={perm}
                  className={
                    g.permissions.includes(perm) ? "" : "text-muted-foreground line-through"
                  }
                >
                  {permTitle(perm)}
                </span>
              ),
            )}
          </div>
        </div>
      ))}
      {p.grants.length === 0 && <p className="text-muted-foreground">No AI may act for them.</p>}
      {p.isTest && without.length > 0 && (
        <Select
          value=""
          onValueChange={(agentId) =>
            // A test person starts with everything the agent's role allows, as before.
            call(agentId, { method: "PUT", json: { permissions: ceilingOf(agentId) } })
          }
        >
          <SelectTrigger className="w-64" aria-label={`Let an agent act for ${p.displayName}`}>
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
    </div>
  );
}

function ActivityTab({ p }: { p: PersonDetail }) {
  const [items, setItems] = useState<Receipt[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(before?: number) {
    setLoading(true);
    try {
      const r = await api<{ items: Receipt[]; nextBefore: number | null }>(
        `/admin/receipts?person=${encodeURIComponent(p.id)}&limit=20${before ? `&before=${before}` : ""}`,
      );
      setItems((xs) => (before ? [...xs, ...r.items] : r.items));
      setNext(r.nextBefore);
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load again only for another person
  useEffect(() => {
    void load();
  }, [p.id]);

  return (
    <div className="grid gap-2">
      {items.map((r) => (
        <div key={r.id} className="flex gap-2 rounded-md border p-2" data-receipt={r.id}>
          {r.decision === "allow" ? (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          ) : (
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <div className="min-w-0">
            <p>{r.sentence}</p>
            <p className="text-xs text-muted-foreground">
              {timeAgo(r.ts)}
              {r.clientName ? ` · via ${r.clientName}` : ""}
            </p>
          </div>
        </div>
      ))}
      {items.length === 0 && !loading && (
        <p className="text-muted-foreground">No requests for them yet.</p>
      )}
      {next && (
        <Button variant="outline" className="justify-self-start" onClick={() => load(next)}>
          Older
        </Button>
      )}
    </div>
  );
}

function ApprovalsTab({ p }: { p: PersonDetail }) {
  if (!p.approvals.length) return <p className="text-muted-foreground">Nothing is waiting.</p>;
  return (
    <div className="grid gap-2">
      {p.approvals.map((a) => (
        <div key={a.id} className="rounded-md border p-3">
          <p>
            <span className="font-medium">{a.agentName}</span>: {a.summary}
          </p>
          <p className="text-xs text-muted-foreground">
            {a.forThem ? `Waiting for ${first(p.displayName)}'s OK` : "They're the approver"} ·
            expires {new Date(a.expiresAt).toLocaleTimeString()}
          </p>
        </div>
      ))}
    </div>
  );
}

/** One person, in a panel over the People list (S9). */
export function PersonPanel(props: {
  personId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const d = useApi<PersonDetail>(`/admin/persons/${encodeURIComponent(props.personId)}`);
  const changed = async () => {
    await d.reload();
    props.onChanged();
  };
  const p = d.data;
  return (
    <Sheet open onOpenChange={(o) => !o && props.onClose()}>
      <SheetContent data-testid="person-panel" aria-describedby={undefined}>
        {d.error && <p className="text-destructive">{d.error.message}</p>}
        {p && (
          <>
            <SheetHeader>
              <SheetTitle>{p.displayName}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{p.records[0]?.ref}</span>
                {p.isTest && <Badge variant="outline">Test person</Badge>}
                {p.status === "suspended" && <Badge variant="destructive">Paused</Badge>}
                {p.login ? (
                  <Badge variant="secondary">Has a login</Badge>
                ) : (
                  <Badge variant="outline">No login</Badge>
                )}
              </SheetDescription>
            </SheetHeader>
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="login">Login</TabsTrigger>
                <TabsTrigger value="ais">AIs ({p.grants.length})</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="approvals">Approvals ({p.approvals.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="pt-3">
                <Overview
                  key={p.displayName}
                  p={p}
                  onChange={changed}
                  onRemoved={() => {
                    props.onChanged();
                    props.onClose();
                  }}
                />
              </TabsContent>
              <TabsContent value="login" className="pt-3">
                <LoginTab p={p} onChange={changed} />
              </TabsContent>
              <TabsContent value="ais" className="pt-3">
                <AisTab p={p} onChange={changed} />
              </TabsContent>
              <TabsContent value="activity" className="pt-3">
                <ActivityTab p={p} />
              </TabsContent>
              <TabsContent value="approvals" className="pt-3">
                <ApprovalsTab p={p} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
