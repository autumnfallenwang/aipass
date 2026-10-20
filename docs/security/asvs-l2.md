# OWASP ASVS 5.0 Level 2: self-check

This page checks aipass against all 253 requirements of OWASP ASVS 5.0.0 that apply at Level 2 (every L1 and L2 requirement). It was done on 2026-10-20, on commit `bd994bd`, and updated the same day for the fixes listed under *Fixed after the first pass*. It was done by the aipass project itself: a self-check, not an independent audit. The evidence is the code, configuration and tests at that commit. Where a dependency handles a control (mostly Better Auth 1.7.11), we read that dependency's code to see what it really does. Nothing was run for this check: a row that cites a test relies on that test, which CI runs, and the two findings that rest on framework behaviour say they were read in code, not tested on a running stack. aipass is developed and tested on localhost only ([D12](../decisions.md)), so the transport and hosting items, TLS above all, are partly the adopter's: those rows say what the adopter has to do. The threat model is in [threat-model.md](threat-model.md).

What the statuses mean:

- **Met**: the code, the configuration or a test does it.
- **Partly**: some of it. The note says what is missing.
- **Not met**: it doesn't.
- **N/A**: it doesn't apply to aipass. The note says why.
- **Delegated**: a dependency we configure does it. The note says what we checked in its code.

Paths in backticks, such as `cookies/index.mjs:35` or `authorize-*.mjs`, are files inside the named dependency's published package (`better-auth/dist/...`, `@better-auth/oauth-provider/dist/...`).

## Summary

| Chapter | Met | Partly | Not met | N/A | Delegated | Total |
|---|---:|---:|---:|---:|---:|---:|
| V1 Encoding and Sanitization | 12 | 1 | 0 | 14 | 0 | 27 |
| V2 Validation and Business Logic | 6 | 5 | 0 | 0 | 0 | 11 |
| V3 Web Frontend Security | 11 | 5 | 1 | 1 | 1 | 19 |
| V4 API and Web Service | 2 | 1 | 0 | 6 | 1 | 10 |
| V5 File Handling | 1 | 0 | 0 | 8 | 0 | 9 |
| V6 Authentication | 6 | 8 | 8 | 9 | 4 | 35 |
| V7 Session Management | 4 | 6 | 7 | 0 | 1 | 18 |
| V8 Authorization | 6 | 0 | 0 | 1 | 0 | 7 |
| V9 Self-contained Tokens | 5 | 2 | 0 | 0 | 0 | 7 |
| V10 OAuth and OIDC | 10 | 6 | 1 | 2 | 10 | 29 |
| V11 Cryptography | 7 | 6 | 1 | 0 | 0 | 14 |
| V12 Secure Communication | 1 | 1 | 6 | 1 | 0 | 9 |
| V13 Configuration | 5 | 5 | 3 | 0 | 0 | 13 |
| V14 Data Protection | 2 | 5 | 2 | 0 | 0 | 9 |
| V15 Secure Coding and Architecture | 5 | 8 | 0 | 0 | 0 | 13 |
| V16 Security Logging and Error Handling | 2 | 14 | 0 | 0 | 0 | 16 |
| V17 WebRTC | 0 | 0 | 0 | 7 | 0 | 7 |
| **All** | **85** | **73** | **29** | **49** | **17** | **253** |

## The gaps that matter most

