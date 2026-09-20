// Minimal DOM shim - just enough surface for the form renderer's logic
// tests. Not a general-purpose DOM.

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.attributes = {};
    this._listeners = new Map();
    this.style = {};
    this._value = "";
    this.checked = false;
    this.selected = false;
    this.textContent = "";
    this._innerHTML = "";
    this.className = "";
    this.minLength = undefined;
    this.maxLength = undefined;
    this.min = undefined;
    this.max = undefined;
    this.step = undefined;
    this.htmlFor = "";
    const self = this;
    this.dataset = new Proxy(
      {},
      {
        get(t, k) { return t[k]; },
        set(t, k, v) {
          t[k] = String(v);
          self.attributes["data-" + String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())] = String(v);
          return true;
        },
      }
    );
  }

  appendChild(child) {
    this.children.push(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

 dispatch(type, event = {}) {
    for (const fn of this._listeners.get(type) || []) fn.call(this, { target: this, ...event });
  }

  focus() { FakeDocument.activeElement = this; }
  setSelectionRange() {}
  select() {}

  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "") {
      this.children = [];
      this.childNodes = [];
    }
  }

  get value() { return this._value; }
  set value(v) { this._value = v; }

  classList = {
    _set: new Set(),
    add(...c) { c.forEach((x) => this._set.add(x)); },
    remove(...c) { c.forEach((x) => this._set.delete(x)); },
    toggle(c, force) {
      const on = force === undefined ? !this._set.has(c) : force;
      on ? this._set.add(c) : this._set.delete(c);
    },
    contains(c) { return this._set.has(c); },
  };

  querySelectorAll(selector) {
    const attr = selector.match(/^\[data-([\w-]+)\]$/);
    if (!attr) return [];
    const name = "data-" + attr[1];
    const out = [];
    const walk = (n) => {
      for (const ch of n.children) {
        if (ch.attributes[name] !== undefined) out.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

export const FakeDocument = {
  activeElement: null,
  createElement(tag) { return new FakeElement(tag); },
  createTextNode(text) { const e = new FakeElement("#text"); e.textContent = String(text); return e; },
  FakeElement,
};

export function installDomShim() {
  globalThis.document = FakeDocument;
  globalThis.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
}

/** Find descendant elements by tag name. */
export function findAll(root, tag) {
  const out = [];
  const walk = (n) => {
    for (const ch of n.children) {
      if (ch.tagName === String(tag).toUpperCase()) out.push(ch);
      walk(ch);
    }
  };
  walk(root);
  return out;
}

/** Find controls annotated with data-path. */
export function findByPath(root, path) {
  return root.querySelectorAll(`[data-path]`).filter((e) => e.attributes["data-path"] === path);
}
