import type { WSContext } from "hono/ws";
import type { Renderer, BroadcastFilter } from "./renderer";
import type { Logger } from "./log";

export type Validator<T> = {
  parse: (input: unknown) => T;
};

export type ActionArgs<Ctx, Data = unknown> = {
  ctx: Ctx;
  data: Data;
  ws: WSContext;
  invalidate: (key: string) => void;
  broadcast: (key: string, filter?: BroadcastFilter<Ctx>) => void;
  reply: (payload: unknown) => void;
};

export type ActionHandler<Ctx, Data = any> = (
  args: ActionArgs<Ctx, Data>
) => void | Promise<void>;

export type ActionDefinition<Ctx, Data> = {
  input?: Validator<Data>;
  handler: ActionHandler<Ctx, Data>;
};

export type ControlBusHooks<Ctx> = {
  beforeAction?: (
    ctx: Ctx,
    key: string,
    data: unknown
  ) => boolean | Promise<boolean>;
  onError?: (err: unknown, kind: string, ctx?: Ctx) => void;
  onLog?: Logger;
};

export class ControlBus<Ctx = unknown> {
  private renderer: Renderer<Ctx>;
  private ctxStore: Map<WSContext, Ctx>;
  private actions = new Map<string, ActionDefinition<Ctx, any>>();
  private hooks: ControlBusHooks<Ctx>;

  constructor(
    renderer: Renderer<Ctx>,
    ctxStore: Map<WSContext, Ctx>,
    hooks: ControlBusHooks<Ctx> = {}
  ) {
    this.renderer = renderer;
    this.ctxStore = ctxStore;
    this.hooks = hooks;
  }

  on<Data = any>(key: string, def: ActionHandler<Ctx, Data> | ActionDefinition<Ctx, Data>): void {
    if (this.actions.has(key)) {
      throw new Error(
        `station: action "${key}" is already registered. Use a different key, or call off(key) first.`
      );
    }
    const norm: ActionDefinition<Ctx, Data> =
      typeof def === "function" ? { handler: def } : def;
    this.actions.set(key, norm);
  }

  off(key: string): boolean {
    return this.actions.delete(key);
  }

  has(key: string): boolean {
    return this.actions.has(key);
  }

  async invoke(
    key: string,
    rawPayload: { data?: unknown; messageId?: number | string } | null | undefined,
    ws: WSContext
  ): Promise<void> {
    const action = this.actions.get(key);
    const ctx = this.ctxStore.get(ws);
    if (ctx === undefined) return;

    const messageId = rawPayload?.messageId;
    const replyAck = (ok: boolean, error?: string) => {
      if (messageId === undefined) return;
      try {
        ws.send(
          JSON.stringify({
            type: "actionResult",
            messageId,
            ok,
            ...(error ? { error } : {}),
          })
        );
      } catch {
        // socket gone; nothing more to do
      }
    };

    if (!action) {
      this.hooks.onLog?.("warn", "unknown_action", { key });
      replyAck(false, `unknown action "${key}"`);
      return;
    }

    if (this.hooks.beforeAction) {
      try {
        const ok = await this.hooks.beforeAction(ctx, key, rawPayload?.data);
        if (ok === false) {
          replyAck(false, "rejected");
          return;
        }
      } catch (err) {
        this.hooks.onError?.(err, "beforeAction", ctx);
        replyAck(false, err instanceof Error ? err.message : String(err));
        return;
      }
    }

    let data: unknown = rawPayload?.data;
    if (action.input) {
      try {
        data = action.input.parse(data);
      } catch (err) {
        this.hooks.onError?.(err, "actionInput", ctx);
        replyAck(false, err instanceof Error ? err.message : "invalid input");
        return;
      }
    }

    try {
      await action.handler({
        ctx,
        data,
        ws,
        invalidate: (k) => {
          this.renderer.renderFor(k, ws).catch((err) =>
            this.hooks.onError?.(err, "invalidate", ctx)
          );
        },
        broadcast: (k, filter) => {
          this.renderer.broadcast(k, filter).catch((err) =>
            this.hooks.onError?.(err, "broadcast", ctx)
          );
        },
        reply: (payload) => {
          try {
            ws.send(
              JSON.stringify({
                type: "actionReply",
                key,
                messageId,
                payload,
              })
            );
          } catch {
            // socket gone
          }
        },
      });
      replyAck(true);
    } catch (err) {
      this.hooks.onError?.(err, "action", ctx);
      this.hooks.onLog?.("error", "action_failed", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      replyAck(false, err instanceof Error ? err.message : String(err));
    }
  }
}
