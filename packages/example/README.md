# @orbital-js/example

Demo app for `@orbital-js/station`. The root workspace runs this package as
part of the full Redis/Postgres/HAProxy example stack.

Install dependencies from the repo root:

```bash
bun install
```

Run the full example stack from the repo root:

```bash
bun run dev
```

Then open:

```txt
http://localhost:8080
```

Package-local commands:

```bash
bun run start
bun run tailwind
bun run build:tailwind
```

`start` expects Redis and Postgres to be reachable at the defaults used by the
root `docker-compose.yml`:

```bash
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://station:station@localhost:5434/station
```
