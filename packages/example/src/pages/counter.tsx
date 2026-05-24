import type { Station } from "@orbital-js/station";
import type { AppCtx } from "../index";

export function registerCounter(station: Station<AppCtx>) {
  station.template("counter", ({ ctx }) => {
    return (
      <div class="flex flex-col items-center py-12">
        <div class="text-center">{ctx.count}</div>
        <div class="flex gap-8 justify-center pt-12">
          <form p-action="decrement">
            <button class="btn btn-primary">decrement</button>
          </form>

          <form p-action="increment">
            <button class="btn btn-primary">increment</button>
          </form>
        </div>
      </div>
    );
  });

  station.action("increment", ({ ctx, invalidate }) => {
    ctx.count++;
    invalidate("counter");
  });

  station.action("decrement", ({ ctx, invalidate }) => {
    ctx.count--;
    invalidate("counter");
  });
}
