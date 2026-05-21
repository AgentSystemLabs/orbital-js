import type { WSContext } from "hono/ws";
import type { Dispatcher } from "./dispatcher";
import type { Logger } from "./log";

// Templates render to a stringifiable HTML chunk. We accept Promises and JSX
// elements (which stringify to HTML in this project), and reject anything else
// at runtime so callers don't end up rendering "[object Object]" into the DOM.
//
// `TemplateResult` is intentionally permissive because Hono's JSX element
// objects are stringifiable but not declared in the global JSX namespace at
// the framework's compile site. Runtime coercion enforces correctness.
export type TemplateResult = string | { toString(): string };
export type TemplateFn<Ctx> = (ctx: Ctx) => unknown | Promise<unknown>;

export type BroadcastFilter<Ctx> = (ctx: Ctx, ws: WSContext) => boolean;

export type RendererHooks<Ctx> = {
  beforeTemplate?: (ctx: Ctx, key: string) => boolean | Promise<boolean>;
  onError?: (err: unknown, kind: string, ctx?: Ctx) => void;
  onLog?: Logger;
};

const FRAME_TYPE_TEMPLATE = "template";
const FRAME_TYPE_TEMPLATE_ERROR = "templateError";

function looksLikeJsxObject(v: unknown): boolean {
  if (v == null || typeof v !== "object") return false;
  // Bun JSX returns objects with toString that produce HTML. If String(v)
  // produces "[object Object]" we know it slipped through.
  return Object.prototype.toString.call(v) === "[object Object]";
}

function coerceTemplateResult(value: unknown, key: string): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const str = String(value);
  if (looksLikeJsxObject(value) && str === "[object Object]") {
    throw new Error(
      `parabola: template "${key}" returned a plain object that does not stringify to HTML. ` +
        `Return a JSX element, a string, or null.`
    );
  }
  return str;
}

export class Renderer<Ctx = unknown> {
  private dispatcher: Dispatcher;
  private templates = new Map<string, TemplateFn<Ctx>>();
  private ctxStore: Map<WSContext, Ctx>;
  private onBroadcast?: (key: string) => void;
  private hooks: RendererHooks<Ctx>;

  constructor(
    dispatcher: Dispatcher,
    ctxStore: Map<WSContext, Ctx>,
    onBroadcast?: (key: string) => void,
    hooks: RendererHooks<Ctx> = {}
  ) {
    this.dispatcher = dispatcher;
    this.ctxStore = ctxStore;
    this.onBroadcast = onBroadcast;
    this.hooks = hooks;
  }

  register(key: string, cb: TemplateFn<Ctx>): void {
    if (this.templates.has(key)) {
      throw new Error(
        `parabola: template "${key}" is already registered. Use a different key, or call unregister(key) first.`
      );
    }
    this.templates.set(key, cb);
  }

  unregister(key: string): boolean {
    return this.templates.delete(key);
  }

  has(key: string): boolean {
    return this.templates.has(key);
  }

  keys(): string[] {
    return [...this.templates.keys()];
  }

  async renderToString(key: string, ctx: Ctx): Promise<string | null> {
    const template = this.templates.get(key);
    if (!template) return null;
    if (this.hooks.beforeTemplate) {
      const ok = await this.hooks.beforeTemplate(ctx, key);
      if (ok === false) return null;
    }
    try {
      const result = await template(ctx);
      return coerceTemplateResult(result, key);
    } catch (err) {
      this.hooks.onError?.(err, "template", ctx);
      this.hooks.onLog?.("error", "template_render_failed", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async renderFor(key: string, ws: WSContext): Promise<void> {
    const ctx = this.ctxStore.get(ws);
    if (ctx === undefined) return;
    try {
      const html = await this.renderToString(key, ctx);
      if (html === null) return;
      this.dispatcher.send(ws, JSON.stringify({ type: FRAME_TYPE_TEMPLATE, key, html }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatcher.send(
        ws,
        JSON.stringify({ type: FRAME_TYPE_TEMPLATE_ERROR, key, error: message })
      );
    }
  }

  async broadcast(key: string, filter?: BroadcastFilter<Ctx>): Promise<void> {
    await this.broadcastLocal(key, filter);
    // Note: a filter cannot cross the Redis boundary today — remote nodes will
    // re-evaluate locally. Filters that depend on remote ctx state will not be
    // exact across nodes; document as best-effort.
    this.onBroadcast?.(key);
  }

  async broadcastLocal(key: string, filter?: BroadcastFilter<Ctx>): Promise<void> {
    if (!this.templates.has(key)) {
      this.hooks.onLog?.("warn", "broadcast_unregistered_template", { key });
      return;
    }
    const subscribers = this.dispatcher.getSubscribers(key);
    if (!subscribers || subscribers.size === 0) return;

    const targets: Array<[WSContext, Ctx]> = [];
    for (const ws of subscribers) {
      const ctx = this.ctxStore.get(ws);
      if (ctx === undefined) continue;
      if (filter && !filter(ctx, ws)) continue;
      targets.push([ws, ctx]);
    }

    const renders = await Promise.allSettled(
      targets.map(async ([ws, ctx]) => {
        const html = await this.renderToString(key, ctx);
        return { ws, html };
      })
    );

    renders.forEach((r, i) => {
      const ws = targets[i][0];
      if (r.status === "fulfilled") {
        const { html } = r.value;
        if (html === null) return;
        this.dispatcher.send(
          ws,
          JSON.stringify({ type: FRAME_TYPE_TEMPLATE, key, html })
        );
      } else {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.hooks.onError?.(r.reason, "broadcast", targets[i][1]);
        this.dispatcher.send(
          ws,
          JSON.stringify({ type: FRAME_TYPE_TEMPLATE_ERROR, key, error: message })
        );
      }
    });
  }
}
