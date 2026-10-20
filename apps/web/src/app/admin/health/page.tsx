"use client";

import { Play, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";

type Result = {
  id: string;
  title: string;
  tries: string;
  status: "pass" | "fail" | "missing" | "n/a";
  leak: boolean;
  detail: string;
};
type Report = {
  target: { name: string; version: string };
  date: string;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: { pass: number; fail: number; missing: number; leaks: number };
  results: Result[];
};

const STATUS: Record<
  Result["status"],
  { label: string; variant: "secondary" | "destructive" | "outline" }
> = {
  pass: { label: "Pass", variant: "secondary" },
  fail: { label: "Fail", variant: "destructive" },
  missing: { label: "Missing", variant: "outline" },
  "n/a": { label: "n/a", variant: "outline" },
};

export default function HealthPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      setReport(await api<Report>("/admin/check", { method: "POST" }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Health check"
        description="Tries to get past this install's own gateway the ways an attacker or a buggy agent would. Uses two temporary probe agents and the synthetic test patient."
        actions={
          <Button onClick={run} disabled={running}>
            <Play /> {running ? "Running…" : "Run the check"}
          </Button>
        }
      />
      {report && (
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-4">
                <div
                  className="flex size-14 items-center justify-center rounded-xl border text-3xl font-semibold"
                  data-testid="grade"
                >
                  {report.grade}
                </div>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <ShieldCheck className="size-4" /> {report.summary.pass} passed,{" "}
                    {report.summary.fail} failed, {report.summary.missing} missing
                  </CardTitle>
                  <CardDescription>
                    {report.target.name} {report.target.version} ·{" "}
                    {new Date(report.date).toLocaleString()} · rerun from a terminal with{" "}
                    <code>pnpm check</code>
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
          </Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Probe</TableHead>
                <TableHead>What it tries</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.results.map((r) => (
                <TableRow key={r.id} data-probe={r.id} data-status={r.status}>
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {r.tries}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-normal text-sm">{r.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
