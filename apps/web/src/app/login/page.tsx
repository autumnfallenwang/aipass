"use client";

import { safeNextPath } from "@aipass/shared";
import { Building2, KeyRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type SubmitEvent, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Me } from "@/lib/api";
import { authClient, followRedirect, inOAuthFlow } from "@/lib/auth-client";

function LoginForm() {
  const router = useRouter();
  // Only a path on this site: a crafted link can't send someone elsewhere after sign-in.
  const next = safeNextPath(useSearchParams().get("next"));
  const [needsAdmin, setNeedsAdmin] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [providers, setProviders] = useState<{ name: string; providerId: string }[]>([]);

  useEffect(() => {
    api<{ name: string; providerId: string }[]>("/connections")
      .then(setProviders)
      .catch(() => setProviders([]));
    // In the middle of an AI app's login, only ever sign in.
    if (inOAuthFlow()) {
      setNeedsAdmin(false);
      return;
    }
    api<{ needsAdmin: boolean }>("/setup")
      .then((r) => setNeedsAdmin(r.needsAdmin))
      .catch(() => setNeedsAdmin(false));
  }, []);

  /** After sign-in: continue an AI app's login, or go to the admin or the person's page. */
  async function land(data: unknown) {
    if (followRedirect(data)) return;
    if (next) {
      router.replace(next);
      return;
    }
    const me = await api<Me>("/me");
    router.replace(me.role === "admin" ? "/admin" : "/my-ais");
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    setBusy(true);
    const res = needsAdmin
      ? await authClient.signUp.email({
          name: form.name,
          email: form.email,
          password: form.password,
        })
      : await authClient.signIn.email({ email: form.email, password: form.password });
    setBusy(false);
    if (res.error) {
      toast.error(res.error.message ?? "Sign-in failed");
      return;
    }
    await land(res.data);
  }

  async function passkey() {
    const res = await authClient.signIn.passkey();
    if (res?.error) {
      toast.error(res.error.message ?? "Passkey sign-in failed");
      return;
    }
    await land(res?.data);
  }

  async function viaConnection(providerId: string) {
    const res = await authClient.signIn.sso({
      providerId,
      callbackURL: `/after-login${next ? `?next=${encodeURIComponent(next)}` : ""}`,
    });
    if (res?.error) toast.error(res.error.message ?? "Sign-in failed");
  }

  if (needsAdmin === null) return null;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">
          {needsAdmin ? "Create the admin account" : "Sign in to aipass"}
        </CardTitle>
        <CardDescription>
          {needsAdmin
            ? "This is a fresh install. The first account runs it."
            : inOAuthFlow()
              ? "An AI app is asking to act for you. Sign in first; you'll see exactly what it wants next."
              : "Use your email and password, or a passkey."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          {needsAdmin && (
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username webauthn"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={needsAdmin ? "new-password" : "current-password"}
              minLength={10}
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {needsAdmin ? "Create account" : "Sign in"}
          </Button>
          {!needsAdmin && (
            <Button type="button" variant="outline" onClick={passkey}>
              <KeyRound /> Sign in with a passkey
            </Button>
          )}
          {!needsAdmin &&
            !inOAuthFlow() &&
            providers.map((p) => (
              <Button
                key={p.providerId}
                type="button"
                variant="outline"
                onClick={() => viaConnection(p.providerId)}
              >
                <Building2 /> Sign in with {p.name}
              </Button>
            ))}
        </form>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
