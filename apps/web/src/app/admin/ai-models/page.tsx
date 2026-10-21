"use client";

import { CheckCircle2, Cloud, FlaskConical, Network, Plus, Trash2, XCircle } from "lucide-react";
import { type SubmitEvent, useEffect, useState } from "react";
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
import {
  api,
  DATA_WORDS,
  type DataLocation,
  type ModelConnection,
  type ProbeResult,
  useApi,
} from "@/lib/api";

function DataBadge({ where }: { where: DataLocation }) {
  return (
    <Badge variant={where === "network" ? "secondary" : "outline"} data-location={where}>
      {where === "network" ? <Network /> : <Cloud />} {DATA_WORDS[where]}
    </Badge>
  );
}

function AddConnection({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const empty = { name: "", baseUrl: "", apiKey: "", dataLocation: "" as DataLocation | "" };
  const [f, setF] = useState(empty);
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    try {
      await api("/admin/model-connections", {
        method: "POST",
        json: { ...f, apiKey: f.apiKey || undefined },
      });
      toast.success(`${f.name} added. Test it, then choose it for an agent.`);
      setF(empty);
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add model
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a model</DialogTitle>
            <DialogDescription>
              Any endpoint that speaks the OpenAI chat format with tool calling: a hosted provider,
              a gateway, or a model server you run (Ollama, vLLM…).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="model-name">Name</Label>
            <Input
              id="model-name"
              required
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="model-url">Base URL</Label>
            <Input
              id="model-url"
              type="url"
              required
              placeholder="https://…/v1"
              value={f.baseUrl}
              onChange={(e) => setF({ ...f, baseUrl: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="model-key">API key (if it needs one)</Label>
            <Input
              id="model-key"
              type="password"
              autoComplete="off"
              value={f.apiKey}
              onChange={(e) => setF({ ...f, apiKey: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Stored sealed. Nobody can read it back, including you.
            </p>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Where does what the AI reads go?</legend>
            {(["network", "cloud"] as const).map((where) => (
              <label
                key={where}
                className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary"
              >
                <input
                  type="radio"
                  name="dataLocation"
                  value={where}
                  required
                  className="mt-1"
                  checked={f.dataLocation === where}
                  onChange={() => setF({ ...f, dataLocation: where })}
                />
                <span>
                  <span className="font-medium">{DATA_WORDS[where]}</span>
                  <span className="block text-muted-foreground">
                    {where === "network"
                      ? "A model you run yourself. Records never leave your network."
                      : "A hosted model. Records go to that provider under your agreement with them. A gateway on your network that forwards to one counts as cloud."}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="submit" disabled={!f.dataLocation}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TestDialog({ conn, onClose }: { conn: ModelConnection; onClose: () => void }) {
  const [listed, setListed] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ProbeResult>(`/admin/model-connections/${conn.id}/test`, { method: "POST", json: {} })
      .then((r) => {
        setListed(r);
        setModel(r.models[0] ?? "");
      })
      .catch((e: Error) => setError(e.message));
  }, [conn.id]);

  async function tryTool() {
    setBusy(true);
    try {
      setListed(
        await api<ProbeResult>(`/admin/model-connections/${conn.id}/test`, {
          method: "POST",
          json: { model },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tc = listed?.toolCall;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Test {conn.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{conn.baseUrl}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm" data-testid="model-test">
          {!listed && !error && <p className="text-muted-foreground">Asking for its models…</p>}
          {error && (
            <p className="flex gap-2 text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}
          {listed && (
            <>
              <p className="flex gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                It answers, and offers {listed.models.length} model
                {listed.models.length === 1 ? "" : "s"}.
              </p>
              <div className="grid gap-2">
                <Label>Try a tool call with</Label>
                <div className="flex gap-2">
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger aria-label="Model to test" className="flex-1">
                      <SelectValue placeholder="Choose a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {listed.models.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button onClick={tryTool} disabled={!model || busy}>
                    <FlaskConical /> {busy ? "Trying…" : "Try"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The built-in chat reads records through tool calls, so the model must make them.
                </p>
              </div>
              {tc && (
                <p
                  className={`flex gap-2 ${tc.ok ? "" : "text-destructive"}`}
                  data-testid="tool-call-result"
                >
                  {tc.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0" />
                  )}
                  {tc.model}: {tc.detail} ({(tc.ms / 1000).toFixed(1)} s).
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

export default function AiModelsPage() {
  const list = useApi<ModelConnection[]>("/admin/model-connections");
  const [testing, setTesting] = useState<ModelConnection | null>(null);

  async function toggle(c: ModelConnection) {
    await api(`/admin/model-connections/${c.id}`, {
      method: "PATCH",
      json: { enabled: !c.enabled },
    });
    await list.reload();
  }

  async function remove(c: ModelConnection) {
    try {
      await api(`/admin/model-connections/${c.id}`, { method: "DELETE" });
      toast.success(
        c.usedBy.length
          ? `${c.name} removed. ${c.usedBy.join(", ")} now ${c.usedBy.length === 1 ? "has" : "have"} no model.`
          : `${c.name} removed.`,
      );
      await list.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="AI models"
        description="The models the built-in chat can use. The model is only the brain: it reaches records through the gateway like any AI app, so switching models never changes what an AI may see. It does change where what the AI reads goes."
        actions={<AddConnection onDone={list.reload} />}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Base URL</TableHead>
            <TableHead>Data</TableHead>
            <TableHead>Used by</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(list.data ?? []).map((c) => (
            <TableRow key={c.id} data-model-connection={c.id}>
              <TableCell className="font-medium">
                {c.name}
                {c.hasKey && <span className="ml-2 text-xs text-muted-foreground">(key set)</span>}
              </TableCell>
              <TableCell className="max-w-72 truncate font-mono text-xs" title={c.baseUrl}>
                {c.baseUrl}
              </TableCell>
              <TableCell>
                <DataBadge where={c.dataLocation} />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {c.usedBy.length ? c.usedBy.join(", ") : "No agent yet"}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Badge variant={c.enabled ? "secondary" : "outline"}>
                    {c.enabled ? "On" : "Off"}
                  </Badge>
                  <Button size="sm" variant="outline" onClick={() => setTesting(c)}>
                    <FlaskConical /> Test
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toggle(c)}>
                    {c.enabled ? "Switch off" : "Switch on"}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${c.name}`}
                    onClick={() => remove(c)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {list.data?.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-sm text-muted-foreground">
                No models yet. Add one to let people chat with their AIs here.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {testing && <TestDialog conn={testing} onClose={() => setTesting(null)} />}
    </>
  );
}
