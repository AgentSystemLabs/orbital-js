# orbital-js

`orbital-js` is a Bun workspace for building and testing
`@orbital-js/station`, a tiny realtime SSR framework for Bun + Hono.

Station renders HTML on the server, sends updates over WebSockets, and patches
the DOM in place on the client. There is no client-side router, virtual DOM, or
app-level JSON API contract; templates and actions are server functions, and
the browser talks to them through declarative `p-*` attributes.

> Status: prototype / pre-1.0. The versioned package contract lives in
> `packages/station/README.md`.

## Workspace

- `packages/station` — the framework package published as
  `@orbital-js/station`.
- `packages/example` — a demo app that exercises SSR, navigation, forms,
  Redis-backed realtime state, Postgres-backed persistence, and multi-node
  broadcasts.
- `docker-compose.yml` — local Redis, Postgres, and HAProxy for the demo.
- `haproxy.cfg` — round-robin load balancing with sticky sessions for two Bun
  nodes.

## Requirements

- [Bun](https://bun.sh/)
- Docker + Docker Compose for the full example stack

Install dependencies from the repo root:

```bash
bun install
```

## Run The Example App

The easiest way to run the demo is from the repo root:

```bash
bun run dev
```

That command:

- starts Redis, Postgres, and HAProxy with `docker compose up -d --wait`
- watches Tailwind from `packages/example`
- starts two Bun app nodes on ports `3000` and `3001`
- streams Docker service logs beside the app processes

Open the app through HAProxy:

```txt
http://localhost:8080
```

Useful local URLs:

- `http://localhost:8080` — load-balanced example app
- `http://localhost:3000` — first Bun node directly
- `http://localhost:3001` — second Bun node directly
- `http://localhost:8404` — HAProxy stats page

Stop the Docker services when you are done:

```bash
bun run dev:down
```

The example uses these local defaults:

```bash
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://station:station@localhost:5434/station
```

## Example Features

The demo app includes:

- Poll — Redis-backed shared votes broadcast to all clients.
- Counter — per-connection state updated with `invalidate()`.
- Views — `p-load` actions and shared realtime counters.
- Chat — Redis-backed message list with profanity filtering.
- Grid — many small subscribed templates updated independently.
- Articles — server-rendered route content with per-connection filtering.
- Notes — Postgres-backed create/delete persistence.
- Form Validation — client-side validation plus server-side actions.

Try opening multiple tabs at `http://localhost:8080`. Shared examples update
across tabs and across both Bun nodes; per-connection examples only update the
current socket.

## Basic Usage

Install the framework in a Bun + Hono app:

```bash
bun add @orbital-js/station hono
# optional, for cross-node broadcasts
bun add ioredis
```

Create a station, register templates and actions, then listen:

```tsx
import { Station } from "@orbital-js/station";

type AppCtx = { count: number };

const station = new Station<AppCtx>({
  port: 3000,
});

station.onConnect(() => ({ count: 0 }));

station.template("main", () => <main id="content" p-template="counter" />);

station.template("counter", ({ ctx }) => (
  <div>
    <p>Count: {ctx.count}</p>
    <form p-action="increment">
      <button>Increment</button>
    </form>
  </div>
));

station.action("increment", ({ ctx, invalidate }) => {
  ctx.count++;
  invalidate("counter");
});

await station.listen();
```

Station serves a shell containing a `p-template` slot, hydrates that slot from
the server, and subscribes the browser to future template updates. Submitting a
`p-action` form invokes the matching server action with form data.

## Core Concepts

- Templates render HTML for a key. They receive the current socket/request
  `ctx` and route params.
- Actions run on the server when a form with `p-action` is submitted or when a
  `p-load` element hydrates.
- `invalidate(key)` re-renders one socket. Use it for per-user or
  per-connection state.
- `broadcast(key)` re-renders all subscribed sockets. With Redis configured,
  broadcasts propagate across nodes.
- The client morphs HTML into the existing DOM, preserving focus, selection,
  scroll, and form state where possible.

Common client attributes:

| Attribute | Use |
| --- | --- |
| `p-template` | Marks an element as a server-rendered template subscription. |
| `p-action` | Submits a form to a server action. |
| `p-load` | Fires an action once when the element hydrates. |
| `p-href` | Performs client-side navigation. |
| `p-target` | Names the slot that navigation should replace. |
| `p-swap` | Names the template to render into the target slot. |
| `p-preserve` | Leaves a DOM subtree alone during morphing. |
| `p-error` | Receives template error output. |

For the complete API, lifecycle hooks, observability options, reconnect
behavior, and multi-node guarantees, read `packages/station/README.md`.

## Development Commands

From the repo root:

```bash
bun run dev       # full example stack: Docker + Tailwind + two Bun nodes
bun run dev:up    # start Redis/Postgres/HAProxy only
bun run dev:down  # stop Docker services
bun run example   # run the example app directly from packages/example
```

Framework package checks:

```bash
cd packages/station
bun test
bun run typecheck
bun run build
```

Example package commands:

```bash
cd packages/example
bun run start
bun run tailwind
bun run build:tailwind
```

## Development Workflow

Run `bun run dev`, open the app through `http://localhost:8080`, then edit the
framework in `packages/station` or the demo in `packages/example`. The root dev
script runs the example with `bun --watch`, so source changes restart the Bun
nodes automatically.
