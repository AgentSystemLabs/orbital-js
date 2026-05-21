import type { Parabola } from "@parabolajs/parabola";
import type { AppCtx } from "../index";
import { sql } from "../db";

type Note = { id: number; body: string; created_at: Date };

export function registerNotes(parabola: Parabola<AppCtx>) {
  parabola.template("notes", () => {
    return (
      <div class="py-12 space-y-6">
        <h1 class="text-2xl font-bold">Notes (Postgres-backed)</h1>
        <p class="opacity-70">
          These notes persist across restarts. Add one, then run{" "}
          <code class="bg-base-300 px-1 rounded">docker compose restart</code>{" "}
          — they survive.
        </p>

        <form p-action="notes:add" class="flex gap-2">
          <input
            required
            name="body"
            type="text"
            placeholder="Write a note..."
            class="input input-bordered flex-1"
          />
          <button class="btn btn-primary">Add</button>
        </form>

        <div p-template="notes:list"></div>
      </div>
    );
  });

  parabola.template("notes:list", async () => {
    const rows = await sql<Note[]>`
      SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 50
    `;
    if (rows.length === 0) {
      return <div class="opacity-60">No notes yet.</div>;
    }
    return (
      <ul class="space-y-2">
        {rows.map((n) => (
          <li class="card bg-base-200 p-3 flex flex-row justify-between gap-4">
            <span>{n.body}</span>
            <form p-action="notes:delete">
              <input type="hidden" name="id" value={String(n.id)} />
              <button class="btn btn-sm btn-ghost">delete</button>
            </form>
          </li>
        ))}
      </ul>
    );
  });

  parabola.action("notes:add", async ({ broadcast, data }) => {
    const body = String(data?.body ?? "").trim();
    if (!body) return;
    await sql`INSERT INTO notes (body) VALUES (${body})`;
    broadcast("notes:list");
  });

  parabola.action("notes:delete", async ({ broadcast, data }) => {
    const id = Number(data?.id);
    if (!Number.isFinite(id)) return;
    await sql`DELETE FROM notes WHERE id = ${id}`;
    broadcast("notes:list");
  });
}
