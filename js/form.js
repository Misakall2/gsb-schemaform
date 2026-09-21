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

function explicitDefault(schema) {
  if (!schema || typeof schema !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(schema, "default")) {
    return JSON.parse(JSON.stringify(schema.default));
  }
  if (schema.type === "object" && schema.properties) {
    const out = {};
    let any = false;
    for (const key of Object.keys(schema.properties)) {
      const value = explicitDefault(schema.properties[key]);
      if (value !== undefined) { out[key] = value; any = true; }
    }
    return any ? out : undefined;
  }
  return undefined;
}

function objectDefault(schema) { return explicitDefault(schema) || {}; }

function defaultFor(schema) {
  if (!schema || typeof schema !== "object") return undefined;
  if (Array.isArray(schema.enum)) return schema.enum.includes(undefined) ? undefined : schema.enum[0];
  switch (schema.type) {
    case "string": return "";
    case "number":
    case "integer": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return objectDefault(schema);
    default: return undefined;
  }
}

function materializeDefault(schema) {
  if (Object.prototype.hasOwnProperty.call(schema || {}, "default")) {
    return JSON.parse(JSON.stringify(schema.default));
  }
  return schema && schema.type === "object" ? objectDefault(schema) : defaultFor(schema);
}

class SchemaForm {
  constructor(rootEl, schema, options = {}) {
    this.root = rootEl;
    this.registry = new SF.SchemaRegistry(schema);
    this.source = schema;
    this.schema = this.registry.root;
    this.onChange = options.onChange || (() => {});
    this.data = undefined;
    this.branches = new Map();
    this.stash = new Map();
    this.touched = false;
    this.lastErrors = [];
    this._render();
  }

