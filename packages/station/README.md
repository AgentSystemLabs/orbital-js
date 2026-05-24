# @orbital-js/station

Realtime SSR for Bun + Hono. The server renders HTML, a single WebSocket fans
broadcasts back, and a small client patches the DOM in place. No virtual DOM,
no client-side router, no JSON contracts — everything is HTML.

> Status: pre-1.0. The API in this README is the v0.1 contract; see
> `CHANGELOG.md` for the line in the sand.

## Install

```bash
bun add @orbital-js/station hono
# optional, for multi-node broadcast
bun add ioredis
```

Station requires the Bun runtime (we lean on `Bun.serve` for WebSocket
upgrades and on `HTMLRewriter` for streaming SSR).

## Quick start

```tsx
import { Station } from "@orbital-js/station";

type AppCtx = { count: number };

const station = new Station<AppCtx>({
  port: 3000,
});

station.onConnect(() => ({ count: 0 }));

station.template("main", () => <main id="content" p-template="welcome" />);

station.template("welcome", ({ ctx }) => (
  <div>
    <h1>{ctx.count}</h1>
    <form p-action="inc">
      <button>+</button>
    </form>
  </div>
));

station.action("inc", ({ ctx, invalidate }) => {
  ctx.count++;
  invalidate("welcome");
});

await station.listen();
```

## Concepts

- **Template** — a server function that renders HTML for a key, given the
  current connection's `ctx`. Subscribed clients re-render in place whenever
  the key is `invalidate`d (one socket) or `broadcast`ed (everyone).
- **Action** — a server-side handler invoked from a `<form p-action="…">` or
  programmatically. Runs with a `ctx`, returns nothing useful — emits state by
  mutating the world (DB, ctx, redis), then calls `invalidate`/`broadcast`.
- **Morph** — when the server re-renders a template, the client diffs the new
  HTML against the existing DOM. Focus, selection, scroll position, and form
  state survive.

## Construction & lifecycle

`new Station(opts)` is pure construction — it does not bind a port. Call one
of:

- `await station.listen(port?)` — starts a Bun server on `port` (or
  `opts.port`, or `process.env.PORT`).
- `station.fetch` / `station.websocket` — wire into an existing
  `Bun.serve({ fetch, websocket })`.
- `station.getApp()` — get the underlying Hono app to mount onto another
  router. e.g. `outer.route("/realtime", station.getApp())`.

`await station.shutdown()` closes all WebSocket clients, stops the Bun
server, and quits Redis connections.

### Lifecycle hooks

All hooks are registered before `listen()` / first request and may be called
multiple times where noted.

```ts
station
  .beforeUpgrade((req) => {
    // return false (or a Response) to reject the WS handshake.
    return req.headers.get("origin") === "https://my.app";
  })
  .onConnect(async (req) => {
    // Build the per-connection ctx. Multiple calls compose by merging
    // returned partials in order.
    const user = await readSessionUser(req);
    return { user };
  })
  .onConnect((_req, ctx) => ({
    // Composable: this runs after the first onConnect and receives the
    // ctx-so-far in the second arg.
    role: ctx.user ? "user" : "anon",
  }))
  .onDisconnect((ctx) => {
    // Cleanup: leave rooms, drop locks, etc.
    leaveAllRooms(ctx.user?.id);
  })
  .beforeAction((ctx, key, _data) => {
    // Central authorization. Return false to reject before the handler runs.
    return key.startsWith("admin:") ? ctx.role === "admin" : true;
  })
  .beforeTemplate((ctx, key) => {
    // Central visibility check. Return false to skip the render.
    return key === "admin-panel" ? ctx.role === "admin" : true;
  })
  .onError((err, kind, ctx) => {
    // Single error sink — kind ∈ "action"|"template"|"broadcast"|"parse"|...
    captureException(err, { kind, user: ctx?.user });
  });
```

## Templates

```ts
const welcome = station.template("welcome", ({ ctx }) => (
  <div>hello {ctx.user?.name ?? "stranger"}</div>
));

// `welcome` is a TemplateHandle with .broadcast() and .invalidate(ws) methods
// for refactor-safe re-renders.
await welcome.broadcast();
```

Templates can return `string | JSX.Element | Promise<…>`. Returning a plain
JavaScript object that stringifies to `[object Object]` throws loudly — that's
almost always a mistake.

### Per-template error handling

When a template throws, the framework emits a `templateError` frame. On the
client, if the target element contains a `[p-error]` descendant, the message
lands there; otherwise the target is replaced with a small inline error. Wrap
critical surfaces:

```tsx
<div p-template="risky">
  <div p-error hidden></div>
  <div class="content">…</div>
</div>
```

## Actions

