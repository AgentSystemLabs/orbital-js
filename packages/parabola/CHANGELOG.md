# Changelog

All notable changes to `@parabolajs/parabola` are documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres
to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-05-19

First versioned pre-release. Establishes the public API contract; everything
below should be considered stable starting from this version.

### Added

- Constructor / lifecycle
  - `new Parabola(opts)` no longer starts the server. Call `parabola.listen()`
    to bind a Bun socket, or mount `parabola.fetch` onto an external Hono /
    runtime.
  - `parabola.shutdown()` closes WebSocket clients, stops the Bun server, and
    quits Redis connections cleanly.
  - `parabola.getApp()` and `parabola.fetch` lazily prepare routes — call after
    all lifecycle hooks are wired.

- Lifecycle hooks
  - `beforeUpgrade(req)` — reject WS handshakes by returning `false` or a
    `Response`. Useful for origin/auth/rate-limit checks.
  - `onConnect(cb)` is composable — each call appends; merges partial ctxs.
  - `onDisconnect(ctx)` — fires after a socket closes, with the ctx that was
    attached to it.
  - `beforeAction(ctx, key, data)` — central gate for every action invocation.
  - `beforeTemplate(ctx, key)` — central gate for every render.
  - `onError(err, kind, ctx?)` — single error sink (`action`, `template`,
    `broadcast`, `parse`, `onConnect`, `onDisconnect`, `beforeUpgrade`,
    `ssrTemplate`, `ws`, `wsMessage`).

- Subscription safety
  - Server validates `template`/`subscribe` payloads against registered
    template keys.
  - Per-WS and per-process subscription caps (`maxSubscriptionsPerWs`,
    `maxSubscriptionsTotal`, defaults 256 / 100k).
  - Dispatcher cleans up empty key Sets on unsubscribe.

- Action model
  - Action handlers are awaited; rejections route through `onError`.
  - `ActionArgs` now exposes `ws` and `reply(payload)` so handlers can answer
    the originating client.
  - `defineAction(key, { input, handler })` accepts a zod-compatible
    `{ parse(input) }` validator.
  - Per-action `messageId` propagates so the client can correlate
    `actionResult`/`actionReply` frames with the originating submit.

- Template contract
  - `TemplateFn` returns `string | JSX.Element | Promise<…>`. Plain objects
    that stringify to `[object Object]` now throw a useful error instead of
    rendering garbage.
  - `broadcastLocal` uses `Promise.allSettled` — one broken template no longer
    starves the rest.
  - On template error the framework emits a `templateError` frame which the
    client renders into a `[p-error]` slot when present.
  - `inlineTemplates` throws (instead of silently dropping work) when its
    pass cap is hit.

- Wire protocol (v1)
  - Welcome frame: `{ type: "welcome", protocolVersion, instanceId, connectionId }`
    so clients can detect sticky-session loss and resync.
  - Action correlation via `messageId`; server replies with `actionResult` and
    optionally `actionReply` for arbitrary payloads.
  - `JSON.parse` is guarded on both ends — bad frames emit
    `parabola:protocolError` rather than throwing.

- Client reconnect
  - Exponential backoff with ±25% jitter; capped at 30s by default.
  - Outbound queue replays pending sends on reconnect so clicks during a brief
    blip aren't dropped.
  - `window.parabola.onReconnect(cb)` for app-level resync.
  - Connection-state events dispatched on `window`:
    `parabola:state`, `parabola:welcome`, `parabola:protocolError`,
    `parabola:actionResult`, `parabola:actionReply`.
  - `window.parabolaAutoConnect = false` defers auto-connect; call
    `window.parabola.connect(opts)` when ready.

- Build / packaging
  - Real `exports` map, `types`, `files` allowlist.
  - `bun run build` emits a `dist/` for npm consumers.
  - Client `parabola.js` is loaded once at boot, hashed for cache busting, and
    served with `Cache-Control: immutable` + `ETag`.

- Observability
  - `logger`/`metric` options route framework logs and counters into the
    user's stack (defaults to `console`).
  - Per-connection `connectionId` propagated through hooks for tracing.

- Multi-node
  - Redis subscriber skips local re-render when no local subscribers exist.
  - Multi-node delivery is documented as best-effort (Redis pub/sub is
    at-most-once).

- Documentation
  - Top-level README documents the API surface, attribute reference, and
    multi-node guarantees.

### Changed (breaking)

- `new Parabola()` no longer auto-starts. Call `parabola.listen()` explicitly.
- Re-registering the same template/action key now throws (was a swallowed
  `console.error`). Use a fresh process under `bun --watch`; collisions are
  almost always bugs.
- `broadcast()` returns a `Promise<void>` and accepts an optional
  `(ctx, ws) => boolean` filter for per-room scoping.

### Removed

- `ioredis` is no longer a hard dependency. It's a `peerDependencies.optional`,
  loaded dynamically when `opts.redis.url` is set.
