import { describe, expect, test } from "bun:test";
import { Dispatcher } from "../src/dispatcher";
import { Renderer } from "../src/renderer";

type Ctx = { name: string };

function fakeWs(): any {
  const sent: string[] = [];
  return {
    sent,
    send(s: string) {
      sent.push(s);
    },
  };
}

function fixture() {
  const dispatcher = new Dispatcher();
  const ctxStore = new Map<any, Ctx>();
  const logs: Array<[string, string, any?]> = [];
  const renderer = new Renderer<Ctx>(
    dispatcher,
    ctxStore,
    undefined,
    {
      onLog: (level, event, fields) => logs.push([level, event, fields]),
    }
  );
  return { dispatcher, ctxStore, renderer, logs };
}

describe("Renderer", () => {
  test("renderToString coerces strings, null, JSX-like objects", async () => {
    const { renderer } = fixture();
    renderer.register("s", () => "hello");
    renderer.register("n", () => null);
    renderer.register("j", () => ({ toString: () => "<div>j</div>" }));
    expect(await renderer.renderToString("s", { name: "a" })).toBe("hello");
    expect(await renderer.renderToString("n", { name: "a" })).toBe("");
    expect(await renderer.renderToString("j", { name: "a" })).toBe("<div>j</div>");
    expect(await renderer.renderToString("missing", { name: "a" })).toBe(null);
  });

  test("renderToString throws when template returns plain object", async () => {
    const { renderer } = fixture();
    renderer.register("bad", () => ({ not: "a jsx" }));
    expect(renderer.renderToString("bad", { name: "x" })).rejects.toThrow(
      /plain object/
    );
  });

  test("register throws on duplicate key", () => {
    const { renderer } = fixture();
    renderer.register("k", () => "");
    expect(() => renderer.register("k", () => "")).toThrow(/already registered/);
  });

  test("broadcastLocal uses allSettled — one broken template does not block others", async () => {
    const { dispatcher, ctxStore, renderer } = fixture();
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    ctxStore.set(ws1, { name: "a" });
    ctxStore.set(ws2, { name: "b" });
    dispatcher.subscribe(ws1, "t");
    dispatcher.subscribe(ws2, "t");
    let calls = 0;
    renderer.register("t", (ctx) => {
      calls++;
      if (ctx.name === "a") throw new Error("boom");
      return "<div>ok</div>";
    });
    await renderer.broadcastLocal("t");
    expect(calls).toBe(2);
    // ws1 receives a templateError; ws2 receives a template frame.
    expect(ws1.sent[0]).toMatch(/templateError/);
    expect(ws2.sent[0]).toMatch(/<div>ok<\/div>/);
  });

  test("broadcastLocal filter scopes recipients", async () => {
    const { dispatcher, ctxStore, renderer } = fixture();
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    ctxStore.set(ws1, { name: "a" });
    ctxStore.set(ws2, { name: "b" });
    dispatcher.subscribe(ws1, "t");
    dispatcher.subscribe(ws2, "t");
    renderer.register("t", (ctx) => `<div>${ctx.name}</div>`);
    await renderer.broadcastLocal("t", (ctx) => ctx.name === "a");
    expect(ws1.sent.length).toBe(1);
    expect(ws2.sent.length).toBe(0);
  });

  test("beforeTemplate=false skips render", async () => {
    const dispatcher = new Dispatcher();
    const ctxStore = new Map<any, Ctx>();
    let beforeCalls = 0;
    const renderer = new Renderer<Ctx>(dispatcher, ctxStore, undefined, {
      beforeTemplate: () => {
        beforeCalls++;
        return false;
      },
    });
    renderer.register("t", () => "<div>ok</div>");
    expect(await renderer.renderToString("t", { name: "a" })).toBe(null);
    expect(beforeCalls).toBe(1);
  });

  test("broadcast of unregistered key logs and no-ops", async () => {
    const { renderer, logs } = fixture();
    await renderer.broadcast("never-registered");
    expect(logs.some(([, e]) => e === "broadcast_unregistered_template")).toBe(true);
  });
});