```ts
station.action("vote", ({ data, broadcast }) => {
  // data is unknown — validate it yourself, or use defineAction.
  recordVote(String(data?.optionId));
  broadcast("poll");
});

// Or with input validation:
import { z } from "zod";

station.defineAction("notes:add", {
  input: z.object({ body: z.string().min(1).max(500) }),
  handler: async ({ data, broadcast }) => {
    await db.insert(notes).values({ body: data.body });
    broadcast("notes:list");
  },
});
```

### Per-submit feedback

Actions can talk back to the originating socket:

```ts
station.action("login", async ({ data, reply, ctx }) => {
  const user = await login(data);
  if (!user) return reply({ error: "bad credentials" });
  ctx.user = user;
  reply({ ok: true });
});
```

The client emits a `station:actionReply` event with `{ key, messageId, payload }`.
The framework also emits an `actionResult` frame for every action carrying a
`messageId`, which the client uses to release the originating submit button.

## `invalidate` vs `broadcast`

- `invalidate(key)` — re-render the template `key` for **just this
  connection**. Use it from inside an action when only the actor's view
  should change (`counter` example: each tab gets its own count).
- `broadcast(key)` — re-render `key` for **every subscribed connection**, on
  every node when Redis is configured. Use for shared state (`chat`, `poll`,
  `grid`).

```ts
station.broadcast("chat", (ctx, _ws) => ctx.room === "general");
```

The optional second argument is a filter — only sockets whose ctx passes the
predicate get the broadcast. Note: filters apply on the local node only;
remote nodes filter independently using their own ctx state, so don't depend
on filter results being globally consistent.

## Client-side attributes

| Attribute        | Where             | Effect                                                                                                |
|------------------|-------------------|-------------------------------------------------------------------------------------------------------|
| `p-template`     | any element       | Marks a slot subscribed to a server template. Client morphs the element's children when the key updates. |
| `p-action`       | `<form>`          | Submitting the form invokes a server action with the form data; the submit button is disabled until the server acknowledges. |
| `p-load`         | any element       | On first hydration, fires an action (no form data). Useful for "on mount" effects (view counters etc).|
| `p-href`         | `<a>` or `<button>` | Client-side navigation. Pairs with `p-target` (slot id) and `p-swap` (template key). Updates history. |
| `p-target`       | `[p-href]`        | The id of the slot to swap into.                                                                       |
| `p-swap`         | `[p-href]`        | Template key to render into the target.                                                                |
| `p-preserve`     | any element       | Tells morph to leave this element's subtree alone (third-party widgets that own their own DOM).        |
| `p-error`        | descendant of `[p-template]` | Error slot for `templateError` frames. Hidden by default.                                            |
| `data-p-hydrated`| auto              | Set by SSR + by the client after a `template` frame is morphed. Used to skip double-renders.           |

## Reconnect

The client reconnects with exponential backoff (250ms → 30s) and ±25% jitter,
queues outbound frames while disconnected, and replays them on open. It
dispatches state events on `window`:

```ts
window.addEventListener("station:state", (e) => {
  // e.detail.state ∈ "connecting"|"open"|"reconnecting"|"closed"
  showBanner(e.detail.state);
});

// Detect a node switch (sticky-session loss):
window.station.onReconnect(({ instanceId, connectionId }) => {
  // ctx is gone on the new node — refetch local UI state here.
});
```

To defer connection (e.g. wait for a session):

```html
<script>window.stationAutoConnect = false;</script>
<script src="/static/station.js"></script>
<script>
  await getSession();
  window.station.connect({ backoffBaseMs: 500 });
</script>
```

## Multi-node guarantees

When `opts.redis.url` is set, broadcasts cross nodes via Redis pub/sub.
**This is at-most-once** — if a subscriber is reconnecting at the moment a
broadcast happens, that node's clients miss the update until something else
triggers a re-render. Treat realtime as best-effort; for must-not-miss flows
back it with a database read on the next interaction.

The server stamps each WS with a `connectionId` and exposes the
`instanceId` (UUID per process) in the welcome frame so clients can detect a
node switch and resync.

## Subscription caps

`opts.maxSubscriptionsPerWs` (default `256`) and `opts.maxSubscriptionsTotal`
(default `100000`) bound memory. Sockets that hit the cap receive a
`protocolError` frame; the dispatcher continues operating on every other
socket.

## Observability

```ts
new Station({
  logger: (level, event, fields) => myLogger[level]({ event, ...fields }),
  metric: (name, value, tags) => statsd.gauge(name, value, tags),
});
```

The framework emits structured events like `listening`, `redis_publish_failed`,
`subscription_cap_reached`, `action_failed`, `template_render_failed`,
`broadcast_unregistered_template`. Per-connection `connectionId` flows through
log fields.

## Embedding

Mount Station under your own Hono app:

```ts
import { Hono } from "hono";
const outer = new Hono();
outer.get("/health", (c) => c.text("ok"));
outer.route("/", station.getApp());

Bun.serve({ fetch: outer.fetch, websocket: station.websocket });
```

## License

MIT.
