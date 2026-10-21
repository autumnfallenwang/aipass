"use client";

import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AddPerson } from "@/components/add-person";
import { PageHeader, timeAgo } from "@/components/page-header";
import { PersonPanel } from "@/components/person-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { type Agent, type FhirServer, type PersonList, useApi } from "@/lib/api";

const ANY = "any";
const KEYS = [
  "q",
  "server",
  "login",
  "agent",
  "status",
  "sort",
  "page",
  "limit",
  "person",
] as const;
type Filters = Partial<Record<(typeof KEYS)[number], string>>;

function readUrl(): Filters {
  if (typeof window === "undefined") return {};
  const q = new URLSearchParams(window.location.search);
  return Object.fromEntries(KEYS.flatMap((k) => (q.get(k) ? [[k, q.get(k) as string]] : [])));
}

/** People (S9): only the list. One person opens in a side panel. */
export default function PeoplePage() {
  const router = useRouter();
  const [f, setF] = useState<Filters | null>(null);
  const [typed, setTyped] = useState("");

  // Filters live in the URL, so a view can be shared and reloaded.
  useEffect(() => {
    const start = readUrl();
    setF(start);
    setTyped(start.q ?? "");
  }, []);

  function update(next: Filters, resetPage = true) {
    const merged = { ...f, ...next, ...(resetPage ? { page: undefined } : {}) };
    const clean = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined && v !== "" && v !== ANY),
    ) as Filters;
    setF(clean);
    router.replace(
      `/admin/people${Object.keys(clean).length ? `?${new URLSearchParams(clean)}` : ""}`,
      {
        scroll: false,
      },
    );
  }

  // Search a moment after they stop typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the typed text changes
  useEffect(() => {
    if (!f || (f.q ?? "") === typed) return;
    const t = setTimeout(() => update({ q: typed || undefined }), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const listQuery = f
    ? new URLSearchParams(
        Object.fromEntries(Object.entries(f).filter(([k]) => k !== "person")) as Record<
          string,
          string
        >,
      ).toString()
    : null;
  const list = useApi<PersonList>(listQuery === null ? null : `/admin/persons?${listQuery}`);
  const servers = useApi<FhirServer[]>("/admin/fhir-servers");
  const agents = useApi<Agent[]>("/admin/agents");

  const page = Number(f?.page ?? 1);
  const limit = Number(f?.limit ?? 25);
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const filtered = Boolean(f?.q || f?.server || f?.login || f?.agent || f?.status);

  const filter = (
    key: "server" | "login" | "agent" | "status",
    label: string,
    options: { value: string; label: string }[],
  ) => (
    <Select value={f?.[key] ?? ANY} onValueChange={(v) => update({ [key]: v })}>
      <SelectTrigger className="w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone the agents may act for. Each person has their records at one or more FHIR servers, and decides themselves what each AI may do."
        actions={
          <AddPerson
            onAdded={(id) => {
              update({ person: id }, false);
              void list.reload();
            }}
          />
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="people-filters">
        <div className="relative">
          <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search people"
            placeholder="Name, email or record id"
            className="w-56 pl-8"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        {filter("server", "Filter by server", [
          { value: ANY, label: "All servers" },
          ...(servers.data ?? []).map((s) => ({ value: s.id, label: s.name })),
        ])}
        {filter("login", "Filter by login", [
          { value: ANY, label: "Login: any" },
          { value: "yes", label: "Has a login" },
          { value: "no", label: "No login" },
        ])}
        {filter("agent", "Filter by AI", [
          { value: ANY, label: "Any AI" },
          ...(agents.data ?? []).map((a) => ({ value: a.id, label: `Allowed: ${a.name}` })),
        ])}
        {filter("status", "Filter by status", [
          { value: ANY, label: "Any status" },
          { value: "active", label: "Active" },
          { value: "suspended", label: "Paused" },
        ])}
        <Select value={f?.sort ?? "name"} onValueChange={(v) => update({ sort: v })}>
          <SelectTrigger className="w-40" aria-label="Sort people">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">Sort: name</SelectItem>
            <SelectItem value="activity">Sort: last activity</SelectItem>
            <SelectItem value="ais">Sort: most AIs</SelectItem>
          </SelectContent>
        </Select>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTyped("");
              update({
                q: undefined,
                server: undefined,
                login: undefined,
                agent: undefined,
                status: undefined,
              });
            }}
          >
            <X /> Clear
          </Button>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Records</TableHead>
            <TableHead>Login</TableHead>
            <TableHead>AIs</TableHead>
            <TableHead>Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(list.data?.items ?? []).map((p) => (
            <TableRow
              key={p.id}
              data-person={p.id}
              className="cursor-pointer"
              onClick={() => update({ person: p.id }, false)}
            >
              <TableCell>
                <button
                  type="button"
                  className="font-medium hover:underline"
                  aria-label={`Open ${p.displayName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    update({ person: p.id }, false);
                  }}
                >
                  {p.displayName}
                </button>
                <span className="ml-2 inline-flex gap-1">
                  {p.isTest && <Badge variant="outline">Test</Badge>}
                  {p.status === "suspended" && <Badge variant="destructive">Paused</Badge>}
                </span>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {p.records.map((r) => (
                    <Badge
                      key={`${r.serverId}:${r.ref}`}
                      variant={r.linkedBy === "person" ? "secondary" : "outline"}
                      title={r.ref}
                    >
                      {r.serverName}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-sm">
                {p.email ?? <span className="text-muted-foreground">No login</span>}
              </TableCell>
              <TableCell className="text-sm">
                {p.ais.active} of {p.ais.total}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {timeAgo(p.lastActivity)}
              </TableCell>
            </TableRow>
          ))}
          {list.data?.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                {filtered ? "No one matches." : "No people yet. Add someone from their record."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <div
        className="mt-4 flex items-center justify-between gap-2 text-sm"
        data-testid="people-paging"
      >
        <span className="text-muted-foreground">
          {total === 0
            ? "0 people"
            : `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total.toLocaleString()}`}
        </span>
        <div className="flex items-center gap-2">
          <Select value={String(limit)} onValueChange={(v) => update({ limit: v })}>
            <SelectTrigger className="w-32" aria-label="People per page" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["25", "50", "100"].map((n) => (
                <SelectItem key={n} value={n}>
                  {n} per page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => update({ page: String(page - 1) }, false)}
          >
            <ChevronLeft />
          </Button>
          <span>
            Page {page} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label="Next page"
            disabled={page >= pages}
            onClick={() => update({ page: String(page + 1) }, false)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      {f?.person && (
        <PersonPanel
          key={f.person}
          personId={f.person}
          onClose={() => update({ person: undefined }, false)}
          onChanged={list.reload}
        />
      )}
    </>
  );
}
