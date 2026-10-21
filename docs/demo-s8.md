# Demo: Maria chats with her AI, in the browser

**What you'll see:**
1. The admin adds a model on the **AI models** page, tests it, and gives it to the Diabetes Coach.
2. Maria opens **Chat** from her "My AIs" page. The chat asks her first, on the same consent page as any AI app.
3. She asks "What was my last A1c?". The chat shows the lookup, *checked by aipass*, then the answer.
4. Her mental-health medication stays private. **Stop** works on the chat's next lookup. **Activity** shows each lookup *via aipass chat (built-in)*.

Everything here is clicks in the browser; the only command is starting aipass. The demo uses synthetic data only, on localhost.

## 1. Start everything

```sh
pnpm dev
```

## 2. Add a model (admin)

Open http://localhost:3000 and sign in as the admin (the first account you create).

1. **AI models → Add model.** Any endpoint that speaks the OpenAI chat format with tool calling works. For example, a local [Ollama](https://ollama.com) with a tool-calling model pulled:
   - Name: `Local model`
   - Base URL: `http://localhost:11434/v1`
   - API key: leave empty
   - **Where does what the AI reads go?** *Stays on your network.* For a hosted provider, choose *Goes to a cloud provider*. aipass doesn't guess this: a gateway on your network that forwards to a hosted model counts as cloud.
2. **Test.** It lists the models. Pick one and click **Try**: the built-in chat reads records through tool calls, so you want *it called the tool*.
3. **Agents → Model** (the button in the Diabetes Coach row). Choose the connection and the model, optionally a fallback, and **Save**.

To skip this on every fresh database, put the model in your local `.env` (git-ignored) and the demo seed adds it:

```sh
AIPASS_DEV_MODEL_URL=http://localhost:11434/v1
AIPASS_DEV_MODEL=qwen3:30b
AIPASS_DEV_MODEL_DATA=network      # or cloud (the default)
```

## 3. Chat (Maria)

In another browser (or a private window), sign in at http://localhost:3000/my-ais as `maria@example.org` / `maria-demo-password`.

1. On the Diabetes Coach card, click **Chat with Diabetes Coach**. The page says which model answers and where what it reads goes.
2. **Allow and start chatting.** The consent page says the Diabetes Coach *connects through aipass chat (built-in)*. Click **Allow**.
3. Ask **What was my last A1c?** You see *Lab results · checked by aipass*, then the answer: 6.9 %.
4. Ask **What medications am I on?** Metformin, and that one record was withheld because *mental-health records are always private*.

## 4. What the admin sees, and Stop

1. **Activity**: each lookup, with *via aipass chat (built-in)*.
2. **Agents → Stop** the Diabetes Coach. Maria's next question gets *refused by aipass* with the reason. **Resume** to undo.
3. **Agents → Apps**: the built-in chat is an app like any other. Remove it and the chat's next lookup is refused; **Allow the built-in chat** puts it back.
4. **Roles → Diabetes Coach → Only models that keep data on your network**: after that, the role's agents can't be given a cloud model.

## What's checked automatically

- `apps/web/e2e/chat.spec.ts` runs all of the above by clicks, with a scripted model standing in for a real one. It also checks that no pass or other credential is ever sent to the model.
- `apps/gateway/test/s8-chat.int.test.ts` runs the chat's loop against the real gateway, Postgres and HAPI: answers, refusals, locked records, Stop, an unapproved app, and the receipt naming the app (with the hash chain still intact).
- `packages/chat` unit tests: streaming, tool calls in pieces, errors, the step limit, the fallback, and that a tool the gateway didn't offer is never called.
