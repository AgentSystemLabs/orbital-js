# ParabolaJs — Framework Production Readiness Checklist

Framework-only review (`packages/parabola/`). Examples and user-app concerns excluded.

---

## 1. Constructor / lifecycle

- [ ] Split construction from server start (`new Parabola()` currently calls `Bun.serve()` synchronously — server.tsx:173).
- [ ] Expose `.start()` / `.listen()` so users can register templates/actions before the server is live without a race.
- [ ] Allow the framework to be mounted under an external Hono app (return an app/handler instead of self-serving).
- [ ] Register the `/ws` route only after user hooks are wired, so users can intercept the upgrade.
- [ ] Add a graceful shutdown path that closes WS connections cleanly.

## 2. Missing lifecycle hooks

- [ ] `beforeUpgrade(req)` — let the user reject a WS handshake (origin, auth cookie, rate limit).
- [ ] `beforeAction(ctx, key, data)` — central gate without wrapping every handler.
- [ ] `beforeTemplate(ctx, key)` — gate renders / scope visibility.
- [ ] `onDisconnect(ctx)` — user cleanup (rooms, presence, locks). Currently ctx is deleted silently in `onClose` (server.tsx:163).
- [ ] `onError(err, kind, ctx?)` — central error sink. Today errors hit `console.error` in 4 spots or become unhandled rejections.
- [ ] Make `onConnect` composable / middleware-style (second call currently overwrites — server.tsx:299–301).

## 3. Broadcast scoping

- [ ] Add per-room / per-channel scoping primitive (`broadcast(key, filter)` or first-class rooms).
- [ ] Today `broadcast(key)` re-renders for every subscribed WS globally — only workaround is per-room template keys, which leaks state into the next item.
- [ ] In `Dispatcher`, delete empty `Set`s from `subscriptions` on `unsubscribe` / `unsubscribeAll` (dispatcher.ts:13–22) — map grows unbounded with dynamic keys.

## 4. Subscription safety

- [ ] Validate `subscribe` payloads server-side — reject keys that don't match a registered template (server.tsx:152).
- [ ] Cap subscriptions per WS to bound memory.
- [ ] Cap total subscriptions per process.

## 5. Action invocation model

