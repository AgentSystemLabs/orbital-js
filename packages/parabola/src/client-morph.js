// Minimal id-keyed DOM morph. Replaces innerHTML so that focus, scroll
// position, selection, input state, and CSS transitions survive an update.
//
// This file is plain ES module JS. It depends only on the document/CSS
// globals at call time — never at module load — so it is unit-testable with
// happy-dom or any other DOM polyfill.

export function isSameNode(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  if (a.tagName !== b.tagName) return false;
  const aId = a.id;
  const bId = b.id;
  if (aId || bId) return aId === bId;
  return true;
}

export function findById(start, id) {
  for (let n = start; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.id === id) return n;
  }
  return null;
}

export function morphChildren(oldParent, newParent) {
  let oldChild = oldParent.firstChild;
  let newChild = newParent.firstChild;

  while (newChild) {
    const nextNew = newChild.nextSibling;

    if (!oldChild) {
      oldParent.appendChild(newChild);
      newChild = nextNew;
      continue;
    }

    if (isSameNode(oldChild, newChild)) {
      morphNode(oldChild, newChild);
      oldChild = oldChild.nextSibling;
      newChild = nextNew;
      continue;
    }

    if (newChild.nodeType === 1 && newChild.id) {
      const match = findById(oldChild.nextSibling, newChild.id);
      if (match) {
        oldParent.insertBefore(match, oldChild);
        morphNode(match, newChild);
        newChild = nextNew;
        continue;
      }
    }

    if (oldChild.nodeType === 1 && oldChild.id) {
      let appearsLater = false;
      for (let cand = nextNew; cand; cand = cand.nextSibling) {
        if (cand.nodeType === 1 && cand.id === oldChild.id) {
          appearsLater = true;
          break;
        }
      }
      if (appearsLater) {
        oldParent.insertBefore(newChild, oldChild);
        newChild = nextNew;
        continue;
      }
    }

    const toRemove = oldChild;
    oldChild = oldChild.nextSibling;
    oldParent.replaceChild(newChild, toRemove);
    newChild = nextNew;
  }

  while (oldChild) {
    const next = oldChild.nextSibling;
    oldParent.removeChild(oldChild);
    oldChild = next;
  }
}

export function morphAttrs(oldEl, newEl) {
  const newAttrs = newEl.attributes;
  for (let i = 0; i < newAttrs.length; i++) {
    const { name, value } = newAttrs[i];
    if (oldEl.getAttribute(name) !== value) oldEl.setAttribute(name, value);
  }
  const oldAttrs = oldEl.attributes;
  for (let i = oldAttrs.length - 1; i >= 0; i--) {
    const name = oldAttrs[i].name;
    if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
  }
}

export function morphFormState(oldEl, newEl) {
  const focused =
    typeof document !== "undefined" && document.activeElement === oldEl;
  const tag = oldEl.tagName;

  if (tag === "INPUT") {
    const type = (oldEl.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      const wantChecked = newEl.hasAttribute("checked");
      if (!focused && oldEl.checked !== wantChecked) oldEl.checked = wantChecked;
      return;
    }
    if (!focused && newEl.hasAttribute("value")) {
      const wantValue = newEl.getAttribute("value") ?? "";
      if (oldEl.value !== wantValue) oldEl.value = wantValue;
    }
    return;
  }

  if (tag === "TEXTAREA") {
    if (!focused) {
      const wantValue = newEl.textContent ?? "";
      if (oldEl.value !== wantValue) oldEl.value = wantValue;
    }
    return;
  }

  if (tag === "OPTION") {
    const wantSelected = newEl.hasAttribute("selected");
    if (oldEl.selected !== wantSelected) oldEl.selected = wantSelected;
  }
}

export function morphNode(oldNode, newNode) {
  if (oldNode.nodeType === 3 || oldNode.nodeType === 8) {
    if (oldNode.nodeValue !== newNode.nodeValue) {
      oldNode.nodeValue = newNode.nodeValue;
    }
    return;
  }
  if (oldNode.nodeType !== 1) return;

  morphAttrs(oldNode, newNode);
  morphFormState(oldNode, newNode);

  if (oldNode.hasAttribute && oldNode.hasAttribute("p-preserve")) return;

  morphChildren(oldNode, newNode);
}

export function morph(target, html) {
  const doc = target.ownerDocument || (typeof document !== "undefined" ? document : null);
  const tpl = doc ? doc.createElement("template") : { content: null, innerHTML: "" };
  tpl.innerHTML = html;

  const active = doc ? doc.activeElement : null;
  const activeInside =
    active && active !== (doc?.body) && target.contains(active);

  let savedId = null;
  let savedSel = null;
  let savedScrollTop = 0;
  let savedScrollLeft = 0;

  if (activeInside) {
    savedId = active.id || null;
    savedScrollTop = active.scrollTop;
    savedScrollLeft = active.scrollLeft;
    if (
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
      typeof active.selectionStart === "number"
    ) {
      try {
        savedSel = {
          start: active.selectionStart,
          end: active.selectionEnd,
          dir: active.selectionDirection,
        };
      } catch (_) {}
    }
  }

  morphChildren(target, tpl.content);

  if (activeInside) {
    let next = null;
    if (doc && doc.contains && doc.contains(active)) {
      next = active;
    } else if (savedId) {
      const escaped =
        typeof window !== "undefined" && window.CSS && window.CSS.escape
          ? window.CSS.escape(savedId)
          : savedId;
      next = target.querySelector("#" + escaped);
    }
    if (next && doc && doc.activeElement !== next) {
      try {
        next.focus({ preventScroll: true });
      } catch (_) {
        next.focus();
      }
      if (savedSel && typeof next.setSelectionRange === "function") {
        try {
          next.setSelectionRange(savedSel.start, savedSel.end, savedSel.dir);
        } catch (_) {}
      }
      next.scrollTop = savedScrollTop;
      next.scrollLeft = savedScrollLeft;
    }
  }
}

export function renderTemplateError(target, key, message) {
  const slot = target.querySelector("[p-error]");
  const safe = String(message ?? "").replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
  );
  const cssAttrEscape = (s) => String(s).replace(/(["\\])/g, "\\$1");
  if (slot) {
    slot.textContent = safe;
    slot.removeAttribute("hidden");
    return;
  }
  target.innerHTML = `<div p-error data-template="${cssAttrEscape(key)}">${safe}</div>`;
}

export function backoffDelay(attempt, opts = {}) {
  const base = opts.base ?? 250;
  const cap = opts.cap ?? 30000;
  const exp = Math.min(cap, base * Math.pow(2, attempt));
  const jitter = exp * 0.25;
  return Math.max(50, exp - jitter + Math.random() * jitter * 2);
}

export function safeJsonParse(s) {
  try {
    return [JSON.parse(s), null];
  } catch (e) {
    return [null, e];
  }
}
