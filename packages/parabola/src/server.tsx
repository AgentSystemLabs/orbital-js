import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { Handler } from "hono";
import { randomUUID, createHash } from "crypto";
import fs from "fs";
import path from "path";

import {
  ControlBus,
  type ActionHandler,
  type ActionDefinition,
  type Validator,
} from "./bus";
import { Dispatcher, SubscriptionLimitError } from "./dispatcher";
import { Renderer, type TemplateFn, type BroadcastFilter } from "./renderer";
import {
  defaultLogger,
  noopMetric,
  type Logger,
  type MetricRecorder,
} from "./log";

const BROADCAST_CHANNEL = "parabola:broadcast";
const PROTOCOL_VERSION = 1;

type Route = { path: string; target: string; template: string };

export type RedisLike = {
  publish(channel: string, message: string): Promise<number> | number;
  subscribe(channel: string, cb?: (err: Error | null, count?: number) => void): unknown;
  on(event: string, cb: (...args: any[]) => void): unknown;
  quit?(): Promise<unknown> | unknown;
  disconnect?(): unknown;
};

export type ParabolaOptions = {
  styles?: string[];
  routes?: Route[];
  port?: number;
  redis?: { url: string };
  /**
   * Pre-built redis publisher/subscriber pair. Use when you want to share a
   * connection with the rest of your app, or for tests with a mock.
   */
  redisClients?: { publisher: RedisLike; subscriber: RedisLike };
  maxSubscriptionsPerWs?: number;
  maxSubscriptionsTotal?: number;
  logger?: Logger;
  metric?: MetricRecorder;
};

export type ParabolaWelcomeFrame = {
  type: "welcome";
  protocolVersion: number;
  instanceId: string;
  connectionId: string;
};

type IncomingFrame =
  | { type: "template"; payload: string }
  | { type: "subscribe"; payload: string }
  | { type: "unsubscribe"; payload: string }
  | { type: "navigate"; payload: unknown }
  | {
      type: "action";
      payload: { key: string; data?: unknown; messageId?: number | string };
    };

function Main({ styles, routes, clientScriptUrl }: ParabolaOptions & { clientScriptUrl: string }) {
  return (
    <html data-theme="night">
      <head>
        <meta charset="UTF-8" />
        <title>Parabola</title>
        {styles?.map((style) => (
          <link rel="stylesheet" href={style} />
        ))}
      </head>
      <body>
        <div id="main" p-template="main">
          loading...
        </div>

        <script
          dangerouslySetInnerHTML={{
            __html: `window.parabolaRoutes = ${JSON.stringify(routes ?? [])};`,
          }}
        />

        <script src={clientScriptUrl} />
      </body>
    </html>
  );
}

export type BeforeUpgradeHook = (
  req: Request
) => boolean | Response | Promise<boolean | Response>;

export type ConnectHook<Ctx> = (
  req: Request,
  ctx: Partial<Ctx>
) => Partial<Ctx> | Ctx | void | Promise<Partial<Ctx> | Ctx | void>;

export type DisconnectHook<Ctx> = (ctx: Ctx) => void | Promise<void>;

export type ErrorHook<Ctx> = (
  err: unknown,
  kind: string,
  ctx?: Ctx
) => void | Promise<void>;

export type BeforeActionHook<Ctx> = (
  ctx: Ctx,
  key: string,
  data: unknown
) => boolean | Promise<boolean>;

export type BeforeTemplateHook<Ctx> = (
  ctx: Ctx,
  key: string
) => boolean | Promise<boolean>;

export type TemplateHandle<Ctx> = {
  key: string;
  broadcast: (filter?: BroadcastFilter<Ctx>) => Promise<void>;
  invalidate: (ws: WSContext) => Promise<void>;
};

export type ActionHandle = {
  key: string;
};

