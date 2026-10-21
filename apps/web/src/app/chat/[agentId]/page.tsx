"use client";

import {
  ArrowLeft,
  Cloud,
  Fingerprint,
  Info,
  Loader2,
  Network,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { OpenPatient } from "@/components/open-patient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, type DataLocation, type OpenPatientRef, useApi } from "@/lib/api";

type ModelInfo = {
  connection: string;
  model: string;
  dataLocation: DataLocation;
  words: string;
};

type Status = {
  orgName: string;
  agent: { id: string; name: string; description: string | null; status: string };
  person: { displayName: string; staff: boolean } | null;
  /** A staff member's open patient (S10). */
  openPatient: OpenPatientRef | null;
  approved: boolean;
  connected: boolean;
  model: ModelInfo | null;
  fallback: ModelInfo | null;
  problem: string | null;
};

/** The OpenAI-format conversation, kept in this tab only and sent back each turn. */
type Message =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type Step = {
  id: string;
  title: string;
  done: boolean;
  refused?: boolean;
  summary?: string;
  approveUrl?: string;
};

type Turn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      steps: Step[];
      notices: string[];
      model?: ModelInfo & { fallback?: boolean };
      error?: string;
      done: boolean;
    };

type Event =
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; title: string }
  | {
      type: "tool_result";
      id: string;
      refused: boolean;
      summary: string;
      approveUrl?: string;
    }
  | { type: "notice"; text: string }
  | ({ type: "model"; fallback?: boolean } & ModelInfo)
  | { type: "done"; messages: Message[] }
  | { type: "error"; message: string };

/**
 * Where this tab keeps a conversation. A staff member has one per patient
 * (S10), so one patient's answers never carry into another's.
 */
const storageKey = (agentId: string, patient: string | null) =>
  `aipass-chat:${agentId}${patient ? `:${patient}` : ""}`;

function load(key: string): { history: Message[]; turns: Turn[] } {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {
    // private window or blocked storage: start empty
  }
  return { history: [], turns: [] };
}

