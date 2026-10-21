"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, ShieldCheck, X } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api, useApi } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

type Approval = {
  id: string;
  agentName: string;
  forPerson: string;
  /** Whose record it goes into, when a staff member's AI proposed it (S10). */
  patient: string | null;
  approver: string;
  isApprover: boolean;
  hasPasskey: boolean;
  summary: string;
  payloadHash: string;
  status: "pending" | "approved" | "used" | "denied" | "expired";
  expiresAt: string;
  options: Parameters<typeof startAuthentication>[0]["optionsJSON"] | null;
};

export default function ApprovePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const a = useApi<Approval>(`/person/approvals/${id}`);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (a.error?.status === 401)
      router.replace(`/login?next=${encodeURIComponent(`/approve/${id}`)}`);
  }, [a.error, id, router]);

  async function approve() {
    if (!a.data?.options) return;
    setBusy(true);
    try {
      const response = await startAuthentication({ optionsJSON: a.data.options });
      await api(`/person/approvals/${id}/approve`, { method: "POST", json: { response } });
      toast.success(`Approved. ${a.data.agentName} can write it now.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      await a.reload();
    }
  }

  async function deny() {
    setBusy(true);
    try {
      await api(`/person/approvals/${id}/deny`, { method: "POST" });
      toast.success("Denied. Nothing will be written.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      await a.reload();
    }
  }

  async function addPasskey() {
    const res = await authClient.passkey.addPasskey({ name: "aipass" });
    if (res?.error) toast.error(res.error.message ?? "Couldn't add a passkey");
    await a.reload();
  }

  if (a.error && a.error.status !== 401) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <p className="text-muted-foreground">{a.error.message}</p>
      </main>
    );
  }
  if (!a.data) return null;
  const x = a.data;
  const pending = x.status === "pending";

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md" data-status={x.status}>
        <CardHeader>
          <CardDescription>
            {x.patient
              ? `${x.agentName} wants to add this to ${x.patient}'s record, for ${x.forPerson}:`
              : `${x.agentName} wants to add this to ${x.forPerson}'s record:`}
          </CardDescription>
          <CardTitle className="text-xl" data-testid="approval-summary">
            {x.summary}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Badge
              variant={x.status === "approved" || x.status === "used" ? "secondary" : "outline"}
              data-testid="approval-status"
            >
              {
                {
                  pending: "Waiting for your OK",
                  approved: "Approved",
                  used: "Approved and written",
                  denied: "Denied",
                  expired: "Expired",
                }[x.status]
              }
            </Badge>
            {pending && (
              <span className="text-muted-foreground">
                until {new Date(x.expiresAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <p className="flex gap-2 text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            Your passkey signs exactly this change. If the AI tries to write anything different, or
            write it twice, it is refused.
          </p>
          <p
            className="break-all font-mono text-xs text-muted-foreground"
            title="sha256 of the exact record"
          >
            {x.payloadHash.slice(0, 32)}…
          </p>
          {!x.isApprover && <p className="text-destructive">Only {x.approver} can approve this.</p>}
        </CardContent>
        {!pending && (
          <CardFooter className="flex justify-end">
            <Button variant="outline" onClick={() => router.back()}>
              Back
            </Button>
          </CardFooter>
        )}
        {pending && x.isApprover && (
          <CardFooter className="flex justify-end gap-2">
            <Button variant="outline" onClick={deny} disabled={busy}>
              <X /> Deny
            </Button>
            {x.hasPasskey ? (
              <Button onClick={approve} disabled={busy}>
                <Fingerprint /> Approve with passkey
              </Button>
            ) : (
              <Button onClick={addPasskey} disabled={busy}>
                <KeyRound /> Add a passkey first
              </Button>
            )}
          </CardFooter>
        )}
      </Card>
    </main>
  );
}
