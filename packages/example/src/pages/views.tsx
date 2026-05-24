import type { Station } from "@orbital-js/station";
import type { AppCtx } from "../index";
import { redis } from "../redis";

const COUNT_KEY = "views:count";
const USERS_KEY = "views:users";
const USER_TTL_MS = 120000;

async function recentUsers(): Promise<string[]> {
  const cutoff = Date.now() - USER_TTL_MS;
  await redis.zremrangebyscore(USERS_KEY, "-inf", cutoff);
  return redis.zrange(USERS_KEY, 0, -1);
}

export function registerViews(station: Station<AppCtx>) {
  station.template("views", () => {
    return (
      <>
        <div
          p-load="views:increment"
          class="flex flex-col items-center py-12 gap-12"
        >
          <div class="text-center">
            <div p-template="views:count"></div> people have loaded this example
          </div>

          <div p-template="users"></div>
        </div>
      </>
    );
  });

  station.template("users", async () => {
    const users = await recentUsers();
    return (
      <div class="space-y-4">
        <h2 class="text-xl">
          Recent Users (random character, clears after 2 min)
        </h2>

        <div className="flex gap-4 flex-wrap">
          {users.map((name) => (
            <div class="flex rounded-full size-10 bg-base-300 justify-center items-center">
              {name.substring(0, 1)}
            </div>
          ))}
        </div>
      </div>
    );
  });

  station.template("views:count", async () => {
    const count = (await redis.get(COUNT_KEY)) ?? "0";
    return <span>{count}</span>;
  });

  station.action("views:increment", async ({ broadcast }) => {
    const name = Math.random().toString(36).substring(7);
    await redis
      .multi()
      .incr(COUNT_KEY)
      .zadd(USERS_KEY, Date.now(), name)
      .exec();
    broadcast("views:count");
    broadcast("users");
  });
}
