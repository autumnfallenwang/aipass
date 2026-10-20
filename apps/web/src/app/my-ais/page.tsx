"use client";

import type { Permission } from "@aipass/shared";
import { Ban, KeyRound, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { timeAgo } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api, useApi } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { permissionSentence } from "@/lib/words";

type MyAi = {
  agentId: string;
  name: string;
  description: string | null;
  agentStatus: "active" | "stopped";
  grantStatus: "active" | "revoked";
  ceiling: Permission[];
  permissions: Permission[];
  effective: Permission[];
  lastActivity: string | null;
  revokedAt: string | null;
  recent: { ts: string; decision: "allow" | "refuse"; sentence: string }[];
};

function AiCard({ ai, onChange }: { ai: MyAi; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const active = ai.grantStatus === "active";

  async function setPermissions(permissions: Permission[]) {
    try {
      await api(`/person/ais/${ai.agentId}`, { method: "PUT", json: { permissions } });
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function revoke() {
    await api(`/person/ais/${ai.agentId}/revoke`, { method: "POST" });
    toast.success(`${ai.name} can no longer act for you. Its next request will be refused.`);
    setConfirming(false);
    onChange();
  }

  return (
    <Card data-ai={ai.agentId}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{ai.name}</CardTitle>
            {ai.description && <CardDescription>{ai.description}</CardDescription>}
          </div>
          <Badge variant={active ? "secondary" : "destructive"} data-status={ai.grantStatus}>
            {active ? "Allowed" : "Revoked"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {active ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium">It may:</p>
            {ai.ceiling.map((p) => (
              <Label key={p} className="flex items-center gap-2 font-normal">
                <Checkbox
                  aria-label={permissionSentence(p)}
                  checked={ai.permissions.includes(p)}
                  onCheckedChange={(on) =>
                    setPermissions(
                      on ? [...ai.permissions, p] : ai.permissions.filter((x) => x !== p),
                    )
                  }
                />
                {permissionSentence(p)}
              </Label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            You revoked this {timeAgo(ai.revokedAt)}. To allow it again, connect it again from the
            app.
          </p>
        )}
        {ai.agentStatus === "stopped" && (
          <p className="text-sm text-muted-foreground">
            Your clinic has stopped this AI for everyone.
          </p>
        )}
        <div className="grid gap-1">
          <p className="text-sm font-medium">
            Recent requests{" "}
            <span className="font-normal text-muted-foreground">
              (last {timeAgo(ai.lastActivity)})
            </span>
          </p>
          {ai.recent.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          {ai.recent.map((r) => (
            <p key={r.ts + r.sentence} className="flex gap-2 text-sm">
              {r.decision === "allow" ? (
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              ) : (
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              )}
              <span>{r.sentence}</span>
            </p>
          ))}
        </div>
        {active &&
          (confirming ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 p-3 text-sm">
              <span className="mr-auto">Stop {ai.name} acting for you?</span>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
                Keep
              </Button>
              <Button size="sm" variant="destructive" onClick={revoke}>
                Yes, revoke
              </Button>
            </div>
          ) : (
            <Button
              variant="destructive"
              className="justify-self-start"
              onClick={() => setConfirming(true)}
            >
              <Ban /> Revoke
            </Button>
          ))}
      </CardContent>
    </Card>
  );
}

type Pending = { id: string; agentName: string; summary: string; status: string };

function Approvals() {
  const list = useApi<Pending[]>("/person/approvals", { pollMs: 3000 });
  const waiting = (list.data ?? []).filter((p) => p.status === "pending");
  if (!waiting.length) return null;
  return (
    <Card className="border-amber-300" data-testid="pending-approvals">
      <CardHeader>
        <CardTitle>Waiting for your OK</CardTitle>
        <CardDescription>
          An AI proposed a change. Nothing is written until you approve it with your passkey.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {waiting.map((p) => (
          <Link
            key={p.id}
            href={`/approve/${p.id}`}
            className="rounded-md border p-3 text-sm hover:bg-muted"
          >
            <span className="font-medium">{p.agentName}</span>: {p.summary}
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

export default function MyAisPage() {
  const router = useRouter();
  const data = useApi<{ person: { displayName: string } | null; ais: MyAi[] }>("/person/ais", {
    pollMs: 5000,
  });

  useEffect(() => {
    if (data.error?.status === 401) router.replace("/login?next=/my-ais");
  }, [data.error, router]);

  if (!data.data) return null;

  return (
    <main className="mx-auto grid max-w-2xl gap-6 p-6 md:p-10">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My AIs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.data.person
              ? `The AI apps that may act for ${data.data.person.displayName}, what they may do, and what they did.`
              : "Your account isn't linked to a patient record yet."}
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const res = await authClient.passkey.addPasskey({ name: "aipass" });
              if (res?.error) toast.error(res.error.message ?? "Couldn't add a passkey");
              else toast.success("Passkey added. You'll use it to approve changes.");
            }}
          >
            <KeyRound /> Add a passkey
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await authClient.signOut();
              router.replace("/login");
            }}
          >
            <LogOut /> Sign out
          </Button>
        </div>
      </div>
      <Approvals />
      {data.data.ais.length === 0 && data.data.person && (
        <p className="text-sm text-muted-foreground">No AI may act for you yet.</p>
      )}
      {data.data.ais.map((ai) => (
        <AiCard key={ai.agentId} ai={ai} onChange={data.reload} />
      ))}
    </main>
  );
}
