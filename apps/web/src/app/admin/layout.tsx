"use client";

import {
  Activity,
  Bot,
  Fingerprint,
  HeartPulse,
  KeyRound,
  LogOut,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type Me, useApi } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin/agents", label: "Agents", icon: Bot },
  { href: "/admin/roles", label: "Roles", icon: ShieldCheck },
  { href: "/admin/people", label: "People", icon: Users },
  { href: "/admin/approvals", label: "Approvals", icon: Fingerprint },
  { href: "/admin/activity", label: "Activity", icon: Activity },
  { href: "/admin/health", label: "Health check", icon: HeartPulse },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const me = useApi<Me>("/me");

  useEffect(() => {
    if (me.error?.status === 401) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [me.error, path, router]);

  if (me.loading || me.error?.status === 401) return null;
  if (me.data && me.data.role !== "admin") {
    return (
      <main className="p-10">
        <p>This account isn&apos;t an admin of this aipass install.</p>
      </main>
    );
  }

  async function addPasskey() {
    const res = await authClient.passkey.addPasskey({ name: "aipass admin" });
    if (res?.error) toast.error(res.error.message ?? "Couldn't add a passkey");
    else toast.success("Passkey added. You can sign in with it next time.");
  }

  async function signOut() {
    await authClient.signOut();
    router.replace("/login");
  }

  return (
    <div className="grid min-h-screen grid-cols-[220px_1fr]">
      <aside className="flex flex-col gap-1 border-r bg-muted/30 p-4">
        <Link href="/admin/agents" className="mb-6 px-2 text-lg font-semibold tracking-tight">
          aipass
          <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">admin</span>
        </Link>
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
              path.startsWith(href) && "bg-muted font-medium",
            )}
          >
            <Icon className="size-4" /> {label}
          </Link>
        ))}
        <div className="mt-auto grid gap-1 border-t pt-4 text-sm">
          <span className="truncate px-2 text-muted-foreground" title={me.data?.email}>
            {me.data?.name}
          </span>
          <Button variant="ghost" size="sm" className="justify-start" onClick={addPasskey}>
            <KeyRound /> Add a passkey
          </Button>
          <Button variant="ghost" size="sm" className="justify-start" onClick={signOut}>
            <LogOut /> Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 p-8">{children}</main>
    </div>
  );
}
