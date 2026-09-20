function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("data-")) node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function defaultFor(s) {
  if (!s || typeof s !== "object") return undefined;
  if (Array.isArray(s.enum)) return s.enum.includes(undefined) ? undefined : s.enum[0];
  switch (s.type) {
    case "string": return "";
    case "number":
    case "integer": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return undefined;
  }
}

/**
 * Build a default row value for an object schema, honoring each
 * property's own `default` keyword. Unlike defaultFor() this never
 * invents implicit values (""/0/false): array rows must only carry what
 * the schema actually declares.
 */
function schemaDefaultValue(s, deref) {
  const ss = deref(s);
  if (!ss || typeof ss !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(ss, "default")) {
    return JSON.parse(JSON.stringify(ss.default));
  }
  if (ss.type === "object" || ss.properties) {
    const out = {};
    for (const key of Object.keys(ss.properties || {})) {
      const d = schemaDefaultValue(ss.properties[key], deref);
      if (d !== undefined) out[key] = d;
    }
    return out;
  }
  if (ss.type === "array") return [];
  return undefined;
}

/**
 * Schema-driven form.
 *
 * Data model:
 *   data     - plain JS value, materialized lazily as fields appear
 *   branches - JSON Pointer (of the oneOf value) -> selected branch index
 *   stash    - pointer -> { [branchIndex]: saved data }
 */
class SchemaForm {
  constructor(rootEl, schema, options = {}) {
    this.root = rootEl;
    this.registry = new SF.SchemaRegistry(schema);
    this.schema = schema;
    this.onChange = options.onChange || (() => {});
    this.data = undefined;
    this.branches = new Map();
    this.stash = new Map();
    this.touched = false;
    this.lastErrors = [];
    this._render();
  }

  deref(s) { return this.registry.deref(s); }

  // --- model accessors ---

  getAt(segments) {
    if (segments.length === 0) return this.data;
    let node = this.data;
    for (const k of segments) {
      if (node === undefined || node === null || typeof node !== "object") return undefined;
      node = node[k];
    }
    return node;
  }

  setAt(segments, value) {
    if (segments.length === 0) { this.data = value; return; }
    let node = this.data;
    if (node === undefined || node === null || typeof node !== "object") {
      node = /^\d+$/.test(segments[0]) ? [] : {};
      this.data = node;
    }
    for (let i = 0; i < segments.length - 1; i++) {
      const k = segments[i];
      const nextRaw = segments[i + 1];
      if (node[k] === undefined || node[k] === null || typeof node[k] !== "object") {
        node[k] = /^\d+$/.test(nextRaw) ? [] : {};
      }
      node = node[k];
    }
    const lastRaw = segments[segments.length - 1];
    node[/^\d+$/.test(lastRaw) ? Number(lastRaw) : lastRaw] = value;
  }

  deleteAt(segments) {
    if (segments.length === 0) { this.data = undefined; return; }
    let node = this.data;
    for (let i = 0; i < segments.length - 1; i++) {
      if (node === undefined || node === null || typeof node !== "object") return;
      node = node[segments[i]];
    }
    if (node && typeof node === "object") delete node[segments[segments.length - 1]];
  }

  // --- public IO ---

  getData() { return this.data; }

  submit() {
    this.touched = true;
    // Hidden conditional/dependency fields must not leak dirty values.
    this._pruneHidden();
    this._render();
    const result = this._validateWithBranches();
    this._applyErrors(result.errors);
    return { valid: result.valid, errors: result.errors, data: this.data };
  }

  /** Fill the form from JSON data; infer oneOf branches. */
  setJSON(value) {
    this.data = value === undefined ? undefined : this._normalizeValue(this.schema, value);
    this.branches = new Map();
    this.stash = new Map();
    this.touched = false;
    this._inferBranches(this.schema, []);
    this._pruneHidden();
    this._render();
    this.onChange(this.data);
  }