- [ ] `await` action handlers in `ControlBus.invoke` so async throws are catchable (bus.ts:31).
- [ ] Add a `reply(payload)` on `ActionArgs` so an action can respond to its initiating WS (per-submit success/failure).
- [ ] Define a key→data type map so handlers receive typed `data` instead of `any`.
- [ ] Add a `defineAction(key, { input, handler })` style with optional input validation (zod or framework-supplied helper) — gives the framework a place to reject malformed payloads before the handler runs.
- [ ] Surface action errors back to the originating WS (today they're swallowed).

## 6. Template contract

- [ ] Narrow `TemplateFn` return from `unknown` to `string | Promise<string> | JSX.Element` (renderer.ts:4).
- [ ] In `broadcastLocal`, use `Promise.allSettled` so one broken template doesn't kill the broadcast for all subscribers (renderer.ts:55).
- [ ] Add a per-template error frame on the wire + a `p-error` slot for the client to render it.
- [ ] In `inlineTemplates`, replace the silent 16-pass cap with a thrown error or loud warning (server.tsx:194) — partial HTML is the worst failure mode.
- [ ] Document or warn on `broadcast(key)` for an unregistered template (renderer.ts:51).
- [ ] Decide and document what happens when template root tag changes during morph.

## 7. Multi-node correctness

- [ ] Redis pub/sub is at-most-once — if a node's subscriber is reconnecting during a broadcast, it never sees the message and its WSs go stale. Either move to Redis Streams with cursors, or document the "best effort" semantics prominently.
- [ ] Avoid fan-out to nodes with zero local subscribers for that key (subscribed-keys advertisement, sharding, or shared subscription registry).
- [ ] Expose the instance UUID (server.tsx:63) on the wire so clients can detect a node switch after sticky-session loss.

## 8. Wire protocol

- [ ] Add `protocolVersion` to the handshake.
- [ ] Add a client→server `messageId` for action correlation (powers per-submit loading/error states).
- [ ] Add a server-issued `serverFrameId` so clients can dedupe after reconnect.
- [ ] Document the full protocol shape in one place.
- [ ] Guard `JSON.parse(evt.data)` (server.tsx:146) and `JSON.parse(event.data)` (parabola.js:325) — first malformed frame currently throws inside the WS callback.

## 9. Client reconnect

- [ ] Exponential backoff with jitter in `ws.onclose` (parabola.js:370) — fixed 1000ms produces thundering herd on regional outage.
- [ ] Configurable max retries / give-up state.
- [ ] Queue outbound sends while disconnected, replay on reconnect — today `currentWs?.send(...)` silently drops user clicks during reconnect (parabola.js:12, 34, 289).
- [ ] Emit a connection-state event (`connecting` / `open` / `reconnecting` / `closed`) so user code can render a banner.
- [ ] Add an `onreconnect` hook for application-level resync logic.
- [ ] Add a backpressure / `readyState` check in `Dispatcher.send` (dispatcher.ts:27) — send-on-closed currently throws into `broadcastLocal`.

## 10. Client morph

- [ ] Add tests for `morph` — keyed insert, keyed remove, attribute change, focused-input survival, `p-preserve` opt-out, root tag change.
- [ ] Document the morph contract publicly (what's preserved, what's replaced, what's user-controllable).
- [ ] Move `window.onpopstate` assignment out of `connect()` so it isn't re-bound on every reconnect (parabola.js:265).
- [ ] Add a top-level client error handler for malformed server frames.
- [ ] Provide a way to defer initial `connect()` (e.g. lazy connect after the user has a session) — today it fires at module load (parabola.js:381).

## 11. Type story

- [ ] Replace `ssrHandler: any` (server.tsx:121) with a real Hono handler type.
- [ ] Tie the `Ctx` generic to a per-key action input type.
- [ ] Return a typed handle from `defineTemplate` / `defineAction` with `.broadcast()` / `.invalidate()` methods so refactors catch missing templates at compile time.
- [ ] Decide on re-registration semantics — today `template()` and `action()` silently drop the second call with `console.error` (renderer.ts:23, bus.ts:24). `bun --watch` hits this on every save. Pick: hot-replace, throw loudly, or namespace.

## 12. Build / packaging

- [ ] Add a `build` script for `packages/parabola`.
- [ ] Add proper `exports` map + `types` entry + `files` allowlist in `packages/parabola/package.json`.
- [ ] Fix `main: "src/index"` (no extension) — npm consumers can't resolve this today.
- [ ] Pick a version + start a changelog.
- [ ] Load `parabola.js` once at boot and serve from memory, not `fs.readFile` per request (server.tsx:113).
- [ ] Stamp a hash / version into the `/static/parabola.js` URL for cache busting.

## 13. Runtime coupling

- [ ] Make `ioredis` an optional peer dep + dynamic import — only loaded when `opts.redis` is set. Today it's a hard dependency for everyone (server.tsx:5).
- [ ] Either document Bun-only support clearly, or abstract the WS adapter via Hono's adapter system instead of importing `hono/bun` directly (server.tsx:2, 7).

## 14. Observability seam

- [ ] Add an `onLog(level, event, fields)` hook so users can route framework logs into their stack.
- [ ] Add an `onMetric(name, value, tags)` hook for timing/counters around dispatch, render, broadcast.
- [ ] Thread a per-connection ID and per-action ID through hooks for tracing.
- [ ] Replace ad-hoc `console.error` calls with the log hook (defaults to `console`).

## 15. Documentation contract

- [ ] Document `invalidate` vs `broadcast` semantics.
- [ ] Document the JSX-string return contract for templates (and what happens if a template returns a plain object — today it becomes `[object Object]` in the DOM).
- [ ] Document required client-side attributes (`p-template`, `p-action`, `p-href`, `p-target`, `p-swap`, `p-load`, `p-preserve`, `p-error`, `data-p-hydrated`).
- [ ] Document the multi-node guarantees (at-most-once today) so users aren't surprised.

---

## Suggested priority order

1. Lifecycle hooks (§2) + constructor split (§1) — unblocks everything else.
2. Action model + typing (§5, §11) — biggest DX win.
3. Morph tests (§10) — protect the hardest code in the framework.
4. Build / packaging (§12) — required before anyone can install it.
5. Broadcast scoping + subscription safety (§3, §4) — required for any real app.
6. Wire protocol versioning + dedupe (§8) — required before any client breaking change.
7. Multi-node correctness (§7) — required to honor the realtime pitch under load.
8. Client reconnect (§9), observability (§14), runtime coupling (§13) — operability.
9. Docs (§15) — once the API has settled.
