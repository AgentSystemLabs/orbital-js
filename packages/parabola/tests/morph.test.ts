import { describe, expect, test, beforeAll } from "bun:test";
import { parseHTML } from "linkedom";
import {
  morph,
  morphChildren,
  backoffDelay,
  renderTemplateError,
} from "../src/client-morph.js";

let dom: ReturnType<typeof parseHTML>;

beforeAll(() => {
  dom = parseHTML(
    "<!doctype html><html><head></head><body></body></html>"
  );
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.document;
  (globalThis as any).CSS = dom.window.CSS ?? { escape: (s: string) => s };
});

function makeContainer(html: string): HTMLElement {
  const div = dom.document.createElement("div");
  div.innerHTML = html;
  return div as unknown as HTMLElement;
}

describe("morph", () => {
  test("text update preserves the parent element", () => {
    const root = makeContainer("<p>hello</p>");
    const p = root.querySelector("p")!;
    morph(root, "<p>world</p>");
    expect(root.querySelector("p")!.textContent).toBe("world");
    expect(root.querySelector("p")).toBe(p);
  });

  test("attribute change updates without remount", () => {
    const root = makeContainer('<input id="a" type="text" />');
    const input = root.querySelector("input")!;
    morph(root, '<input id="a" type="text" placeholder="hi" />');
    expect(root.querySelector("input")).toBe(input);
    expect(input.getAttribute("placeholder")).toBe("hi");
  });

  test("removed attribute is dropped", () => {
    const root = makeContainer('<input id="a" disabled />');
    const input = root.querySelector("input")!;
    morph(root, '<input id="a" />');
    expect(input.hasAttribute("disabled")).toBe(false);
  });

  test("keyed insert (move) reuses existing node", () => {
    const root = makeContainer(
      '<ul><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>'
    );
    const ul = root.querySelector("ul")!;
    const liC = ul.querySelector("#c")!;
    // Apply morphChildren directly to UL so we morph children of the same
    // element (not innerHTML of an ancestor).
    const newRoot = makeContainer(
      '<ul><li id="c">C</li><li id="a">A</li><li id="b">B</li></ul>'
    );
    morphChildren(ul, newRoot.querySelector("ul")!);
    expect(ul.children[0]).toBe(liC);
    expect(ul.children[0].id).toBe("c");
    expect(ul.children[1].id).toBe("a");
    expect(ul.children[2].id).toBe("b");
  });

  test("keyed remove drops the right node", () => {
    const root = makeContainer(
      '<ul><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>'
    );
    const ul = root.querySelector("ul")!;
    const liA = ul.querySelector("#a")!;
    const liC = ul.querySelector("#c")!;
    const newRoot = makeContainer('<ul><li id="a">A</li><li id="c">C</li></ul>');
    morphChildren(ul, newRoot.querySelector("ul")!);
    expect(ul.children.length).toBe(2);
    expect(ul.children[0]).toBe(liA);
    expect(ul.children[1]).toBe(liC);
  });

  test("p-preserve halts descent — children survive untouched", () => {
    const root = makeContainer(
      '<div id="outer"><div p-preserve id="island"><span>keep me</span></div></div>'
    );
    const outer = root.querySelector("#outer")!;
    const island = root.querySelector("#island")!;
    const span = island.querySelector("span")!;
    morph(
      outer,
      '<div p-preserve id="island"><span>NEW CHILD</span></div>'
    );
    expect(root.querySelector("#island")).toBe(island);
    expect(island.querySelector("span")).toBe(span);
    expect(span.textContent).toBe("keep me");
  });

  test("input value DOES sync when not focused", () => {
    const root = makeContainer('<input id="a" type="text" value="old" />');
    const input = root.querySelector("input")! as HTMLInputElement;
    input.value = "old";
    if (typeof input.blur === "function") input.blur();
    morph(root, '<input id="a" type="text" value="new" />');
    expect(input.value).toBe("new");
  });

  test("checkbox `checked` attribute syncs by attribute presence", () => {
    const root = makeContainer('<input id="a" type="checkbox" />');
    const input = root.querySelector("input")! as HTMLInputElement;
    expect(input.hasAttribute("checked")).toBe(false);
    morph(root, '<input id="a" type="checkbox" checked />');
    expect(input.hasAttribute("checked")).toBe(true);
    morph(root, '<input id="a" type="checkbox" />');
    expect(input.hasAttribute("checked")).toBe(false);
  });

  test("renderTemplateError uses [p-error] slot when present", () => {
    const root = makeContainer(
      '<div p-template="k"><div p-error hidden></div><div class="content">x</div></div>'
    );
    const target = root.querySelector('[p-template]')!;
    renderTemplateError(target, "k", "kaboom");
    const slot = target.querySelector("[p-error]") as HTMLElement;
    expect(slot.textContent).toBe("kaboom");
    expect(slot.hasAttribute("hidden")).toBe(false);
  });

  test("renderTemplateError without slot falls back to inline element", () => {
    const root = makeContainer('<div p-template="k">hi</div>');
    const target = root.querySelector('[p-template]')!;
    renderTemplateError(target, "k", "nope");
    const err = target.querySelector("[p-error]") as HTMLElement;
    expect(err).not.toBeNull();
    expect(err.textContent).toBe("nope");
  });
});

describe("backoffDelay", () => {
  test("respects floor / jitter at low attempts", () => {
    const d0 = backoffDelay(0, { base: 100, cap: 1000 });
    expect(d0).toBeGreaterThanOrEqual(50);
    expect(d0).toBeLessThanOrEqual(200);
  });

  test("grows with attempt count", () => {
    const lo = backoffDelay(1, { base: 100, cap: 30000 });
    const hi = backoffDelay(5, { base: 100, cap: 30000 });
    expect(hi).toBeGreaterThan(lo);
  });

  test("respects cap at high attempts", () => {
    const samples = Array.from({ length: 20 }, () =>
      backoffDelay(100, { base: 250, cap: 5000 })
    );
    expect(Math.max(...samples)).toBeLessThanOrEqual(6500);
  });
});
