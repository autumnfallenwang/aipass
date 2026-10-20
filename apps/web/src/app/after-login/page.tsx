"use client";

import { safeNextPath } from "@aipass/shared";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { api, type Me } from "@/lib/api";

/** Where a sign-in through a connected login (S6) lands: on to the admin or the person's page. */
function Continue() {
  const router = useRouter();
  // Only a path on this site: a crafted link can't send someone elsewhere after sign-in.
  const next = safeNextPath(useSearchParams().get("next"));
  useEffect(() => {
    api<Me>("/me")
      .then((me) => router.replace(next ?? (me.role === "admin" ? "/admin" : "/my-ais")))
      .catch(() => router.replace("/login"));
  }, [next, router]);
  return <p className="p-10 text-muted-foreground">Signing you in…</p>;
}

export default function AfterLogin() {
  return (
    <Suspense>
      <Continue />
    </Suspense>
  );
}
