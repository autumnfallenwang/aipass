/**
 * The built-in chat (S8): a person talks to one of their AIs in the browser.
 *
 * The chat is an ordinary AI app. It signs in at aipass's own OAuth server
 * (PKCE, the person's normal consent page), keeps the pass sealed here, and
 * reaches the record only through the gateway, which checks every call.
 * The browser never sees a token, and aipass keeps no transcript: the
 * browser holds the conversation and sends it back each turn.
 */
import { randomBytes } from "node:crypto";
import {
  type ChatEvent,
  type ChatMessage,
  connectGateway,
  type ModelCall,
  ModelError,
  runChat,
  streamChat,
  withFallback,
} from "@aipass/chat";
import {
  agentClients,
  agents,
  CHAT_CLIENT_ID,
  chatCallbackUrl,
  chatLaunches,
  chatLinks,
  type Db,
  grants,
  persons,
  seal,
  unseal,
  vaultKey,
  vaultKeys,
} from "@aipass/db";
import { type FhirClient, pkcePair } from "@aipass/fhir";
import { agentUrl, firstName } from "@aipass/shared";
import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { decodeJwt } from "jose";
import * as z from "zod";
import type { Auth } from "./auth.ts";
import { config } from "./config.ts";
import { DATA_WORDS, endpointOf, modelsForAgent } from "./models.ts";
import { isStaff, openPatientOf } from "./person.ts";

const LAUNCH_MINUTES = 10;

