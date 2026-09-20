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
    case "object": return objectDefault(s);
    default: return undefined;
  }
}

/**
 * Build the value a freshly added object row starts with. Only keys that
 * carry an explicit schema `default` (nested objects included) are
 * materialized, so a row with `{}` schema still starts empty.
 */
function explicitDefault(s) {
  if (!s || typeof s !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(s, "default")) {
    return JSON.parse(JSON.stringify(s.default));
  }
  if (s.type === "object" && s.properties) {
    const out = {};
    let any = false;
    for (const key of Object.keys(s.properties)) {
      const v = explicitDefault(s.properties[key]);
      if (v !== undefined) { out[key] = v; any = true; }
    }
    return any ? out : undefined;
  }
  return undefined;
}

function objectDefault(s) {
  return explicitDefault(s) || {};
}

/** Like defaultFor, but an explicit schema `default` always wins. */
function materializeDefault(s) {
  if (!s || typeof s !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(s, "default")) {
    return JSON.parse(JSON.stringify(s.default));
  }
  if (s.type === "object") return objectDefault(s);
  return defaultFor(s);
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
    // Hidden conditional / dependency fields must never leak into the output.
    this._pruneData(this.schema, this.data, []);
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
    this._pruneData(this.schema, this.data, []);
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
      // Same merged view used for rendering (if/then, dependencies, allOf).
      const { fields, active, hidden } = this._objectLayout(s, value);
      const propSchemas = {};
      for (const f of fields) {
        if (active.has(f.key)) propSchemas[f.key] = f.schema;
      }
      for (const key of Object.keys(value)) {
        // Keys owned by a hidden conditional/dependency group are dirty
        // values and are dropped on load. Genuinely unknown keys are
        // kept verbatim so additionalProperties:false can flag them.
        if (hidden.has(key)) continue;
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
      if (matches.length === 1 && !this.branches.has(p)) this.branches.set(p, matches[0].i);
    }
    const value = this.getAt(segments);
    const isObject = value && typeof value === "object" && !Array.isArray(value);
    if (isObject && (s.properties || s.if || s.allOf || s.dependencies)) {
      const { fields } = this._objectLayout(s, value);
      for (const f of fields) {
        this._inferBranches(f.schema, [...segments, f.key]);
      }
    }
    if (s.type === "array" && s.items && !Array.isArray(s.items)) {
      const arr = this.getAt(segments);
      if (Array.isArray(arr)) arr.forEach((_, i) => this._inferBranches(s.items, [...segments, i]));
    }
  }

  // --- validation, including the explicit oneOf branch selection rule ---

  /**
   * Object layout: what to render/allow for `schema` evaluated against
   * `value`.
   *
   * fields:  [{key, schema}] in render order, de-duplicated by key
   *         (the schema that contributes a key first wins, matching the
   *         order base props -> active conditional -> active dependencies ->
   *         allOf branches).
   * active:  Set of keys contributed by at least one ACTIVE group
   * hidden:  Set of keys owned only by inactive conditional/dependency
   *         groups (safe to prune from the data when hidden).
   *
   * allOf branches are always active and merged flat into the same
   * object, as required.
   */
  _objectLayout(schema, value) {
    const root = this.deref(schema);
    const fields = [];
    const seen = new Set();
    const active = new Set();
    const hidden = new Set();

    const addField = (key, childSchema, isActive) => {
      if (!seen.has(key)) {
        seen.add(key);
        fields.push({ key, schema: childSchema });
      }
      if (isActive) active.add(key);
    };

    // base properties are always present
    if (root && root.properties) {
      for (const key of Object.keys(root.properties)) {
        addField(key, root.properties[key], true);
      }
    }

    // Merge an object-contributing schema into the layout.
    const contribute = (sc, isActive) => {
      const d = this.deref(sc);
      if (!d || typeof d !== "object") return;
      if (d.properties) {
        for (const key of Object.keys(d.properties)) addField(key, d.properties[key], isActive);
      }
      if (Array.isArray(d.allOf)) {
        for (const branch of d.allOf) contribute(branch, isActive);
      }
      if (d.dependencies && value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const trigger of Object.keys(d.dependencies)) {
          const on = Object.prototype.hasOwnProperty.call(value, trigger);
          const dep = d.dependencies[trigger];
          if (dep && typeof dep === "object" && !Array.isArray(dep)) {
            contribute(dep, isActive && on);
          }
        }
      }
      if (d.if) {
        const on = SF.validate(value, d.if, this.registry).valid;
        // both sides must contribute their keys for ownership tracking;
        // only the picked side is active.
        contribute(d.then, isActive && on);
        contribute(d.else, isActive && !on);
      }
    };
    if (root) contribute(root, true);

    for (const f of fields) {
      if (!active.has(f.key)) hidden.add(f.key);
    }
    return { fields, active, hidden };
  }

  /**
   * Remove values belonging to fields that the current layout hides
   * (failed if/else side, inactive dependency group, or an unselected
   * oneOf branch). Recurses through objects and arrays and descends into
   * the picked oneOf branch.
   */
  _pruneData(schema, value, segments) {
    const s = this.deref(schema);
    if (!s || value === null || value === undefined) return;

    if (Array.isArray(s.oneOf)) {
      const idx = this.branches.get(SF.buildPointer(segments));
      if (idx !== undefined && s.oneOf[idx]) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const ownedBySelected = new Set();
          const ownedByAny = new Set();
          s.oneOf.forEach((branch, branchIndex) => {
            const keys = new Set();
            this._collectOwnedKeys(branch, keys);
            for (const key of keys) {
              ownedByAny.add(key);
              if (branchIndex === idx) ownedBySelected.add(key);
            }
          });
          for (const key of Object.keys(value)) {
            if (ownedByAny.has(key) && !ownedBySelected.has(key)) delete value[key];
          }
        }
        this._pruneData(s.oneOf[idx], value, segments);
      }
      return;
    }

    if (Array.isArray(value) && s.items && !Array.isArray(s.items)) {
      value.forEach((_, i) => this._pruneData(s.items, value[i], [...segments, i]));
      return;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const { hidden } = this._objectLayout(s, value);
      for (const key of hidden) {
        if (Object.prototype.hasOwnProperty.call(value, key)) delete value[key];
      }
      const { fields } = this._objectLayout(s, value);
      for (const f of fields) {
        if (value[f.key] !== undefined) {
          this._pruneData(f.schema, value[f.key], [...segments, f.key]);
        }
      }
    }
  }

  /**
   * Property keys that a schema can render in any of its conditional,
   * dependency, allOf, or nested oneOf branches.
   */
  _collectOwnedKeys(schema, out) {
    const s = this.deref(schema);
    if (!s || typeof s !== "object") return;
    if (s.properties) Object.keys(s.properties).forEach((key) => out.add(key));
    if (Array.isArray(s.allOf)) s.allOf.forEach((branch) => this._collectOwnedKeys(branch, out));
    if (Array.isArray(s.oneOf)) s.oneOf.forEach((branch) => this._collectOwnedKeys(branch, out));
    if (s.then) this._collectOwnedKeys(s.then, out);
    if (s.else) this._collectOwnedKeys(s.else, out);
    if (s.dependencies) {
      for (const dep of Object.values(s.dependencies)) {
        if (dep && typeof dep === "object" && !Array.isArray(dep)) this._collectOwnedKeys(dep, out);
      }
    }
  }

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
        for (const e of sub.errors) {
          extra.push({
            ...e,
            path: pointer + e.path,
          });
        }
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

      // Resolve a property against the SAME merged layout the
      // renderer uses: own props, active if/then side, active
      // dependency schemas, and allOf branches.
      const parentValue = this.getAt(walked);
      if (parentValue && typeof parentValue === "object" && !Array.isArray(parentValue) &&
          (s.properties || s.if || s.allOf || s.dependencies)) {
        const { fields } = this._objectLayout(s, parentValue);
        const hit = fields.find((f) => f.key === key);
        if (hit) s = hit.schema;
        else return this.deref(s);
      } else if (s.type === "array" && s.items && !Array.isArray(s.items)) {
        s = s.items;
      } else {
        return this.deref(s);
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
    // Keep hidden conditional / dependency values out of the data
    // model at all times, not just on submit.
    this._pruneData(this.schema, this.data, []);
    if (rebuildNeeded) {
      this._render();
    }
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

    // Merged layout: base properties + active if/then side +
    // active dependency schemas + every allOf branch, flattened together.
    const { fields, active } = this._objectLayout(s, value);
    for (const f of fields) {
      if (!active.has(f.key)) continue; // hidden conditional/dependency group
      this._renderNode(f.schema, [...segments, f.key], body, f.key, false);
    }

    const errAt = el("div", { class: "sf-errors sf-group-errors" });
    errAt.dataset.errorFor = SF.buildPointer(segments);
    group.appendChild(errAt);

    container.appendChild(group);
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
      // New object rows carry the schema's declared defaults
      // (recursively); plain {} rows still start empty.
      cur.push(materializeDefault(itemSchema));
      this.setAt(segments, cur);
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
        // An enum value is a common if/dependency trigger: fields
        // may appear/disappear, so rebuild the whole layout.
        this._refresh(true);
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
      control.addEventListener("compositionend", (event) => {
        if (event && event.isComposing) return;
        composing = false;
        this._commitText(s, segments, control.value);
        this._refresh(true);
      });
      control.addEventListener("input", (event) => {
        if (composing || (event && event.isComposing)) return;
        this._commitText(s, segments, control.value);
        this._refresh(false);
      });
      control.addEventListener("blur", (event) => {
        if (composing || (event && event.isComposing)) return;
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
      this._refresh(true);
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
    const key = segments[segments.length - 1];
    const parentSchema = this._schemaAt(parentSegs);
    if (!parentSchema) return false;
    const value = this.getAt(parentSegs);
    if (!(value && typeof value === "object" && !Array.isArray(value))) {
      return Array.isArray(parentSchema.required) && parentSchema.required.includes(key);
    }
    // Union of required[] across the base schema, active conditional side,
    // active dependency schemas and every allOf branch.
    const required = new Set(Array.isArray(parentSchema.required) ? parentSchema.required : []);
    const collect = (sc, isActive) => {
      const d = this.deref(sc);
      if (!d || typeof d !== "object") return;
      if (Array.isArray(d.required) && isActive) d.required.forEach((r) => required.add(r));
      if (Array.isArray(d.allOf)) d.allOf.forEach((b) => collect(b, isActive));
      if (d.dependencies) {
        for (const trigger of Object.keys(d.dependencies)) {
          const on = Object.prototype.hasOwnProperty.call(value, trigger);
          const dep = d.dependencies[trigger];
          if (dep && typeof dep === "object" && !Array.isArray(dep)) collect(dep, isActive && on);
          else if (Array.isArray(dep) && isActive && on) dep.forEach((r) => required.add(r));
        }
      }
      if (d.if) {
        const on = SF.validate(value, d.if, this.registry).valid;
        collect(d.then, isActive && on);
        collect(d.else, isActive && !on);
      }
    };
    collect(parentSchema, true);
    return required.has(key);
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
