"use client";

import {
  ACTION_TITLES,
  ACTIONS,
  type Action,
  GROUP_TITLES,
  GROUPS,
  type Group,
  LOCKED_LABEL_TITLES,
  PATIENT_FIELD_TITLES,
  PATIENT_FIELDS,
  type PatientField,
  type RoleRule,
} from "@aipass/shared";
import { Lock, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { PreviewPanel } from "@/components/preview";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, type Role, useApi } from "@/lib/api";

type Draft = {
  name: string;
  description: string;
  rules: RoleRule[];
  patientFields: PatientField[];
};

function ruleFor(rules: RoleRule[], group: Group): RoleRule {
  return (
    rules.find((r) => r.group === group) ?? { group, read: false, propose: false, write: false }
  );
}

export default function RoleEditor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const role = useApi<Role>(`/admin/roles/${id}`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(0);

  useEffect(() => {
    if (role.data && !draft) {
      setDraft({
        name: role.data.name,
        description: role.data.description ?? "",
        rules: role.data.rules,
        patientFields: role.data.patientFields,
      });
    }
  }, [role.data, draft]);

  if (!draft) return null;

  function toggle(group: Group, action: Action, on: boolean) {
    if (!draft) return;
    const r = { ...ruleFor(draft.rules, group), [action]: on };
    // Proposing or changing something you can't see makes no sense.
    if (action !== "read" && on) r.read = true;
    if (action === "read" && !on) {
      r.propose = false;
      r.write = false;
    }
    setDraft({ ...draft, rules: [...draft.rules.filter((x) => x.group !== group), r] });
  }

  async function save() {
    if (!draft) return;
    try {
      await api(`/admin/roles/${id}`, {
        method: "PUT",
        json: {
          ...draft,
          rules: GROUPS.map((g) => ruleFor(draft.rules, g)).filter(
            (r) => r.read || r.propose || r.write,
          ),
        },
      });
      toast.success("Role saved. Agents with this role use it from their next call.");
      setSaved((n) => n + 1);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove() {
    try {
      await api(`/admin/roles/${id}`, { method: "DELETE" });
      router.push("/admin/roles");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title={draft.name || "Role"}
        description="Turn on what this kind of AI may do. Locked records stay off whatever you choose."
        actions={
          <>
            <Button variant="outline" onClick={remove}>
              <Trash2 /> Delete
            </Button>
            <Button onClick={save}>Save role</Button>
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <Card>
            <CardContent className="grid gap-4 pt-6">
              <div className="grid gap-2">
                <Label htmlFor="role-name">Name</Label>
                <Input
                  id="role-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="role-description">Description</Label>
                <Textarea
                  id="role-description"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What it may do</CardTitle>
              <CardDescription>
                See = read. Propose = suggest a change the person approves. Change = write.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm" aria-label="Permissions">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-2 font-normal">Records</th>
                    {ACTIONS.map((a) => (
                      <th key={a} className="pb-2 text-center font-normal">
                        {ACTION_TITLES[a]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {GROUPS.map((g) => {
                    const r = ruleFor(draft.rules, g);
                    return (
                      <tr key={g} className="border-t">
                        <td className="py-2">{GROUP_TITLES[g]}</td>
                        {ACTIONS.map((a) => (
                          <td key={a} className="py-2 text-center">
                            <Switch
                              aria-label={`${GROUP_TITLES[g]}: ${ACTION_TITLES[a]}`}
                              checked={r[a]}
                              onCheckedChange={(on) => toggle(g, a, on)}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  {Object.values(LOCKED_LABEL_TITLES).map((t) => (
                    <tr key={t} className="border-t text-muted-foreground">
                      <td className="flex items-center gap-1 py-2">
                        <Lock className="size-3" /> {t} records
                      </td>
                      {ACTIONS.map((a) => (
                        <td key={a} className="py-2 text-center">
                          <Switch disabled checked={false} aria-label={`${t}: always off`} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-muted-foreground">
                Locked records are refused for every role, always. Records with a sensitivity label
                aipass doesn&apos;t recognise are refused too.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Patient details it may see</CardTitle>
              <CardDescription>
                Applies when &ldquo;Patient details: See&rdquo; is on. Everything else is masked.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2">
              {PATIENT_FIELDS.map((f) => (
                <Label key={f} className="flex items-center gap-2 font-normal">
                  <Checkbox
                    checked={draft.patientFields.includes(f)}
                    onCheckedChange={(on) =>
                      setDraft({
                        ...draft,
                        patientFields: on
                          ? [...draft.patientFields, f]
                          : draft.patientFields.filter((x) => x !== f),
                      })
                    }
                  />
                  {PATIENT_FIELD_TITLES[f]}
                </Label>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card className="content-start">
          <CardHeader>
            <CardTitle>Preview as this role</CardTitle>
            <CardDescription>
              The chart exactly as an AI with this role would see it, from the same checks the
              gateway runs. It shows the last saved version and assumes the person agreed to
              everything the role allows.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PreviewPanel key={saved} target={{ roleId: id }} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