export class Parabola<Ctx = Record<string, unknown>> {
  private dispatcher: Dispatcher;
  private renderer: Renderer<Ctx>;
  private controlBus: ControlBus<Ctx>;
  private app: Hono;
  private ctxStore = new Map<WSContext, Ctx>();
  private connIdStore = new WeakMap<WSContext, string>();
  private connectHooks: Array<ConnectHook<Ctx>> = [];
  private disconnectHooks: Array<DisconnectHook<Ctx>> = [];
  private beforeUpgradeHook?: BeforeUpgradeHook;
  private beforeActionHook?: BeforeActionHook<Ctx>;
  private beforeTemplateHook?: BeforeTemplateHook<Ctx>;
  private errorHook?: ErrorHook<Ctx>;
  private opts: ParabolaOptions;
  private instanceId = randomUUID();
  private publisher?: RedisLike;
  private subscriber?: RedisLike;
  private bunServer?: { stop: (closeActiveConnections?: boolean) => void; port?: number };
  private liveSockets = new Set<WSContext>();
  private prepared = false;
  private clientScriptBody?: string;
  private clientScriptHash: string = "";
  private clientScriptEtag: string = "";
  private upgradeWebSocket: ReturnType<typeof createBunWebSocket>["upgradeWebSocket"];
  private bunWebsocket: ReturnType<typeof createBunWebSocket>["websocket"];
  private logger: Logger;
  private metric: MetricRecorder;
  private clientScriptUrl = "/static/parabola.js";

  constructor(opts?: ParabolaOptions) {
    this.opts = opts ?? {};
    this.logger = this.opts.logger ?? defaultLogger;
    this.metric = this.opts.metric ?? noopMetric;
    this.dispatcher = new Dispatcher({
      maxSubscriptionsPerWs: this.opts.maxSubscriptionsPerWs,
      maxSubscriptionsTotal: this.opts.maxSubscriptionsTotal,
    });

    this.renderer = new Renderer<Ctx>(
      this.dispatcher,
      this.ctxStore,
      (key) => this.publishBroadcast(key),
      {
        beforeTemplate: (ctx, key) =>
          this.beforeTemplateHook ? this.beforeTemplateHook(ctx, key) : true,
        onError: (err, kind, ctx) => this.emitError(err, kind, ctx),
        onLog: this.logger,
      }
    );

    this.controlBus = new ControlBus<Ctx>(this.renderer, this.ctxStore, {
      beforeAction: (ctx, key, data) =>
        this.beforeActionHook ? this.beforeActionHook(ctx, key, data) : true,
      onError: (err, kind, ctx) => this.emitError(err, kind, ctx),
      onLog: this.logger,
    });

    if (this.opts.redisClients) {
      this.publisher = this.opts.redisClients.publisher;
      this.subscriber = this.opts.redisClients.subscriber;
      this.wireRedisSubscriber();
    }

    const ws = createBunWebSocket();
    this.upgradeWebSocket = ws.upgradeWebSocket;
    this.bunWebsocket = ws.websocket;

    this.app = new Hono();
  }

  /**
   * Returns the underlying Hono app so callers can mount additional routes or
   * middleware. Triggers route preparation if it hasn't happened yet — call
   * this only after all lifecycle hooks are registered.
   */
  getApp(): Hono {
    this.prepare();
    return this.app;
  }

  /**
   * Hono fetch handler. Convenient for mounting Parabola under another runtime
   * (e.g. another Hono app via `app.route('/', parabola.fetch)`).
   */
  get fetch() {
    this.prepare();
    return this.app.fetch;
  }

  /**
   * The Bun WS handler. Pass alongside `Bun.serve({ fetch, websocket })` when
   * embedding manually rather than calling listen().
   */
  get websocket() {
    return this.bunWebsocket;
  }

