/* Shakshak shortages system v14.1.0 — built 2026-10-31T15:09:37.264Z — see README.md. Frontend guard only; not server-side enforcement. */
"use strict";
(() => {
  // src/config/category.ts
  var SHORTAGE_CATEGORY = Object.freeze({
    id: "269c7f1b-74ca-4e20-be9a-788e3e41444f",
    slug: "shortage-medicines",
    label: "\u0623\u062F\u0648\u064A\u0629 \u0627\u0644\u0646\u0648\u0627\u0642\u0635"
  });
  var MAX_UNITS_PER_SHORTAGE_PRODUCT = 1;

  // src/config/settings.ts
  var DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    debug: false,
    categoryId: SHORTAGE_CATEGORY.id,
    apiBase: "https://api.easy-orders.net/api/v1",
    themeKey: "sphinx",
    // 20 is the page size verified against the live API; pagination covers larger categories.
    catalogPageSize: 20,
    catalogMaxPages: 100,
    catalogTtlMs: 5 * 60 * 1e3,
    cartFreshMs: 15 * 1e3,
    addSettleTimeoutMs: 6e3,
    failClosedOnShortageAdd: true,
    autoCorrectOverLimit: false,
    cleanupLegacyStorage: true,
    refuseIfLegacyPresent: true,
    requireAdditionalProduct: true
  });
  var OVERRIDABLE = [
    "enabled",
    "debug",
    "catalogTtlMs",
    "cartFreshMs",
    "addSettleTimeoutMs",
    "failClosedOnShortageAdd",
    "autoCorrectOverLimit",
    "cleanupLegacyStorage",
    "refuseIfLegacyPresent",
    "requireAdditionalProduct"
  ];
  var KILL_SWITCH_PARAM = "shk_shortages";
  var DEBUG_STORAGE_KEY = "shakshak-shortages:debug";
  function resolveSettings(win) {
    const out = { ...DEFAULT_SETTINGS };
    const raw = win.SHAKSHAK_SHORTAGES_CONFIG;
    if (raw && typeof raw === "object") {
      for (const key of OVERRIDABLE) {
        const value = raw[key];
        if (value === void 0) continue;
        if (typeof value === typeof out[key]) out[key] = value;
      }
    }
    try {
      const flag = new URL(win.location.href).searchParams.get(KILL_SWITCH_PARAM);
      if (flag === "off") out.enabled = false;
      if (flag === "debug") out.debug = true;
    } catch {
    }
    try {
      if (win.localStorage.getItem(DEBUG_STORAGE_KEY) === "1") out.debug = true;
    } catch {
    }
    return out;
  }

  // src/diagnostics/debug-logger.ts
  var PREFIX = "[shakshak-shortages]";
  function createLogger(enabled, sink = console) {
    return {
      enabled,
      debug(msg, data) {
        if (enabled) sink.info(PREFIX, msg, data != null ? data : "");
      },
      // Warnings are always emitted (no personal data) so a broken install is visible in DevTools.
      warn(msg, data) {
        sink.warn(PREFIX, msg, data != null ? data : "");
      }
    };
  }

  // src/cart/cart-identity.ts
  var GUEST_ID_STORAGE_KEY = "guest-id";
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function readGuestId(storage) {
    var _a;
    if (!storage) return null;
    try {
      const raw = storage.getItem(GUEST_ID_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const id = (_a = parsed == null ? void 0 : parsed.state) == null ? void 0 : _a.guestId;
      return typeof id === "string" && UUID_RE.test(id) ? id : null;
    } catch {
      return null;
    }
  }
  function isUuid(value) {
    return typeof value === "string" && UUID_RE.test(value);
  }
  function slugFromHref(href, base) {
    if (!href) return null;
    try {
      const url = new URL(href, base);
      if (url.origin !== new URL(base).origin) return null;
      const m = url.pathname.match(/^\/products\/([^/?#]+)\/?$/i);
      return m ? decodeURIComponent(m[1]).toLowerCase() : null;
    } catch {
      return null;
    }
  }
  function normalizeName(value) {
    return String(value != null ? value : "").normalize("NFKC").replace(/[ً-ٰٟـ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // src/catalog/shortage-products.ts
  var CatalogError = class extends Error {
  };
  function buildCatalogUrl(settings, page) {
    const q = new URLSearchParams({
      limit: String(settings.catalogPageSize),
      page: String(page),
      sort: "position,desc",
      fields: "id,name,slug",
      category_id: settings.categoryId,
      theme_key: settings.themeKey
    });
    return `${settings.apiBase}/products?${q.toString()}`;
  }
  async function fetchShortageCatalog(fetchFn, settings, now = Date.now) {
    var _a;
    const ids = /* @__PURE__ */ new Set();
    const slugToId = /* @__PURE__ */ new Map();
    const nameToId = /* @__PURE__ */ new Map();
    const ambiguous = /* @__PURE__ */ new Set();
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      if (page > settings.catalogMaxPages) throw new CatalogError(`catalog exceeds ${settings.catalogMaxPages} pages`);
      const res = await fetchFn(buildCatalogUrl(settings, page), {
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (!res.ok) throw new CatalogError(`catalog HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body == null ? void 0 : body.data)) throw new CatalogError("catalog response has no data[]");
      for (const item of body.data) {
        if (!isUuid(item == null ? void 0 : item.id)) continue;
        const id = item.id;
        ids.add(id);
        if (typeof item.slug === "string" && item.slug.trim()) slugToId.set(item.slug.trim().toLowerCase(), id);
        if (typeof item.name === "string") {
          const n = normalizeName(item.name);
          if (!n) continue;
          const prev = nameToId.get(n);
          if (prev && prev !== id) ambiguous.add(n);
          else nameToId.set(n, id);
        }
      }
      const tp = Number((_a = body.totalPages) != null ? _a : 1);
      if (!Number.isInteger(tp) || tp < 1) throw new CatalogError("catalog totalPages invalid");
      totalPages = tp;
    }
    for (const n of ambiguous) nameToId.delete(n);
    return { ids, slugToId, nameToId, fetchedAt: now() };
  }

  // src/catalog/catalog-cache.ts
  var CATALOG_CACHE_KEY = "shakshak-shortages:v14:catalog";
  var CatalogService = class {
    constructor(fetchFn, settings, logger, session, now = Date.now) {
      this.fetchFn = fetchFn;
      this.settings = settings;
      this.logger = logger;
      this.session = session;
      this.now = now;
      this.snapshot = null;
      this.inFlight = null;
      this.lastAttempt = 0;
      this.snapshot = this.restore();
    }
    current() {
      return this.snapshot;
    }
    /** Returns a snapshot, refreshing if older than the TTL. Never throws. */
    ready(force = false) {
      const fresh = this.snapshot && this.now() - this.snapshot.fetchedAt < this.settings.catalogTtlMs;
      if (fresh && !force) return Promise.resolve(this.snapshot);
      if (this.inFlight) return this.inFlight;
      if (!force && this.lastAttempt && this.now() - this.lastAttempt < 1e4) return Promise.resolve(this.snapshot);
      this.lastAttempt = this.now();
      this.inFlight = fetchShortageCatalog(this.fetchFn, this.settings, this.now).then((snap) => {
        this.snapshot = snap;
        this.persist(snap);
        this.logger.debug("catalog loaded", { products: snap.ids.size });
        return snap;
      }).catch((err) => {
        this.logger.warn("catalog unavailable \u2014 keeping previous snapshot", String(err));
        return this.snapshot;
      }).finally(() => {
        this.inFlight = null;
      });
      return this.inFlight;
    }
    persist(snap) {
      if (!this.session) return;
      const data = {
        ids: [...snap.ids],
        slugs: [...snap.slugToId],
        names: [...snap.nameToId],
        fetchedAt: snap.fetchedAt
      };
      try {
        this.session.setItem(CATALOG_CACHE_KEY, JSON.stringify(data));
      } catch {
      }
    }
    restore() {
      if (!this.session) return null;
      try {
        const raw = this.session.getItem(CATALOG_CACHE_KEY);
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (!Array.isArray(d.ids) || !Array.isArray(d.slugs) || !Array.isArray(d.names)) return null;
        return {
          ids: new Set(d.ids.filter((x) => typeof x === "string")),
          slugToId: new Map(d.slugs),
          nameToId: new Map(d.names),
          fetchedAt: 0
        };
      } catch {
        return null;
      }
    }
  };

  // src/cart/cart-reader.ts
  var CartReadError = class extends Error {
  };
  var CART_PAGE_LIMIT = 100;
  function buildCartUrl(settings, guestId) {
    const q = new URLSearchParams({
      guest_id: guestId,
      limit: String(CART_PAGE_LIMIT),
      join: "product.variants.variationProps"
    });
    return `${settings.apiBase}/cart-items/guest?${q.toString()}`;
  }
  function parseCartItems(body) {
    var _a, _b;
    if (!Array.isArray(body)) throw new CartReadError("cart response is not an array");
    const lines = [];
    for (const raw of body) {
      if ((raw == null ? void 0 : raw.in_cart) === false) continue;
      if (!isUuid(raw == null ? void 0 : raw.id) || !isUuid(raw == null ? void 0 : raw.product_id)) throw new CartReadError("cart line without valid ids");
      const qty = Number(raw.quantity);
      if (!Number.isInteger(qty) || qty < 0) throw new CartReadError("cart line with invalid quantity");
      if (qty === 0) continue;
      lines.push({
        itemId: raw.id,
        productId: raw.product_id,
        variantId: isUuid(raw.variant_id) ? raw.variant_id : null,
        quantity: qty,
        slug: typeof ((_a = raw.product) == null ? void 0 : _a.slug) === "string" ? raw.product.slug.toLowerCase() : null,
        normalizedName: typeof ((_b = raw.product) == null ? void 0 : _b.name) === "string" ? normalizeName(raw.product.name) : ""
      });
    }
    return lines;
  }
  async function readCart(fetchFn, settings, guestId) {
    const res = await fetchFn(buildCartUrl(settings, guestId), {
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!res.ok) throw new CartReadError(`cart HTTP ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body) && body.length >= CART_PAGE_LIMIT) throw new CartReadError("cart may be truncated (>= page limit)");
    return parseCartItems(body);
  }

  // src/cart/cart-adapter.ts
  var CartStore = class {
    constructor(fetchFn, settings, logger, local, now = Date.now) {
      this.fetchFn = fetchFn;
      this.settings = settings;
      this.logger = logger;
      this.local = local;
      this.now = now;
      this.state = { status: "unknown", lines: [], readAt: 0 };
      this.listeners = /* @__PURE__ */ new Set();
      this.inFlight = null;
      this.seq = 0;
      this.appliedSeq = 0;
    }
    get() {
      return this.state;
    }
    isFresh() {
      return this.state.status === "ok" && this.now() - this.state.readAt < this.settings.cartFreshMs;
    }
    quantityOf(productId) {
      return this.state.lines.filter((l) => l.productId === productId).reduce((sum, l) => sum + l.quantity, 0);
    }
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    /**
     * Re-read the server cart. When a read is already running and `force` is set, a new read is queued
     * after it so the result reflects mutations that completed after the first read started.
     */
    refresh(force = false) {
      var _a;
      if (this.inFlight && !force) return this.inFlight;
      const prev = (_a = this.inFlight) != null ? _a : Promise.resolve(this.state);
      const run = prev.then(() => this.readOnce());
      this.inFlight = run.finally(() => {
        if (this.inFlight === tracked) this.inFlight = null;
      });
      const tracked = this.inFlight;
      return tracked;
    }
    async readOnce() {
      const mySeq = ++this.seq;
      const startedAt = this.now();
      const guestId = readGuestId(this.local);
      let next;
      if (!guestId) {
        next = { status: "ok", lines: [], readAt: startedAt };
      } else {
        try {
          next = { status: "ok", lines: await readCart(this.fetchFn, this.settings, guestId), readAt: startedAt };
        } catch (err) {
          this.logger.warn("cart read failed", String(err));
          next = { status: "error", lines: this.state.lines, readAt: this.state.readAt };
        }
      }
      if (mySeq > this.appliedSeq) {
        this.appliedSeq = mySeq;
        this.state = next;
        this.logger.debug("cart", {
          status: next.status,
          lines: next.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.quantity }))
        });
        for (const l of [...this.listeners]) {
          try {
            l(next);
          } catch {
          }
        }
      }
      return this.state;
    }
    /**
     * Set an absolute quantity on one cart line — same request the storefront's own "−"/remove buttons send
     * (PATCH {api}/cart-items/{itemId} {"quantity":n}, observed 2026-10-30). Only used when
     * settings.autoCorrectOverLimit is true.
     */
    async setQuantity(itemId, quantity) {
      try {
        const res = await this.fetchFn(`${this.settings.apiBase}/cart-items/${encodeURIComponent(itemId)}`, {
          method: "PATCH",
          credentials: "omit",
          mode: "cors",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ quantity })
        });
        return res.ok;
      } catch {
        return false;
      }
    }
  };

  // src/cart/cart-events.ts
  var MUTATION_URL = /\/api\/v1\/cart-items\/(?:guest|[0-9a-f-]{36})\/?$/i;
  function isCartMutationUrl(url) {
    try {
      const u = new URL(url);
      return u.search === "" && MUTATION_URL.test(u.pathname);
    } catch {
      return false;
    }
  }
  var CartActivityMonitor = class {
    constructor(win) {
      this.win = win;
      this.listeners = /* @__PURE__ */ new Set();
      this.observer = null;
    }
    /** Returns false when Resource Timing isn't available (callers then fall back to timed re-reads). */
    start() {
      const PO = this.win.PerformanceObserver;
      if (!PO || this.observer) return !!this.observer;
      try {
        this.observer = new PO((list) => {
          if (list.getEntries().some((e) => isCartMutationUrl(e.name))) this.emit();
        });
        this.observer.observe({ type: "resource", buffered: false });
        return true;
      } catch {
        this.observer = null;
        return false;
      }
    }
    stop() {
      var _a;
      (_a = this.observer) == null ? void 0 : _a.disconnect();
      this.observer = null;
      this.listeners.clear();
    }
    on(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    /** Resolves true on the next mutation, false on timeout. */
    next(timeoutMs) {
      return new Promise((resolve) => {
        const off = this.on(() => {
          clearTimeout(timer);
          off();
          resolve(true);
        });
        const timer = setTimeout(() => {
          off();
          resolve(false);
        }, timeoutMs);
      });
    }
    emit() {
      for (const l of [...this.listeners]) {
        try {
          l();
        } catch {
        }
      }
    }
  };

  // src/sync/cross-tab-sync.ts
  var LOCK_PREFIX = "shakshak-shortages:add:";
  var CHANNEL = "shakshak-shortages";
  var LOCK_TIMEOUT_MS = 15e3;
  var ProductLock = class {
    constructor(locks) {
      this.locks = locks;
      this.local = /* @__PURE__ */ new Map();
    }
    get crossTab() {
      return !!this.locks;
    }
    run(productId, fn) {
      var _a;
      const name = LOCK_PREFIX + productId;
      if (this.locks) {
        const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(LOCK_TIMEOUT_MS) : void 0;
        return this.locks.request(name, { mode: "exclusive", signal }, fn);
      }
      const prev = (_a = this.local.get(name)) != null ? _a : Promise.resolve();
      const next = prev.catch(() => void 0).then(fn);
      this.local.set(name, next);
      void next.finally(() => {
        if (this.local.get(name) === next) this.local.delete(name);
      }).catch(() => void 0);
      return next;
    }
  };
  function lockManagerFrom(nav) {
    const locks = nav == null ? void 0 : nav.locks;
    return locks && typeof locks.request === "function" ? locks : null;
  }
  var CartBroadcast = class {
    constructor(win, onRemoteChange) {
      this.channel = null;
      const BC = win.BroadcastChannel;
      if (!BC) return;
      try {
        this.channel = new BC(CHANNEL);
        this.channel.onmessage = (ev) => {
          if (ev.data === "cart-changed") onRemoteChange();
        };
      } catch {
        this.channel = null;
      }
    }
    notify() {
      var _a;
      try {
        (_a = this.channel) == null ? void 0 : _a.postMessage("cart-changed");
      } catch {
      }
    }
    close() {
      var _a;
      (_a = this.channel) == null ? void 0 : _a.close();
      this.channel = null;
    }
  };

  // src/ui/notifications.ts
  var MESSAGES = Object.freeze({
    alreadyInCart: "\u0647\u0630\u0627 \u0627\u0644\u062F\u0648\u0627\u0621 \u0645\u0648\u062C\u0648\u062F \u0628\u0627\u0644\u0641\u0639\u0644 \u0641\u064A \u0633\u0644\u062A\u0643. \u0627\u0644\u062D\u062F \u0627\u0644\u0645\u0633\u0645\u0648\u062D \u0639\u0644\u0628\u0629 \u0648\u0627\u062D\u062F\u0629 \u0641\u0642\u0637 \u0645\u0646 \u0643\u0644 \u0635\u0646\u0641 \u0645\u0646 \u0623\u062F\u0648\u064A\u0629 \u0627\u0644\u0646\u0648\u0627\u0642\u0635.",
    maxOne: "\u0627\u0644\u062D\u062F \u0627\u0644\u0645\u0633\u0645\u0648\u062D \u0639\u0644\u0628\u0629 \u0648\u0627\u062D\u062F\u0629 \u0641\u0642\u0637 \u0645\u0646 \u0643\u0644 \u0635\u0646\u0641 \u0645\u0646 \u0623\u062F\u0648\u064A\u0629 \u0627\u0644\u0646\u0648\u0627\u0642\u0635.",
    verifyFailed: "\u062A\u0639\u0630\u0651\u0631 \u0627\u0644\u062A\u062D\u0642\u0642 \u0645\u0646 \u0645\u062D\u062A\u0648\u0649 \u0627\u0644\u0633\u0644\u0629 \u0627\u0644\u0622\u0646. \u062D\u0627\u0648\u0644 \u0645\u0631\u0629 \u0623\u062E\u0631\u0649 \u0628\u0639\u062F \u0644\u062D\u0638\u0627\u062A.",
    inProgress: "\u062C\u0627\u0631\u064D \u0625\u0636\u0627\u0641\u0629 \u0627\u0644\u062F\u0648\u0627\u0621 \u0644\u0644\u0633\u0644\u0629\u2026",
    overLimit: "\u0633\u0644\u062A\u0643 \u062A\u062D\u062A\u0648\u064A \u0639\u0644\u0649 \u0623\u0643\u062B\u0631 \u0645\u0646 \u0639\u0644\u0628\u0629 \u0645\u0646 \u062F\u0648\u0627\u0621 \u0645\u0646 \u0623\u062F\u0648\u064A\u0629 \u0627\u0644\u0646\u0648\u0627\u0642\u0635. \u0645\u0646 \u0641\u0636\u0644\u0643 \u0642\u0644\u0651\u0644 \u0627\u0644\u0643\u0645\u064A\u0629 \u0625\u0644\u0649 \u0639\u0644\u0628\u0629 \u0648\u0627\u062D\u062F\u0629 \u0644\u0643\u0644 \u0635\u0646\u0641 \u0642\u0628\u0644 \u0625\u062A\u0645\u0627\u0645 \u0627\u0644\u0637\u0644\u0628.",
    corrected: "\u062A\u0645 \u062A\u0639\u062F\u064A\u0644 \u0643\u0645\u064A\u0629 \u062F\u0648\u0627\u0621 \u0627\u0644\u0646\u0648\u0627\u0642\u0635 \u0625\u0644\u0649 \u0639\u0644\u0628\u0629 \u0648\u0627\u062D\u062F\u0629 \u0637\u0628\u0642\u064B\u0627 \u0644\u0633\u064A\u0627\u0633\u0629 \u0627\u0644\u0635\u064A\u062F\u0644\u064A\u0629.",
    needsCompanion: "\u0623\u062F\u0648\u064A\u0629 \u0627\u0644\u0646\u0648\u0627\u0642\u0635 \u0644\u0627 \u062A\u064F\u0637\u0644\u0628 \u0628\u0645\u0641\u0631\u062F\u0647\u0627. \u0645\u0646 \u0641\u0636\u0644\u0643 \u0623\u0636\u0641 \u0645\u0646\u062A\u062C\u064B\u0627 \u0622\u062E\u0631 \u0645\u0646 \u0645\u0646\u062A\u062C\u0627\u062A \u0627\u0644\u0635\u064A\u062F\u0644\u064A\u0629 (\u0645\u0646 \u062E\u0627\u0631\u062C \u0642\u0633\u0645 \u0623\u062F\u0648\u064A\u0629 \u0627\u0644\u0646\u0648\u0627\u0642\u0635) \u0625\u0644\u0649 \u0633\u0644\u062A\u0643 \u0644\u0625\u062A\u0645\u0627\u0645 \u0627\u0644\u0637\u0644\u0628."
  });
  var TOAST_ID = "shk-shortage-toast";
  var DRAWER_NOTICE_ID = "shk-shortage-drawer-notice";
  var CHECKOUT_NOTICE_ID = "shk-shortage-checkout-notice";
  var Notifier = class {
    constructor(doc) {
      this.doc = doc;
    }
    toast(message, ms = 4500) {
      let el = this.doc.getElementById(TOAST_ID);
      if (!el) {
        el = this.doc.createElement("div");
        el.id = TOAST_ID;
        el.setAttribute("role", "status");
        el.setAttribute("aria-live", "polite");
        el.dir = "rtl";
        this.doc.body.appendChild(el);
      }
      el.textContent = message;
      el.hidden = false;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (el) el.hidden = true;
      }, ms);
    }
    /** Insert/update/remove a notice placed immediately before `anchor`. Empty message removes it. */
    notice(id, anchor, message) {
      var _a;
      const existing = this.doc.getElementById(id);
      if (!anchor || !message) {
        existing == null ? void 0 : existing.remove();
        return;
      }
      let el = existing;
      if (!el) {
        el = this.doc.createElement("div");
        el.id = id;
        el.className = "shk-shortage-notice";
        el.setAttribute("role", "alert");
        el.dir = "rtl";
      }
      if (el.textContent !== message) el.textContent = message;
      if (el.nextElementSibling !== anchor) (_a = anchor.parentElement) == null ? void 0 : _a.insertBefore(el, anchor);
    }
    destroy() {
      var _a;
      clearTimeout(this.timer);
      for (const id of [TOAST_ID, DRAWER_NOTICE_ID, CHECKOUT_NOTICE_ID]) (_a = this.doc.getElementById(id)) == null ? void 0 : _a.remove();
    }
  };

  // src/rules/product-classifier.ts
  function readPageProduct(doc) {
    var _a, _b;
    const el = doc.getElementById("__NEXT_DATA__");
    if (!(el == null ? void 0 : el.textContent)) return null;
    try {
      const data = JSON.parse(el.textContent);
      if (data.page !== "/products/[id]") return null;
      const p = (_b = (_a = data.props) == null ? void 0 : _a.pageProps) == null ? void 0 : _b.product;
      if (!p || !isUuid(p.id) || !Array.isArray(p.categories)) return null;
      return {
        id: p.id,
        slug: typeof p.slug === "string" ? p.slug.toLowerCase() : null,
        categoryIds: p.categories.map((c) => c == null ? void 0 : c.id).filter(isUuid),
        buyNowText: typeof p.buy_now_text === "string" ? p.buy_now_text : null
      };
    } catch {
      return null;
    }
  }
  function classify(productId, src) {
    var _a, _b, _c;
    if (((_a = src.pageProduct) == null ? void 0 : _a.id) === productId && src.pageProduct.categoryIds.includes(src.categoryId)) return "shortage";
    if ((_b = src.catalog) == null ? void 0 : _b.ids.has(productId)) return "shortage";
    if (src.catalog) return "normal";
    if (((_c = src.pageProduct) == null ? void 0 : _c.id) === productId) return "normal";
    return "unknown";
  }
  function productIdFromSlug(slug, lines, src) {
    var _a, _b, _c;
    if (!slug) return null;
    const s = slug.toLowerCase();
    const fromCart = lines.find((l) => l.slug === s);
    if (fromCart) return fromCart.productId;
    if (((_a = src.pageProduct) == null ? void 0 : _a.slug) === s) return src.pageProduct.id;
    return (_c = (_b = src.catalog) == null ? void 0 : _b.slugToId.get(s)) != null ? _c : null;
  }
  function productIdFromName(name, lines, src) {
    var _a, _b;
    const n = normalizeName(name);
    if (!n) return null;
    const ids = new Set(lines.filter((l) => l.normalizedName === n).map((l) => l.productId));
    if (ids.size === 1) return [...ids][0];
    if (ids.size > 1) return null;
    return (_b = (_a = src.catalog) == null ? void 0 : _a.nameToId.get(n)) != null ? _b : null;
  }

  // src/context.ts
  function currentPageProduct(ctx) {
    const p = readPageProduct(ctx.doc);
    if (!p) return null;
    const slug = slugFromHref(ctx.win.location.href, ctx.win.location.href);
    return slug && p.slug === slug ? p : null;
  }
  function sources(ctx) {
    return { catalog: ctx.catalog.current(), pageProduct: currentPageProduct(ctx), categoryId: ctx.settings.categoryId };
  }
  function classifyIn(ctx, productId) {
    return classify(productId, sources(ctx));
  }
  function asElement(target) {
    const el = target;
    return el && el.nodeType === 1 && typeof el.closest === "function" ? el : null;
  }
  function isCheckoutPath(win) {
    return /^\/checkout\/?$/i.test(win.location.pathname);
  }

  // src/rules/quantity-validator.ts
  function unitsByProduct(lines) {
    var _a;
    const out = /* @__PURE__ */ new Map();
    for (const l of lines) out.set(l.productId, ((_a = out.get(l.productId)) != null ? _a : 0) + l.quantity);
    return out;
  }
  function findViolations(lines, classifyFn, max = MAX_UNITS_PER_SHORTAGE_PRODUCT) {
    const out = [];
    for (const [productId, quantity] of unitsByProduct(lines)) {
      if (quantity > max && classifyFn(productId) === "shortage") {
        out.push({ productId, quantity, lines: lines.filter((l) => l.productId === productId) });
      }
    }
    return out;
  }
  function isShortageOnly(lines, classifyFn) {
    const ids = [...unitsByProduct(lines).keys()];
    return ids.length > 0 && ids.every((id) => classifyFn(id) === "shortage");
  }
  function decideAdd(productId, lines, max = MAX_UNITS_PER_SHORTAGE_PRODUCT) {
    var _a;
    const current = (_a = unitsByProduct(lines).get(productId)) != null ? _a : 0;
    return current + 1 > max ? "already-in-cart" : "allow";
  }

  // src/ui/product-page.ts
  var ADD_SELECTOR = "button.add_to_cart_btn";
  function resolveAddTarget(ctx, target) {
    var _a, _b, _c;
    const button = target.closest("button");
    if (!button || button.closest("[data-cart]")) return null;
    const page = currentPageProduct(ctx);
    const group = button.parentElement;
    const mainAdd = (_a = group == null ? void 0 : group.querySelector(`:scope > ${ADD_SELECTOR}`)) != null ? _a : null;
    const inMainBuyBox = !!page && !!mainAdd && group.querySelectorAll(":scope > button").length === 2;
    if (inMainBuyBox) {
      if (button === mainAdd) return { button, kind: "add", productId: page.id };
      const text = (_c = (_b = button.textContent) == null ? void 0 : _b.trim()) != null ? _c : "";
      if (page.buyNowText && text === page.buyNowText.trim()) return { button, kind: "buy-now", productId: page.id };
      return null;
    }
    if (button.matches(ADD_SELECTOR)) {
      let node = button.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const slugs = new Set(
          [...node.querySelectorAll('a[href*="/products/"]')].map((a) => slugFromHref(a.getAttribute("href"), ctx.win.location.href)).filter((s) => !!s)
        );
        if (slugs.size === 1) {
          const productId = productIdFromSlug([...slugs][0], ctx.cart.get().lines, sources(ctx));
          return { button, kind: "add", productId };
        }
        if (slugs.size > 1) break;
      }
      return { button, kind: "add", productId: null };
    }
    return null;
  }
  var ProductPageGuard = class {
    constructor(ctx) {
      this.ctx = ctx;
      /** Buttons we re-dispatch ourselves; the next click on them passes through once. */
      this.bypass = /* @__PURE__ */ new WeakSet();
      this.busy = /* @__PURE__ */ new Set();
    }
    /** Returns true when the event was handled (stopped) by this guard. */
    onClick(event) {
      const target = asElement(event.target);
      if (!target) return false;
      const add = resolveAddTarget(this.ctx, target);
      if (!add) return false;
      if (this.bypass.has(add.button)) {
        this.bypass.delete(add.button);
        return false;
      }
      if (!add.productId || classifyIn(this.ctx, add.productId) !== "shortage") return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      const productId = add.productId;
      if (this.busy.has(productId)) {
        this.ctx.notifier.toast(MESSAGES.inProgress, 2e3);
        return true;
      }
      this.busy.add(productId);
      void this.ctx.lock.run(productId, () => this.guardedAdd(add, productId)).catch((err) => {
        this.ctx.logger.warn("add guard failed", String(err));
        this.ctx.notifier.toast(MESSAGES.verifyFailed);
      }).finally(() => this.busy.delete(productId));
      return true;
    }
    async guardedAdd(add, productId) {
      const { cart, settings, notifier, activity, logger, broadcast, nav } = this.ctx;
      const state = await cart.refresh(true);
      if (state.status !== "ok") {
        if (settings.failClosedOnShortageAdd) {
          notifier.toast(MESSAGES.verifyFailed);
          return;
        }
      } else if (decideAdd(productId, state.lines) === "already-in-cart") {
        logger.debug("add blocked: already in cart", { productId, kind: add.kind });
        if (add.kind === "buy-now") {
          nav.assign("/checkout");
        } else {
          notifier.toast(MESSAGES.alreadyInCart);
        }
        return;
      }
      if (!add.button.isConnected) return;
      this.bypass.add(add.button);
      const settled = this.ctx.activityObserved ? activity.next(settings.addSettleTimeoutMs) : delay(1500).then(() => true);
      add.button.click();
      this.bypass.delete(add.button);
      const seen = await settled;
      if (!seen) logger.warn("no cart request observed after add", { productId });
      await cart.refresh(true);
      broadcast.notify();
    }
  };
  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // src/ui/cart-drawer.ts
  var SHORTAGE_ATTR = "data-shk-shortage";
  var CartDrawerGuard = class {
    constructor(ctx) {
      this.ctx = ctx;
    }
    rowProductId(row) {
      var _a;
      const href = (_a = row.querySelector('a[href*="/products/"]')) == null ? void 0 : _a.getAttribute("href");
      const slug = slugFromHref(href, this.ctx.win.location.href);
      return productIdFromSlug(slug, this.ctx.cart.get().lines, sources(this.ctx));
    }
    onClick(event) {
      const target = asElement(event.target);
      if (!target) return false;
      const plus = target.closest('[data-cart="item-increase"]');
      if (!plus) return false;
      const row = plus.closest('[data-cart="item"]');
      const productId = row ? this.rowProductId(row) : null;
      if (!productId || classifyIn(this.ctx, productId) !== "shortage") return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.ctx.notifier.toast(MESSAGES.maxOne);
      return true;
    }
    /** Idempotent DOM decoration; only writes when a value actually changes. */
    render() {
      const { doc, cart, notifier } = this.ctx;
      const rows = doc.querySelectorAll('[data-cart="item"]');
      for (const row of rows) {
        const productId = this.rowProductId(row);
        const restricted = !!productId && classifyIn(this.ctx, productId) === "shortage";
        setAttr(row, SHORTAGE_ATTR, restricted ? "1" : null);
        const plus = row.querySelector('[data-cart="item-increase"]');
        if (plus) {
          setAttr(plus, "aria-disabled", restricted ? "true" : null, SHORTAGE_ATTR);
          setAttr(plus, "title", restricted ? MESSAGES.maxOne : null, SHORTAGE_ATTR);
        }
      }
      const anchor = doc.querySelector('[data-cart="checkout-wrapper"]');
      const state = cart.get();
      const classifyFn = (id) => classifyIn(this.ctx, id);
      const ok = state.status === "ok";
      const message = ok && findViolations(state.lines, classifyFn).length ? MESSAGES.overLimit : ok && this.ctx.settings.requireAdditionalProduct && isShortageOnly(state.lines, classifyFn) ? MESSAGES.needsCompanion : "";
      notifier.notice(DRAWER_NOTICE_ID, rows.length ? anchor : null, message);
    }
    destroy() {
      for (const el of this.ctx.doc.querySelectorAll(`[${SHORTAGE_ATTR}]`)) el.removeAttribute(SHORTAGE_ATTR);
      for (const el of this.ctx.doc.querySelectorAll(`[${SHORTAGE_ATTR}-owned]`)) clearOwned(el);
    }
  };
  function setAttr(el, name, value, owner) {
    var _a, _b;
    const ownedKey = owner ? `${owner}-owned` : null;
    if (value === null) {
      if (ownedKey) {
        const owned = ((_a = el.getAttribute(ownedKey)) != null ? _a : "").split(" ").filter(Boolean);
        if (!owned.includes(name)) return;
        el.removeAttribute(name);
        const rest = owned.filter((n) => n !== name);
        if (rest.length) el.setAttribute(ownedKey, rest.join(" "));
        else el.removeAttribute(ownedKey);
      } else if (el.hasAttribute(name)) {
        el.removeAttribute(name);
      }
      return;
    }
    if (ownedKey) {
      const owned = ((_b = el.getAttribute(ownedKey)) != null ? _b : "").split(" ").filter(Boolean);
      if (!owned.includes(name)) {
        if (el.hasAttribute(name)) return;
        el.setAttribute(ownedKey, [...owned, name].join(" "));
      }
    }
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  function clearOwned(el) {
    var _a;
    for (const name of ((_a = el.getAttribute(`${SHORTAGE_ATTR}-owned`)) != null ? _a : "").split(" ").filter(Boolean)) el.removeAttribute(name);
    el.removeAttribute(`${SHORTAGE_ATTR}-owned`);
  }

  // src/ui/checkout.ts
  var FORM_SELECTOR = "form#checkout-form";
  var PLUS_SELECTOR = 'button[aria-label="Increase quantity"]';
  function isOrderButton(el) {
    const b = el;
    return !!b && b.tagName === "BUTTON" && b.type === "submit" && !!b.closest(FORM_SELECTOR);
  }
  function orderButtonOf(doc) {
    var _a;
    const form = doc.querySelector(FORM_SELECTOR);
    return form ? (_a = [...form.querySelectorAll("button")].find(isOrderButton)) != null ? _a : null : null;
  }
  var CheckoutGuard = class {
    constructor(ctx) {
      this.ctx = ctx;
      this.corrected = /* @__PURE__ */ new Set();
    }
    active() {
      return isCheckoutPath(this.ctx.win);
    }
    /** Name of the summary row that owns this "+" button (nearest ancestor with a non-empty <p> name). */
    rowProductId(plus) {
      var _a;
      const lines = this.ctx.cart.get().lines;
      const known = new Set(lines.map((l) => l.normalizedName).filter(Boolean));
      let node = plus.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (node.querySelectorAll(PLUS_SELECTOR).length > 1) break;
        for (const p of node.querySelectorAll("p")) {
          const n = normalizeName(p.textContent);
          if (known.has(n) || ((_a = this.ctx.catalog.current()) == null ? void 0 : _a.nameToId.has(n))) return productIdFromName(n, lines, sources(this.ctx));
        }
      }
      return null;
    }
    violations() {
      const state = this.ctx.cart.get();
      if (state.status !== "ok") return [];
      return findViolations(state.lines, (id) => classifyIn(this.ctx, id));
    }
    /** Message for the first rule the current (authoritative) cart breaks, or '' when checkout may proceed. */
    problem(violations) {
      if (violations.length) return MESSAGES.overLimit;
      const state = this.ctx.cart.get();
      if (state.status !== "ok" || !this.ctx.settings.requireAdditionalProduct) return "";
      return isShortageOnly(state.lines, (id) => classifyIn(this.ctx, id)) ? MESSAGES.needsCompanion : "";
    }
    onClick(event) {
      if (!this.active()) return false;
      const target = asElement(event.target);
      if (!target) return false;
      const plus = target.closest(PLUS_SELECTOR);
      if (plus) {
        const productId = this.rowProductId(plus);
        if (!productId || classifyIn(this.ctx, productId) !== "shortage") return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.ctx.notifier.toast(MESSAGES.maxOne);
        return true;
      }
      if (isOrderButton(target.closest("button"))) return this.blockIfInvalid(event);
      return false;
    }
    onSubmit(event) {
      if (!this.active()) return false;
      const form = asElement(event.target);
      if (!form || form.tagName !== "FORM" || form.id !== "checkout-form") return false;
      return this.blockIfInvalid(event);
    }
    blockIfInvalid(event) {
      void this.ctx.cart.refresh();
      const message = this.problem(this.violations());
      if (!message) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.ctx.notifier.toast(message, 6e3);
      this.render();
      return true;
    }
    render() {
      const { doc, notifier } = this.ctx;
      if (!this.active()) {
        notifier.notice(CHECKOUT_NOTICE_ID, null, "");
        return;
      }
      for (const plus of doc.querySelectorAll(PLUS_SELECTOR)) {
        const productId = this.rowProductId(plus);
        const restricted = !!productId && classifyIn(this.ctx, productId) === "shortage";
        setAttr(plus, SHORTAGE_ATTR, restricted ? "1" : null);
        setAttr(plus, "aria-disabled", restricted ? "true" : null, SHORTAGE_ATTR);
        setAttr(plus, "title", restricted ? MESSAGES.maxOne : null, SHORTAGE_ATTR);
      }
      const violations = this.violations();
      notifier.notice(CHECKOUT_NOTICE_ID, orderButtonOf(doc), this.problem(violations));
      if (violations.length && this.ctx.settings.autoCorrectOverLimit) void this.autoCorrect(violations);
    }
    /** Opt-in: bring each violating product back to exactly 1 unit, then reload so the platform UI re-syncs. */
    async autoCorrect(violations) {
      const { cart, notifier, nav, logger } = this.ctx;
      let changed = false;
      for (const v of violations) {
        const [first, ...rest] = v.lines;
        const plan = [[first.itemId, 1], ...rest.map((l) => [l.itemId, 0])];
        for (const [itemId, qty] of plan) {
          if (this.corrected.has(itemId)) continue;
          this.corrected.add(itemId);
          const ok = await cart.setQuantity(itemId, qty);
          logger.debug("auto-correct", { productId: v.productId, qty, ok });
          changed = changed || ok;
        }
      }
      if (changed) {
        notifier.toast(MESSAGES.corrected, 3e3);
        setTimeout(() => nav.reload(), 1200);
      }
    }
    destroy() {
      for (const el of this.ctx.doc.querySelectorAll(`[${SHORTAGE_ATTR}-owned]`)) clearOwned(el);
      this.ctx.notifier.notice(CHECKOUT_NOTICE_ID, null, "");
    }
  };

  // src/main.ts
  var VERSION = "14.1.0";
  var GLOBAL_KEY = "__SHAKSHAK_SHORTAGES__";
  var LEGACY_FLAGS = [
    "__SHAKSHAK_SHORTAGES_V13__",
    "__SHAKSHAK_SHORTAGES_V12__",
    "__shakshakShortagesV8",
    "__SHK_EMERGENCY_PAUSE__"
  ];
  var LEGACY_STORAGE_PREFIXES = ["shakshak-shortages-v", "shk12-cart-hints", "shk13-cart-hints"];
  function detectLegacy(win) {
    const w = win;
    const found = LEGACY_FLAGS.filter((f) => !!w[f]);
    if (win.document.getElementById("shk13-toast") || win.document.getElementById("ss8-toast")) found.push("legacy-dom");
    return found;
  }
  function cleanupLegacyStorage(storage) {
    if (!storage) return [];
    const removed = [];
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && LEGACY_STORAGE_PREFIXES.some((p) => k.startsWith(p))) keys.push(k);
      }
      for (const k of keys) {
        storage.removeItem(k);
        removed.push(k);
      }
    } catch {
    }
    return removed;
  }
  function safeStorage(get) {
    try {
      return get();
    } catch {
      return null;
    }
  }
  function start(win, options = {}) {
    var _a;
    const { overrides } = options;
    const existing = win[GLOBAL_KEY];
    if (existing) return existing;
    const settings = { ...resolveSettings(win), ...overrides };
    const logger = createLogger(settings.debug);
    if (!settings.enabled) {
      logger.debug("disabled by configuration");
      return null;
    }
    const legacy = detectLegacy(win);
    if (legacy.length && settings.refuseIfLegacyPresent) {
      logger.warn("legacy shortage script detected \u2014 not starting. Remove old code from Header Code.", legacy);
      return null;
    }
    const doc = win.document;
    const local = safeStorage(() => win.localStorage);
    const session = safeStorage(() => win.sessionStorage);
    if (settings.cleanupLegacyStorage) {
      const removed = cleanupLegacyStorage(local);
      if (removed.length) logger.debug("removed legacy storage keys", removed.length);
    }
    const fetchFn = (input, init) => win.fetch(input, init);
    const catalog = new CatalogService(fetchFn, settings, logger, session);
    const cart = new CartStore(fetchFn, settings, logger, local);
    const activity = new CartActivityMonitor(win);
    const activityObserved = activity.start();
    const lock = new ProductLock(lockManagerFrom(win.navigator));
    const broadcast = new CartBroadcast(win, () => void cart.refresh(true));
    const notifier = new Notifier(doc);
    const nav = (_a = options.nav) != null ? _a : {
      assign: (path) => win.location.assign(path),
      reload: () => win.location.reload()
    };
    const ctx = { win, doc, settings, logger, catalog, cart, activity, activityObserved, lock, broadcast, notifier, nav };
    const product = new ProductPageGuard(ctx);
    const drawer = new CartDrawerGuard(ctx);
    const checkout = new CheckoutGuard(ctx);
    let renderTimer;
    const scheduleRender = () => {
      if (renderTimer !== void 0) return;
      renderTimer = setTimeout(() => {
        renderTimer = void 0;
        drawer.render();
        checkout.render();
      }, 120);
    };
    const onClick = (e) => {
      if (drawer.onClick(e)) return;
      if (checkout.onClick(e)) return;
      product.onClick(e);
    };
    const onSubmit = (e) => void checkout.onSubmit(e);
    const onVisible = () => {
      if (doc.visibilityState === "visible") void cart.refresh(true);
    };
    const onPageShow = () => void cart.refresh(true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("submit", onSubmit, true);
    doc.addEventListener("visibilitychange", onVisible);
    win.addEventListener("pageshow", onPageShow);
    const offActivity = activity.on(() => {
      void cart.refresh(true).then(() => broadcast.notify());
    });
    const offCart = cart.subscribe(scheduleRender);
    const MO = win.MutationObserver;
    const mo = new MO(scheduleRender);
    mo.observe(doc.body, { childList: true, subtree: true });
    void catalog.ready().then(scheduleRender);
    void cart.refresh();
    const catalogTimer = setInterval(() => void catalog.ready().then(scheduleRender), settings.catalogTtlMs);
    const instance = {
      version: VERSION,
      destroy() {
        doc.removeEventListener("click", onClick, true);
        doc.removeEventListener("submit", onSubmit, true);
        doc.removeEventListener("visibilitychange", onVisible);
        win.removeEventListener("pageshow", onPageShow);
        offActivity();
        offCart();
        mo.disconnect();
        clearInterval(catalogTimer);
        clearTimeout(renderTimer);
        activity.stop();
        broadcast.close();
        drawer.destroy();
        checkout.destroy();
        notifier.destroy();
        delete win[GLOBAL_KEY];
      },
      snapshot() {
        var _a2, _b;
        const s = cart.get();
        return {
          version: VERSION,
          cart: { status: s.status, readAt: s.readAt, lines: s.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.quantity })) },
          catalogSize: (_b = (_a2 = catalog.current()) == null ? void 0 : _a2.ids.size) != null ? _b : null,
          crossTabLock: lock.crossTab,
          activityObserved
        };
      }
    };
    win[GLOBAL_KEY] = instance;
    logger.debug("started", { version: VERSION, crossTabLock: lock.crossTab, activityObserved });
    return instance;
  }
  if (typeof window !== "undefined") {
    const boot = () => {
      try {
        start(window);
      } catch (err) {
        console.warn("[shakshak-shortages] failed to start", err);
      }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }
})();
