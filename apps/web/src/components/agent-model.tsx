"use client";

import { Cloud, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Agent, api, DATA_WORDS, type ModelConnection, type Role } from "@/lib/api";

const NONE = "none";

type Choice = { connectionId: string; model: string };

/** One model choice: a connection, then one of the models it offers (read live). */
function ModelPicker(props: {
  label: string;
  connections: ModelConnection[];
  value: Choice;
  onChange: (c: Choice) => void;
  optional?: boolean;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { connectionId } = props.value;

  useEffect(() => {
    setModels(null);
    setError(null);
    if (connectionId === NONE) return;
    api<{ models: string[] }>(`/admin/model-connections/${connectionId}/models`)
      .then((r) => setModels(r.models))
      .catch((e: Error) => setError(e.message));
  }, [connectionId]);

  const conn = props.connections.find((c) => c.id === connectionId);
  // The saved model may not be listed (the endpoint changed); keep it choosable.
  const options = models
    ? [...new Set([...(props.value.model ? [props.value.model] : []), ...models])]
    : [];
  return (
    <div className="grid gap-2">
      <Label>{props.label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={connectionId}
          onValueChange={(v) => props.onChange({ connectionId: v, model: "" })}
        >
          <SelectTrigger aria-label={`${props.label}: connection`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{props.optional ? "No fallback" : "No model"}</SelectItem>
            {props.connections
              .filter((c) => c.enabled || c.id === connectionId)
              .map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select
          value={props.value.model}
          onValueChange={(model) => props.onChange({ connectionId, model })}
          disabled={connectionId === NONE || !models}
        >
          <SelectTrigger aria-label={`${props.label}: model`}>
            <SelectValue
              placeholder={connectionId === NONE ? "" : models ? "Choose" : "Loading…"}
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {conn && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {conn.dataLocation === "network" ? (
            <Network className="size-3" />
          ) : (
            <Cloud className="size-3" />
          )}
          What it reads {DATA_WORDS[conn.dataLocation].toLowerCase()}.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** The model the built-in chat uses for this agent, and one to fall back on. */
export function AgentModelDialog(props: {
  agent: Agent;
  role: Role | undefined;
  connections: ModelConnection[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { agent } = props;
  const [primary, setPrimary] = useState<Choice>({
    connectionId: agent.modelConnectionId ?? NONE,
    model: agent.model ?? "",
  });
  const [fallback, setFallback] = useState<Choice>({
    connectionId: agent.fallbackConnectionId ?? NONE,
    model: agent.fallbackModel ?? "",
  });

  async function save() {
    const pick = (c: Choice) => (c.connectionId === NONE ? null : c);
    const p = pick(primary);
    const f = pick(fallback);
    try {
      await api(`/admin/agents/${agent.id}`, {
        method: "PATCH",
        json: {
          modelConnectionId: p?.connectionId ?? null,
          model: p?.model || null,
          fallbackConnectionId: f?.connectionId ?? null,
          fallbackModel: f?.model || null,
        },
      });
      toast.success(`${agent.name} uses ${p ? p.model : "no model"} in the built-in chat`);
      props.onSaved();
      props.onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const incomplete =
    (primary.connectionId !== NONE && !primary.model) ||
    (fallback.connectionId !== NONE && !fallback.model);

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Model for {agent.name}</DialogTitle>
          <DialogDescription>
            What the built-in chat uses when someone talks to this AI. If the model can&apos;t be
            reached, the fallback answers instead.
            {props.role?.networkModelsOnly &&
              ` The ${props.role.name} role only allows models that keep data on your network.`}
          </DialogDescription>
        </DialogHeader>
        {props.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No models yet. Add one on the AI models page first.
          </p>
        ) : (
          <div className="grid gap-4">
            <ModelPicker
              label="Model"
              connections={props.connections}
              value={primary}
              onChange={setPrimary}
            />
            <ModelPicker
              label="Fallback"
              connections={props.connections}
              value={fallback}
              onChange={setFallback}
              optional
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={incomplete}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