  toJSONString() { return JSON.stringify(this.data, null, 2); }

  /**
   * Deep-clone incoming JSON while applying the form's own empty-value
   * convention: an empty string in a free-text field means "not filled"
   * (the field is deleted), exactly like pressing backspace in the control.
   * Enum values keep "" when it is a legal option; object keys that become
   * undefined are dropped, empty arrays are preserved.
   */
  _normalizeValue(schema, value) {
    const s = this.deref(schema);
    if (!s || value === null || value === undefined) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }
    if (Array.isArray(s.oneOf)) {
      for (const branch of s.oneOf) {
        if (SF.validate(value, branch, this.registry).valid) {
          return this._normalizeValue(branch, value);
        }
      }
      return JSON.parse(JSON.stringify(value));
    }
    if (Array.isArray(value) && s.items) {
      return value.map((item) => this._normalizeValue(s.items, item));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const out = {};
      const propSchemas = { ...(s.properties || {}) };
      for (const c of this._objectFacets(s, value, "active")) {
        if (c.properties) Object.assign(propSchemas, c.properties);
      }
      for (const key of Object.keys(value)) {
        const childSchema = propSchemas[key] || {};
        const nv = this._normalizeValue(childSchema, value[key]);
        if (nv !== undefined) out[key] = nv;
      }
      return out;
    }
    if (typeof value === "string" && value === "" && !Array.isArray(s.enum)) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(value));
  }

  // --- oneOf branch inference on load ---

  _inferBranches(schema, segments) {
    const s = this.deref(schema);
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.oneOf)) {
      const value = this.getAt(segments);
      const matches = s.oneOf
        .map((b, i) => ({ i, ok: SF.validate(value, b, this.registry).valid }))
        .filter((x) => x.ok);
      const p = SF.buildPointer(segments);
      if (matches.length === 1 && !this.branches.has(p)) {
        this.branches.set(p, matches[0].i);
        this._inferBranches(s.oneOf[matches[0].i], segments);
      }
      return; // only the picked branch can describe the value
    }
    if (s.type === "object" || s.properties) {
      const value = this.getAt(segments);
      // Own props + active facets (allOf, dependencies, if/then/else).
      const contributors = [s, ...this._objectFacets(s, value, "active")];
      const seen = new Set();
      for (const c of contributors) {
        if (!c.properties) continue;
        for (const k of Object.keys(c.properties)) {
          if (seen.has(k)) continue;
          seen.add(k);
          this._inferBranches(c.properties[k], [...segments, k]);
        }
      }
    }
    if (s.type === "array" && s.items && !Array.isArray(s.items)) {
      const arr = this.getAt(segments);
      if (Array.isArray(arr)) arr.forEach((_, i) => this._inferBranches(s.items, [...segments, i]));
    }
  }

  // --- validation, including the explicit oneOf branch selection rule ---

  _validateWithBranches() {
    const result = SF.validate(this.data, this.schema, this.registry);
    const extra = [];
    for (const [pointer, branchIndex] of this.branches) {
      const segments = SF.parsePointer(pointer);
      const value = this.getAt(segments);
      const oneOfSchema = this._schemaAt(segments);
      const branch = oneOfSchema.oneOf[branchIndex];
      const sub = SF.validate(value, branch, this.registry);
      if (!sub.valid) {
        extra.push({ path: pointer, keyword: "oneOf", message: "当前选择的类型与字段内容不符" });
      }
    }
    const errors = result.errors.concat(extra);
    return { valid: errors.length === 0, errors };
  }

  /** Resolve the (dereffed) subschema located at the given segments. */
  _schemaAt(segments) {
    let s = this.deref(this.schema);
    let walked = [];
    for (const key of segments) {
      s = this.deref(s);

      // oneOf node: descend into whichever branch the user picked.
      if (Array.isArray(s.oneOf)) {
        const branchIndex = this.branches.get(SF.buildPointer(walked));
        s = s.oneOf[branchIndex ?? 0];
        s = this.deref(s);
      }

      if (s.type === "array" && s.items && !Array.isArray(s.items)) {
        s = s.items;
      } else if (s.type === "array") {
        return this.deref(s);
      }

      const own = s.properties && s.properties[key];
      if (own) {
        s = own;
      } else {
        // Field contributed by an active facet: allOf branch, schema
        // dependency, or the picked if/then/else side.
        const facets = this._objectFacets(s, this.getAt(walked), "active");
        let found = null;
        for (const f of facets) {
          if (f.properties && key in f.properties) { found = f.properties[key]; break; }
        }
        if (!found) return this.deref(s);
        s = found;
      }
      walked = walked.concat(key);
    }
    return this.deref(s);
  }

  // --- rendering ---

  _render() {
    const active = document.activeElement;
    const focusPath = active && active.dataset ? active.dataset.path : null;

    this.root.innerHTML = "";
    const fieldset = el("div", { class: "sf-root" });
    this._renderNode(this.schema, [], fieldset, "", true);
    this.root.appendChild(fieldset);

    if (focusPath) {
      const target = this.root.querySelector(`[data-path="${CSS.escape(focusPath)}"]`);
      if (target) {
        target.focus();
        if (typeof target.setSelectionRange === "function" && target.value != null) {
          const len = target.value.length;
          try { target.setSelectionRange(len, len); } catch (_) {}
        }
      }
    }

    const result = this.touched ? this._validateWithBranches() : null;
    if (result) this._applyErrors(result.errors);
  }

  _refresh(rebuildNeeded) {
    // Facets (if/then, allOf, dependencies) appear/disappear as values
    // change, so the tree is rebuilt on every commit. Focus/caret is
    // preserved across the rebuild inside _render(); IME composition
    // never reaches here (composition events short-circuit earlier).
    this._pruneHidden();
    this._render();
    const result = this._validateWithBranches();
    this.lastErrors = result.errors;
    this._applyErrors(result.errors);
    this.onChange(this.data);
  }

  _applyErrors(errors) {
    const byPath = new Map();
    for (const e of errors) {
      if (!byPath.has(e.path)) byPath.set(e.path, []);
      byPath.get(e.path).push(e.message);
    }
    this.root.querySelectorAll("[data-error-for]").forEach((node) => {
      const p = node.dataset.errorFor;
      const msgs = byPath.get(p) || [];
      node.innerHTML = "";
      node.classList.toggle("sf-error", msgs.length > 0);
      for (const m of msgs) {
        const div = el("div", { class: "sf-error-msg" });
        div.textContent = m;
        node.appendChild(div);
      }
    });
    this.root.querySelectorAll("[data-control-for]").forEach((node) => {
      node.classList.toggle("sf-invalid", byPath.has(node.dataset.controlFor));
    });
  }

  _errorSlot(segments) {
    const msg = el("div", { class: "sf-errors" });
    msg.dataset.errorFor = SF.buildPointer(segments);
    return msg;
  }

  _renderNode(schema, segments, container, labelText, top = false) {
    const s = this.deref(schema);
    if (!s || typeof s !== "object") return;
    const label = s.title || labelText;

    let value = this.getAt(segments);
    if (top && value === undefined) {
      const d = defaultFor(s);
      if (d !== undefined) { this.setAt(segments, d); value = d; }
    }

    if (Array.isArray(s.oneOf)) return this._renderOneOf(s, segments, container, label);

    switch (s.type) {
      case "object": return this._renderObject(s, segments, container, label, value);
      case "array": return this._renderArray(s, segments, container, label, value);
      case "boolean": return this._renderBoolean(s, segments, container, label, value);
      default: return this._renderPrimitive(s, segments, container, label, value);
    }
  }

  _renderObject(s, segments, container, labelText, value) {
    const group = el("fieldset", { class: "sf-group sf-object" });
    if (labelText) {
      const legend = el("legend", { class: "sf-group-title" });
      legend.textContent = labelText;
      group.appendChild(legend);
    }
    const body = el("div", { class: "sf-group-body" });
    group.appendChild(body);

    // Own properties render first and directly in the body.
    const renderedKeys = new Set();
    if (s.properties) {
      for (const key of Object.keys(s.properties)) {
        this._renderNode(s.properties[key], [...segments, key], body, key, false);
        renderedKeys.add(key);
      }
    }

    // Then the active facets: allOf branches (ALL of them, merged flat),
    // schema dependencies whose trigger is present, and the picked
    // if/then/else side. Each top-level source gets a labeled wrapper.
    for (const src of this._facetSources(s, value)) {
      const wrapClass =
        "sf-conditional sf-facet" +
        (src.kind === "allOf" ? " sf-facet-allof" : src.kind === "dependencies" ? " sf-facet-dep" : "");
      const wrap = el("div", { class: wrapClass });
      if (src.label) {
        const tag = el("span", { class: "sf-facet-title" });
        tag.textContent = src.label;
        wrap.appendChild(tag);
      }
      this._renderFacetNode(src.schema, segments, wrap, renderedKeys);
      // Wrappers stay only if they actually contributed a control.
      if (wrap.children.length > (src.label ? 1 : 0)) body.appendChild(wrap);
    }

    const errAt = el("div", { class: "sf-errors sf-group-errors" });
    errAt.dataset.errorFor = SF.buildPointer(segments);
    group.appendChild(errAt);

    container.appendChild(group);
  }

  /**
   * Render one facet source: its own properties flat plus any nested
   * active facets (nested if/then, allOf inside an allOf branch, ...).
   * `renderedKeys` is the object-wide dedupe set so a field merged in by
   * several branches renders exactly once (first occurrence wins).
   */
  _renderFacetNode(schema, segments, container, renderedKeys) {
    const s = this.deref(schema);
    if (!s) return;
    if (Array.isArray(s.oneOf)) return this._renderOneOf(s, segments, container, "");

    if (s.properties) {
      for (const key of Object.keys(s.properties)) {
        if (renderedKeys.has(key)) continue;
        renderedKeys.add(key);
        this._renderNode(s.properties[key], [...segments, key], container, key, false);
      }
    }
    // Nested facets inherit the parent source's wrapper/label.
    for (const child of this._facetSources(s, this.getAt(segments))) {
      this._renderFacetNode(child.schema, segments, container, renderedKeys);
    }
  }

  /**
   * Active contributing object-schemas of `s` for the given value,
   * flattened in stable order: if/then side, allOf branches, then
   * triggered schema dependencies. `mode`:
   *   "active" - only currently contributing facets
   *   "all"    - every facet regardless of the current value (used to
   *              know which keys are "managed" and safe to prune)
   */
  _objectFacets(schema, value, mode) {
    const out = [];
    const seen = new Set();
    const isObj = value !== null && typeof value === "object" && !Array.isArray(value);
    const visitActive = (node, depth) => {
      const n = this.deref(node);
      if (!n || typeof n !== "object" || seen.has(n) || depth > 64) return;
      seen.add(n);
      if (n.if) {
        const condValid = SF.validate(value, n.if, this.registry).valid;
        const side = condValid ? n.then : n.else;
        if (side) visitActive(side, depth + 1);
      }
      if (Array.isArray(n.allOf)) n.allOf.forEach((b) => visitActive(b, depth + 1));
      if (isObj && n.dependencies) {
        for (const trigger of Object.keys(n.dependencies)) {
          const dep = n.dependencies[trigger];
          if (dep && typeof dep === "object" && !Array.isArray(dep) && trigger in value) {
            visitActive(dep, depth + 1);
          }
        }
      }
      if (n !== this.deref(schema)) out.push(n);
    };
    const visitAll = (node, depth) => {
      const n = this.deref(node);
      if (!n || typeof n !== "object" || seen.has(n) || depth > 64) return;
      seen.add(n);
      if (n.if) { visitAll(n.then, depth + 1); visitAll(n.else, depth + 1); }
      if (Array.isArray(n.allOf)) n.allOf.forEach((b) => visitAll(b, depth + 1));
      if (n.dependencies) {
        for (const trigger of Object.keys(n.dependencies)) {
          const dep = n.dependencies[trigger];
          if (dep && typeof dep === "object" && !Array.isArray(dep)) visitAll(dep, depth + 1);
        }
      }
      if (n !== this.deref(schema)) out.push(n);
    };
    if (mode === "all") visitAll(schema, 0);
    else visitActive(schema, 0);
    return out;
  }

  /** Top-level facet sources with labels, for grouped rendering. */
  _facetSources(schema, value) {
    const s = this.deref(schema);
    const sources = [];
    const isObj = value !== null && typeof value === "object" && !Array.isArray(value);
    if (s.if) {
      const condValid = SF.validate(value, s.if, this.registry).valid;
      const side = condValid ? s.then : s.else;
      if (side) sources.push({ schema: side, label: "", kind: "if" });
    }
    if (Array.isArray(s.allOf)) {
      s.allOf.forEach((b, i) => {
        sources.push({
          schema: b,
          label: `allOf 第 ${i + 1} 支`,
          kind: "allOf",
        });
      });
    }
    if (isObj && s.dependencies) {
      Object.keys(s.dependencies).forEach((trigger, i) => {
        if (!(trigger in value)) return;
        const dep = s.dependencies[trigger];
        if (dep && typeof dep === "object" && !Array.isArray(dep)) {
          sources.push({
            schema: dep,
            label: `依赖 "${trigger}"`,
            kind: "dependencies",
          });
        }
      });
    }
    return sources;
  }

  /**
   * Remove values belonging to facets that are currently inactive:
   * hidden if/else sides, untriggered schema dependencies, keys not
   * carried by the picked oneOf branch. Runs to a fixpoint because
   * deleting a trigger key may deactivate a nested facet in turn.
   * Data the schema says nothing about is left untouched.
   */
  _pruneHidden() {
    const prune = (segments, schema) => {
      const s = this.deref(schema);
      if (!s || typeof s !== "object") return;
      const value = this.getAt(segments);

      if (Array.isArray(s.oneOf)) {
        const p = SF.buildPointer(segments);
        const idx = this.branches.get(p);
        if (idx != null && s.oneOf[idx]) {
          prune(segments, s.oneOf[idx]);
        }
        return; // unselected sibling branches own none of the value
      }

      if (Array.isArray(value)) {
        if (s.items && !Array.isArray(s.items)) {
          value.forEach((_, i) => prune([...segments, i], s.items));
        }
        return;
      }

      if (value === null || typeof value !== "object") return;

      const active = this._objectFacets(s, value, "active");
      const all = this._objectFacets(s, value, "all");
      const activeKeys = new Set();
      const allKeys = new Set();
      const activeSchemaForKey = new Map();
      for (const f of active) {
        for (const k of Object.keys(f.properties || {})) {
          activeKeys.add(k);
          if (!activeSchemaForKey.has(k)) activeSchemaForKey.set(k, f.properties[k]);
        }
      }
      for (const f of all) {
        for (const k of Object.keys(f.properties || {})) allKeys.add(k);
      }

      let changed = false;
      for (const key of Object.keys(value)) {
        if (s.properties && key in s.properties) {
          prune([...segments, key], s.properties[key]);
        } else if (activeKeys.has(key)) {
          prune([...segments, key], activeSchemaForKey.get(key));
        } else if (allKeys.has(key)) {
          // Managed by some facet that is currently inactive: drop it.
          delete value[key];
          changed = true;
        }
        // Key managed by nobody: preserved (handled by
        // additionalProperties at validation time instead).
      }
      return changed;
    };

    if (this.data === undefined) return;
    for (let i = 0; i < 8; i++) {
      if (prune([], this.schema) !== true) break;
    }
  }

  _renderArray(s, segments, container, labelText) {
    const group = el("fieldset", { class: "sf-group sf-array" });
    if (labelText) {
      const legend = el("legend", { class: "sf-group-title" });
      legend.textContent = labelText;
      group.appendChild(legend);
    }

    const arr = this.getAt(segments) || [];
    const rows = el("div", { class: "sf-array-rows" });
    arr.forEach((item, i) => {
      const row = el("div", { class: "sf-array-row" });
      const idxLabel = el("span", { class: "sf-array-index" });
      idxLabel.textContent = `#${i + 1}`;
      row.appendChild(idxLabel);

      const itemWrap = el("div", { class: "sf-array-item" });
      this._renderNode(s.items || {}, [...segments, i], itemWrap, "", false);
      row.appendChild(itemWrap);

      const del = el("button", { type: "button", class: "sf-btn sf-btn-del", title: "删除此行" });
      del.textContent = "删除";
      del.addEventListener("click", () => {
        const cur = this.getAt(segments) || [];
        cur.splice(i, 1);
        this._reindexBranchMeta(segments, i);
        this._refresh(true);
      });
      row.appendChild(del);
      rows.appendChild(row);

      // per-row error slot (array item type errors etc.)
      const errAt = el("div", { class: "sf-errors" });
      errAt.dataset.errorFor = SF.buildPointer([...segments, i]);
      itemWrap.appendChild(errAt);
    });

    const add = el("button", { type: "button", class: "sf-btn sf-btn-add" });
    add.textContent = "+ 添加一行";
    add.addEventListener("click", () => {
      const cur = this.getAt(segments) || [];
      const itemSchema = this.deref(s.items || {});
      // Object rows carry each property's declared `default`; primitives
      // still use the control-level empty convention (enum[0], "", 0...).
      let row = schemaDefaultValue(itemSchema, (x) => this.deref(x));
      if (row === undefined) row = defaultFor(itemSchema);
      cur.push(row);
      this.setAt(segments, cur);
      const rowSegs = [...segments, cur.length - 1];
      this._inferBranches(itemSchema, rowSegs);
      this._pruneHidden();
      this._refresh(true);
    });

    group.appendChild(rows);
    group.appendChild(add);
    const errAt = el("div", { class: "sf-errors sf-group-errors" });
    errAt.dataset.errorFor = SF.buildPointer(segments);
    group.appendChild(errAt);
    container.appendChild(group);
  }

  _reindexBranchMeta(segments, deletedIndex) {
    // Branch/stash pointers are absolute JSON Pointers. After deleting row
    // deletedIndex in the array at `segments`, deeper pointers at index >=
    // deletedIndex shift down one; all other entries are untouched.
    const depth = segments.length;
    const remap = (map) => {
      const next = new Map();
      for (const [pointer, v] of map) {
        const segs = SF.parsePointer(pointer);
        let matches = segs.length > depth;
        for (let d = 0; matches && d < depth; d++) {
          if (segs[d] !== String(segments[d])) matches = false;
        }
        if (!matches) { next.set(pointer, v); continue; }
        const idx = Number(segs[depth]);
        if (!Number.isInteger(idx) || Number.isNaN(idx)) { next.set(pointer, v); continue; }
        if (idx === deletedIndex) continue; // dropped row
        if (idx > deletedIndex) segs[depth] = String(idx - 1);
        next.set(SF.buildPointer(segs), v);
      }
      return next;
    };
    this.branches = remap(this.branches);
    this.stash = remap(this.stash);
    // Re-infer selections that may now be unambiguous.
    this._inferBranches(this.schema, []);
  }

  _renderPrimitive(s, segments, container, labelText, value) {
    const pointer = SF.buildPointer(segments);
    const required = this._isRequired(segments);
    const label = s.title || labelText;
    let control;

    if (Array.isArray(s.enum)) {
      control = el("select", { class: "sf-control sf-select" });
      // Empty placeholder when value is not present yet.
      if (value === undefined) {
        const ph = el("option", { value: "" });
        ph.textContent = "请选择…";
        control.appendChild(ph);
      }
      for (const candidate of s.enum) {
        const opt = el("option", { value: String(candidate) });
        opt.textContent = String(candidate);
        if (candidate === value) opt.selected = true;
        control.appendChild(opt);
      }
      control.addEventListener("change", () => {
        const raw = control.value;
        const chosen = s.enum.find((c) => String(c) === raw);
        if (chosen === undefined) this.deleteAt(segments);
        else this.setAt(segments, chosen);
        this._refresh(false);
      });
    } else {
      const type = s.type === "integer" || s.type === "number" ? s.type : "text";
      control = el("input", {
        class: "sf-control sf-input",
        type: type === "integer" ? "number" : type === "number" ? "number" : "text",
        value: value === undefined || value === null ? "" : String(value),
      });
      if (s.minLength !== undefined) control.minLength = s.minLength;
      if (s.maxLength !== undefined) control.maxLength = s.maxLength;
      if (s.minimum !== undefined) control.min = s.minimum;
      if (s.maximum !== undefined) control.max = s.maximum;
      if (type === "integer") control.step = "1";

      // IME: while composing pinyin (compositionstart..end), do NOT validate,
      // so the field is not painted red letter by letter.
      let composing = false;
      control.addEventListener("compositionstart", () => { composing = true; });
      control.addEventListener("compositionend", () => {
        composing = false;
        this._commitText(s, segments, control.value);
        this._refresh(false);
      });
      control.addEventListener("input", () => {
        if (composing) return;
        this._commitText(s, segments, control.value);
        this._refresh(false);
      });
      control.addEventListener("blur", () => {
        if (composing) return;
        this._commitText(s, segments, control.value);
        this._refresh(false);
      });
    }

    control.dataset.controlFor = pointer;
    control.dataset.path = pointer;
    const wrap = el("div", { class: "sf-row" });
    if (label) {
      const lab = el("span", { class: "sf-label" });
      lab.textContent = label + (required ? " *" : "");
      wrap.appendChild(lab);
    }
    wrap.appendChild(control);
    wrap.appendChild(this._errorSlot(segments));
    container.appendChild(wrap);
  }

  _commitText(s, segments, raw) {
    if (raw === "") { this.deleteAt(segments); return; }
    if (s.type === "integer") {
      if (/^[+-]?\d+$/.test(raw.trim())) this.setAt(segments, Number(raw.trim()));
      else this.setAt(segments, raw); // leave a string -> type error lands here
      return;
    }
    if (s.type === "number") {
      const n = Number(raw);
      if (raw.trim() !== "" && !Number.isNaN(n)) this.setAt(segments, n);
      else this.setAt(segments, raw);
      return;
    }
    this.setAt(segments, raw);
  }

  _renderBoolean(s, segments, container, labelText, value) {
    const pointer = SF.buildPointer(segments);
    const checked = value === true;
    const label = s.title || labelText;
    const control = el("input", { type: "checkbox", class: "sf-control sf-checkbox" });
    control.checked = checked;
    control.dataset.controlFor = pointer;
    control.dataset.path = pointer;
    control.addEventListener("change", () => {
      this.setAt(segments, control.checked);
      this._refresh(false);
    });
    const wrap = el("div", { class: "sf-row sf-row-checkbox" });
    if (label) {
      const lab = el("span", { class: "sf-label sf-label-inline" });
      lab.textContent = label;
      wrap.appendChild(lab);
    }
    wrap.appendChild(control);
    wrap.appendChild(this._errorSlot(segments));
    container.appendChild(wrap);
  }

  _isRequired(segments) {
    if (segments.length === 0) return false;
    const parentSegs = segments.slice(0, -1);
    const parent = this._schemaAt(parentSegs);
    return Array.isArray(parent.required) && parent.required.includes(segments[segments.length - 1]);
  }

  _renderOneOf(s, segments, container, labelText) {
    const pointer = SF.buildPointer(segments);
    const group = el("fieldset", { class: "sf-group sf-oneof" });
    if (labelText) {
      const legend = el("legend", { class: "sf-group-title" });
      legend.textContent = labelText;
      group.appendChild(legend);
    }

    let selected = this.branches.has(pointer) ? this.branches.get(pointer) : null;

    const selectWrap = el("div", { class: "sf-row" });
    const lab = el("span", { class: "sf-label" });
    lab.textContent = "类型";
    const select = el("select", { class: "sf-control sf-select sf-oneof-select" });
    const ph = el("option", { value: "" });
    ph.textContent = "请选择类型…";
    select.appendChild(ph);
    s.oneOf.forEach((branch, i) => {
      const opt = el("option", { value: String(i) });
      opt.textContent = this._branchTitle(branch, i);
      if (i === selected) opt.selected = true;
      select.appendChild(opt);
    });
    selectWrap.appendChild(lab);
    selectWrap.appendChild(select);
    const selectErr = el("div", { class: "sf-errors" });
    selectErr.dataset.errorFor = pointer;
    selectWrap.appendChild(selectErr);
    group.appendChild(selectWrap);

    const branchWrap = el("div", { class: "sf-oneof-body" });
    group.appendChild(branchWrap);

    const renderBranch = (idx) => {
      branchWrap.innerHTML = "";
      if (idx == null) return;
      const branch = s.oneOf[idx];
      this._renderNode(branch, segments, branchWrap, "", false);
    };
    renderBranch(selected);

    select.addEventListener("change", () => {
      const raw = select.value;
      const prev = selected;
      if (raw === "") {
        if (prev != null) {
          this._stash(segments, prev, this.getAt(segments));
          this.deleteAt(segments);
        }
        this.branches.delete(pointer);
        selected = null;
        renderBranch(null);
        this._refresh(false);
        return;
      }
      const idx = Number(raw);
      if (prev != null && prev !== idx) this._stash(segments, prev, this.getAt(segments));
      this.branches.set(pointer, idx);
      selected = idx;
      // Restore data previously entered for this branch, else materialize
      // defaults so its fields actually render.
      const saved = this._unstash(segments, idx);
      this.setAt(segments, saved !== undefined ? saved : defaultFor(this.deref(s.oneOf[idx])));
      renderBranch(idx);
      this._refresh(true);
    });

    container.appendChild(group);
  }

  _branchTitle(branch, i) {
    const s = this.deref(branch);
    if (s.title) return s.title;
    if (s.type === "object" && s.properties) return "对象: " + Object.keys(s.properties).join(", ");
    if (s.const !== undefined) return String(s.const);
    if (Array.isArray(s.enum) && s.enum.length === 1) return String(s.enum[0]);
    return `选项 ${i + 1}`;
  }

  _stash(segments, branchIndex, value) {
    const p = SF.buildPointer(segments);
    if (!this.stash.has(p)) this.stash.set(p, {});
    this.stash.get(p)[branchIndex] = value === undefined
      ? undefined
      : JSON.parse(JSON.stringify(value));
  }

  _unstash(segments, branchIndex) {
    const p = SF.buildPointer(segments);
    const bucket = this.stash.get(p);
    if (!bucket || !(branchIndex in bucket)) return undefined;
    return bucket[branchIndex];
  }
}

// UMD-ish: plain <script> tags (works from file://) and Node's ESM import.
(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(
      SF,
      require("./errors.js"),
      require("./schema-core.js"),
      require("./validator.js")
    );
    module.exports = factory(SF);
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.SchemaForm = SchemaForm;
  return { SchemaForm: SF.SchemaForm };
});
