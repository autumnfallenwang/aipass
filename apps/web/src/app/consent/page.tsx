"use client";

import type { Permission } from "@aipass/shared";
import { Lock, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { authClient, followRedirect } from "@/lib/auth-client";
import { permissionSentence } from "@/lib/words";

type Context = {
  orgName: string;
  agent: { id: string; name: string; description: string | null; status: string; roleName: string };
  client: { id: string; name: string; approved: boolean };
  person: { displayName: string } | null;
  ceiling: Permission[];
  granted: Permission[] | null;
};

/** Better Auth's consent step, finished with the person's answer. */
async function finish(accept: boolean) {
  const res = await authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept } });
  if (res.error) throw new Error(res.error.message ?? "consent failed");
  followRedirect(res.data);
}

export default function ConsentPage() {
  const [ctx, setCtx] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const params = new URLSearchParams({
      client_id: q.get("client_id") ?? "",
      resource: q.get("resource") ?? "",
    });
    api<Context>(`/person/consent/context?${params}`)
      .then((c) => {
        setCtx(c);
        setChosen(c.granted ?? c.ceiling);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function allow() {
    if (!ctx) return;
    setBusy(true);
    try {
      await api("/person/consent/grant", {
        method: "POST",
        json: { agentId: ctx.agent.id, clientId: ctx.client.id, permissions: chosen },
      });
      await finish(true);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  async function deny() {
    setBusy(true);
    try {
      await finish(false);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  const blocked = ctx && (!ctx.person || !ctx.client.approved || ctx.agent.status !== "active");

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        {error && (
          <CardHeader>
            <CardTitle>Something's not right</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        )}
        {ctx && (
          <>
            <CardHeader>
              <CardTitle className="text-xl" data-testid="consent-title">
                {ctx.agent.name} wants to act for you
              </CardTitle>
              <CardDescription>
                Approved by {ctx.orgName} as a {ctx.agent.roleName}. It connects through{" "}
                <span className="font-medium text-foreground">{ctx.client.name}</span>.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {!ctx.person && (
                <p className="text-sm text-destructive">
                  Your account isn&apos;t linked to a patient record yet, so no AI can act for you.
                  Ask {ctx.orgName}.
                </p>
              )}
              {!ctx.client.approved && (
                <p className="text-sm text-destructive">
                  {ctx.orgName} hasn&apos;t approved this app to act as {ctx.agent.name}.
                </p>
              )}
              {ctx.agent.status !== "active" && (
                <p className="text-sm text-destructive">{ctx.orgName} has stopped this AI.</p>
              )}
              {!blocked && (
                <>
                  <div className="grid gap-2">
                    <p className="text-sm font-medium">It may:</p>
                    {ctx.ceiling.map((p) => (
                      <Label key={p} className="flex items-center gap-2 font-normal">
                        <Checkbox
                          aria-label={permissionSentence(p)}
                          checked={chosen.includes(p)}
                          onCheckedChange={(on) =>
                            setChosen(on ? [...chosen, p] : chosen.filter((x) => x !== p))
                          }
                        />
                        {permissionSentence(p)}
                      </Label>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      Untick anything you don&apos;t want. {ctx.orgName} set the most it may ever
                      do; you can only allow less.
                    </p>
                  </div>
                  <p className="flex gap-2 rounded-md bg-muted p-3 text-sm">
                    <Lock className="mt-0.5 size-4 shrink-0" />
                    It will never see mental-health, substance-use, HIV-related or restricted
                    records, whatever you choose.
                  </p>
                  <p className="flex gap-2 text-sm text-muted-foreground">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                    Every request it makes is recorded. You can see them and take this back anytime
                    on your &ldquo;My AIs&rdquo; page.
                  </p>
                </>
              )}
            </CardContent>
            <CardFooter className="flex justify-end gap-2">
              <Button variant="outline" onClick={deny} disabled={busy}>
                Deny
              </Button>
              {!blocked && (
                <Button onClick={allow} disabled={busy || chosen.length === 0}>
                  Allow
                </Button>
              )}
            </CardFooter>
          </>
        )}
      </Card>
    </main>
  );
}