1. **V6.3.3, V6.8.4**: An admin signs in with a password alone. Fix: require a passkey (or TOTP) for admin sessions in the admin guard [api/admin.ts:99](../../apps/api/src/admin.ts#L99).
2. **V7.3.2, V10.4.8, V7.4.2, V7.4.5**: Sessions and refresh tokens have no absolute lifetime, and an admin can't end someone's sessions or disable a login. Fix: cap session and refresh-token-family age; add "sign out everywhere" and "disable login" for admins.
3. **V6.2.4, V6.2.12, V6.4.1, V11.4.2**: No common or breached password check; the admin's temporary password never expires; scrypt is tuned below current guidance. Fix: a password-list check, a forced change on first sign-in, and stronger hash settings.
4. **V6.3.1, V15.3.4**: Sign-in limits count in memory, per process, with no per-account lockout; through the web app's own proxy, every browser shares one address. Fix: a per-account limit, and `/api` sent straight to the api (the Helm ingress does this).
5. **V1.3.6**: Admin-entered discovery URLs can name any host. Fix: an outbound host allow-list setting.
6. **V3.4.3**: The CSP allows inline scripts. Fix: a nonce-based `script-src` (Next middleware).
7. **V16.3.1, V16.3.3**: Sign-ins and admin changes are JSON log lines, not part of the hash-chained receipts, and some events (passkey registration, token exchange, refused cross-site requests) aren't logged. Fix: log them, and ship logs off the host (V16.4.3).

## Fixed after the first pass

The first pass of this check (on `bd994bd`) found these, and they were fixed the same day. Each fix has a test:

| Was | Fix |
|---|---|
| V3.5.1, V3.5.2: admin and person routes relied on `SameSite=Lax` alone | `Origin` / `Sec-Fetch-Site` check on every state change |
| V8.2.2: any signed-in user could read an approval by its id | only its person and approver; others get 403 and the approver's name only |
| V8.2.1: any signed-in person could register SSO providers | SSO provider management is admin-only |
| V3.7.2: `next` after sign-in was an open redirect | only same-origin paths |
| V4.1.3: the api believed a single `X-Forwarded-For` from anyone | the api works out the address itself, like the gateway |
| V15.3.2, V16.5.1: discovery followed redirects and echoed error text | `redirect: "error"`, generic errors, details in the server log |
| V16.3.1, V16.3.3: sign-ins and admin changes weren't logged | JSON log lines, without emails or passwords |
| V3.4.3: `base-uri 'self'` | `base-uri 'none'` |

## V1 Encoding and Sanitization

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V1.1.1 | Decode input once, before validation | Met | Hono and zod parse each body and query once, then validate. FHIR search values are put into `URLSearchParams` and never decoded again [gateway/guard.ts:367](../../apps/gateway/src/guard.ts#L367). |
| V1.1.2 | Encode output as the last step, or let the interpreter do it | Met | React escapes at render time, Drizzle binds SQL parameters, and `URLSearchParams` and `JSON.stringify` encode at the point of use. |
| V1.2.1 | Output encoding fits the context (HTML, attributes, headers) | Met | All UI text goes through React's escaping. There is no `dangerouslySetInnerHTML` or `innerHTML` in `apps/web/src`. The APIs answer JSON. |
| V1.2.2 | Encode URL parts; allow only safe URL schemes | Met | URLs are built with `URLSearchParams` [fhir/smart.ts:84](../../packages/fhir/src/smart.ts#L84) and `encodeURIComponent` [fhir/client.ts:78](../../packages/fhir/src/client.ts#L78). Admin-entered URLs are shown as text, never as links. |
| V1.2.3 | Encode when building JavaScript or JSON | Met | JSON only comes from `JSON.stringify` or `c.json`, including the records in tool results [gateway/tools.ts:48](../../apps/gateway/src/tools.ts#L48). |
| V1.2.4 | Parameterized database queries | Met | Drizzle ORM throughout; the few `sql` templates bind their values. FHIR searches take only allow-listed parameters from validated tool arguments [gateway/guard.ts:439](../../apps/gateway/src/guard.ts#L439). Test "_include / $everything style arguments are refused before reaching FHIR" [gateway/test/s1-guard.int.test.ts:283](../../apps/gateway/test/s1-guard.int.test.ts#L283). |
| V1.2.5 | Prevent OS command injection | Met | The servers never start processes. Only the `pnpm check` CLI and test helpers use `execFileSync`, with no shell. |
| V1.2.6 | Prevent LDAP injection | N/A | No LDAP. |
| V1.2.7 | Prevent XPath injection | N/A | No XML or XPath. |
| V1.2.8 | Configure LaTeX safely | N/A | No LaTeX. |
| V1.2.9 | Escape regex metacharacters | N/A | No regular expression is built from input. |
| V1.3.1 | Sanitize HTML from WYSIWYG editors | N/A | aipass takes no rich HTML. Notes from FHIR are shown as plain text. |
| V1.3.2 | Avoid eval and dynamic code execution | Met | No `eval`, `new Function` or expression language in the source. |
| V1.3.3 | Sanitize data for dangerous contexts; limit length | Met | zod schemas cap the length of every admin and person field [api/admin.ts:60](../../apps/api/src/admin.ts#L60); ids are slugified [api/admin.ts:43](../../apps/api/src/admin.ts#L43). |
| V1.3.4 | Sanitize user-supplied SVG | N/A | No user-supplied SVG. |
| V1.3.5 | Sanitize Markdown, CSS, XSL and similar | N/A | No user-supplied markup or templates are rendered. |
| V1.3.6 | Protect against SSRF with allowlists | Partly | Protected: an OAuth app's metadata document (Better Auth CIMD fetches HTTPS from public addresses only, without redirects: `@better-auth/cimd/dist/node.mjs:32`), and paging links, which must stay on the FHIR server [fhir/client.ts:52](../../packages/fhir/src/client.ts#L52). Admin-entered discovery URLs (connections, FHIR servers) no longer follow redirects [api/connections.ts:62](../../apps/api/src/connections.ts#L62), [fhir/smart.ts:43](../../packages/fhir/src/smart.ts#L43), but can still name any host: there is no outbound allow-list. Internal hosts are allowed on purpose, for logins on the hospital's own network. |
| V1.3.7 | Prevent template injection | N/A | No server-side templates; receipt sentences are plain string building. |
| V1.3.8 | Prevent JNDI injection | N/A | Not Java. |
| V1.3.9 | Sanitize content sent to memcache | N/A | No memcache. |
| V1.3.10 | Sanitize format strings | Met | No printf-style formatting of input. Log lines are template literals passed as one argument. |
| V1.3.11 | Prevent SMTP/IMAP injection | N/A | aipass sends no email. |
| V1.4.1 | Memory-safe strings and buffers | N/A | TypeScript on Node.js; no unmanaged code of our own. |
| V1.4.2 | Prevent integer overflow with range checks | Met | Numbers from input are range-checked: page size 1 to 50 [gateway/tools.ts:13](../../apps/gateway/src/tools.ts#L13), receipt pages 1 to 200 [api/admin.ts:460](../../apps/api/src/admin.ts#L460), proposed values per measure [fhir/proposal.ts:63](../../packages/fhir/src/proposal.ts#L63). |
| V1.4.3 | Release memory; no dangling pointers | N/A | Garbage-collected runtime. |
| V1.5.1 | Restrictive XML parser (no XXE) | N/A | No XML is parsed: FHIR is JSON, and SAML sign-in isn't used. |
| V1.5.2 | Safe deserialization of untrusted data | Met | Only `JSON.parse`, followed by zod schemas. Paging tokens are authenticated (AES-GCM) before they are parsed [gateway/paging.ts:39](../../apps/gateway/src/paging.ts#L39). |

## V2 Validation and Business Logic

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V2.1.1 | Docs define input validation rules | Partly | The rules live in code as zod schemas (tools [gateway/tools.ts:13](../../apps/gateway/src/tools.ts#L13), admin bodies [api/admin.ts:60](../../apps/api/src/admin.ts#L60)). The plan lists the tools and the proposal catalog with its ranges ([PLAN.md](../PLAN.md)). There is no single page of validation rules. |
| V2.1.2 | Docs define checks on combined data items | Partly | Some are written down: a grant can't exceed the role (D6), and a pass's patient must be its person's ([threat model](threat-model.md)). They aren't gathered in one place. |
| V2.1.3 | Business limits documented, per user and globally | Partly | Lifetimes are documented: a pass lives 5 minutes at most, a proposal 10 minutes, and a commit must come within 2 minutes, once ([PLAN.md](../PLAN.md)). The threat model gives the gateway's limits (300 calls a minute per agent and person, 60 refused passes per address). Better Auth's sign-in limits and any overall limit aren't written down. |
| V2.2.1 | Validate all input against expected values | Met | Strict zod schemas (unknown fields refused) on every admin, person and tool input [gateway/tools.ts:72](../../apps/gateway/src/tools.ts#L72). Test "rejects bad role bodies" [api/test/admin.int.test.ts:87](../../apps/api/test/admin.int.test.ts#L87). Path ids aren't pattern-checked, but they are only ever bound query values. |
| V2.2.2 | Validate at a trusted service layer | Met | Every check is server-side. The web form's `minLength` is a convenience only. |
| V2.2.3 | Combinations of related items are reasonable | Met | A person may grant only within the role [api/person.ts:116](../../apps/api/src/person.ts#L116). A pass's patient must be its person's [gateway/guard.ts:154](../../apps/gateway/src/guard.ts#L154). Proposals refuse out-of-range and future readings: test [fhir/test/proposal.test.ts:42](../../packages/fhir/test/proposal.test.ts#L42). |
| V2.3.1 | Business flows run in order, no skipped steps | Met | Propose, then approve with a passkey, then commit; each step is checked (rule 7, [policy/index.ts:225](../../packages/policy/src/index.ts#L225)). Tests A1 to A8 [web/e2e/writes.spec.ts:99](../../apps/web/e2e/writes.spec.ts#L99). A SMART launch's `state` is single use and tied to the person [api/fhir-servers.ts:198](../../apps/api/src/fhir-servers.ts#L198). |
| V2.3.2 | Business limits are enforced | Met | Pass lifetime cap [gateway/pass.ts:144](../../apps/gateway/src/pass.ts#L144); the 2-minute approval window [policy/index.ts:218](../../packages/policy/src/index.ts#L218); page size caps [gateway/guard.ts:366](../../apps/gateway/src/guard.ts#L366). |
| V2.3.3 | Business operations succeed fully or roll back | Partly | Receipts are appended in a transaction [db/receipts.ts:50](../../packages/db/src/receipts.ts#L50). Elsewhere aipass undoes by hand when a second step fails (creating an agent [api/admin.ts:172](../../apps/api/src/admin.ts#L172), committing a change [gateway/changes.ts:265](../../apps/gateway/src/changes.ts#L265)). "Give a login" creates the account and then links it, outside one transaction [api/admin.ts:397](../../apps/api/src/admin.ts#L397). |
| V2.3.4 | Locking stops double use of limited resources | Met | An approval is used with a conditional update, so two commits can't both win [gateway/changes.ts:221](../../apps/gateway/src/changes.ts#L221). Deciding an approval only works while it is pending [api/approvals.ts:231](../../apps/api/src/approvals.ts#L231). |
| V2.4.1 | Anti-automation against excessive calls | Partly | The gateway limits each agent acting for each person (300 calls a minute) and refused passes per client address (60 a minute) [gateway/app.ts:155](../../apps/gateway/src/app.ts#L155); tests "a flood of bad passes is cut off before it reaches the audit trail" and "one agent acting for one person is limited per minute" [gateway/test/s7-limits.int.test.ts:19](../../apps/gateway/test/s7-limits.int.test.ts#L19). The counters are per process. Better Auth limits its own routes in production only, with the address caveat in V4.1.3. The admin and person APIs have no limit. |

## V3 Web Frontend Security

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V3.2.1 | Browsers can't render responses in the wrong context | Met | The api and gateway answer `application/json` with `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin` (Hono `secureHeaders` defaults, [api/app.ts:41](../../apps/api/src/app.ts#L41), [gateway/app.ts:83](../../apps/gateway/src/app.ts#L83)). aipass serves no user files. |
| V3.2.2 | Show text with safe rendering functions | Met | React renders text nodes. No `innerHTML` or `dangerouslySetInnerHTML` in `apps/web/src`. |
| V3.3.1 | Cookies are Secure, with a __Host- or __Secure- prefix | Partly | Better Auth sets `Secure` and the `__Secure-` prefix only when `PUBLIC_URL` is `https://` (`better-auth/dist/cookies/index.mjs:23`). On the localhost trial the cookies are plain. Nothing refuses an `http://` public origin outside localhost. |
| V3.3.2 | SameSite set for each cookie's purpose | Delegated | Better Auth sets `SameSite=Lax` (`cookies/index.mjs:35`). Lax suits a top-level sign-in flow, but aipass's own JSON routes lean on it as their only CSRF defence (V3.5.1). |
| V3.3.3 | Cookie names use the __Host- prefix | Not met | The session cookie is `aipass.session_token`, or `__Secure-aipass.session_token` over HTTPS [api/auth.ts:208](../../apps/api/src/auth.ts#L208). Fix: name it `__Host-...` through Better Auth's `advanced.cookies`. |
| V3.3.4 | Session cookie is HttpOnly; token only sent via Set-Cookie | Partly | The cookie is `HttpOnly` (`cookies/index.mjs:37`). But Better Auth's sign-in and sign-up responses also carry the session token in the JSON body (`api/routes/sign-in.mjs:364`). The cookie is HMAC-signed, so the bare token can't be pasted in as a cookie, but page scripts can read it. |
| V3.4.1 | HSTS on all responses: 1 year, includeSubDomains | Partly | `max-age=31536000` on the api, the gateway and the web app's production build [web/next.config.ts:44](../../apps/web/next.config.ts#L44), but without `includeSubDomains`, and not under `next dev`. HSTS only works over HTTPS, which the adopter terminates. |
| V3.4.2 | CORS origin is fixed or allow-listed | Met | aipass sends no `Access-Control-Allow-Origin` at all. One public origin (D10) means the browser never needs CORS. |
| V3.4.3 | CSP with object-src 'none', base-uri 'none', allowlist or nonces | Partly | The production CSP has `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` and a `'self'` allowlist [web/next.config.ts](../../apps/web/next.config.ts). `script-src` still allows `'unsafe-inline'` (Next inlines its bootstrap scripts), which leaves inline-script XSS less contained. Fix: nonces from Next middleware. |
| V3.4.4 | X-Content-Type-Options: nosniff on every response | Met | Hono `secureHeaders` on the api and gateway; the web app's production headers [web/next.config.ts:45](../../apps/web/next.config.ts#L45). (Not sent by `next dev`.) |
| V3.4.5 | A referrer policy is set | Met | `Referrer-Policy: no-referrer` on the api, the gateway and the web app [web/next.config.ts:47](../../apps/web/next.config.ts#L47). |
| V3.4.6 | CSP frame-ancestors on every response | Partly | Web pages send `frame-ancestors 'none'` [web/next.config.ts:34](../../apps/web/next.config.ts#L34). The api and gateway send only `X-Frame-Options: DENY` [api/app.ts:41](../../apps/api/src/app.ts#L41), which ASVS calls obsolete. Fix: add a `frame-ancestors 'none'` policy to their `secureHeaders`. |
| V3.5.1 | Cross-site requests to sensitive functions are rejected | Met | Better Auth's routes check `Origin` (`api/middlewares/origin-check.mjs:96`). aipass's own `/api/admin/*` and `/api/person/*` refuse any POST, PUT, PATCH or DELETE whose `Origin` isn't aipass's own, or whose `Sec-Fetch-Site` is `cross-site` or `same-site` [api/app.ts](../../apps/api/src/app.ts); cookies are also `SameSite=Lax`. Test "refuses a state change from another site (CSRF), even with the admin's cookie" [security.int.test.ts](../../apps/api/test/security.int.test.ts). |
| V3.5.2 | Preflight-protected functions can't be called without one | Met | A request that skips the preflight (`text/plain`, no body) still carries `Origin` from a browser, so the same check refuses it [api/app.ts](../../apps/api/src/app.ts); test as in V3.5.1. |
| V3.5.3 | Sensitive actions don't use GET | Met | Every change is a POST, PUT or DELETE. Two GETs belong to the SMART flow by design: `connect` creates a launch and redirects [api/fhir-servers.ts:163](../../apps/api/src/fhir-servers.ts#L163), and `callback` is tied to the person by `state` [api/fhir-servers.ts:198](../../apps/api/src/fhir-servers.ts#L198). |
| V3.5.4 | Separate applications on separate hostnames | Met | The Helm chart puts the web app and the gateway on separate hosts [helm/templates/ingress.yaml](../../deploy/helm/aipass/templates/ingress.yaml), and the api isn't public. The localhost trial separates them by port only. |
| V3.5.5 | postMessage checks origin and syntax | N/A | aipass doesn't use `postMessage`. |
| V3.7.1 | Only supported client-side technology | Met | React 19 and Next.js 16; no plugins. |
| V3.7.2 | Redirects to other hosts only via an allowlist | Met | After sign-in, `next` is followed only when it is a path on this origin (`safeNextPath`: not `//`, not `/\\`, no scheme, no control characters) [shared/index.ts](../../packages/shared/src/index.ts), used by [web/login/page.tsx](../../apps/web/src/app/login/page.tsx) and [web/after-login/page.tsx](../../apps/web/src/app/after-login/page.tsx); tests [shared/test/next-path.test.ts](../../packages/shared/test/next-path.test.ts). |

## V4 API and Web Service

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V4.1.1 | Content-Type matches the body, with charset where needed | Met | Hono and Next send `application/json` and `text/html; charset=utf-8`; MCP answers `application/json` or `text/event-stream`. JSON takes no charset parameter. |
| V4.1.2 | Only user-facing endpoints redirect HTTP to HTTPS | Partly | aipass itself never redirects to HTTPS. But the Helm ingress puts the gateway's host in the same TLS block as the web app's [helm/templates/ingress.yaml](../../deploy/helm/aipass/templates/ingress.yaml), and many ingress controllers then redirect every host by default. Adopter: switch that redirect off for the gateway host. |
| V4.1.3 | Users can't override headers set by intermediaries | Met | Clients can't choose their address. The gateway and the api both take the socket's address, and believe `X-Forwarded-For` only from a proxy in `AIPASS_TRUSTED_PROXIES` (`clientAddress` [shared/index.ts](../../packages/shared/src/index.ts)). The api writes the result into the one header Better Auth reads, replacing whatever the client sent [api/app.ts](../../apps/api/src/app.ts), [api/auth.ts](../../apps/api/src/auth.ts). Tests: "ignores X-Forwarded-For from anyone but a trusted proxy" [gateway/test/limits.test.ts](../../apps/gateway/test/limits.test.ts). |
| V4.2.1 | All components agree on HTTP message boundaries | Delegated | Node's HTTP parser (llhttp) runs in strict mode; nothing turns on `insecureHTTPParser`. Any load balancer in front is the adopter's. |
| V4.3.1 | Limit GraphQL query depth and cost | N/A | No GraphQL. |
| V4.3.2 | GraphQL introspection off in production | N/A | No GraphQL. |
| V4.4.1 | WebSockets use WSS | N/A | No WebSockets; MCP runs over HTTP. |
| V4.4.2 | WebSocket handshake checks Origin | N/A | No WebSockets. |
| V4.4.3 | Dedicated WebSocket tokens follow session rules | N/A | No WebSockets. |
| V4.4.4 | WebSocket tokens come from the HTTPS session | N/A | No WebSockets. |

## V5 File Handling

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V5.1.1 | Docs define allowed upload types and sizes | N/A | aipass takes no file uploads. |
| V5.2.1 | Accept only files of a size it can process | N/A | No file uploads. |
| V5.2.2 | Check file extension and content type | N/A | No file uploads. |
| V5.2.3 | Check archives' unpacked size before unpacking | N/A | No archives are accepted. |
| V5.3.1 | Uploaded files are never executed | N/A | No uploads. |
| V5.3.2 | File paths come from trusted data | Met | The only file paths are configuration: `AIPASS_FIXTURES_DIR` [api/init.ts:16](../../apps/api/src/init.ts#L16) and `AIPASS_MIGRATIONS_DIR` [db/migrate.ts:11](../../packages/db/src/migrate.ts#L11). No request supplies a filename. |
| V5.4.1 | Ignore user filenames; set Content-Disposition | N/A | No file downloads. |
| V5.4.2 | Encode filenames that are served | N/A | No file downloads. |
| V5.4.3 | Scan untrusted files for malware | N/A | No files are accepted or served. |

## V6 Authentication

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V6.1.1 | Docs explain rate limits, anti-automation and lockout | Partly | The threat model names Better Auth's rate limiter, "on in production", and how the client address is found behind a proxy ([threat model](threat-model.md)). It doesn't give the limits (3 sign-in attempts per 10 s per address), say they are off in development, or explain how a malicious lockout is avoided. |
| V6.1.2 | A list of context-specific words is documented | Not met | No such list. |
| V6.1.3 | All authentication pathways and their strength are documented | Partly | The guides and the threat model describe password, passkey, connected logins, OAuth for AI apps, token exchange and dev passes ([guides/own-login.md](../guides/own-login.md)). How strong each is, and what must hold across them, isn't written down; for example, admins can sign in through a connection, which skips aipass's own password and passkey. |
| V6.2.1 | Passwords at least 8 characters (15 recommended) | Met | At least 10 [api/auth.ts:124](../../apps/api/src/auth.ts#L124), also in the admin's "Give a login" [api/admin.ts:83](../../apps/api/src/admin.ts#L83). Below the recommended 15. |
| V6.2.2 | Users can change their password | Partly | Better Auth's `/change-password` endpoint is on, but no aipass page offers it. |
| V6.2.3 | Password change needs the current and new password | Delegated | `/change-password` requires `currentPassword` (`better-auth/dist/api/routes/update-user.mjs:88`). |
| V6.2.4 | Check new passwords against the top 3,000 | Not met | No check. Fix: a common-password list in the sign-up hook and on password change, or Better Auth's breached-password plugin. |
| V6.2.5 | No character-composition rules | Delegated | Better Auth checks length only. |
| V6.2.6 | Password fields use type=password | Met | Sign-in [web/login/page.tsx:128](../../apps/web/src/app/login/page.tsx#L128) and the admin's temporary-password field [web/admin/people/page.tsx:135](../../apps/web/src/app/admin/people/page.tsx#L135). |
| V6.2.7 | Paste and password managers are allowed | Met | No paste blocking; `autocomplete` hints are set (`username webauthn`, `current-password`, `new-password`) [web/login/page.tsx:118](../../apps/web/src/app/login/page.tsx#L118). |
| V6.2.8 | Password checked exactly as typed | Delegated | No truncation or case change, up to 128 characters. Better Auth applies Unicode NFKC normalization before hashing (`@better-auth/utils/dist/password.node.mjs`), which NIST allows. |
| V6.2.9 | Passwords of 64+ characters allowed | Delegated | Better Auth allows up to 128 (`context/create-context.mjs:187`). aipass's own form takes up to 200 [api/admin.ts:83](../../apps/api/src/admin.ts#L83), then Better Auth caps it at 128. |
| V6.2.10 | No forced periodic password changes | Met | Passwords never expire. |
| V6.2.11 | The context-specific word list is enforced | Not met | No list exists (V6.1.2). |
| V6.2.12 | New passwords checked against breached passwords | Not met | No check. |
| V6.3.1 | Credential stuffing and brute force are stopped as documented | Partly | Better Auth allows 3 sign-in attempts per 10 s per client address (`api/rate-limiter/index.mjs:305`), in production only (`context/create-context.mjs:172`), counted in memory per process. The address can't be chosen by the client (V4.1.3). But when browsers reach the api through the web app's own proxy (`compose.yaml`, dev), they all share the web app's address; the Helm ingress sends `/api` to the api directly to avoid that. There is no per-account lockout. |
| V6.3.2 | No default accounts | Partly | There is no built-in admin. But the first account on a fresh install becomes the admin [api/auth.ts:136](../../apps/api/src/auth.ts#L136), so a fresh install that is reachable can be claimed by anyone. And the demo, on by default in `compose.yaml` [compose.yaml:63](../../compose.yaml#L63), creates two person logins whose passwords are published [api/demo.ts:18](../../apps/api/src/demo.ts#L18); nothing refuses the demo outside localhost. |
| V6.3.3 | Multi-factor authentication is required | Not met | A password alone signs anyone in, admins included; passkeys are optional. (Writing to a record does need the person's passkey, with user verification.) |
| V6.3.4 | No undocumented pathways; equal strength across them | Partly | Every pathway is in the docs, and dev passes are off unless asked for and loopback-only [api/app.ts:135](../../apps/api/src/app.ts#L135). Strength isn't equal: a connection signs people in, admins included, on its own terms. |
| V6.4.1 | Initial passwords are random, short-lived, not kept | Not met | The admin types a "temporary password" for a person [api/admin.ts:387](../../apps/api/src/admin.ts#L387). It never expires, and the person is never asked to change it. |
| V6.4.2 | No password hints or secret questions | Met | None. |
| V6.4.3 | Secure password reset that keeps MFA | Not met | There is no reset flow (Better Auth's needs an email sender, which isn't set up) and no admin reset. A person who forgets their password has no documented way back. |
| V6.4.4 | A lost factor is replaced only after identity proofing | Partly | A new passkey can be added with any password session less than 24 hours old (Better Auth `freshAge`, required by `@better-auth/passkey` for registration), and that passkey can then approve writes. Nothing stronger is asked. |
| V6.5.1 | OTPs and lookup secrets work only once | N/A | aipass has no OTPs, lookup secrets or out-of-band codes. |
| V6.5.2 | Hash low-entropy lookup secrets | N/A | None. |
| V6.5.3 | OTP seeds and codes from a CSPRNG | N/A | None. |
| V6.5.4 | Codes have 20+ bits of entropy | N/A | None. |
| V6.5.5 | Out-of-band requests at most 10 min; TOTP 30 s | N/A | None. (A write proposal waits at most 10 minutes [gateway/changes.ts:23](../../apps/gateway/src/changes.ts#L23).) |
| V6.6.1 | SMS or phone OTPs only with safeguards | N/A | No SMS or phone. |
| V6.6.2 | Out-of-band codes bound to their request | N/A | No out-of-band codes. (Passkey approvals are bound to the payload, the approval and a nonce: test [fhir/test/proposal.test.ts:33](../../packages/fhir/test/proposal.test.ts#L33).) |
| V6.6.3 | Rate-limit out-of-band code entry | N/A | No out-of-band codes. |
| V6.8.1 | Identity can't be spoofed through another IdP | Partly | Every connection links by verified email to an existing login [api/auth.ts:85](../../apps/api/src/auth.ts#L85), and token exchange does the same [api/token-exchange.ts:131](../../apps/api/src/token-exchange.ts#L131). So any enabled connection that asserts someone's email, an admin's included, signs in as that person. Fix: link by issuer and `sub` after the first sign-in, and choose per connection whether it may sign in admins. |
| V6.8.2 | Signatures on IdP assertions are always checked | Met | Connected-login ID tokens: Better Auth SSO checks signature, issuer and audience with `jose` (`@better-auth/sso/dist/index.mjs:580`). Token exchange checks against the connection's keys [api/token-exchange.ts:106](../../apps/api/src/token-exchange.ts#L106); test "refuses a token signed with the wrong key" [api/test/exchange.int.test.ts:222](../../apps/api/test/exchange.int.test.ts#L222). |
| V6.8.3 | SAML assertions used only once | N/A | No SAML connections; aipass registers OIDC only. |
| V6.8.4 | IdP authentication strength and recency checked | Not met | Admin access should take more than one factor (V6.3.3), but aipass reads no `acr`, `amr` or `auth_time` from a connection, and documents no fallback. |

## V7 Session Management

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V7.1.1 | Inactivity and maximum session lifetimes documented | Not met | Not documented. Better Auth's defaults apply: 7-day sessions, extended on each day of use (`context/create-context.mjs:147`). |
| V7.1.2 | Concurrent session policy documented | Not met | Not documented, and there is no limit. |
| V7.1.3 | Federated session systems and their lifetimes documented | Not met | Connections are documented (D13), but not how aipass sessions relate to the IdP's. They don't: signing out at the IdP leaves the aipass session. |
| V7.2.1 | Session tokens verified by a trusted backend | Met | Every route that needs a signed-in user checks the session with Better Auth's `getSession` on the server [api/admin.ts:100](../../apps/api/src/admin.ts#L100); the gateway verifies passes itself [gateway/pass.ts:89](../../apps/gateway/src/pass.ts#L89). |
| V7.2.2 | Dynamic tokens, not static API keys | Met | Sessions are random tokens; passes are short-lived signed JWTs; headless agents authenticate as OAuth clients and exchange tokens. |
| V7.2.3 | Reference tokens: CSPRNG, 128+ bits | Delegated | Better Auth session tokens are 32 random letters and digits, about 190 bits (`db/internal-adapter.mjs:285`). |
| V7.2.4 | New session token on sign-in; old one ended | Partly | Each sign-in gets a new token from Better Auth. Signing in again doesn't end a session the browser already had. |
| V7.3.1 | Inactivity timeout set by risk analysis | Partly | In effect 7 days without use, Better Auth's default. No risk analysis or decision behind it, and long for an admin console. |
| V7.3.2 | Absolute maximum session lifetime | Not met | Sessions slide: each day of use pushes the expiry 7 days out (`api/routes/session.mjs:180`), with no cap. |
| V7.4.1 | Ended sessions can't be used again | Met | Sign-out deletes the session on the server (Better Auth). A pass can't be recalled, but it lives 5 minutes at most and the gateway re-checks the agent and the grant on every call: test "Grant revoked, then calls again" [gateway/test/s1-guard.int.test.ts:156](../../apps/gateway/test/s1-guard.int.test.ts#L156). |
| V7.4.2 | Disabling or deleting an account ends its sessions | Not met | aipass has no way to disable or delete a login, so a leaver's sessions can't be ended. (Stopping an agent or revoking a grant does work at once.) |
| V7.4.3 | Offer to end other sessions after a factor change | Partly | Better Auth's `/change-password` has `revokeOtherSessions` (`api/routes/update-user.mjs:93`), but no aipass page uses it. Adding or removing a passkey doesn't offer it. |
| V7.4.4 | Visible logout on every authenticated page | Partly | The admin pages [web/admin/layout.tsx:59](../../apps/web/src/app/admin/layout.tsx#L59) and My AIs [web/my-ais/page.tsx:265](../../apps/web/src/app/my-ais/page.tsx#L265) have "Sign out". The consent and approval pages don't. |
| V7.4.5 | Admins can end a user's or everyone's sessions | Not met | No such function. |
| V7.5.1 | Re-authenticate before changing authentication settings | Partly | Changing the password needs the current one. Adding a passkey needs a session under 24 hours old, not a fresh sign-in; removing one needs only a session. Email change is off. |
| V7.5.2 | Users can view and end their sessions (after re-auth) | Partly | Better Auth's `/list-sessions` and `/revoke-sessions` exist, but no page shows them, and they ask for no re-authentication. |
| V7.6.1 | RP and IdP session lifetimes behave as documented | Not met | Not documented. A session started through a connection lives on its own (7 days, sliding), whatever the IdP does. |
| V7.6.2 | New sessions need consent or an explicit action | Met | Sessions start only from a sign-in the person makes, including "Sign in with" a connection. AI apps get passes only after the consent page. |

## V8 Authorization

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V8.1.1 | Docs define function- and data-level access rules | Met | The decision rules 1 to 7 ([PLAN.md](../PLAN.md), [policy/index.ts](../../packages/policy/src/index.ts)), D6 and D11 ([decisions.md](../decisions.md)), and the threat model. |
| V8.1.2 | Docs define field-level read and write rules | Met | The role's patient-field mask is documented ([PLAN.md](../PLAN.md)). Agents never write fields; they only propose a measure and a value. |
| V8.2.1 | Function access only with explicit permission | Met | Admin routes need role `admin` [api/admin.ts:99](../../apps/api/src/admin.ts#L99); test "refuses a second (person) account with 403" [api/test/admin.int.test.ts:73](../../apps/api/test/admin.int.test.ts#L73). Better Auth's SSO provider management (`/api/auth/sso/*` other than sign-in callbacks) is admin-only too [api/app.ts](../../apps/api/src/app.ts); test "lets only the admin manage SSO providers" [security.int.test.ts](../../apps/api/test/security.int.test.ts). |
| V8.2.2 | Data access only to permitted items (no IDOR/BOLA) | Met | The gateway pins every call to the pass's patient and filters every record: tests [gateway/test/s1-guard.int.test.ts:127](../../apps/gateway/test/s1-guard.int.test.ts#L127), [gateway/test/s1-filter.int.test.ts:93](../../apps/gateway/test/s1-filter.int.test.ts#L93). Person routes only look up the caller's own person. An approval is shown only to its person and its approver; anyone else gets 403 and learns only who may approve [api/approvals.ts](../../apps/api/src/approvals.ts); test "shows an approval only to its person and approver" [security.int.test.ts](../../apps/api/test/security.int.test.ts). |
| V8.2.3 | Field access only to permitted fields (no BOPLA) | Met | A Patient is rebuilt from an empty object with only the role's fields [fhir/mask.ts:11](../../packages/fhir/src/mask.ts#L11); test "drops fields it doesn't know, even if asked" [fhir/test/fhir.test.ts:110](../../packages/fhir/test/fhir.test.ts#L110). |
| V8.3.1 | Authorization enforced at a trusted service layer | Met | All checks run in the api and the gateway; the UI only hides buttons. |
| V8.4.1 | Cross-tenant controls | N/A | One install serves one organization; there are no tenants. |

## V9 Self-contained Tokens

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V9.1.1 | Token signature checked before its contents are used | Met | `jwtVerify` runs before any claim is used [gateway/pass.ts:112](../../apps/gateway/src/pass.ts#L112); tests "tampered payload" and "signed by an unknown key" [gateway/test/s1-guard.int.test.ts:183](../../apps/gateway/test/s1-guard.int.test.ts#L183). |
| V9.1.2 | Algorithm allowlist, never 'none' | Partly | The gateway allows ES256, RS256, EdDSA and PS256 only [gateway/pass.ts:39](../../apps/gateway/src/pass.ts#L39). Token exchange passes no `algorithms` to `jwtVerify` [api/token-exchange.ts:106](../../apps/api/src/token-exchange.ts#L106); `jose` still refuses `none` and needs a matching key, but there is no explicit list. |
| V9.1.3 | Keys come from trusted, preconfigured sources | Met | Each trusted issuer's JWKS URL is configuration [gateway/config.ts:49](../../apps/gateway/src/config.ts#L49). A connection's comes from its discovery document when the admin adds it [api/connections.ts:67](../../apps/api/src/connections.ts#L67). `jku`, `x5u` and embedded `jwk` headers are ignored. |
| V9.2.1 | Check exp and nbf | Met | `jose` checks `exp` and `nbf` with 10 s of skew; the gateway also requires `exp` and caps the lifetime at 5 minutes [gateway/pass.ts:117](../../apps/gateway/src/pass.ts#L117); test "expired" [gateway/test/s1-guard.int.test.ts:183](../../apps/gateway/test/s1-guard.int.test.ts#L183). (Token exchange doesn't require `exp`.) |
| V9.2.2 | Check the token's type and purpose | Partly | The audience (one agent's URL) and a required `act.sub` keep ID tokens and preview tokens out. The `typ` header (`at+jwt`) isn't checked. |
| V9.2.3 | Accept only tokens meant for this service (aud) | Met | The audience must be this agent's own gateway URL [gateway/pass.ts:114](../../apps/gateway/src/pass.ts#L114); tests "wrong audience" and "pass for a different agent" [gateway/test/s1-guard.int.test.ts:183](../../apps/gateway/test/s1-guard.int.test.ts#L183). Token exchange checks the connection's audience: test [api/test/exchange.int.test.ts:235](../../apps/api/test/exchange.int.test.ts#L235). |
| V9.2.4 | One key, many audiences: each token names its audience | Met | Passes name one agent's URL [api/pass.ts:44](../../apps/api/src/pass.ts#L44), previews name `/internal/preview` [api/admin.ts:564](../../apps/api/src/admin.ts#L564), and ID tokens name the client id. |

## V10 OAuth and OIDC

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V10.1.1 | Tokens go only to components that need them | Met | Agents never see EHR tokens: they stay sealed in the vault and go only to that EHR [gateway/upstream.ts:98](../../apps/gateway/src/upstream.ts#L98); test "never lets an upstream token or the client secret out" [gateway/test/s6-upstream.int.test.ts:288](../../apps/gateway/test/s6-upstream.int.test.ts#L288). The pass is never sent on to FHIR: test [gateway/test/s1-filter.int.test.ts:123](../../apps/gateway/test/s1-filter.int.test.ts#L123). |
| V10.1.2 | State, PKCE and nonce bound to the session and transaction | Met | SMART launch: a random `state` (24 bytes) and PKCE verifier per launch, single use, tied to the person [api/fhir-servers.ts:169](../../apps/api/src/fhir-servers.ts#L169), [api/fhir-servers.ts:198](../../apps/api/src/fhir-servers.ts#L198); tests "a launch is single use" and "someone else can't finish Maria's launch" [api/test/smart.int.test.ts:173](../../apps/api/test/smart.int.test.ts#L173). Connected-login sign-in: Better Auth's own state handling, with PKCE turned on [api/connections.ts:103](../../apps/api/src/connections.ts#L103). |
| V10.2.1 | Code flow protected from CSRF (PKCE or state) | Met | Both, with S256 [fhir/smart.ts:82](../../packages/fhir/src/smart.ts#L82). |
| V10.2.2 | Mix-up defence when using several authorization servers | Partly | Connected logins each get their own callback URL. SMART servers share one redirect URI, and the `iss` response parameter isn't checked; `state` ties each launch to one server. FHIR servers are added by the admin, which limits the risk. Fix: a redirect URI per server, or check `iss` (RFC 9207). |
| V10.3.1 | Resource server checks the audience | Met | See V9.2.3. |
| V10.3.2 | Decisions use the delegation claims | Met | `sub` names the person and `act.sub` the agent; both drive the decision, with the role and grant read live [gateway/guard.ts:103](../../apps/gateway/src/guard.ts#L103). The OAuth scopes here are only OIDC scopes and grant nothing. |
| V10.3.3 | Users identified by claims that can't be reassigned (iss + sub) | Partly | The gateway looks `sub` up as either a person id or a login id, whichever issuer signed it [db/queries.ts:23](../../packages/db/src/queries.ts#L23). Person ids come from display names, so a person named like another person's login id (e.g. the demo's `user-maria`) would collide. Fix: map `sub` by issuer. |
| V10.3.4 | Check authentication strength or recency if required | N/A | The gateway asks for no particular strength; writes need a fresh passkey approval instead. |
| V10.4.1 | Redirect URIs: exact match against the client's list | Delegated | Better Auth compares exact strings; only a loopback port may vary, as RFC 8252 allows (`@better-auth/oauth-provider` `authorize-*.mjs:5580`). |
| V10.4.2 | Codes work once; reuse revokes tokens | Delegated | The code is consumed on use, and a replay revokes what it issued (`introspect-*.mjs:1902`). |
| V10.4.3 | Authorization codes live 10 minutes at most | Delegated | 600 seconds (`authorize-*.mjs:4330`). |
| V10.4.4 | Each client gets only the grants it needs; no implicit or password | Delegated | Grants are checked per client, and the implicit and password grants aren't offered [api/auth.ts:154](../../apps/api/src/auth.ts#L154). `client_credentials` and token exchange are on, but reach no agent until the admin approves the client (D11). |
| V10.4.5 | Refresh token replay is mitigated (rotation) | Delegated | Refresh tokens rotate, and reusing an old one revokes the whole family (`introspect-*.mjs:2174`). |
| V10.4.6 | PKCE required; S256 only | Delegated | Required for public clients and by default for the rest; S256 only (`authorize-*.mjs:5778`, `utils-*.mjs:912`). |
| V10.4.7 | Unauthenticated client registration is made safe | Met | Open registration is on [api/auth.ts:151](../../apps/api/src/auth.ts#L151), but a new app can't act as any agent until the admin approves it, and the consent page says so and blocks [web/consent/page.tsx:114](../../apps/web/src/app/consent/page.tsx#L114). Test "an app the admin hasn't approved can't get a pass" [web/e2e/oauth.spec.ts:27](../../apps/web/e2e/oauth.spec.ts#L27). Better Auth validates the registered redirect URIs. |
| V10.4.8 | Refresh tokens have an absolute expiry | Not met | Each rotation issues a new 30-day token counted from that moment (`introspect-*.mjs:1623`), so a client that keeps refreshing never has to come back to the person. |
| V10.4.9 | Users can revoke refresh tokens in the UI | Met | "Revoke" on My AIs ends the grant and that agent's refresh tokens [api/person.ts:233](../../apps/api/src/person.ts#L233); test "Maria revokes on My AIs" [web/e2e/oauth.spec.ts:136](../../apps/web/e2e/oauth.spec.ts#L136). Access tokens are self-contained and last 5 minutes. |
| V10.4.10 | Confidential clients authenticate on back-channel calls | Delegated | Better Auth authenticates clients at the token endpoint. Token exchange refuses public clients [api/token-exchange.ts:66](../../apps/api/src/token-exchange.ts#L66); test [api/test/exchange.int.test.ts:242](../../apps/api/test/exchange.int.test.ts#L242). |
| V10.4.11 | Clients get only the scopes they need | Partly | Every registered client may ask for all four scopes, `openid profile email offline_access` [api/auth.ts:147](../../apps/api/src/auth.ts#L147). The real permission is the admin's approval plus the person's grant, but scopes aren't narrowed per client. |
| V10.5.1 | ID token replay is mitigated (nonce) | Partly | Better Auth's SSO sign-in sends no `nonce`; it relies on `state` and PKCE [api/connections.ts:103](../../apps/api/src/connections.ts#L103). |
| V10.5.2 | Users identified by sub, which can't be reassigned | Partly | aipass links a connected login to a person by verified email, not by `sub` [api/auth.ts:79](../../apps/api/src/auth.ts#L79) (D13). If the IdP gives an email to someone new, the aipass login follows it. |
| V10.5.3 | Reject AS metadata whose issuer doesn't match | Met | aipass refuses a discovery document whose `issuer` differs [api/connections.ts:67](../../apps/api/src/connections.ts#L67); Better Auth SSO checks it too (`issuer_mismatch`). |
| V10.5.4 | ID token aud equals the client_id | Delegated | Better Auth SSO checks `aud` and `azp` (`@better-auth/sso/dist/index.mjs:580`). |
| V10.5.5 | Back-channel logout tokens validated | N/A | No back-channel logout. |
| V10.6.1 | OP allows only code-based response types | Delegated | Only `response_type=code` (`authorize-*.mjs:5721`). |
| V10.6.2 | OP prevents forced-logout attacks | Delegated | Sign-out is a POST behind Better Auth's origin check. RP-initiated logout is off unless a client is set up for it, and then needs a valid `id_token_hint` (`authorize-*.mjs:646`). |
| V10.7.1 | The user consents to each authorization request | Met | The consent page saves the person's grant before Better Auth's consent completes [web/consent/page.tsx](../../apps/web/src/app/consent/page.tsx); test "Maria consents (unticking vitals)" [web/e2e/oauth.spec.ts:43](../../apps/web/e2e/oauth.spec.ts#L43). |
| V10.7.2 | Consent shows what, who, and for how long | Partly | It names the agent, the organization, the app and every permission, and the person can untick any [web/consent/page.tsx:124](../../apps/web/src/app/consent/page.tsx#L124). It doesn't say how long the consent lasts, or that a self-registered app chose its own name. |
| V10.7.3 | Users can review, change and revoke consents | Met | My AIs lists each AI and lets the person change what it may do, or revoke it [api/person.ts:196](../../apps/api/src/person.ts#L196). |

## V11 Cryptography

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V11.1.1 | Documented key management policy and lifecycle | Partly | Vault key rotation is documented ([guides/own-fhir-server.md](../guides/own-fhir-server.md)). Nothing covers the pass-signing keys (their table has `retiredAt`, but there is no rotation tool), `BETTER_AUTH_SECRET`, or who may hold each key. |
| V11.1.2 | Cryptographic inventory kept up to date | Not met | Algorithms are mentioned in passing (D14, the threat model), but there is no inventory of keys and algorithms, or of where each may be used. |
| V11.2.1 | Industry-validated crypto implementations | Met | `node:crypto` (OpenSSL), `jose`, `@simplewebauthn/server`, and Better Auth's `@noble` ciphers. No home-made crypto. |
| V11.2.2 | Crypto agility: algorithms and keys can be replaced | Partly | Vault values carry a version (`v1`) and keys rotate [db/vault.ts:50](../../packages/db/src/vault.ts#L50); passes carry `kid` and `alg`. Paging tokens and the receipt hash have no version, and the pass key has no rotation path. |
| V11.2.3 | All primitives give 128+ bits of security | Partly | AES-256-GCM, P-256 (ES256), Ed25519 and SHA-256 all do. The gateway and token exchange also accept RS256 and PS256 from other issuers, where 2048-bit RSA (about 112 bits) is common. |
| V11.3.1 | No ECB or weak padding | Met | Only AES-GCM is used to encrypt. (RS256 signatures, which use PKCS#1 v1.5, are accepted from other issuers for compatibility.) |
| V11.3.2 | Approved ciphers and modes, such as AES-GCM | Met | AES-256-GCM for the vault [db/vault.ts:47](../../packages/db/src/vault.ts#L47) and paging tokens [gateway/paging.ts:24](../../apps/gateway/src/paging.ts#L24). Better Auth uses XChaCha20-Poly1305 for its own secrets. |
| V11.3.3 | Encrypted data can't be changed unnoticed | Met | GCM, with the person and server as associated data [db/vault.ts:48](../../packages/db/src/vault.ts#L48); tests "won't open a value moved to another person or server" and "won't open a tampered value" [db/test/vault.test.ts:17](../../packages/db/test/vault.test.ts#L17). |
| V11.4.1 | Only approved hash functions | Met | SHA-256 everywhere; no MD5 or SHA-1 in the source. |
| V11.4.2 | Passwords stored with a strong, tuned KDF | Partly | Better Auth uses scrypt with N=16384, r=16, p=1, about 32 MiB (`@better-auth/utils/dist/password.node.mjs`). That is below OWASP's current scrypt minimum (N=2^17, r=8, p=1, or a set of equal cost). |
| V11.4.3 | Integrity hashes are collision-resistant, 256+ bits | Met | SHA-256 for the receipt chain [db/receipts.ts:43](../../packages/db/src/receipts.ts#L43), the approved payload hash and the passkey challenge. |
| V11.4.4 | Keys derived from passwords use key stretching | Partly | `AIPASS_VAULT_KEY` and `PAGE_SECRET` become keys through one SHA-256 [db/vault.ts:6](../../packages/db/src/vault.ts#L6). That is fine for a random secret, but the docs only ask for "32+ characters", so a passphrase gets no stretching. Fix: ask for a random key (e.g. `openssl rand -base64 32`), or use a KDF. |
| V11.5.1 | Unguessable values from a CSPRNG, 128+ bits | Partly | `state` (192 bits), PKCE (256), approval nonces (128) and session tokens (about 190) all come from a CSPRNG. Approval ids are UUIDv7 with 74 random bits [db/ids.ts:5](../../packages/db/src/ids.ts#L5), and given V8.2.2 they act as unguessable references. |
| V11.6.1 | Approved algorithms for key generation and signatures | Met | ES256 keys from WebCrypto through `jose` [api/keys.ts:16](../../apps/api/src/keys.ts#L16); Better Auth's keys are Ed25519. |

## V12 Secure Communication

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V12.1.1 | Only TLS 1.2 and 1.3, newest preferred | Not met | The adopter's (D12): aipass serves plain HTTP and leaves TLS to what runs in front. Adopter: TLS 1.2 or later, 1.3 preferred, at the ingress. |
| V12.1.2 | Only strong cipher suites, strongest first | Not met | The adopter's (D12): set at the TLS terminator. |
| V12.1.3 | mTLS client certificates validated | N/A | No mTLS. |
| V12.2.1 | TLS for all client connections, no plain fallback | Partly | The Helm chart defaults to `https://` URLs and has an ingress TLS setting [helm/values.yaml:55](../../deploy/helm/aipass/values.yaml#L55). Nothing refuses a plain-HTTP public origin outside localhost. |
| V12.2.2 | Publicly trusted certificates on external services | Not met | The adopter's (D12): aipass ships no certificates. |
| V12.3.1 | Encrypted protocols for all connections, databases included | Not met | Inside the stack everything is plain HTTP and plain Postgres, in both `compose.yaml` and the chart. Adopter: `sslmode=verify-full` in `DATABASE_URL`, and TLS or a service mesh between pods. |
| V12.3.2 | TLS clients validate server certificates | Met | Node's `fetch` checks certificates, and nothing turns that off (no `rejectUnauthorized: false`, no `NODE_TLS_REJECT_UNAUTHORIZED`). For Postgres, use `sslmode=verify-full`. |
| V12.3.3 | TLS between internal HTTP services | Not met | Web to api, api to gateway and gateway to FHIR are plain HTTP in the shipped compose file and chart. |
| V12.3.4 | Internal TLS uses trusted certificates | Not met | Follows from V12.3.3: there is no internal TLS yet. |

## V13 Configuration

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V13.1.1 | All communication needs are documented | Partly | The threat model's trust boundaries (B1 to B5) cover browsers, AI clients, connected logins, FHIR servers and Postgres, and name the URLs an admin or an OAuth app can supply ([threat model](threat-model.md)). The internal calls (api to gateway for previews and the health check, gateway to api for keys) aren't listed. |
| V13.2.1 | Backend calls use short-lived or per-service credentials | Partly | Previews from the api to the gateway carry a 60-second signed JWT [api/admin.ts:566](../../apps/api/src/admin.ts#L566). Postgres takes one static password; the FHIR server gets a static header (`FHIR_AUTHORIZATION`) or nothing. |
| V13.2.2 | Backend accounts have least privilege | Not met | The api, the gateway and migrations share one database login with full rights, so the gateway can read the pass-signing keys and sessions. |
| V13.2.3 | No default credentials between services | Partly | The Helm chart needs your own `DATABASE_URL`. The compose file uses `aipass`/`aipass` for Postgres [compose.yaml:34](../../compose.yaml#L34), and the code falls back to it [api/config.ts:27](../../apps/api/src/config.ts#L27); the local-trial guard covers the auth secret and vault key, not this. |
| V13.2.4 | Allowlist of external systems to talk to | Not met | No outbound allow-list (V1.3.6). Adopter: egress rules on the network. |
| V13.2.5 | Server only fetches from an allowlist | Not met | Same as V13.2.4. |
| V13.3.1 | Secrets in a secrets manager, not in code or builds | Partly | Secrets come from the environment or a Kubernetes Secret [helm/values.yaml:26](../../deploy/helm/aipass/values.yaml#L26), and production refuses missing, short or public trial values [api/config.ts:53](../../apps/api/src/config.ts#L53), [db/vault.ts:20](../../packages/db/src/vault.ts#L20). EHR tokens and SMART client secrets are sealed in the vault. But the pass-signing private keys sit unencrypted in `pass_keys` [db/schema.ts:145](../../packages/db/src/schema.ts#L145), and Better Auth's SSO plugin stores a connection's sign-in secret as given. |
| V13.3.2 | Least privilege for access to secrets | Partly | The gateway is given `BETTER_AUTH_SECRET`, which it doesn't use (compose file, and the chart [helm/templates/_helpers.tpl:41](../../deploy/helm/aipass/templates/_helpers.tpl#L41)). |
| V13.4.1 | No source-control metadata deployed | Met | `.git` is kept out of images [.dockerignore:10](../../.dockerignore#L10); images hold only bundles (D15). |
| V13.4.2 | Debug modes off in production | Met | Images run with `NODE_ENV=production` [Dockerfile:28](../../Dockerfile#L28). Planted defects are refused in production [gateway/broken.ts:38](../../apps/gateway/src/broken.ts#L38), and dev passes are off unless asked for. |
| V13.4.3 | No directory listings | Met | No static file server lists directories; Next serves only its build output. |
| V13.4.4 | HTTP TRACE not supported | Met | Neither Node's HTTP server, Hono nor Next answers TRACE with an echo. (Read in the code, not tested on a running stack.) |
| V13.4.5 | Docs and monitoring endpoints not exposed unless intended | Met | Only `/health` (status only), the public discovery documents and the JWKS. No API-docs endpoint is turned on. |

## V14 Data Protection

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V14.1.1 | Sensitive data identified and classified | Partly | The threat model lists what aipass protects: records (the locked categories above all), people's choices, signing keys, EHR tokens, secrets and receipts ([threat model](threat-model.md)). There are no protection levels. |
| V14.1.2 | Protection requirements per protection level | Not met | No levels, so no requirements per level. Retention isn't addressed anywhere. |
| V14.2.1 | No sensitive data in URLs | Partly | Tokens travel in headers, cookies and bodies. Approval ids, enough to read a proposed change (V8.2.2), appear in URLs (`/approve/<id>`) and in agent output. |
| V14.2.2 | Sensitive data not cached by server components | Partly | aipass caches nothing itself, but API responses with health data send no `Cache-Control: no-store`, so a cache in front must be trusted not to keep them. |
| V14.2.3 | Sensitive data not sent to trackers | Met | No analytics or third-party scripts; the CSP allows only `'self'` [web/next.config.ts:24](../../apps/web/next.config.ts#L24); Next telemetry is off in images [Dockerfile:58](../../Dockerfile#L58). |
| V14.2.4 | Data protection controls follow the documentation | Partly | Strong where defined: the vault (AES-GCM, tied to its row), field masking, locked labels, hash-chained receipts. With no protection levels (V14.1.2), retention and log handling have nothing to follow. |
| V14.3.1 | Client-side data cleared after logout | Partly | Sign-out ends the session and leaves the page, and nothing is kept in browser storage. No `Clear-Site-Data` header. |
| V14.3.2 | Cache-Control: no-store on sensitive responses | Not met | Admin and person API responses (receipts, a chart preview) carry no `Cache-Control` header. |
| V14.3.3 | No sensitive data in browser storage | Met | aipass's code uses no `localStorage`, `sessionStorage` or IndexedDB; only the session cookie. |

## V15 Secure Coding and Architecture

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V15.1.1 | Documented time frames for fixing vulnerable components | Partly | CI fails on any known advisory in shipped dependencies [ci.yml:31](../../.github/workflows/ci.yml#L31), and Dependabot runs weekly [dependabot.yml](../../.github/dependabot.yml). There are no written time frames by severity. |
| V15.1.2 | SBOM kept; components from trusted repositories | Met | The frozen `pnpm-lock.yaml` lists every third-party package, from the npm registry. Image builds (the release workflow, run by hand) add an SBOM and SLSA provenance [release.yml:58](../../.github/workflows/release.yml#L58). |
| V15.1.3 | Docs name costly functions and their defences | Partly | The threat model gives the gateway's rate limits and says they count per process. It doesn't list the costly functions (health check, chain verification, previews, FHIR searches) or how each is bounded. |
| V15.2.1 | Components within their remediation time frames | Partly | The CI audit gate keeps known advisories out in practice, but there are no time frames to measure against (V15.1.1). |
| V15.2.2 | Defences against resource exhaustion | Partly | Bounded: the gateway's call rate [gateway/app.ts:155](../../apps/gateway/src/app.ts#L155), page sizes, receipt pages, timeouts on outbound calls [fhir/client.ts:33](../../packages/fhir/src/client.ts#L33), one health check at a time, the MCP SDK's request-size limit. Not bounded: the admin and person APIs, and "Verify chain" reads every receipt into memory [db/receipts.ts:90](../../packages/db/src/receipts.ts#L90). |
| V15.2.3 | Production holds only needed functionality | Partly | Dev passes are off and loopback-only; planted defects are refused in production. But the api image ships the synthetic fixtures [Dockerfile:36](../../Dockerfile#L36), and the demo is on by default in `compose.yaml`. |
| V15.3.1 | Return only the fields needed | Partly | Agents get masked, simplified records; secrets are stripped from FHIR-server rows [api/fhir-servers.ts:57](../../apps/api/src/fhir-servers.ts#L57). Gap: approval details go to any signed-in user (V8.2.2). |
| V15.3.2 | Backend calls don't follow redirects unless intended | Partly | Discovery and SMART token calls refuse redirects (`redirect: "error"`) [api/connections.ts:62](../../apps/api/src/connections.ts#L62), [fhir/smart.ts:43](../../packages/fhir/src/smart.ts#L43); Better Auth's CIMD and SSO fetches don't follow them either. The FHIR client still follows redirects from the FHIR server [fhir/client.ts:53](../../packages/fhir/src/client.ts#L53). |
| V15.3.3 | Protection against mass assignment | Met | `z.strictObject` on every body; a user's `role` can't be set at sign-up (`input: false`) [api/auth.ts:128](../../apps/api/src/auth.ts#L128). |
| V15.3.4 | Real client IP passed by proxies and used correctly | Partly | The address is worked out correctly in the gateway and the api (V4.1.3). Through the web app's own proxy (`compose.yaml`, dev) the api sees the web app's address for every browser; the Helm ingress routes `/api` to the api directly so the real one arrives. |
| V15.3.5 | Correct types and strict comparisons | Met | TypeScript in strict mode, zod parsing, `===` throughout; Biome lint in CI. |
| V15.3.6 | JavaScript code prevents prototype pollution | Met | No deep merges of untrusted objects; input is parsed by strict zod schemas, which refuse unknown keys. |
| V15.3.7 | Defences against HTTP parameter pollution | Met | Each value is read by name from one place (body, query or path). A repeated `resource` is cut to its first value on purpose [api/token-exchange.ts:145](../../apps/api/src/token-exchange.ts#L145). |

## V16 Security Logging and Error Handling

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V16.1.1 | Log inventory for each layer | Partly | Receipts and FHIR AuditEvents are described (PLAN, threat model). Console logs, their format, where they go, who can read them and how long anything is kept aren't. |
| V16.2.1 | Each log entry says when, where, who and what | Partly | Each receipt has a UTC time, agent, person, tool, action, decision, rule, reason and pass `jti` [db/schema.ts:108](../../packages/db/src/schema.ts#L108); AuditEvents name the AI and the person. Sign-in and admin events are JSON lines with path, outcome, user or admin id and client address [api/auth.ts](../../apps/api/src/auth.ts), [api/app.ts](../../apps/api/src/app.ts), but carry no timestamp of their own (the log collector adds it), and receipts have no client address or OAuth client id. |
| V16.2.2 | Synchronized clocks; UTC timestamps | Partly | Receipts use `timestamptz` and ISO UTC [db/schema.ts:113](../../packages/db/src/schema.ts#L113), and so do AuditEvents. Console lines carry no timestamp. Clock sync is the host's. |
| V16.2.3 | Logs go only to documented places | Partly | Receipts (Postgres), AuditEvents (the FHIR server) and stdout. Only the first two are documented. |
| V16.2.4 | Logs are in a format the log processor can read | Partly | AuditEvents are standard FHIR; receipts are JSON through the admin API. Console logs are free text. |
| V16.2.5 | Sensitive data logged according to its level | Partly | Passes, EHR tokens and secrets are kept out of receipts, AuditEvents, tool results and logs: test [gateway/test/s6-upstream.int.test.ts:288](../../apps/gateway/test/s6-upstream.int.test.ts#L288). Receipts keep the pass `jti`, not the pass. With no protection levels (V14.1.1), nothing rules on the record ids and search terms receipts do keep. |
| V16.3.1 | All authentication events are logged | Partly | An agent's missing or bad pass is logged as a refusal, with an AuditEvent [gateway/app.ts:185](../../apps/gateway/src/app.ts#L185); past 60 a minute from one address, only a console line is written. People's and admins' sign-ins (success and failure), sign-ups, sign-outs, passkey and SSO sign-ins are logged as JSON lines, with no email or password [api/auth.ts](../../apps/api/src/auth.ts); test "logs sign-ins and admin changes as JSON lines" [security.int.test.ts](../../apps/api/test/security.int.test.ts). Not logged: passkey registration, token exchanges. |
| V16.3.2 | Failed authorization attempts are logged | Partly | Every refused agent call leaves a receipt and an AuditEvent: test "every refused call has a receipt and an AuditEvent" [gateway/test/s1-guard.int.test.ts:315](../../apps/gateway/test/s1-guard.int.test.ts#L315). Refusals (401, 403) in the admin and person APIs aren't logged. |
| V16.3.3 | Documented security events and bypass attempts are logged | Partly | Refusals are logged, bad passes and other patients' records included, and the gateway logs each rate-limit hit. Every admin change is logged as a JSON line (admin, method, path, status) [api/app.ts](../../apps/api/src/app.ts), but not in the hash-chained receipts: test "writes no receipts for admin actions" [api/test/admin.int.test.ts:116](../../apps/api/test/admin.int.test.ts#L116). Cross-site requests the API refuses (V3.5.1) aren't logged. |
| V16.3.4 | Unexpected errors and control failures are logged | Partly | FHIR, audit-write, refresh and SMART exchange failures are logged [gateway/guard.ts:237](../../apps/gateway/src/guard.ts#L237), and Hono logs unhandled errors. Some failures are swallowed: a failed grant upsert becomes "no such person or agent" [api/admin.ts:426](../../apps/api/src/admin.ts#L426). |
| V16.4.1 | Log data encoded against log injection | Partly | Receipts and AuditEvents are structured (table columns, FHIR JSON). Console lines include error text as is, so a newline from an upstream error could fake a line. |
| V16.4.2 | Logs protected from access and change | Partly | Receipts are hash-chained, and "Verify chain" finds an edited or removed one: test [gateway/test/s1-guard.int.test.ts:344](../../apps/gateway/test/s1-guard.int.test.ts#L344). Anyone with database write access can rewrite the chain from any point (a residual risk in the threat model); nothing anchors it outside. |
| V16.4.3 | Logs sent to a separate system | Partly | AuditEvents go to the FHIR server, a separate system. aipass doesn't ship receipts or console logs anywhere; collecting stdout is the adopter's. |
| V16.5.1 | Generic messages for unexpected errors | Partly | Unhandled errors give Hono's plain "Internal Server Error". Discovery failures now answer a generic message and log the detail server-side [api/connections.ts](../../apps/api/src/connections.ts), [api/fhir-servers.ts](../../apps/api/src/fhir-servers.ts). Some handlers still return library error text, e.g. creating a login [api/admin.ts](../../apps/api/src/admin.ts). |
| V16.5.2 | Stays secure when external resources fail | Met | If FHIR is down or slow (15 s timeout), the call is refused and nothing is released [gateway/guard.ts:237](../../apps/gateway/src/guard.ts#L237). A failed EHR refresh is refused, asking the person to reconnect: test [gateway/test/s6-upstream.int.test.ts:209](../../apps/gateway/test/s6-upstream.int.test.ts#L209). |
| V16.5.3 | Fails closed when an exception occurs | Met | If the AuditEvent can't be written, the read is refused [gateway/guard.ts:322](../../apps/gateway/src/guard.ts#L322). Unknown labels and record types are withheld [policy/index.ts:161](../../packages/policy/src/index.ts#L161). A failed write leaves the approval unused [gateway/changes.ts:265](../../apps/gateway/src/changes.ts#L265). |

## V17 WebRTC

| ID | Requirement (short) | Status | Evidence / note |
|---|---|---|---|
| V17.1.1 | TURN server blocks reserved IP ranges | N/A | No WebRTC. |
| V17.2.1 | DTLS certificate key managed by policy | N/A | No WebRTC. |
| V17.2.2 | Approved DTLS cipher suites and SRTP profile | N/A | No WebRTC. |
| V17.2.3 | SRTP authentication checked | N/A | No WebRTC. |
| V17.2.4 | Media server survives malformed SRTP | N/A | No WebRTC. |
| V17.3.1 | Signaling survives floods (rate limits) | N/A | No WebRTC. |
| V17.3.2 | Signaling survives malformed messages | N/A | No WebRTC. |
