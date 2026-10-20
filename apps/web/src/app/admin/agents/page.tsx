"use client";

import { AppWindow, Copy, Eye, Play, Plus, Square } from "lucide-react";
import { type SubmitEvent, useState } from "react";
import { toast } from "sonner";
import { AgentAppsDialog } from "@/components/agent-apps";
import { PageHeader, timeAgo } from "@/components/page-header";
import { PreviewDialog } from "@/components/preview";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { type Agent, api, type FhirServer, type Role, useApi } from "@/lib/api";

function RegisterAgent({ roles, onDone }: { roles: Role[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    roleId: "",
    allowClaudeCode: true,
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    try {
      const a = await api<Agent>("/admin/agents", { method: "POST", json: form });
      toast.success(`${a.name} registered`, { description: a.mcpUrl });
      setOpen(false);
      setForm({ name: "", description: "", roleId: "", allowClaudeCode: true });
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Register agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Register an agent</DialogTitle>
            <DialogDescription>
              The agent gets its own gateway URL and a FHIR Device record. Its role decides the most
              it may ever do.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-description">What it does</Label>
            <Textarea
              id="agent-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label>Role</Label>
            <Select value={form.roleId} onValueChange={(roleId) => setForm({ ...form, roleId })}>
              <SelectTrigger aria-label="Role">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={form.allowClaudeCode}
              onCheckedChange={(on) => setForm({ ...form, allowClaudeCode: on === true })}
            />
            Let Claude Code connect as this agent
          </Label>
          <DialogFooter>
            <Button type="submit" disabled={!form.name || !form.roleId}>
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AgentsPage() {
  const agents = useApi<Agent[]>("/admin/agents", { pollMs: 5000 });
  const roles = useApi<Role[]>("/admin/roles");
  const servers = useApi<FhirServer[]>("/admin/fhir-servers");

  async function setServer(a: Agent, value: string) {
    try {
      await api(`/admin/agents/${a.id}`, {
        method: "PATCH",
        json: { fhirServerId: value === "home" ? null : value },
      });
      await agents.reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  const [preview, setPreview] = useState<Agent | null>(null);
  const [apps, setApps] = useState<Agent | null>(null);

  async function setStatus(a: Agent, verb: "stop" | "resume") {
    try {
      await api(`/admin/agents/${a.id}/${verb}`, { method: "POST" });
      toast.success(
        verb === "stop" ? `${a.name} stopped. Its next call will be refused.` : `${a.name} resumed`,
      );
      await agents.reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each AI the clinic lets in. Stop takes effect on the agent's very next call."
        actions={<RegisterAgent roles={roles.data ?? []} onDone={agents.reload} />}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Records from</TableHead>
            <TableHead>Gateway URL</TableHead>
            <TableHead>Last activity</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(agents.data ?? []).map((a) => (
            <TableRow key={a.id} data-agent={a.id}>
              <TableCell>
                <div className="font-medium">{a.name}</div>
                {a.description && (
                  <div className="max-w-xs truncate text-xs text-muted-foreground">
                    {a.description}
                  </div>
                )}
              </TableCell>
              <TableCell>{a.roleName}</TableCell>
              <TableCell>
                <Badge
                  variant={a.status === "active" ? "secondary" : "destructive"}
                  data-status={a.status}
                >
                  {a.status === "active" ? "Active" : "Stopped"}
                </Badge>
              </TableCell>
              <TableCell>
                <Select value={a.fhirServerId ?? "home"} onValueChange={(v) => setServer(a, v)}>
                  <SelectTrigger aria-label={`Records for ${a.name}`} size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="home">aipass&apos;s FHIR server</SelectItem>
                    {(servers.data ?? [])
                      .filter((s) => s.enabled || s.id === a.fhirServerId)
                      .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  title={a.mcpUrl}
                  className="flex max-w-80 items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    void navigator.clipboard?.writeText(a.mcpUrl);
                    toast.success("Copied");
                  }}
                >
                  <span className="truncate">{a.mcpUrl}</span>
                  <Copy className="size-3 shrink-0" />
                </button>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {timeAgo(a.lastActivity)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setApps(a)}>
                    <AppWindow /> Apps
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPreview(a)}>
                    <Eye /> Preview
                  </Button>
                  {a.status === "active" ? (
                    <Button variant="destructive" size="sm" onClick={() => setStatus(a, "stop")}>
                      <Square /> Stop
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setStatus(a, "resume")}>
                      <Play /> Resume
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {apps && <AgentAppsDialog agent={apps} onClose={() => setApps(null)} />}
      {preview && (
        <PreviewDialog
          title={`Preview: ${preview.name}`}
          description="What this agent sees right now: its role, the person's grant and the record labels, all applied."
          target={{ agentId: preview.id }}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
