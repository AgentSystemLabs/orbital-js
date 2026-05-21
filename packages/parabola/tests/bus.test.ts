import { describe, expect, test } from "bun:test";
import { ControlBus } from "../src/bus";
import { Renderer } from "../src/renderer";
import { Dispatcher } from "../src/dispatcher";

type Ctx = { id: string };

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
  const renderer = new Renderer<Ctx>(dispatcher, ctxStore);
  let lastError: { err: unknown; kind: string } | null = null;
  const bus = new ControlBus<Ctx>(renderer, ctxStore, {
    onError: (err, kind) => {
      lastError = { err, kind };
    },
  });
  return { dispatcher, ctxStore, renderer, bus, getLastError: () => lastError };
}

describe("ControlBus", () => {
  test("invoke awaits async handlers and surfaces errors via onError + actionResult", async () => {
    const { ctxStore, bus, getLastError } = fixture();
    const ws = fakeWs();
    ctxStore.set(ws, { id: "u1" });
    bus.on("doit", async () => {
      throw new Error("oh no");
    });
    await bus.invoke("doit", { messageId: 7 }, ws);
    expect(getLastError()?.kind).toBe("action");
    expect((getLastError()?.err as Error).message).toBe("oh no");
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.type).toBe("actionResult");
    expect(frame.ok).toBe(false);
    expect(frame.messageId).toBe(7);
    expect(frame.error).toBe("oh no");
  });

  test("input validator rejects bad payload with actionResult.ok=false", async () => {
    const { ctxStore, bus } = fixture();
    const ws = fakeWs();
    ctxStore.set(ws, { id: "u1" });
    let handlerCalled = false;
    bus.on("save", {
      input: {
        parse: (v: unknown) => {
          if (typeof v !== "object" || !v || !(v as any).body) {
            throw new Error("missing body");
          }
          return v as { body: string };
        },
      },
      handler: () => {
        handlerCalled = true;
      },
    });
    await bus.invoke("save", { data: {}, messageId: 1 }, ws);
    expect(handlerCalled).toBe(false);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.ok).toBe(false);
    expect(frame.error).toMatch(/missing body/);
  });

  test("reply() sends actionReply frame correlated by messageId", async () => {
    const { ctxStore, bus } = fixture();
    const ws = fakeWs();
    ctxStore.set(ws, { id: "u1" });
    bus.on("echo", ({ reply, data }) => {
      reply({ got: data });
    });
    await bus.invoke("echo", { data: { x: 1 }, messageId: "abc" }, ws);
    const reply = JSON.parse(ws.sent[0]);
    expect(reply.type).toBe("actionReply");
    expect(reply.key).toBe("echo");
    expect(reply.messageId).toBe("abc");
    expect(reply.payload).toEqual({ got: { x: 1 } });
  });

  test("beforeAction=false rejects before handler runs", async () => {
    const dispatcher = new Dispatcher();
    const ctxStore = new Map<any, Ctx>();
    const renderer = new Renderer<Ctx>(dispatcher, ctxStore);
    const bus = new ControlBus<Ctx>(renderer, ctxStore, {
      beforeAction: () => false,
    });
    const ws = fakeWs();
    ctxStore.set(ws, { id: "u" });
    let handlerCalled = false;
    bus.on("blocked", () => {
      handlerCalled = true;
    });
    await bus.invoke("blocked", { messageId: 1 }, ws);
    expect(handlerCalled).toBe(false);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.ok).toBe(false);
    expect(frame.error).toBe("rejected");
  });

  test("unknown action returns actionResult with ok=false", async () => {
    const { ctxStore, bus } = fixture();
    const ws = fakeWs();
    ctxStore.set(ws, { id: "u" });
    await bus.invoke("ghost", { messageId: 9 }, ws);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.ok).toBe(false);
    expect(frame.error).toMatch(/unknown/);
  });

  test("duplicate registration throws", () => {
    const { bus } = fixture();
    bus.on("k", () => {});
    expect(() => bus.on("k", () => {})).toThrow(/already registered/);
  });
});
