import type { Parabola } from "@parabolajs/parabola";
import type { AppCtx } from "../index";
import { redis } from "../redis";

const GRID_SIZE = 20;
const KEY = "grid:cells";

const cellField = (row: number, col: number) => `${row}:${col}`;

export function registerGrid(parabola: Parabola<AppCtx>) {
  parabola.template("grid", () => {
    return (
      <div class="items-center py-12">
        <h1 class="text-xl mb-4">Toggle anything on this realtime grid!</h1>

        {Array.from({ length: GRID_SIZE }, (_, rowIndex) => (
          <div p-template={`row:${rowIndex}`} />
        ))}
      </div>
    );
  });

  for (let rowIndex = 0; rowIndex < GRID_SIZE; rowIndex++) {
    const row = rowIndex;
    const fields = Array.from({ length: GRID_SIZE }, (_, col) => cellField(row, col));

    parabola.template(`row:${row}`, async () => {
      const values = await redis.hmget(KEY, ...fields);
      return (
        <div class="flex gap-2">
          {values.map((v, colIndex) => (
            <form p-action={`toggle:${row}`}>
              <input type="hidden" name="col" value={colIndex} />
              <button class="btn">{v === "1" ? "🟩" : "🟥"}</button>
            </form>
          ))}
        </div>
      );
    });

    parabola.action(`toggle:${row}`, async ({ broadcast, data }) => {
      const col = Number(data?.col);
      if (!Number.isInteger(col) || col < 0 || col >= GRID_SIZE) return;
      const field = cellField(row, col);
      const current = await redis.hget(KEY, field);
      await redis.hset(KEY, field, current === "1" ? "0" : "1");
      broadcast(`row:${row}`);
    });
  }
}
