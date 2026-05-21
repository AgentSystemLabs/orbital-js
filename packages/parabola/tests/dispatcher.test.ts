import { describe, expect, test } from "bun:test";
import { Dispatcher, SubscriptionLimitError } from "../src/dispatcher";

function fakeWs(): any {
  return {
    sent: [] as string[],
    send(s: string) {
      this.sent.push(s);
    },
    close() {},
  };
}

describe("Dispatcher", () => {
  test("subscribe / unsubscribe removes empty Sets", () => {
    const d = new Dispatcher();
    const a = fakeWs();
    d.subscribe(a, "k1");
    expect(d.getSubscribers("k1")?.size).toBe(1);
    d.unsubscribe(a, "k1");
    expect(d.getSubscribers("k1")).toBeUndefined();
    expect(d.totalCount()).toBe(0);
  });

  test("unsubscribeAll cleans up per-socket map and per-key sets", () => {
    const d = new Dispatcher();
    const a = fakeWs();
    d.subscribe(a, "k1");
    d.subscribe(a, "k2");
    d.unsubscribeAll(a);
    expect(d.getSubscribers("k1")).toBeUndefined();
    expect(d.getSubscribers("k2")).toBeUndefined();
    expect(d.totalCount()).toBe(0);
    expect(d.countFor(a)).toBe(0);
  });

  test("duplicate subscribes are idempotent", () => {
    const d = new Dispatcher();
    const a = fakeWs();
    d.subscribe(a, "k1");
    d.subscribe(a, "k1");
    expect(d.totalCount()).toBe(1);
    expect(d.countFor(a)).toBe(1);
  });

  test("per-ws cap throws SubscriptionLimitError", () => {
    const d = new Dispatcher({ maxSubscriptionsPerWs: 2 });
    const a = fakeWs();
    d.subscribe(a, "a");
    d.subscribe(a, "b");
    expect(() => d.subscribe(a, "c")).toThrow(SubscriptionLimitError);
  });

  test("process cap throws SubscriptionLimitError", () => {
    const d = new Dispatcher({ maxSubscriptionsTotal: 2 });
    const a = fakeWs();
    const b = fakeWs();
    d.subscribe(a, "a");
    d.subscribe(b, "b");
    expect(() => d.subscribe(a, "c")).toThrow(SubscriptionLimitError);
  });

  test("send returns false on throwing socket without poisoning state", () => {
    const d = new Dispatcher();
    const a = {
      send() {
        throw new Error("socket closed");
      },
    } as any;
    expect(d.send(a, "frame")).toBe(false);
  });

  test("hasSubscribersFor reflects key state", () => {
    const d = new Dispatcher();
    const a = fakeWs();
    expect(d.hasSubscribersFor("k")).toBe(false);
    d.subscribe(a, "k");
    expect(d.hasSubscribersFor("k")).toBe(true);
    d.unsubscribe(a, "k");
    expect(d.hasSubscribersFor("k")).toBe(false);
  });
});
