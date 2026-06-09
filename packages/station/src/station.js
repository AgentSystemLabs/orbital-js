// Station client.
//
// Wire protocol (v1):
//   Client → server frames:
//     { type: "template",    payload: <key> }            // subscribe + initial render
//     { type: "subscribe",   payload: <key> }            // subscribe only (already hydrated)
//     { type: "unsubscribe", payload: <key> }
//     { type: "navigate",    payload: { path, target, swap, push, navId } }
//     { type: "action",      payload: { key, data, messageId } }
//
//   Server → client frames:
//     { type: "welcome",        protocolVersion, instanceId, connectionId }
//     { type: "template",       key, html }
//     { type: "templateError",  key, error }
//     { type: "navigation",     path, target, template, html, push, navId }
//     { type: "actionResult",   messageId, ok, error? }
//     { type: "actionReply",    key, messageId, payload }
//     { type: "protocolError",  error }
//
// Connection state events are dispatched on `window` as `CustomEvent`s:
//     `station:state` with detail { state: 'connecting'|'open'|'reconnecting'|'closed' }
//     `station:welcome` with detail { protocolVersion, instanceId, connectionId, reconnected }
//     `station:actionResult` with detail { messageId, ok, error? }
//     `station:actionReply` with detail { key, messageId, payload }
//
// To opt out of auto-connect, set `window.stationAutoConnect = false` before this
// script loads. Then call `window.station.connect()` when ready.

