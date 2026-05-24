import type { Station } from "@orbital-js/station";
import type { AppCtx } from "../index";
import { redis } from "../redis";

const KEY = "poll:votes";

const options = [
  { id: "1", text: "Ice cream" },
  { id: "2", text: "Banana Bread" },
  { id: "3", text: "Cookies" },
];

export function registerPoll(station: Station<AppCtx>) {
  station.template("poll", async () => {
    const counts = await redis.hmget(KEY, ...options.map((o) => o.id));
    return (
      <div class="flex gap-8 justify-center pt-12">
        {options.map((option, idx) => (
          <form
            p-action="vote"
            class="card bg-base-300 w-96 shadow-xl flex flex-col gap-4 rounded p-8"
          >
            <div>{option.text}</div>
            <div>{Number(counts[idx] ?? 0)} votes</div>
            <input type="hidden" name="optionId" value={option.id} />
            <button class="btn btn-primary">vote</button>
          </form>
        ))}
      </div>
    );
  });

  station.action("vote", async ({ broadcast, data }) => {
    const voteId = String(data?.optionId ?? "");
    if (!options.find((o) => o.id === voteId)) return;
    await redis.hincrby(KEY, voteId, 1);
    broadcast("poll");
  });
}
