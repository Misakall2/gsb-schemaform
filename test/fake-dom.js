// Minimal DOM stub, just enough for src/form.js. No layout, no events fired
// automatically; tests invoke handlers directly.

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.selected = false;
    this.handlers = {};
    this.selectionStart = null;
    this.parent = null;
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...kids) { kids.forEach((k) => this.appendChild(k)); }
  replaceChildren(...kids) {
    this.children = [];
    kids.forEach((k) => this.appendChild(k));
  }
  addEventListener(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.handlers[type] || []) fn({ target: this, ...event });
  }
  focus() { global.document.activeElement = this; }
  setSelectionRange() {}

  // --- querying helpers for tests ---
  walk(fn) {
    fn(this);
    this.children.forEach((c) => c.walk(fn));
  }
  find(predicate) {
    let hit = null;
    this.walk((n) => { if (!hit && predicate(n)) hit = n; });
    return hit;
  }
  findAll(predicate) {
    const all = [];
    this.walk((n) => { if (predicate(n)) all.push(n); });
    return all;
  }
  byPath(path) {
    return this.find((n) => n.getAttribute('data-path') === path);
  }
  get classList() {
    return {
      add: (c) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        set.add(c);
        this.className = [...set].join(' ');
      },
    };
  }
}

export function installFakeDom() {
  global.document = {
    activeElement: null,
    createElement: (tag) => new FakeNode(tag),
  };
  return { FakeNode };
}

// Fire the most recently registered event of `type` on a node.
export function fire(node, type, event) {
  node.dispatch(type, event);
}