  /**
   * UUID for this server instance. Useful for clients to detect node switches
   * after sticky-session loss.
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  private emitError(err: unknown, kind: string, ctx?: Ctx) {
    try {
      this.errorHook?.(err, kind, ctx);
    } catch (hookErr) {
      this.logger("error", "onError_hook_threw", {
        kind,
        error: hookErr instanceof Error ? hookErr.message : String(hookErr),
      });
    }
    if (!this.errorHook) {
      this.logger("error", "unhandled_error", {
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks (composable — second call appends unless noted)
  // -------------------------------------------------------------------------

  beforeUpgrade(cb: BeforeUpgradeHook): this {
    if (this.prepared) {
      throw new Error(
        "parabola: beforeUpgrade must be registered before getApp()/listen()/fetch is accessed."
      );
    }
    this.beforeUpgradeHook = cb;
    return this;
  }

  onConnect(cb: ConnectHook<Ctx>): this {
    this.connectHooks.push(cb);
    return this;
  }

  onDisconnect(cb: DisconnectHook<Ctx>): this {
    this.disconnectHooks.push(cb);
    return this;
  }

  beforeAction(cb: BeforeActionHook<Ctx>): this {
    this.beforeActionHook = cb;
    return this;
  }

  beforeTemplate(cb: BeforeTemplateHook<Ctx>): this {
    this.beforeTemplateHook = cb;
    return this;
  }

  onError(cb: ErrorHook<Ctx>): this {
    this.errorHook = cb;
    return this;
  }

  // -------------------------------------------------------------------------
  // Templates / actions
  // -------------------------------------------------------------------------

  template(
    key: string,
    cb: (args: { ctx: Ctx }) => unknown | Promise<unknown>
  ): TemplateHandle<Ctx> {
    return this.defineTemplate(key, ({ ctx }) => cb({ ctx }) as any);
  }

  defineTemplate<R = unknown>(
    key: string,
    cb: (args: { ctx: Ctx }) => R | Promise<R>
  ): TemplateHandle<Ctx> {
    const fn: TemplateFn<Ctx> = async (ctx) => {
      const result = await cb({ ctx });
      return result as any;
    };
    this.renderer.register(key, fn);
    return {
      key,
      broadcast: (filter) => this.renderer.broadcast(key, filter),
      invalidate: (ws) => this.renderer.renderFor(key, ws),
    };
  }

  action<Data = any>(key: string, cb: ActionHandler<Ctx, Data>): ActionHandle;
  action<Data = any>(key: string, def: ActionDefinition<Ctx, Data>): ActionHandle;
  action<Data = any>(
    key: string,
    def: ActionHandler<Ctx, Data> | ActionDefinition<Ctx, Data>
  ): ActionHandle {
    this.controlBus.on<Data>(key, def);
    return { key };
  }

  defineAction<Data>(
    key: string,
    opts: { input?: Validator<Data>; handler: ActionHandler<Ctx, Data> }
  ): ActionHandle {
    this.controlBus.on<Data>(key, opts);
    return { key };
  }

  // -------------------------------------------------------------------------
  // Broadcast convenience
  // -------------------------------------------------------------------------

  broadcast(key: string, filter?: BroadcastFilter<Ctx>): Promise<void> {
    return this.renderer.broadcast(key, filter);
  }

  // -------------------------------------------------------------------------
  // Server lifecycle
  // -------------------------------------------------------------------------

  private prepare() {
    if (this.prepared) return;
    this.prepared = true;
    this.loadClientScriptSync();
    this.wireRoutes();
  }

  private loadClientScriptSync() {
    if (this.clientScriptBody) return;
    const filePath = path.join(__dirname, "./parabola.js");
    const body = fs.readFileSync(filePath, { encoding: "utf-8" });
    const hash = createHash("sha1").update(body).digest("hex").slice(0, 10);
    this.clientScriptBody = body;
    this.clientScriptHash = hash;
    this.clientScriptEtag = `"${hash}"`;
  }

  private wireRedisSubscriber() {
    const sub = this.subscriber;
    const pub = this.publisher;
    if (!sub || !pub) return;
    (pub as any).on?.("error", (err: Error) =>
      this.logger("error", "redis_publisher_error", { error: err.message })
    );
    (sub as any).on?.("error", (err: Error) =>
      this.logger("error", "redis_subscriber_error", { error: err.message })
    );
    sub.subscribe(BROADCAST_CHANNEL, (err) => {
      if (err) this.logger("error", "redis_subscribe_failed", { error: err.message });
    });
    (sub as any).on("message", (channel: string, raw: string) => {
      if (channel !== BROADCAST_CHANNEL) return;
      try {
        const { key, originId } = JSON.parse(raw);
        if (originId === this.instanceId) return;
        // Skip work when this node has no local subscribers for the key.
        if (!this.dispatcher.hasSubscribersFor(key)) return;
        this.renderer.broadcastLocal(key).catch((rerr) =>
          this.emitError(rerr, "broadcastLocal")
        );
      } catch (perr) {
        this.logger("error", "bad_broadcast_payload", {
          error: perr instanceof Error ? perr.message : String(perr),
        });
      }
    });
  }

  private wireRoutes() {
    const app = this.app;

    app.get(this.clientScriptUrl, (c) => {
      const body = this.clientScriptBody ?? "";
      c.header("Content-Type", "application/javascript; charset=utf-8");
      c.header("ETag", this.clientScriptEtag);
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      if (c.req.header("if-none-match") === this.clientScriptEtag) {
        return c.body(null, 304);
      }
      return c.body(body);
    });

    const ssrHandler: Handler = async (c) => {
      const html = await this.ssr(c.req.raw);
      return c.html(html);
    };

    app.get("/", ssrHandler);

    app.get(
      "/ws",
      this.upgradeWebSocket(async (c) => {
        const req = c.req.raw;
        if (this.beforeUpgradeHook) {
          try {
            const res = await this.beforeUpgradeHook(req);
            if (res === false) {
              throw new UpgradeRejectedError("upgrade rejected by beforeUpgrade hook");
            }
            if (res instanceof Response) {
              throw new UpgradeRejectedError("upgrade rejected", res);
            }
          } catch (err) {
            this.emitError(err, "beforeUpgrade");
            throw err;
          }
        }
        return this.buildWsHandlers(req);
      })
    );

    app.notFound((c) => ssrHandler(c, async () => {}));
  }

  private buildWsHandlers(req: Request) {
    const buildCtx = async (): Promise<Ctx> => {
      let ctx: Partial<Ctx> = {};
      for (const hook of this.connectHooks) {
        try {
          const ret = await hook(req, ctx);
          if (ret && typeof ret === "object") {
            ctx = { ...ctx, ...(ret as object) } as Partial<Ctx>;
          }
        } catch (err) {
          this.emitError(err, "onConnect");
        }
      }
      return ctx as Ctx;
    };

    const ctxPromise = buildCtx();

    const ensureCtx = async (ws: WSContext) => {
      if (!this.ctxStore.has(ws)) {
        this.ctxStore.set(ws, await ctxPromise);
      }
    };

    return {
      onOpen: async (_event: unknown, ws: WSContext) => {
        await ensureCtx(ws);
        this.liveSockets.add(ws);
        const connId = randomUUID();
        this.connIdStore.set(ws, connId);
        this.metric("parabola.ws.open", 1);
        try {
          ws.send(
            JSON.stringify({
              type: "welcome",
              protocolVersion: PROTOCOL_VERSION,
              instanceId: this.instanceId,
              connectionId: connId,
            } satisfies ParabolaWelcomeFrame)
          );
        } catch {
          // socket closed before welcome could send
        }
      },
      onMessage: async (evt: { data: unknown }, ws: WSContext) => {
        await ensureCtx(ws);
        let parsed: IncomingFrame;
        try {
          parsed = JSON.parse(evt.data as string) as IncomingFrame;
        } catch (err) {
          this.emitError(err, "parse");
          this.logger("warn", "ws_bad_json", { connId: this.connIdStore.get(ws) });
          try {
            ws.send(JSON.stringify({ type: "protocolError", error: "invalid json" }));
          } catch {}
          return;
        }

        if (!parsed || typeof parsed !== "object" || typeof (parsed as any).type !== "string") {
          this.logger("warn", "ws_unknown_frame", { connId: this.connIdStore.get(ws) });
          return;
        }

        try {
          if (parsed.type === "template") {
            const key = String(parsed.payload ?? "");
            if (!this.renderer.has(key)) {
              this.logger("warn", "subscribe_unknown_template", { key });
              try {
                ws.send(
                  JSON.stringify({
                    type: "templateError",
                    key,
                    error: "unknown template",
                  })
                );
              } catch {}
              return;
            }
            this.safeSubscribe(ws, key);
            await this.renderer.renderFor(key, ws);
            return;
          }
          if (parsed.type === "subscribe") {
            const key = String(parsed.payload ?? "");
            if (!this.renderer.has(key)) {
              this.logger("warn", "subscribe_unknown_template", { key });
              return;
            }
            this.safeSubscribe(ws, key);
            return;
          }
          if (parsed.type === "unsubscribe") {
            const key = String(parsed.payload ?? "");
            this.dispatcher.unsubscribe(ws, key);
            return;
          }
          if (parsed.type === "navigate") {
            await this.handleNavigate(ws, parsed.payload);
            return;
          }
          if (parsed.type === "action") {
            const payload = parsed.payload ?? ({} as any);
            if (!payload || typeof payload.key !== "string") {
              this.logger("warn", "action_bad_payload", {});
              return;
            }
            await this.controlBus.invoke(payload.key, payload, ws);
            return;
          }
        } catch (err) {
          this.emitError(err, "wsMessage", this.ctxStore.get(ws));
        }
      },
      onClose: (_evt: unknown, ws: WSContext) => {
        const ctx = this.ctxStore.get(ws);
        this.dispatcher.unsubscribeAll(ws);
        this.liveSockets.delete(ws);
        this.ctxStore.delete(ws);
        this.metric("parabola.ws.close", 1);
        if (ctx !== undefined) {
          for (const hook of this.disconnectHooks) {
            Promise.resolve(hook(ctx)).catch((err) =>
              this.emitError(err, "onDisconnect", ctx)
            );
          }
        }
      },
      onError: (err: unknown, ws: WSContext) => {
        this.emitError(err, "ws", this.ctxStore.get(ws));
      },
    };
  }

  private safeSubscribe(ws: WSContext, key: string) {
    try {
      this.dispatcher.subscribe(ws, key);
    } catch (err) {
      if (err instanceof SubscriptionLimitError) {
        this.logger("warn", "subscription_cap_reached", {
          scope: err.scope,
          limit: err.limit,
        });
        try {
          ws.send(
            JSON.stringify({ type: "protocolError", error: err.message })
          );
        } catch {}
        return;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // SSR + nav
  // -------------------------------------------------------------------------

  private async buildCtxFromRequest(req: Request): Promise<Ctx> {
    let ctx: Partial<Ctx> = {};
    for (const hook of this.connectHooks) {
      try {
        const ret = await hook(req, ctx);
        if (ret && typeof ret === "object") {
          ctx = { ...ctx, ...(ret as object) } as Partial<Ctx>;
        }
      } catch (err) {
        this.emitError(err, "onConnect");
      }
    }
    return ctx as Ctx;
  }

  private async ssr(req: Request): Promise<string> {
    const ctx: Ctx = await this.buildCtxFromRequest(req);
    const url = new URL(req.url);
    const requestPath = url.pathname;
    const clientScriptUrl = this.clientScriptHash
      ? `${this.clientScriptUrl}?v=${this.clientScriptHash}`
      : this.clientScriptUrl;
    const shell = String(
      <Main
        styles={this.opts.styles}
        routes={this.opts.routes}
        clientScriptUrl={clientScriptUrl}
      />
    );
    return await this.inlineTemplates(shell, ctx, requestPath);
  }

  private async inlineTemplates(html: string, ctx: Ctx, requestPath: string): Promise<string> {
    const routes = this.opts.routes ?? [];
    const MAX_PASSES = 16;
    let current = html;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let changed = false;
      const next = await new HTMLRewriter()
        .on("[p-template]", {
          element: async (el) => {
            if (el.getAttribute("data-p-hydrated") !== null) return;
            let key = el.getAttribute("p-template");
            if (!key) return;
            const id = el.getAttribute("id");
            if (id) {
              for (const r of routes) {
                if (r.path === requestPath && id === r.target) {
                  key = r.template;
                  el.setAttribute("p-template", key);
                  break;
                }
              }
            }
            try {
              const rendered = await this.renderer.renderToString(key, ctx);
              if (rendered === null) return;
              el.setInnerContent(rendered, { html: true });
              el.setAttribute("data-p-hydrated", "true");
              changed = true;
            } catch (err) {
              this.emitError(err, "ssrTemplate", ctx);
              el.setInnerContent(
                `<div p-error data-template="${escapeHtml(key)}">Template error.</div>`,
                { html: true }
              );
              el.setAttribute("data-p-hydrated", "true");
              changed = true;
            }
          },
        })
        .transform(new Response(current))
        .text();
      if (!changed) return next;
      current = next;
      if (pass === MAX_PASSES - 1) {
        const cycleErr = new Error(
          `parabola: inlineTemplates exceeded ${MAX_PASSES} passes (template cycle?) on ${requestPath}. Aborting to avoid partial HTML.`
        );
        this.emitError(cycleErr, "ssrTemplate", ctx);
        throw cycleErr;
      }
    }
    return current;
  }

  private async handleNavigate(ws: WSContext, payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const p = payload as any;
    const navPath = typeof p.path === "string" ? p.path : null;
    const target = typeof p.target === "string" ? p.target : null;
    const swap = typeof p.swap === "string" ? p.swap : null;
    const push = p.push !== false;
    const navId = typeof p.navId === "number" ? p.navId : null;
    if (!navPath || !target) return;

    const ctx = this.ctxStore.get(ws);
    if (ctx === undefined) return;

    const resolved = await this.renderRoute(navPath, target, swap, ctx);
    if (!resolved.template) return;

    this.dispatcher.unsubscribeAll(ws);

    this.dispatcher.send(
      ws,
      JSON.stringify({
        type: "navigation",
        path: navPath,
        target,
        template: resolved.template,
        html: resolved.html,
        push,
        navId,
      })
    );
  }

  private async renderRoute(
    routePath: string,
    target: string,
    swap: string | null,
    ctx: Ctx
  ): Promise<{ html: string; template: string }> {
    const routes = this.opts.routes ?? [];
    let key: string | null = swap;
    for (const r of routes) {
      if (r.path === routePath && r.target === target) {
        key = r.template;
        break;
      }
    }
    if (!key) return { html: "", template: "" };

    const top = await this.renderer.renderToString(key, ctx);
    if (top === null) return { html: "", template: "" };

    const inner = await this.inlineTemplates(top, ctx, routePath);
    const escapedKey = key.replace(/"/g, "&quot;");
    const html = `<div p-template="${escapedKey}" data-p-hydrated="true">${inner}</div>`;
    return { html, template: key };
  }

  private publishBroadcast(key: string) {
    if (!this.publisher) return;
    try {
      const result = this.publisher.publish(
        BROADCAST_CHANNEL,
        JSON.stringify({ key, originId: this.instanceId })
      );
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch((err) =>
          this.logger("error", "redis_publish_failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    } catch (err) {
      this.logger("error", "redis_publish_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // listen / shutdown
  // -------------------------------------------------------------------------

  async listen(port?: number): Promise<{ port: number; instanceId: string }> {
    this.prepare();

    // Lazy redis init (avoids dragging ioredis in unless the user opted in).
    if (!this.publisher && !this.subscriber && this.opts.redis?.url) {
      let Redis: any;
      try {
        ({ default: Redis } = await import("ioredis"));
      } catch (err) {
        this.logger("error", "ioredis_not_installed", {
          hint: "Install ioredis to enable multi-node broadcast, or pass redisClients yourself.",
        });
        throw err;
      }
      this.publisher = new Redis(this.opts.redis.url);
      this.subscriber = new Redis(this.opts.redis.url);
      this.wireRedisSubscriber();
    }

    const resolvedPort = port ?? this.opts.port ?? Number(process.env.PORT ?? 3000);

    if (typeof (globalThis as any).Bun === "undefined" || !(globalThis as any).Bun?.serve) {
      throw new Error(
        "parabola: listen() requires the Bun runtime. For other runtimes, mount `parabola.fetch` onto your own server."
      );
    }

    this.bunServer = (globalThis as any).Bun.serve({
      fetch: this.app.fetch,
      websocket: this.bunWebsocket,
      port: resolvedPort,
    });

    this.logger("info", "listening", {
      port: resolvedPort,
      instanceId: this.instanceId.slice(0, 8),
    });

    return { port: resolvedPort, instanceId: this.instanceId };
  }

  /**
   * Close active websocket sockets, stop the Bun server, and quit Redis
   * connections. Resolves when shutdown is complete.
   */
  async shutdown(): Promise<void> {
    for (const ws of this.liveSockets) {
      try {
        ws.close(1001, "server shutdown");
      } catch {}
    }
    this.liveSockets.clear();

    if (this.bunServer) {
      try {
        this.bunServer.stop(true);
      } catch (err) {
        this.logger("warn", "server_stop_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.bunServer = undefined;
    }

    const closeRedis = async (client?: RedisLike) => {
      if (!client) return;
      try {
        if (typeof client.quit === "function") {
          await client.quit();
        } else if (typeof client.disconnect === "function") {
          client.disconnect();
        }
      } catch (err) {
        this.logger("warn", "redis_close_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    await Promise.all([closeRedis(this.publisher), closeRedis(this.subscriber)]);
    this.publisher = undefined;
    this.subscriber = undefined;
  }
}

class UpgradeRejectedError extends Error {
  constructor(message: string, public response?: Response) {
    super(message);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
