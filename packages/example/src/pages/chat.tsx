import type { Station } from "@orbital-js/station";
import type { AppCtx } from "../index";
import Filter from "bad-words";
import { redis } from "../redis";

const MAX_MESSAGES = 100;
const KEY = "chat:messages";
const filter = new Filter();

export function registerChat(station: Station<AppCtx>) {
  station.template("chat", () => {
    return (
      <div class="items-center py-12">
        <h1 class="text-xl">Send Messages to Everyone!</h1>

        <div class="flex flex-col gap-8 justify-center pt-12">
          <form p-action="sendMessage">
            <input
              required
              name="message"
              type="text"
              class="input input-bordered"
            />
            <button class="btn btn-primary">send</button>
          </form>

          <div p-template="messageList"></div>
        </div>
      </div>
    );
  });

  station.template("messageList", async () => {
    const messages = await redis.lrange(KEY, 0, MAX_MESSAGES - 1);
    return (
      <div class="flex flex-wrap gap-4">
        {messages.map((message) => (
          <div class="bg-base-200 p-4 rounded-lg">{message}</div>
        ))}
      </div>
    );
  });

  station.action("sendMessage", async ({ broadcast, data }) => {
    const raw = String(data?.message ?? "").trim();
    if (!raw) return;
    const message = filter.clean(raw);
    await redis
      .multi()
      .lpush(KEY, message)
      .ltrim(KEY, 0, MAX_MESSAGES - 1)
      .exec();
    broadcast("messageList");
  });
}
