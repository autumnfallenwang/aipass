"use client";

import { CheckCircle2, ExternalLink, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type Agent, api, type Person, type Receipt, useApi } from "@/lib/api";

const ALL = "__all";

/** What each rule number on a refusal means (docs/PLAN.md § 3). */
const RULES: Record<number, string> = {
  0: "the check itself failed, so nothing was released",
  1: "the pass must be valid",
  2: "the agent must be active and the app approved",
  3: "the role must allow it",
  4: "the person must have agreed",
  5: "it must be the person's own record",
  6: "no locked label on the record",
  7: "the person must approve this exact change",
};

export default function ActivityPage() {
  const agents = useApi<Agent[]>("/admin/agents");
  const persons = useApi<Person[]>("/admin/persons");
  const [agent, setAgent] = useState(ALL);
  const [person, setPerson] = useState(ALL);
  const [decision, setDecision] = useState(ALL);
  const [previews, setPreviews] = useState(false);
  const [chain, setChain] = useState<string | null>(null);

  const q = new URLSearchParams({ limit: "100", mode: previews ? "all" : "live" });
  if (agent !== ALL) q.set("agent", agent);
  if (person !== ALL) q.set("person", person);
  if (decision !== ALL) q.set("decision", decision);
  const receipts = useApi<{ items: Receipt[] }>(`/admin/receipts?${q}`, { pollMs: 2000 });

  async function verify() {
    const r = await api<{ intact: boolean; brokenAt: string | null }>("/admin/receipts/verify");
    const at = new Date().toLocaleTimeString();
    if (r.intact) {
      toast.success("Receipt chain intact: no receipt has been edited or removed.");
      setChain(`Chain intact (checked ${at})`);
    } else {
      toast.error(`Receipt chain broken at ${r.brokenAt}`);
      setChain(`Chain BROKEN at ${r.brokenAt} (checked ${at})`);
    }
  }

  return (
    <>
      <PageHeader
        title="Activity"
        description="One receipt per request, refusals included. Each links to the AuditEvent in the FHIR record's own log."
        actions={
          <>
            {chain && (
              <span
                className="self-center text-sm text-muted-foreground"
                data-testid="chain-status"
              >
                {chain}
              </span>
            )}
            <Button variant="outline" onClick={verify}>
              <CheckCircle2 /> Verify chain
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger className="w-48" aria-label="Filter by agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All agents</SelectItem>
            {(agents.data ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={person} onValueChange={setPerson}>
          <SelectTrigger className="w-48" aria-label="Filter by person">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All people</SelectItem>
            {(persons.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={decision} onValueChange={setDecision}>
          <SelectTrigger className="w-40" aria-label="Filter by decision">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All decisions</SelectItem>
            <SelectItem value="allow">Allowed</SelectItem>
            <SelectItem value="refuse">Refused</SelectItem>
          </SelectContent>
        </Select>
        <Label className="flex items-center gap-2 font-normal">
          <Switch checked={previews} onCheckedChange={setPreviews} /> Include admin previews
        </Label>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-40">When</TableHead>
            <TableHead className="w-28">Decision</TableHead>
            <TableHead>What happened</TableHead>
            <TableHead className="w-28">FHIR audit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(receipts.data?.items ?? []).map((r) => (
            <TableRow key={r.id} data-receipt={r.id} data-decision={r.decision}>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(r.ts).toLocaleString()}
              </TableCell>
              <TableCell>
                {r.decision === "allow" ? (
                  <Badge variant="secondary">
                    <ShieldCheck /> Allowed
                  </Badge>
                ) : (
                  <Badge variant="destructive">
                    <ShieldAlert /> Refused
                  </Badge>
                )}
              </TableCell>
              <TableCell className="whitespace-normal">
                {r.sentence}
                {r.rule !== null && (
                  <span
                    className="ml-2 cursor-help text-xs text-muted-foreground underline decoration-dotted"
                    title={`Rule ${r.rule}: ${RULES[r.rule] ?? ""}`}
                  >
                    rule {r.rule}
                  </span>
                )}
              </TableCell>
              <TableCell>
                {r.auditEventUrl ? (
                  <a
                    className="flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                    href={r.auditEventUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    AuditEvent <ExternalLink className="size-3" />
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {r.mode === "preview" ? "preview" : "—"}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