(function () {
  const PROTOCOL_VERSION = 1;

  // Mutable state shared across reconnects.
  let currentWs = null;
  let latestNavId = 0;
  let messageCounter = 0;
  let reconnectAttempt = 0;
  let lastInstanceId = null;
  let manualClose = false;
  let pendingReconnectTimer = null;
  let state = "closed";
  const outboundQueue = [];
  const inflightResults = new Map();
  const reconnectListeners = new Set();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function setState(next) {
    if (state === next) return;
    state = next;
    try {
      window.dispatchEvent(
        new CustomEvent("station:state", { detail: { state: next } })
      );
    } catch (_) {}
  }

  function emitWelcome(detail) {
    try {
      window.dispatchEvent(new CustomEvent("station:welcome", { detail }));
    } catch (_) {}
  }

  function safeJsonParse(s) {
    try {
      return [JSON.parse(s), null];
    } catch (e) {
      return [null, e];
    }
  }

  function nowMs() {
    return Date.now();
  }

  function backoffDelay(attempt, opts) {
    const base = opts.base ?? 250;
    const cap = opts.cap ?? 30000;
    const exp = Math.min(cap, base * Math.pow(2, attempt));
    const jitter = exp * 0.25;
    return Math.max(50, exp - jitter + Math.random() * jitter * 2);
  }

  function sendFrame(frame) {
    const json = JSON.stringify(frame);
    if (currentWs && currentWs.readyState === 1) {
      try {
        currentWs.send(json);
        return true;
      } catch (_) {
        outboundQueue.push(json);
        return false;
      }
    }
    outboundQueue.push(json);
    return false;
  }

  function flushOutbound() {
    if (!currentWs || currentWs.readyState !== 1) return;
    while (outboundQueue.length) {
      const next = outboundQueue.shift();
      try {
        currentWs.send(next);
      } catch (e) {
        // Re-queue and abort the flush; we'll retry on next open.
        outboundQueue.unshift(next);
        return;
      }
    }
  }

  function cssAttrEscape(s) {
    return String(s).replace(/(["\\])/g, "\\$1");
  }

  // Match a route pattern (which may contain :param segments) against the
  // current request path. Returns an object of extracted params on match, or
  // null on miss. Mirrors the server's matchRoutePath so client and server
  // agree on which routes resolve.
  function matchRoutePath(routePath, requestPath) {
    var rp = routePath.split("/").filter(Boolean);
    var rq = requestPath.split("/").filter(Boolean);
    if (rp.length !== rq.length) return null;
    var params = {};
    for (var i = 0; i < rp.length; i++) {
      var seg = rp[i];
      var got = rq[i];
      if (seg.charAt(0) === ":") {
        try {
          params[seg.slice(1)] = decodeURIComponent(got);
        } catch (e) {
          params[seg.slice(1)] = got;
        }
      } else if (seg !== got) {
        return null;
      }
    }
    return params;
  }

  // -------------------------------------------------------------------------
  // Click + submit delegation (document-level so morphed nodes work for free)
  // -------------------------------------------------------------------------

  document.addEventListener("click", function onHrefClick(event) {
    const element = event.target.closest("[p-href]");
    if (!element) return;
    event.preventDefault();
    const navId = ++latestNavId;
    sendFrame({
      type: "navigate",
      payload: {
        path: element.getAttribute("p-href"),
        target: element.getAttribute("p-target"),
        swap: element.getAttribute("p-swap"),
        push: true,
        navId,
      },
    });
  });

  document.addEventListener("submit", function onActionSubmit(event) {
    const form = event.target.closest("[p-action]");
    if (!form) return;
    event.preventDefault();
    const key = form.getAttribute("p-action");
    const formData = new FormData(form);
    const data = Object.fromEntries(formData);
    const submitter = form.querySelector("button[type=submit], button:not([type])");
    const messageId = ++messageCounter;
    if (submitter && !submitter.disabled) {
      submitter.disabled = true;
      submitter.setAttribute("data-p-busy", "true");
      inflightResults.set(messageId, () => {
        submitter.disabled = false;
        submitter.removeAttribute("data-p-busy");
      });
    }
    form.reset();
    sendFrame({ type: "action", payload: { key, data, messageId } });
  });

  // History navigation lives outside connect() so it isn't rebound on every
  // reconnect. We dispatch into the same outbound path; the queue handles
  // disconnects.
  window.addEventListener("popstate", (event) => {
    if (!event.state) return;
    const navId = ++latestNavId;
    sendFrame({
      type: "navigate",
      payload: {
        path: location.pathname,
        target: event.state.target,
        swap: event.state.template,
        push: false,
        navId,
      },
    });
  });

  // -------------------------------------------------------------------------
  // Morph: minimal id-keyed DOM diff.
  // -------------------------------------------------------------------------

  function isSameNode(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    if (a.tagName !== b.tagName) return false;
    const aId = a.id;
    const bId = b.id;
    if (aId || bId) return aId === bId;
    return true;
  }

  function findById(start, id) {
    for (let n = start; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.id === id) return n;
    }
    return null;
  }

  function morphChildren(oldParent, newParent) {
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

  function morphAttrs(oldEl, newEl) {
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

  function morphFormState(oldEl, newEl) {
    const focused = document.activeElement === oldEl;
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

  function morphNode(oldNode, newNode) {
    if (oldNode.nodeType === 3 || oldNode.nodeType === 8) {
      if (oldNode.nodeValue !== newNode.nodeValue) {
        oldNode.nodeValue = newNode.nodeValue;
      }
      return;
    }
    if (oldNode.nodeType !== 1) return;

    morphAttrs(oldNode, newNode);
    morphFormState(oldNode, newNode);

    if (oldNode.hasAttribute("p-preserve")) return;

    morphChildren(oldNode, newNode);
  }

  function morph(target, html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;

    const active = document.activeElement;
    const activeInside =
      active && active !== document.body && target.contains(active);

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
      if (document.contains(active)) {
        next = active;
      } else if (savedId) {
        const escaped = window.CSS && CSS.escape ? CSS.escape(savedId) : savedId;
        next = target.querySelector("#" + escaped);
      }
      if (next && document.activeElement !== next) {
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

  function renderTemplateError(target, key, message) {
    // Look for an opt-in slot — first descendant with `[p-error]` — otherwise
    // morph the whole target to a small inline error.
    const slot = target.querySelector("[p-error]");
    const safe = String(message ?? "").replace(/[<>&]/g, (c) =>
      c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
    );
    if (slot) {
      slot.textContent = safe;
      slot.removeAttribute("hidden");
      return;
    }
    target.innerHTML = `<div p-error data-template="${cssAttrEscape(key)}">${safe}</div>`;
  }

  // -------------------------------------------------------------------------
  // WS lifecycle + registration
  // -------------------------------------------------------------------------

  function makeRegistry(ws) {
    const subscribed = new WeakSet();
    const loaded = new WeakSet();

    function register(parent = document) {
      registerTemplates(parent);
      registerLoad(parent);
    }

    function registerLoad(parent) {
      const elements = parent.querySelectorAll("[p-load]");
      elements.forEach((element) => {
        if (loaded.has(element)) return;
        loaded.add(element);
        const key = element.getAttribute("p-load");
        // Forward any data-* attributes as the action payload so a p-load can pass
        // context the handler needs (e.g. data-node / data-cluster). No data-*
        // attributes → data:null (unchanged for existing on-mount effects).
        const data = { ...element.dataset };
        sendFrame({
          type: "action",
          payload: { key, data: Object.keys(data).length ? data : null },
        });
      });
    }

    function registerTemplates(parent) {
      const path = window.location.pathname;
      const elements = parent.querySelectorAll("[p-template]");
      elements.forEach((element) => {
        if (subscribed.has(element)) return;

        let key = element.getAttribute("p-template");
        const id = element.getAttribute("id");

        const routes = window.stationRoutes || [];
        for (const route of routes) {
          if (id !== route.target) continue;
          if (matchRoutePath(route.path, path) == null) continue;
          key = route.template;
          element.setAttribute("p-template", key);
          history.replaceState({ template: key, target: route.target }, "");
          break;
        }

        subscribed.add(element);

        const hydrated = element.hasAttribute("data-p-hydrated");
        if (hydrated) {
          sendFrame({ type: "subscribe", payload: key });
        } else {
          sendFrame({ type: "template", payload: key });
        }
      });
    }

    return { register, subscribed };
  }

  function connect(opts) {
    opts = opts || {};
    var baseUrl = opts.url || "/ws";
    // Forward the current page pathname so the server knows which :param
    // route this socket is viewing. The WS upgrade request's own URL is
    // always /ws, which can't be matched against app routes.
    var sep = baseUrl.indexOf("?") >= 0 ? "&" : "?";
    var url =
      baseUrl + sep + "path=" + encodeURIComponent(window.location.pathname);
    const backoffOpts = {
      base: opts.backoffBaseMs ?? 250,
      cap: opts.backoffCapMs ?? 30000,
    };
    const maxRetries = opts.maxRetries ?? Infinity;

    manualClose = false;
    setState(reconnectAttempt > 0 ? "reconnecting" : "connecting");

    let ws;
    try {
      ws = currentWs = new WebSocket(url);
    } catch (err) {
      // Synchronous failure (e.g. invalid URL) — schedule retry.
      scheduleReconnect(opts);
      return;
    }

    const { register, subscribed } = makeRegistry(ws);

    ws.onopen = () => {
      reconnectAttempt = 0;
      setState("open");
      flushOutbound();
      register();
    };

    ws.onmessage = (event) => {
      let data;
      const [parsed, err] = safeJsonParse(event.data);
      if (err) {
        try {
          window.dispatchEvent(
            new CustomEvent("station:protocolError", {
              detail: { error: "bad json from server" },
            })
          );
        } catch (_) {}
        return;
      }
      data = parsed;

      try {
        if (!data || typeof data.type !== "string") return;

        if (data.type === "welcome") {
          const reconnected = lastInstanceId && lastInstanceId !== data.instanceId;
          lastInstanceId = data.instanceId;
          emitWelcome({
            protocolVersion: data.protocolVersion,
            instanceId: data.instanceId,
            connectionId: data.connectionId,
            reconnected: !!reconnected,
          });
          if (data.protocolVersion !== PROTOCOL_VERSION) {
            console.warn(
              "station: protocol version mismatch — client",
              PROTOCOL_VERSION,
              "server",
              data.protocolVersion
            );
          }
          // Notify reconnect listeners so user code can refetch/resync state.
          if (reconnected) {
            reconnectListeners.forEach((fn) => {
              try {
                fn({ instanceId: data.instanceId, connectionId: data.connectionId });
              } catch (_) {}
            });
          }
          return;
        }

        if (data.type === "navigation") {
          if (typeof data.navId === "number" && data.navId !== latestNavId) return;
          const targetEl = document.getElementById(data.target);
          if (!targetEl) return;
          if (data.push) {
            history.pushState(
              { template: data.template, target: data.target },
              "",
              data.path
            );
          }
          const tpl = document.createElement("template");
          tpl.innerHTML = data.html;
          targetEl.replaceChildren(tpl.content);
          if (
            typeof data.template === "string" &&
            targetEl.hasAttribute("p-template")
          ) {
            targetEl.setAttribute("p-template", data.template);
            subscribed.delete(targetEl);
            subscribed.add(targetEl);
            sendFrame({ type: "subscribe", payload: data.template });
          }
          register(targetEl);
          return;
        }

        if (data.type === "template") {
          const selector = '[p-template="' + cssAttrEscape(data.key) + '"]';
          const elements = document.querySelectorAll(selector);
          elements.forEach((element) => {
            try {
              morph(element, data.html);
              register(element);
            } catch (err) {
              console.error("station: morph failed", err);
            }
          });
          return;
        }

        if (data.type === "templateError") {
          const selector = '[p-template="' + cssAttrEscape(data.key) + '"]';
          const elements = document.querySelectorAll(selector);
          elements.forEach((el) => renderTemplateError(el, data.key, data.error));
          return;
        }

        if (data.type === "actionResult") {
          const cleanup = inflightResults.get(data.messageId);
          if (cleanup) {
            try {
              cleanup();
            } catch (_) {}
            inflightResults.delete(data.messageId);
          }
          try {
            window.dispatchEvent(
              new CustomEvent("station:actionResult", { detail: data })
            );
          } catch (_) {}
          return;
        }

        if (data.type === "actionReply") {
          try {
            window.dispatchEvent(
              new CustomEvent("station:actionReply", { detail: data })
            );
          } catch (_) {}
          return;
        }

        if (data.type === "protocolError") {
          console.warn("station: server protocol error:", data.error);
          try {
            window.dispatchEvent(
              new CustomEvent("station:protocolError", { detail: data })
            );
          } catch (_) {}
          return;
        }
      } catch (err) {
        console.error("station: failed to handle frame", err, data);
      }
    };

    ws.onerror = () => {
      // onclose will follow; nothing to do here besides log.
    };

    ws.onclose = () => {
      if (manualClose) {
        setState("closed");
        return;
      }
      currentWs = null;
      // Mark inflight submits as released so the UI doesn't sit forever on a
      // disabled state when the server vanishes mid-flight.
      inflightResults.forEach((cleanup) => {
        try {
          cleanup();
        } catch (_) {}
      });
      inflightResults.clear();

      if (reconnectAttempt >= maxRetries) {
        setState("closed");
        return;
      }
      scheduleReconnect(opts);
    };
  }

  function scheduleReconnect(opts) {
    setState("reconnecting");
    const delay = backoffDelay(reconnectAttempt++, {
      base: opts.backoffBaseMs ?? 250,
      cap: opts.backoffCapMs ?? 30000,
    });
    if (pendingReconnectTimer) clearTimeout(pendingReconnectTimer);
    pendingReconnectTimer = setTimeout(() => {
      pendingReconnectTimer = null;
      connect(opts);
    }, delay);
  }

  function disconnect() {
    manualClose = true;
    if (pendingReconnectTimer) {
      clearTimeout(pendingReconnectTimer);
      pendingReconnectTimer = null;
    }
    if (currentWs) {
      try {
        currentWs.close();
      } catch (_) {}
      currentWs = null;
    }
    setState("closed");
  }

  // Public API attached to window.
  window.station = {
    connect,
    disconnect,
    send: (frame) => sendFrame(frame),
    onReconnect: (fn) => {
      reconnectListeners.add(fn);
      return () => reconnectListeners.delete(fn);
    },
    state: () => state,
    get connection() {
      return currentWs;
    },
    // Internals exposed for tests. Not part of the public API — do not rely
    // on these from app code.
    __internals: {
      morph,
      morphChildren,
      morphNode,
      morphAttrs,
      morphFormState,
      renderTemplateError,
      backoffDelay,
      safeJsonParse,
    },
  };

  // Auto-connect at module load, unless the user opted out.
  if (window.stationAutoConnect !== false) {
    connect();
  }
})();