/** The patient a pass names, read without checking it (the gateway checks). */
function patientOf(pass: string): string | undefined {
  try {
    const p = decodeJwt(pass).patient;
    return typeof p === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}
/** Refresh the pass this long before it runs out. */
const SKEW_MS = 30_000;

const ToolCall = z.strictObject({
  id: z.string().min(1).max(200),
  type: z.literal("function"),
  function: z.strictObject({
    name: z.string().min(1).max(100),
    arguments: z.string().max(20_000),
  }),
});

/** The conversation the browser sends back: never a system message, and the person spoke last. */
const History = z
  .strictObject({
    messages: z
      .array(
        z.discriminatedUnion("role", [
          z.strictObject({ role: z.literal("user"), content: z.string().trim().min(1).max(8000) }),
          z.strictObject({
            role: z.literal("assistant"),
            content: z.string().max(20_000).nullable(),
            tool_calls: z.array(ToolCall).max(20).optional(),
          }),
          z.strictObject({
            role: z.literal("tool"),
            tool_call_id: z.string().min(1).max(200),
            content: z.string().max(60_000),
          }),
        ]),
      )
      .min(1)
      .max(80),
  })
  .refine((b) => b.messages.at(-1)?.role === "user", {
    message: "the last message is the person's",
  })
  .refine((b) => JSON.stringify(b.messages).length <= 400_000, {
    message: "the conversation is too long; start a new one",
  });

type Tokens = { access_token: string; refresh_token?: string };

const bindOf = (userId: string, agentId: string) => `chat|${userId}|${agentId}`;

function systemPrompt(p: {
  agent: { name: string; description: string | null };
  personName: string;
  /** A staff member's open patient (S10). */
  patientName?: string | null;
  instructions?: string;
}): string {
  const first = firstName(p.personName);
  const about = p.patientName
    ? `${first} is a clinician with ${p.patientName}'s chart open. Everything you know about the patient comes from ${p.patientName}'s record through aipass's tools, which check each request against what the clinic allows and what ${first} agreed to. Every answer is about ${p.patientName} only.`
    : `Everything you know about ${first}'s health comes from their record through aipass's tools, which check each request against what the clinic allows and what ${first} agreed to.`;
  return [
    `You are ${p.agent.name}, an AI assistant that ${config.orgName} set up${p.agent.description ? `: ${p.agent.description}` : "."}`,
    `You're talking with ${p.personName} in aipass's built-in chat. ${about}`,
    p.instructions ?? "",
    "Look things up with the tools instead of guessing. Answer briefly, in plain words.",
    "If a tool says REFUSED, tell them the reason as given, and don't look for a way around it.",
    "To add a reading, use propose_observation. They approve it with their passkey (a link appears in the chat); then use commit_change with exactly the proposed values.",
    p.patientName
      ? "You support the clinician; the clinical decisions are theirs."
      : "You don't give medical advice. For decisions about their care, suggest they talk to their care team.",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function personChatRoutes(deps: {
  db: Db;
  auth: Auth;
  /** How the api reaches the gateway (tests pass the gateway's fetch). */
  fetch?: typeof fetch;
  /** How the api reaches model endpoints. */
  modelFetch?: typeof fetch;
  /** How the chat reaches aipass's own token endpoint, like any client would. */
  selfFetch?: typeof fetch;
  /** aipass's own FHIR server: a staff member's care team (S10). */
  fhir: FhirClient;
}) {
  const { db, auth } = deps;
  const key = vaultKey();
  const selfFetch = deps.selfFetch ?? fetch;
  const app = new Hono<{ Variables: { userId: string } }>();
  const page = (agentId: string, q: Record<string, string> = {}) => {
    const qs = new URLSearchParams(q).toString();
    return `${config.publicUrl}/chat/${encodeURIComponent(agentId)}${qs ? `?${qs}` : ""}`;
  };
  /** One answer at a time per person and AI. */
  const busy = new Set<string>();

  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "sign in first" }, 401);
    c.set("userId", session.user.id);
    await next();
  });

  async function tokenRequest(
    form: Record<string, string>,
  ): Promise<Tokens & { expires_in?: number }> {
    const res = await selfFetch(`${config.selfUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CHAT_CLIENT_ID, ...form }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Tokens & {
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token)
      throw new Error(json.error ?? `token endpoint ${res.status}`);
    return json;
  }

  async function saveTokens(userId: string, agentId: string, t: Tokens & { expires_in?: number }) {
    const sealed = seal(
      key,
      JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token }),
      bindOf(userId, agentId),
    );
    const expiresAt = new Date(Date.now() + (t.expires_in ?? 300) * 1000);
    await db
      .insert(chatLinks)
      .values({ userId, agentId, tokensSealed: sealed, expiresAt })
      .onConflictDoUpdate({
        target: [chatLinks.userId, chatLinks.agentId],
        set: { tokensSealed: sealed, expiresAt },
      });
  }

  /** A pass that's good for the next few minutes, refreshed if it has to be. */
  /**
   * The chat's pass for this AI, refreshed when it's about to run out, or when
   * it names another patient than the one a staff member has open (S10).
   */
  async function currentPass(
    userId: string,
    agentId: string,
    patient?: string,
  ): Promise<{ ok: true; pass: string } | { ok: false; error: string }> {
    const [link] = await db
      .select()
      .from(chatLinks)
      .where(and(eq(chatLinks.userId, userId), eq(chatLinks.agentId, agentId)));
    if (!link) return { ok: false, error: "connect the chat to this AI first" };
    const tokens = JSON.parse(
      unseal(vaultKeys(), link.tokensSealed, bindOf(userId, agentId)),
    ) as Tokens;
    if (
      link.expiresAt.getTime() - SKEW_MS > Date.now() &&
      (patient === undefined || patientOf(tokens.access_token) === patient)
    )
      return { ok: true, pass: tokens.access_token };
    if (!tokens.refresh_token)
      return { ok: false, error: "the chat's sign-in ran out; connect again" };
    try {
      const next = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: agentUrl(config.gatewayUrl, agentId),
      });
      await saveTokens(userId, agentId, {
        ...next,
        refresh_token: next.refresh_token ?? tokens.refresh_token,
      });
      return { ok: true, pass: next.access_token };
    } catch (err) {
      // Revoked on My AIs, or the app was withdrawn: start over with consent.
      console.warn(`chat refresh for ${agentId} failed: ${(err as Error).message}`);
      await db
        .delete(chatLinks)
        .where(and(eq(chatLinks.userId, userId), eq(chatLinks.agentId, agentId)));
      return { ok: false, error: "you'll need to allow this AI again before chatting" };
    }
  }

  async function personOf(userId: string) {
    const [p] = await db.select().from(persons).where(eq(persons.userId, userId));
    return p ?? null;
  }

  async function chatApproved(agentId: string) {
    const [hit] = await db
      .select()
      .from(agentClients)
      .where(and(eq(agentClients.agentId, agentId), eq(agentClients.clientId, CHAT_CLIENT_ID)));
    return Boolean(hit);
  }

  const describe = (m: NonNullable<Awaited<ReturnType<typeof modelsForAgent>>["primary"]>) => ({
    connection: m.connection.name,
    model: m.model,
    dataLocation: m.connection.dataLocation,
    words: DATA_WORDS[m.connection.dataLocation],
  });

  // Before the /:agentId routes, which would otherwise take this path.
  app.get("/callback", async (c) => {
    const userId = c.get("userId");
    // Single use: the launch is gone whatever happens next.
    const [launch] = await db
      .delete(chatLaunches)
      .where(
        and(
          eq(chatLaunches.state, c.req.query("state") ?? ""),
          gt(chatLaunches.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!launch || launch.userId !== userId) {
      // A browser that follows the redirect twice gets here the second time:
      // give the first a moment to finish, then go to the chat as usual.
      const agentId = /^([a-z0-9][a-z0-9-]{0,62})\./.exec(c.req.query("state") ?? "")?.[1];
      if (!agentId) return c.redirect(`${config.publicUrl}/my-ais`);
      for (let i = 0; i < 20; i++) {
        const [link] = await db
          .select({ at: chatLinks.updatedAt })
          .from(chatLinks)
          .where(and(eq(chatLinks.userId, userId), eq(chatLinks.agentId, agentId)));
        if (link && Date.now() - link.at.getTime() < 60_000) {
          return c.redirect(page(agentId, { connected: "1" }));
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return c.redirect(page(agentId, { error: "that sign-in link expired; try again" }));
    }
    const code = c.req.query("code");
    if (!code) {
      const said = c.req.query("error");
      return c.redirect(
        page(launch.agentId, {
          error:
            said === "access_denied"
              ? "you said no, so the chat isn't connected"
              : `the sign-in didn't finish (${said ?? "no code"})`,
        }),
      );
    }
    try {
      const tokens = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: chatCallbackUrl(config.publicUrl),
        code_verifier: launch.codeVerifier,
        resource: agentUrl(config.gatewayUrl, launch.agentId),
      });
      await saveTokens(userId, launch.agentId, tokens);
    } catch (err) {
      console.error(`chat code exchange for ${launch.agentId} failed: ${(err as Error).message}`);
      return c.redirect(page(launch.agentId, { error: "the sign-in didn't finish; try again" }));
    }
    return c.redirect(page(launch.agentId, { connected: "1" }));
  });

  // The AIs I can chat with: approved for the built-in chat and switched on.
  app.get("/", async (c) => {
    const person = await personOf(c.get("userId"));
    if (!person) return c.json([]);
    const rows = await db
      .select({ agent: agents })
      .from(agentClients)
      .innerJoin(agents, eq(agentClients.agentId, agents.id))
      .where(and(eq(agentClients.clientId, CHAT_CLIENT_ID), eq(agents.status, "active")));
    const mine = await db.select().from(grants).where(eq(grants.personId, person.id));
    return c.json(
      rows.map(({ agent }) => ({
        agentId: agent.id,
        name: agent.name,
        description: agent.description,
        granted: mine.some((g) => g.agentId === agent.id && g.status === "active"),
      })),
    );
  });

  // Everything the chat page needs to say before the first message.
  app.get("/:agentId", async (c) => {
    const userId = c.get("userId");
    const agentId = c.req.param("agentId");
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return c.json({ error: "no such AI" }, 404);
    const person = await personOf(userId);
    const approved = await chatApproved(agentId);
    const models = await modelsForAgent(db, agentId);
    const [link] = await db
      .select({ at: chatLinks.connectedAt })
      .from(chatLinks)
      .where(and(eq(chatLinks.userId, userId), eq(chatLinks.agentId, agentId)));
    const openPatient = person ? await openPatientOf(db, deps.fhir, person, agentId) : null;
    const problem = !person
      ? "your account isn't linked to a patient record yet"
      : agent.status !== "active"
        ? `${config.orgName} has stopped this AI`
        : !approved
          ? `${config.orgName} hasn't allowed the built-in chat for this AI`
          : models.problem;
    return c.json({
      orgName: config.orgName,
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status,
      },
      person: person ? { displayName: person.displayName, staff: isStaff(person) } : null,
      openPatient,
      approved,
      connected: Boolean(link),
      model: models.primary ? describe(models.primary) : null,
      fallback: models.fallback ? describe(models.fallback) : null,
      problem,
    });
  });

  // Start the chat's sign-in: aipass's own OAuth server, the person's consent page.
  app.get("/:agentId/connect", async (c) => {
    const agentId = c.req.param("agentId");
    const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
    if (!agent) return c.redirect(page(agentId, { error: "no such AI" }));
    // The agent rides along in the state, so a repeated callback still lands on its page.
    const state = `${agentId}.${randomBytes(24).toString("base64url")}`;
    const { verifier, challenge } = pkcePair();
    await db.insert(chatLaunches).values({
      state,
      userId: c.get("userId"),
      agentId,
      codeVerifier: verifier,
      expiresAt: new Date(Date.now() + LAUNCH_MINUTES * 60_000),
    });
    const u = new URL(`${config.publicUrl}/api/auth/oauth2/authorize`);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: CHAT_CLIENT_ID,
      redirect_uri: chatCallbackUrl(config.publicUrl),
      scope: "openid offline_access",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: agentUrl(config.gatewayUrl, agentId),
    })) {
      u.searchParams.set(k, v);
    }
    return c.redirect(u.toString());
  });

  app.post("/:agentId/disconnect", async (c) => {
    const userId = c.get("userId");
    const agentId = c.req.param("agentId");
    const [link] = await db
      .delete(chatLinks)
      .where(and(eq(chatLinks.userId, userId), eq(chatLinks.agentId, agentId)))
      .returning();
    if (link) {
      const tokens = JSON.parse(
        unseal(vaultKeys(), link.tokensSealed, bindOf(userId, agentId)),
      ) as Tokens;
      if (tokens.refresh_token) {
        await selfFetch(`${config.selfUrl}/api/auth/oauth2/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: CHAT_CLIENT_ID,
            token: tokens.refresh_token,
            token_type_hint: "refresh_token",
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch((err: Error) => console.warn(`chat token revoke failed: ${err.message}`));
      }
    }
    return c.json({ ok: true });
  });

  // One turn: the person's message in, the steps and the answer streamed back as NDJSON.
  app.post("/:agentId/messages", async (c) => {
    const userId = c.get("userId");
    const agentId = c.req.param("agentId");
    const body = History.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return c.json({ error: "no such AI" }, 404);
    const person = await personOf(userId);
    if (!person) return c.json({ error: "your account isn't linked to a patient record yet" }, 403);
    const models = await modelsForAgent(db, agentId);
    if (!models.primary) return c.json({ error: models.problem }, 409);
    const busyKey = `${userId}|${agentId}`;
    if (busy.has(busyKey)) return c.json({ error: "still answering your last message" }, 429);
    // A staff member works on the patient they have open (S10): the pass names them.
    const open = isStaff(person) ? await openPatientOf(db, deps.fhir, person, agentId) : null;
    if (isStaff(person) && !open) return c.json({ error: "choose a patient first" }, 409);
    const pass = await currentPass(userId, agentId, open?.ref.replace(/^Patient\//, ""));
    if (!pass.ok) return c.json({ error: pass.error, reconnect: true }, 409);

    const primary = models.primary;
    const fallback = models.fallback;
    const callOf =
      (m: typeof primary): ModelCall =>
      (req) =>
        streamChat(
          endpointOf(m.connection),
          { ...req, model: m.model },
          { fetch: deps.modelFetch },
        );

    busy.add(busyKey);
    c.header("content-type", "application/x-ndjson; charset=utf-8");
    c.header("cache-control", "no-store");
    c.header("x-accel-buffering", "no");
    return stream(c, async (s) => {
      // Writes queue in order, so events can be sent from synchronous callbacks.
      const send = (e: ChatEvent | Record<string, unknown>) => {
        void s.write(`${JSON.stringify(e)}\n`);
      };
      try {
        send({ type: "model", ...describe(primary) });
        const model = withFallback(callOf(primary), fallback ? callOf(fallback) : null, (err) => {
          if (!fallback) return;
          send({
            type: "notice",
            text: `${primary.connection.name} didn't answer (${err.message}), so ${fallback.model} is answering instead.`,
          });
          send({ type: "model", ...describe(fallback), fallback: true });
        });
        const tools = await connectGateway(
          agentUrl(config.gatewayInternalUrl, agentId),
          pass.pass,
          { fetch: deps.fetch },
        );
        try {
          const added = await runChat({
            model,
            tools,
            system: systemPrompt({
              agent,
              personName: person.displayName,
              patientName: open ? (open.name ?? open.ref) : null,
              instructions: tools.instructions,
            }),
            history: body.data.messages as ChatMessage[],
            emit: send,
          });
          send({ type: "done", messages: added });
        } finally {
          await tools.close().catch(() => {});
        }
      } catch (err) {
        const message =
          err instanceof ModelError ? err.message : "something went wrong while answering";
        if (!(err instanceof ModelError))
          console.error(`chat for ${agentId}: ${(err as Error).stack}`);
        send({ type: "error", message });
      } finally {
        busy.delete(busyKey);
      }
    });
  });

  return app;
}