  deref(schema) { return this.registry.deref(schema); }
  getAt(segments) {
    let node = this.data;
    for (const key of segments) {
      if (node === undefined || node === null || typeof node !== "object") return undefined;
      node = node[key];
    }
    return node;
  }
  setAt(segments, value) {
    if (!segments.length) { this.data = value; return; }
    let node = this.data;
    if (node === undefined || node === null || typeof node !== "object") {
      node = /^\d+$/.test(segments[0]) ? [] : {};
      this.data = node;
    }
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i], next = segments[i + 1];
      if (node[key] === undefined || node[key] === null || typeof node[key] !== "object") {
        node[key] = /^\d+$/.test(next) ? [] : {};
      }
      node = node[key];
    }
    const last = segments[segments.length - 1];
    node[/^\d+$/.test(last) ? Number(last) : last] = value;
  }
  deleteAt(segments) {
    if (!segments.length) { this.data = undefined; return; }
    let node = this.data;
    for (let i = 0; i < segments.length - 1; i++) {
      if (node === undefined || node === null || typeof node !== "object") return;
      node = node[segments[i]];
    }
    if (node && typeof node === "object") delete node[segments[segments.length - 1]];
  }
  getData() { return this.data; }

  submit() {
    this.touched = true;
    SF.pruneFormData(this.schema, this.data, [], this.branches);
    const result = SF.validate(this.data, this.schema, this.registry, { branches: this.branches });
    this.lastErrors = result.errors;
    this._applyErrors(result.errors);
    return { valid: result.valid, errors: result.errors, data: this.data };
  }

  setJSON(value) {
    this.data = value === undefined ? undefined : this._normalizeValue(this.schema, value);
    this.branches = new Map();
    this.stash = new Map();
    this.touched = false;
    SF.inferBranches(this.schema, (segments) => this.getAt(segments), [], this.branches);
    SF.pruneFormData(this.schema, this.data, [], this.branches);
    this._render();
    this.onChange(this.data);
  }

  toJSONString() { return JSON.stringify(this.data, null, 2); }

  _normalizeValue(schema, value) {
    if (!schema || value === null || value === undefined) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }
    if (Array.isArray(schema.oneOf)) {
      for (const branch of schema.oneOf) {
        if (SF.validateNormalized(value, branch).valid) return this._normalizeValue(branch, value);
      }
      return JSON.parse(JSON.stringify(value));
    }
    if (Array.isArray(value) && schema.items) {
      return value.map((item) => this._normalizeValue(schema.items, item));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const layout = SF.createObjectLayout(schema, value);
      const childSchemas = {};
      layout.fields.forEach((field) => {
        if (layout.active.has(field.key)) childSchemas[field.key] = field.schema;
      });
      const out = {};
      for (const key of Object.keys(value)) {
        if (layout.hidden.has(key)) continue;
        const normalized = this._normalizeValue(childSchemas[key] || {}, value[key]);
        if (normalized !== undefined) out[key] = normalized;
      }
      return out;
    }
    if (typeof value === "string" && value === "" && !Array.isArray(schema.enum)) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  _validateWithBranches() {
    return SF.validate(this.data, this.schema, this.registry, { branches: this.branches });
  }
  _schemaAt(segments) {
    return SF.findSchemaAt(this.schema, segments, (walked) => this.getAt(walked), this.branches);
  }

  _render() {
    const activeElement = document.activeElement;
    const focusPath = activeElement && activeElement.dataset ? activeElement.dataset.path : null;

    let value = this.data;
    if (value === undefined) {
      const defaultValue = defaultFor(this.schema);
      if (defaultValue !== undefined) {
        this.setAt([], defaultValue);
        value = defaultValue;
      }
    }

    const tree = SF.buildControlTree(this.schema, value, [], this.branches, "");
    this.root.innerHTML = "";
    const mount = el("div", { class: "sf-root" });
    this._renderNode(tree, mount);
    this.root.appendChild(mount);

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
    if (this.touched) this._applyErrors(this._validateWithBranches().errors);
  }

  _refresh(rebuildNeeded) {
    SF.pruneFormData(this.schema, this.data, [], this.branches);
    if (rebuildNeeded) this._render();
    const result = this._validateWithBranches();
    this.lastErrors = result.errors;
    this._applyErrors(result.errors);
    this.onChange(this.data);
  }

  _applyErrors(errors) {
    const byPath = new Map();
    for (const error of errors) {
      if (!byPath.has(error.path)) byPath.set(error.path, []);
      byPath.get(error.path).push(error.message);
    }
    this.root.querySelectorAll("[data-error-for]").forEach((node) => {
      const messages = byPath.get(node.dataset.errorFor) || [];
      node.innerHTML = "";
      node.classList.toggle("sf-error", messages.length > 0);
      messages.forEach((message) => {
        const row = el("div", { class: "sf-error-msg" });
        row.textContent = message;
        node.appendChild(row);
      });
    });
    this.root.querySelectorAll("[data-control-for]").forEach((node) => {
      node.classList.toggle("sf-invalid", byPath.has(node.dataset.controlFor));
    });
  }

  _errorSlot(segments) {
    const node = el("div", { class: "sf-errors" });
    node.dataset.errorFor = SF.buildPointer(segments);
    return node;
  }

  _renderNode(node, container) {
    if (node.kind === "object") this._renderObject(node, container);
    else if (node.kind === "array") this._renderArray(node, container);
    else if (node.kind === "oneOf") this._renderOneOf(node, container);
    else this._renderControl(node, container);
  }

  _renderObject(node, container) {
    const group = el("fieldset", { class: "sf-group sf-object" });
    if (node.label) {
      const legend = el("legend", { class: "sf-group-title" });
      legend.textContent = node.label;
      group.appendChild(legend);
    }
    const body = el("div", { class: "sf-group-body" });
    node.children.forEach((child) => this._renderNode(child, body));
    group.appendChild(body);
    const errors = el("div", { class: "sf-errors sf-group-errors" });
    errors.dataset.errorFor = node.errorPointer;
    group.appendChild(errors);
    container.appendChild(group);
  }

  _renderArray(node, container) {
    const group = el("fieldset", { class: "sf-group sf-array" });
    if (node.label) {
      const legend = el("legend", { class: "sf-group-title" });
      legend.textContent = node.label;
      group.appendChild(legend);
    }
    const rows = el("div", { class: "sf-array-rows" });
    node.rows.forEach((itemNode, index) => {
      const row = el("div", { class: "sf-array-row" });
      const indexLabel = el("span", { class: "sf-array-index" });
      indexLabel.textContent = `#${index + 1}`;
      row.appendChild(indexLabel);
      const itemWrap = el("div", { class: "sf-array-item" });
      this._renderNode(itemNode, itemWrap);
      row.appendChild(itemWrap);
      const remove = el("button", { type: "button", class: "sf-btn sf-btn-del", title: "删除此行" });
      remove.textContent = "删除";
      remove.addEventListener("click", () => {
        const current = this.getAt(node.segments) || [];
        current.splice(index, 1);
        this._reindexBranchMeta(node.segments, index);
        this._refresh(true);
      });
      row.appendChild(remove);
      rows.appendChild(row);
      const errors = el("div", { class: "sf-errors" });
      errors.dataset.errorFor = SF.buildPointer(node.segments.concat(index));
      itemWrap.appendChild(errors);
    });
    const add = el("button", { type: "button", class: "sf-btn sf-add" });
    add.textContent = "+ 添加一行";
    add.addEventListener("click", () => {
      const current = this.getAt(node.segments) || [];
      current.push(materializeDefault(node.items));
      this.setAt(node.segments, current);
      this._refresh(true);
    });
    group.appendChild(rows);
    group.appendChild(add);
    const errors = el("div", { class: "sf-errors sf-group-errors" });
    errors.dataset.errorFor = node.errorPointer;
    group.appendChild(errors);
    container.appendChild(group);
  }

  _renderOneOf(node, container) {
    const group = el("fieldset", { class: "sf-group sf-oneof" });
    if (node.label) {
      const legend = el("legend", { class: "sf-group-title" });
      legend.textContent = node.label;
      group.appendChild(legend);
    }
    const selectWrap = el("div", { class: "sf-row" });
    const label = el("span", { class: "sf-label" });
    label.textContent = "类型";
    const select = el("select", { class: "sf-control sf-select sf-oneof-select" });
    const placeholder = el("option", { value: "" });
    placeholder.textContent = "请选择类型…";
    select.appendChild(placeholder);
    node.options.forEach((option) => {
      const optionNode = el("option", { value: String(option.index) });
      optionNode.textContent = option.label;
      if (option.index === node.selected) optionNode.selected = true;
      select.appendChild(optionNode);
    });
    selectWrap.appendChild(label);
    selectWrap.appendChild(select);
    const selectErrors = el("div", { class: "sf-errors" });
    selectErrors.dataset.errorFor = node.pointer;
    selectWrap.appendChild(selectErrors);
    group.appendChild(selectWrap);

    const body = el("div", { class: "sf-oneof-body" });
    group.appendChild(body);
    if (node.branch) this._renderNode(node.branch, body);

    select.addEventListener("change", () => {
      const raw = select.value;
      const previous = node.selected;
      if (raw === "") {
        if (previous != null) {
          this._stash(node.segments, previous, this.getAt(node.segments));
          this.deleteAt(node.segments);
        }
        this.branches.delete(node.pointer);
        this._refresh(true);
        return;
      }
      const index = Number(raw);
      if (previous != null && previous !== index) {
        this._stash(node.segments, previous, this.getAt(node.segments));
      }
      this.branches.set(node.pointer, index);
      const saved = this._unstash(node.segments, index);
      this.setAt(node.segments, saved !== undefined ? saved : defaultFor(node.schema.oneOf[index]));
      this._refresh(true);
    });

    container.appendChild(group);
  }

  _renderControl(node, container) {
    const { schema: s, segments, pointer, label: labelText } = node;
    const required = this._isRequired(segments);
    const label = s.title || labelText;
    let control;

    if (node.control === "select") {
      control = el("select", { class: "sf-control sf-select" });
      if (node.value === undefined) {
        const placeholder = el("option", { value: "" });
        placeholder.textContent = "请选择…";
        control.appendChild(placeholder);
      }
      for (const candidate of s.enum) {
        const option = el("option", { value: String(candidate) });
        option.textContent = String(candidate);
        if (candidate === node.value) option.selected = true;
        control.appendChild(option);
      }
      control.addEventListener("change", () => {
        const chosen = s.enum.find((candidate) => String(candidate) === control.value);
        if (chosen === undefined) this.deleteAt(segments);
        else this.setAt(segments, chosen);
        this._refresh(true);
      });
    } else if (node.control === "checkbox") {
      control = el("input", { type: "checkbox", class: "sf-control sf-checkbox" });
      control.checked = node.value === true;
      control.addEventListener("change", () => {
        this.setAt(segments, control.checked);
        this._refresh(true);
      });
    } else {
      control = el("input", {
        class: "sf-control sf-input",
        type: s.type === "integer" || s.type === "number" ? "number" : "text",
        value: node.value === undefined || node.value === null ? "" : String(node.value),
      });
      if (s.minLength !== undefined) control.minLength = s.minLength;
      if (s.maxLength !== undefined) control.maxLength = s.maxLength;
      if (s.minimum !== undefined) control.min = s.minimum;
      if (s.maximum !== undefined) control.maximum = s.maximum;
      if (s.type === "integer") control.step = "1";

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
    const wrap = el("div", { class: node.control === "checkbox" ? "sf-row sf-row-checkbox" : "sf-row" });
    if (label) {
      const labelNode = el("span", {
        class: node.control === "checkbox" ? "sf-label sf-label-inline" : "sf-label",
      });
      labelNode.textContent = label + (required ? " *" : "");
      wrap.appendChild(labelNode);
    }
    wrap.appendChild(control);
    wrap.appendChild(this._errorSlot(segments));
    container.appendChild(wrap);
  }

  _commitText(s, segments, raw) {
    if (raw === "") { this.deleteAt(segments); return; }
    if (s.type === "integer") {
      if (/^[+-]?\d+$/.test(raw.trim())) this.setAt(segments, Number(raw.trim()));
      else this.setAt(segments, raw);
      return;
    }
    if (s.type === "number") {
      const number = Number(raw);
      if (raw.trim() !== "" && !Number.isNaN(number)) this.setAt(segments, number);
      else this.setAt(segments, raw);
      return;
    }
    this.setAt(segments, raw);
  }

  _isRequired(segments) {
    if (!segments.length) return false;
    const parentSegments = segments.slice(0, -1);
    const key = segments[segments.length - 1];
    const parentSchema = this._schemaAt(parentSegments);
    const value = this.getAt(parentSegments);
    if (!(value && typeof value === "object" && !Array.isArray(value))) {
      return Array.isArray(parentSchema.required) && parentSchema.required.includes(key);
    }
    return SF.createObjectLayout(parentSchema, value).requiredForRendering.has(key);
  }

  _reindexBranchMeta(segments, deletedIndex) {
    const depth = segments.length;
    const remap = (map) => {
      const next = new Map();
      for (const [pointer, value] of map) {
        const parts = SF.parsePointer(pointer);
        let matches = parts.length > depth;
        for (let i = 0; matches && i < depth; i++) {
          if (parts[i] !== String(segments[i])) matches = false;
        }
        if (!matches) { next.set(pointer, value); continue; }
        const index = Number(parts[depth]);
        if (!Number.isInteger(index) || Number.isNaN(index)) { next.set(pointer, value); continue; }
        if (index === deletedIndex) continue;
        if (index > deletedIndex) parts[depth] = String(index - 1);
        next.set(SF.buildPointer(parts), value);
      }
      return next;
    };
    this.branches = remap(this.branches);
    this.stash = remap(this.stash);
    SF.inferBranches(this.schema, (walked) => this.getAt(walked), [], this.branches);
  }

  _stash(segments, branchIndex, value) {
    const pointer = SF.buildPointer(segments);
    if (!this.stash.has(pointer)) this.stash.set(pointer, {});
    this.stash.get(pointer)[branchIndex] = value === undefined
      ? undefined
      : JSON.parse(JSON.stringify(value));
  }

  _unstash(segments, branchIndex) {
    const bucket = this.stash.get(SF.buildPointer(segments));
    if (!bucket || !(branchIndex in bucket)) return undefined;
    return bucket[branchIndex];
  }
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(SF, require("./errors.js"), require("./schema-core.js"));
    require("./schema-layout.js");
    require("./validator.js");
    module.exports = factory(SF);
  } else factory(SF);
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.SchemaForm = SchemaForm;
  return { SchemaForm: SF.SchemaForm };
});
