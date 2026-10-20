"use client";

import { GROUP_TITLES, type Group } from "@aipass/shared";
import { toast } from "sonner";
import { PageHeader, timeAgo } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api, type Person, useApi } from "@/lib/api";

type Rule = { roleId: string; roleName: string; group: Group; approverPersonId: string | null };
type Row = {
  id: string;
  agentName: string;
  forPerson: string;
  approver: string;
  summary: string;
  status: string;
  createdAt: string;
  resultRef: string | null;
};

const PATIENT = "__patient";

export default function ApprovalsPage() {
  const rules = useApi<Rule[]>("/admin/approval-rules");
  const persons = useApi<Person[]>("/admin/persons");
  const recent = useApi<Row[]>("/admin/approvals", { pollMs: 3000 });

  async function setApprover(r: Rule, value: string) {
    try {
      await api("/admin/approval-rules", {
        method: "PUT",
        json: {
          roleId: r.roleId,
          group: r.group,
          approverPersonId: value === PATIENT ? null : value,
        },
      });
      await rules.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        description="An agent may only propose a change. It's written after the approver says yes with their passkey, within 2 minutes, once."
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Who approves</CardTitle>
            <CardDescription>
              For every role that may propose changes. By default the patient approves; you can name
              someone else, such as a clinician.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {(rules.data ?? []).map((r) => (
              <div
                key={`${r.roleId}:${r.group}`}
                className="flex items-center gap-3 text-sm"
                data-rule={`${r.roleId}:${r.group}`}
              >
                <span className="w-72">
                  <span className="font-medium">{r.roleName}</span> proposes{" "}
                  {GROUP_TITLES[r.group].toLowerCase()}
                </span>
                <Select
                  value={r.approverPersonId ?? PATIENT}
                  onValueChange={(v) => setApprover(r, v)}
                >
                  <SelectTrigger
                    className="w-56"
                    aria-label={`Approver for ${r.roleName} ${r.group}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PATIENT}>The patient</SelectItem>
                    {(persons.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            {rules.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No role may propose changes. Turn on &ldquo;Propose&rdquo; in a role.
              </p>
            )}
          </CardContent>
        </Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>For / approver</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(recent.data ?? []).map((r) => (
              <TableRow key={r.id} data-approval={r.id}>
                <TableCell className="text-xs text-muted-foreground">
                  {timeAgo(r.createdAt)}
                </TableCell>
                <TableCell>{r.agentName}</TableCell>
                <TableCell className="whitespace-normal">{r.summary}</TableCell>
                <TableCell className="text-sm">
                  {r.forPerson}
                  {r.approver !== r.forPerson && (
                    <span className="text-muted-foreground"> · approver {r.approver}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={r.status === "used" ? "secondary" : "outline"}>
                    {r.status === "used" ? `written (${r.resultRef})` : r.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
