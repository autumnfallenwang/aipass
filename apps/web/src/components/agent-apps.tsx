"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Agent, api, useApi } from "@/lib/api";

export const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";

type AllowedApp = { clientId: string; name: string | null; seen: boolean };
type KnownApp = { clientId: string; name: string | null; kind: string };

/** Which AI apps (OAuth clients) may connect as this agent. */
export function AgentAppsDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const allowed = useApi<AllowedApp[]>(`/admin/agents/${agent.id}/clients`);
  const known = useApi<KnownApp[]>("/admin/oauth-clients");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);

  async function headless() {
    try {
      setSecret(await api(`/admin/agents/${agent.id}/headless-client`, { method: "POST" }));
      await allowed.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function allow(id: string) {
    try {
      await api(`/admin/agents/${agent.id}/clients`, { method: "POST", json: { clientId: id } });
      setClientId("");
      await allowed.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove(id: string) {
    await api(`/admin/agents/${agent.id}/clients?clientId=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    toast.success("Removed. That app's next call as this agent will be refused.");
    await allowed.reload();
  }

  const notYet = (known.data ?? []).filter(
    (k) => !(allowed.data ?? []).some((a) => a.clientId === k.clientId),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Apps that may connect as {agent.name}</DialogTitle>
          <DialogDescription>
            An AI app signs in with OAuth and asks for this agent&apos;s gateway URL. Only apps
            listed here get a pass for it; removing one takes effect on its next call.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2" data-testid="allowed-apps">
          {(allowed.data ?? []).map((a) => (
            <li key={a.clientId} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {a.clientId === CLAUDE_CODE ? "Claude Code" : (a.name ?? "Unnamed app")}
                </div>
                <div
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={a.clientId}
                >
                  {a.clientId}
                </div>
              </div>
              {!a.seen && <Badge variant="outline">not connected yet</Badge>}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${a.clientId}`}
                onClick={() => remove(a.clientId)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
          {allowed.data?.length === 0 && (
            <li className="text-sm text-muted-foreground">No app may connect as this agent.</li>
          )}
        </ul>
        <div className="grid gap-2">
          {!(allowed.data ?? []).some((a) => a.clientId === CLAUDE_CODE) && (
            <Button
              variant="outline"
              className="justify-self-start"
              onClick={() => allow(CLAUDE_CODE)}
            >
              <Plus /> Allow Claude Code
            </Button>
          )}
          {notYet.length > 0 && (
            <Select value="" onValueChange={allow}>
              <SelectTrigger aria-label="Allow a registered app">
                <SelectValue placeholder="Allow an app that has registered…" />
              </SelectTrigger>
              <SelectContent>
                {notYet.map((k) => (
                  <SelectItem key={k.clientId} value={k.clientId}>
                    {k.name ?? "Unnamed app"} · {k.kind} · {k.clientId.slice(0, 40)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" className="justify-self-start" onClick={headless}>
            <Plus /> Create a headless client (token exchange)
          </Button>
          {secret && (
            <div
              className="rounded-md border border-amber-300 p-3 text-xs"
              data-testid="headless-secret"
            >
              <p className="mb-1 font-medium">
                Shown once. The agent authenticates with these at the token endpoint:
              </p>
              <p className="font-mono">client_id: {secret.clientId}</p>
              <p className="font-mono">client_secret: {secret.clientSecret}</p>
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (clientId.trim()) void allow(clientId.trim());
            }}
          >
            <Input
              aria-label="Client ID"
              placeholder="…or paste a client ID or metadata-document URL"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={!clientId.trim()}>
              Allow
            </Button>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
