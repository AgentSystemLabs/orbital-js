import type { WSContext } from "hono/ws";

export type DispatcherOptions = {
  maxSubscriptionsPerWs?: number;
  maxSubscriptionsTotal?: number;
};

export class SubscriptionLimitError extends Error {
  constructor(public scope: "ws" | "process", public limit: number) {
    super(
      scope === "ws"
        ? `station: subscription cap reached for connection (${limit})`
        : `station: subscription cap reached for process (${limit})`
    );
  }
}

export class Dispatcher {
  private subscriptions = new Map<string, Set<WSContext>>();
  private perSocket = new WeakMap<WSContext, Set<string>>();
  private total = 0;
  private readonly maxPerWs: number;
  private readonly maxTotal: number;

  constructor(opts: DispatcherOptions = {}) {
    this.maxPerWs = opts.maxSubscriptionsPerWs ?? 256;
    this.maxTotal = opts.maxSubscriptionsTotal ?? 100_000;
  }

  subscribe(ws: WSContext, key: string) {
    let keys = this.perSocket.get(ws);
    if (!keys) {
      keys = new Set();
      this.perSocket.set(ws, keys);
    }
    if (keys.has(key)) return;
    if (keys.size >= this.maxPerWs) {
      throw new SubscriptionLimitError("ws", this.maxPerWs);
    }
    if (this.total >= this.maxTotal) {
      throw new SubscriptionLimitError("process", this.maxTotal);
    }
    let set = this.subscriptions.get(key);
    if (!set) {
      set = new Set();
      this.subscriptions.set(key, set);
    }
    set.add(ws);
    keys.add(key);
    this.total++;
  }

  unsubscribe(ws: WSContext, key: string) {
    const set = this.subscriptions.get(key);
    if (!set) return;
    if (set.delete(ws)) {
      this.total--;
      this.perSocket.get(ws)?.delete(key);
      if (set.size === 0) this.subscriptions.delete(key);
    }
  }

  unsubscribeAll(ws: WSContext) {
    const keys = this.perSocket.get(ws);
    if (!keys) return;
    for (const key of keys) {
      const set = this.subscriptions.get(key);
      if (!set) continue;
      if (set.delete(ws)) {
        this.total--;
        if (set.size === 0) this.subscriptions.delete(key);
      }
    }
    this.perSocket.delete(ws);
  }

  getSubscribers(key: string): Set<WSContext> | undefined {
    return this.subscriptions.get(key);
  }

  hasSubscribersFor(key: string): boolean {
    const set = this.subscriptions.get(key);
    return !!set && set.size > 0;
  }

  subscribedKeys(): string[] {
    return [...this.subscriptions.keys()];
  }

  countFor(ws: WSContext): number {
    return this.perSocket.get(ws)?.size ?? 0;
  }

  totalCount(): number {
    return this.total;
  }

  // Returns true if the underlying socket accepted the frame, false otherwise.
  // Catches send-on-closed and ill-states so a single broken socket never
  // poisons broadcastLocal.
  send(ws: WSContext, data: string): boolean {
    try {
      // hono's WSContext does not expose readyState directly; we rely on a
      // try/catch which works for both Bun and ws-style adapters.
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }
}