function save(key: string, data: { history: Message[]; turns: Turn[] }) {
  try {
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch {
    // not kept; the chat still works
  }
}

/** Plain text with line breaks; links to this aipass (an approval) become links. */
function Text({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <p className="whitespace-pre-wrap break-words">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) &&
        typeof window !== "undefined" &&
        p.startsWith(window.location.origin) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <a key={i} href={p} className="underline underline-offset-4">
            {p}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

function StepLine({ s }: { s: Step }) {
  return (
    <div className="grid gap-1 rounded-md border bg-muted/30 p-2 text-xs" data-step={s.id}>
      <div className="flex items-center gap-2">
        {!s.done ? (
          <Loader2 className="size-3 animate-spin" />
        ) : s.refused ? (
          <ShieldAlert className="size-3 text-destructive" />
        ) : (
          <ShieldCheck className="size-3 text-emerald-600" />
        )}
        <Search className="size-3 text-muted-foreground" />
        <span className="font-medium">{s.title}</span>
        {s.done && (
          <span className={s.refused ? "text-destructive" : "text-muted-foreground"}>
            {s.refused ? "refused by aipass" : "checked by aipass"}
          </span>
        )}
      </div>
      {s.summary && (
        <p className={s.refused ? "text-destructive" : "text-muted-foreground"}>{s.summary}</p>
      )}
      {s.approveUrl && (
        <Button size="sm" className="justify-self-start" asChild>
          {/* Same tab: a passkey may live in this tab only; Back returns to the chat. */}
          <a href={s.approveUrl}>
            <Fingerprint /> Review and approve
          </a>
        </Button>
      )}
    </div>
  );
}

function ModelLine({ m, label }: { m: ModelInfo; label: string }) {
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="model-line">
      {m.dataLocation === "network" ? <Network className="size-3" /> : <Cloud className="size-3" />}
      {label} {m.model} ({m.connection}). What it reads {m.words}.
    </p>
  );
}

export default function ChatPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const router = useRouter();
  const status = useApi<Status>(`/person/chat/${agentId}`);
  const [history, setHistory] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const staff = Boolean(status.data?.person?.staff);
  // The conversation for this AI (and, for a staff member, this patient) once the status is known.
  const wanted = status.data
    ? storageKey(agentId, staff ? (status.data.openPatient?.ref ?? "none") : null)
    : null;
  /** The conversation on screen: set together with it, so it's never saved under another key. */
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (status.error?.status === 401) router.replace(`/login?next=/chat/${agentId}`);
  }, [status.error, router, agentId]);

  useEffect(() => {
    if (!wanted || wanted === shown) return;
    const kept = load(wanted);
    setHistory(kept.history);
    setTurns(kept.turns);
    setShown(wanted);
  }, [wanted, shown]);

  useEffect(() => {
    // Back from the sign-in: say how it went, then tidy the URL.
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) toast.success("Connected. Ask away.");
    const err = q.get("error");
    if (err) toast.error(err);
    if (q.size) window.history.replaceState(null, "", `/chat/${agentId}`);
  }, [agentId]);

  useEffect(() => {
    if (shown && !busy) save(shown, { history, turns });
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [shown, history, turns, busy]);

  /** Applies one streamed event to the turn being answered. */
  const apply = useCallback((e: Event) => {
    setTurns((all) => {
      const last = all.at(-1);
      if (last?.role !== "assistant") return all;
      const t = { ...last, steps: [...last.steps], notices: [...last.notices] };
      if (e.type === "text") t.text += e.delta;
      else if (e.type === "tool") t.steps.push({ id: e.id, title: e.title, done: false });
      else if (e.type === "tool_result") {
        const i = t.steps.findIndex((s) => s.id === e.id);
        const s = {
          ...(t.steps[i] ?? { id: e.id, title: "" }),
          done: true,
          refused: e.refused,
          summary: e.summary,
          approveUrl: e.approveUrl,
        };
        if (i >= 0) t.steps[i] = s;
        else t.steps.push(s);
      } else if (e.type === "notice") t.notices.push(e.text);
      else if (e.type === "model") t.model = e;
      else if (e.type === "error") {
        t.error = e.message;
        t.done = true;
      } else if (e.type === "done") t.done = true;
      return [...all.slice(0, -1), t];
    });
  }, []);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    const outgoing: Message[] = [...history, { role: "user", content: text }];
    setDraft("");
    setBusy(true);
    setTurns((t) => [
      ...t,
      { role: "user", text },
      { role: "assistant", text: "", steps: [], notices: [], done: false },
    ]);
    try {
      const res = await fetch(`/api/person/chat/${agentId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: outgoing }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          reconnect?: boolean;
        };
        apply({ type: "error", message: body.error ?? res.statusText });
        if (body.reconnect) await status.reload();
        return;
      }
      let added: Message[] | null = null;
      let buffer = "";
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            const e = JSON.parse(line) as Event;
            if (e.type === "done") added = e.messages;
            apply(e);
          }
          nl = buffer.indexOf("\n");
        }
      }
      // Only a finished turn joins the conversation the model sees next time.
      if (added) setHistory([...outgoing, ...added]);
      else apply({ type: "error", message: "the answer broke off; try again" });
    } catch (e) {
      apply({ type: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function disconnect() {
    await api(`/person/chat/${agentId}/disconnect`, { method: "POST" });
    toast.success("Disconnected. The chat can't act for you until you allow it again.");
    await status.reload();
  }

  function startOver() {
    setHistory([]);
    setTurns([]);
  }

  const s = status.data;
  if (!s) {
    return status.error && status.error.status !== 401 ? (
      <main className="mx-auto max-w-2xl p-10 text-sm">{status.error.message}</main>
    ) : null;
  }
  const ready = !s.problem && s.connected && (!staff || Boolean(s.openPatient));

  return (
    <main className="mx-auto grid min-h-screen max-w-3xl grid-rows-[auto_1fr_auto] gap-4 p-4 md:p-8">
      <header className="grid gap-2">
        <Link
          href="/my-ais"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> My AIs
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="chat-title">
              {s.agent.name}
            </h1>
            {s.agent.description && (
              <p className="text-sm text-muted-foreground">{s.agent.description}</p>
            )}
          </div>
          <div className="flex gap-1">
            {turns.length > 0 && (
              <Button variant="ghost" size="sm" onClick={startOver} disabled={busy}>
                <RotateCcw /> New conversation
              </Button>
            )}
            {s.connected && (
              <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>
                Disconnect
              </Button>
            )}
          </div>
        </div>
        {staff && (
          <OpenPatient
            agentId={agentId}
            current={s.openPatient}
            disabled={busy}
            onChanged={(p) => {
              toast.success(
                `${p.name ?? p.ref} is open. ${s.agent.name} sees only their record now.`,
              );
              void status.reload();
            }}
          />
        )}
        {s.model && <ModelLine m={s.model} label="Answers come from" />}
        {s.fallback && <ModelLine m={s.fallback} label="If that's down:" />}
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <ShieldCheck className="size-3" />
          {staff
            ? "It reads the open patient's record only through aipass, which checks every request against what "
            : "It reads your record only through aipass, which checks every request against what "}
          {s.orgName} allows and what you agreed to, and records it on My AIs.
        </p>
      </header>

      <section className="grid content-start gap-4" aria-label="Conversation">
        {s.problem && (
          <Card className="border-destructive/40" data-testid="chat-problem">
            <CardHeader>
              <CardTitle>You can&apos;t chat with {s.agent.name} right now</CardTitle>
              <CardDescription className="first-letter:uppercase">{s.problem}.</CardDescription>
            </CardHeader>
          </Card>
        )}
        {!s.problem && !s.connected && (
          <Card data-testid="chat-connect">
            <CardHeader>
              <CardTitle>Before you start</CardTitle>
              <CardDescription>
                The chat is an AI app like any other: you choose what {s.agent.name} may see, once,
                on the next page. You can change or take that back anytime on My AIs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <a href={`/api/person/chat/${agentId}/connect`}>Allow and start chatting</a>
              </Button>
            </CardContent>
          </Card>
        )}
        {staff && !s.problem && s.connected && !s.openPatient && (
          <p className="text-sm text-muted-foreground" data-testid="choose-patient">
            Choose the patient you have open. {s.agent.name} will see only their record, and only
            while they&apos;re in your care.
          </p>
        )}
        {ready && turns.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {staff
              ? `Ask about ${s.openPatient?.name ?? "the patient"}, for example “What was the last A1c?”`
              : "Ask about your record, for example “What was my last A1c?”"}
          </p>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: turns only grow
              key={i}
              className="justify-self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
              data-turn="user"
            >
              <Text text={t.text} />
            </div>
          ) : (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: turns only grow
              key={i}
              className="grid max-w-[90%] gap-2 text-sm"
              data-turn="assistant"
              data-done={t.done}
            >
              {t.steps.map((st) => (
                <StepLine key={st.id} s={st} />
              ))}
              {t.notices.map((n) => (
                <p key={n} className="flex gap-1 text-xs text-amber-700">
                  <Info className="mt-0.5 size-3 shrink-0" /> {n}
                </p>
              ))}
              {t.text && (
                <div className="rounded-lg border px-3 py-2" data-testid="answer">
                  <Text text={t.text} />
                </div>
              )}
              {!t.done && !t.text && t.steps.length === 0 && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Thinking…
                </p>
              )}
              {t.error && (
                <p className="text-destructive" data-testid="chat-error">
                  {t.error}
                </p>
              )}
              {t.done && t.model && (
                <p className="text-xs text-muted-foreground">
                  Answered by {t.model.model}
                  {t.model.fallback ? " (the fallback)" : ""}
                </p>
              )}
            </div>
          ),
        )}
        <div ref={bottom} />
      </section>

      <footer className="sticky bottom-0 grid gap-2 bg-background py-2">
        <div className="flex gap-2">
          <Textarea
            aria-label="Message"
            placeholder={ready ? `Message ${s.agent.name}` : ""}
            value={draft}
            disabled={!ready || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            className="min-h-11 resize-none"
            rows={1}
          />
          <Button onClick={send} disabled={!ready || busy || !draft.trim()} aria-label="Send">
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          This conversation stays in this browser tab; aipass doesn&apos;t keep it. It isn&apos;t
          medical advice.
        </p>
      </footer>
    </main>
  );
}
