function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("data-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    if (typeof child === "string") {
      node.appendChild(document.createTextNode(child));
      node.textContent += child;
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

class SchemaForm {
  constructor(rootEl, schema, options = {}) {
    this.root = rootEl;
    this.schema = schema;
    this.compiled = SF.compileSchema(schema);
    this.onChange = options.onChange || (() => {});
    this.model = new SF.SchemaModel(this.compiled, SF.validate);
    this.touched = false;

    // Compatibility accessors. Branch selection itself lives in the model.
    this.branches = this.model.branches;
    this.stash = this.model.stash;

    this._materializeRootDefault();
    this._render();
  }

  deref() { return this.compiled.root; }
  getAt(segments) { return this.model.getAt(segments); }
  setAt(segments, value) { this.model.setAt(segments, value); }
  deleteAt(segments) { this.model.deleteAt(segments); }
  getData() { return this.model.data; }
  toJSONString() { return JSON.stringify(this.model.data, null, 2); }

  setJSON(value) {
    this.touched = false;
    this.model.setJSON(value);
    this._syncStateMaps();
    this._render();
    this.onChange(this.model.data);
  }

  submit() {
    this.touched = true;
    this.model.pruneData(this.compiled.root, this.model.data, []);
    const result = this._validateWithBranches();
    this._applyErrors(result.errors);
    return { valid: result.valid, errors: result.errors, data: this.model.data };
  }

  _syncStateMaps() {
    this.branches = this.model.branches;
    this.stash = this.model.stash;
  }

  _materializeRootDefault() {
    if (this.model.data !== undefined) return;
    const value = SF.defaultFor(this.compiled.root);
    if (value !== undefined) this.model.setAt([], value);
  }

  _validateWithBranches() {
    const result = SF.validate(this.model.data, this.compiled);
    const extra = [];
    for (const [pointer, branchIndex] of this.model.branches) {
      const segments = SF.parsePointer(pointer);
      const oneOfSchema = this._schemaAt(segments, true);
      const branch = oneOfSchema.oneOf[branchIndex];
      const value = this.model.getAt(segments);
      const sub = SF.validate(value, branch, this.compiled);
      if (!sub.valid) {
        for (const error of sub.errors) extra.push({ ...error, path: pointer + error.path });
        extra.push({ path: pointer, keyword: "oneOf", message: "当前选择的类型与字段内容不符" });
      }
    }
    const errors = result.errors.concat(extra);
    return { valid: errors.length === 0, errors };
  }

  _schemaAt(segments, stopAtOneOf = false) {
    if (!stopAtOneOf) return this.model.schemaAt(segments);

    let schema = this.compiled.root;
    let walked = [];
    for (const key of segments) {
      if (Array.isArray(schema.oneOf)) return schema;
      const parentValue = this.model.getAt(walked);
      const isObject = parentValue !== null && typeof parentValue === "object" && !Array.isArray(parentValue);
      if (isObject && (schema.properties || schema.if || schema.allOf || schema.dependencies)) {
        const { fields } = this.model.objectPlan(schema, parentValue);
        const hit = fields.find((field) => field.key === key);
        if (!hit) return schema;
        schema = hit.schema;
      } else if (schema.type === "array" && schema.items && !Array.isArray(schema.items)) {
        schema = schema.items;
      } else {
        return schema;
      }
      walked = walked.concat(key);
    }
    return schema;
  }

  _isRequired(segments) { return this.model.isRequired(segments); }

  _reindexBranchMeta(segments, deletedIndex) {
    this.model.reindexBranchMeta(segments, deletedIndex);
    this._syncStateMaps();
  }

  _commitText(schema, segments, raw) {
    if (raw === "") {
      this.model.deleteAt(segments);
      return;
    }
    if (schema.type === "integer") {
      if (/^[+-]?\d+$/.test(raw.trim())) this.model.setAt(segments, Number(raw.trim()));
      else this.model.setAt(segments, raw);
      return;
    }
    if (schema.type === "number") {
      const number = Number(raw);
      if (raw.trim() !== "" && !Number.isNaN(number)) this.model.setAt(segments, number);
      else this.model.setAt(segments, raw);
      return;
    }
    this.model.setAt(segments, raw);
  }

  _refresh(rebuildNeeded) {
    this.model.pruneData(this.compiled.root, this.model.data, []);
    if (rebuildNeeded) this._render();
    const result = this._validateWithBranches();
    this._applyErrors(result.errors);
    this.onChange(this.model.data);
  }

  _render() {
    const activeElement = document.activeElement;
    const focusPath = activeElement && activeElement.dataset ? activeElement.dataset.path : null;

    this.root.innerHTML = "";
    const tree = SF.buildControlTree(this.model, this.compiled.root, [], "", true);
    const fieldset = el("div", { class: "sf-root" }, this._renderNode(tree));
    this.root.appendChild(fieldset);

    if (focusPath) {
      const target = this.root.querySelector(`[data-path="${CSS.escape(focusPath)}"]`);
      if (target) {
        target.focus();
        if (typeof target.setSelectionRange === "function" && target.value != null) {
          const length = target.value.length;
          try { target.setSelectionRange(length, length); } catch (_) {}
        }
      }
    }

    if (this.touched) this._applyErrors(this._validateWithBranches().errors);
  }

  _renderNode(node) {
    if (node.kind === "object") return this._renderObject(node);
    if (node.kind === "array") return this._renderArray(node);
    if (node.kind === "oneOf") return this._renderOneOf(node);
    if (node.kind === "boolean") return this._renderBoolean(node);
    return this._renderPrimitive(node);
  }

  _renderObject(node) {
    const group = el("fieldset", { class: "sf-group sf-object" });
    if (node.label) group.appendChild(el("legend", { class: "sf-group-title" }, node.label));
    const body = el("div", { class: "sf-group-body" });
    for (const child of node.fields) body.appendChild(this._renderNode(child));
    group.appendChild(body);
    group.appendChild(this._errorSlot(node.segments, "sf-errors sf-group-errors"));
    return group;
  }

  _renderArray(node) {
    const group = el("fieldset", { class: "sf-group sf-array" });
    if (node.label) group.appendChild(el("legend", { class: "sf-group-title" }, node.label));

    const rows = el("div", { class: "sf-array-rows" });
    node.items.forEach((item, index) => {
      const row = el("div", { class: "sf-array-row" });
      row.appendChild(el("span", { class: "sf-array-index" }, `#${index + 1}`));

      const itemWrap = el("div", { class: "sf-array-item" });
      itemWrap.appendChild(this._renderNode(item));
      itemWrap.appendChild(this._errorSlot([...node.segments, index]));
      row.appendChild(itemWrap);

      const del = el("button", { type: "button", class: "sf-btn sf-btn-del", title: "删除此行" }, "删除");
      del.addEventListener("click", () => {
        const current = this.model.getAt(node.segments) || [];
        current.splice(index, 1);
        this._reindexBranchMeta(node.segments, index);
        this._refresh(true);
      });
      row.appendChild(del);
      rows.appendChild(row);
    });

    const add = el("button", { type: "button", class: "sf-btn sf-btn-add" }, "+ 添加一行");
    add.addEventListener("click", () => {
      const current = this.model.getAt(node.segments) || [];
      current.push(SF.materializeDefault(node.schema.items || {}));
      this.model.setAt(node.segments, current);
      this._refresh(true);
    });

    group.appendChild(rows);
    group.appendChild(add);
    group.appendChild(this._errorSlot(node.segments, "sf-errors sf-group-errors"));
    return group;
  }

  _renderPrimitive(node) {
    const wrap = el("div", { class: "sf-row" });
    if (node.label) {
      wrap.appendChild(el("span", { class: "sf-label" }, node.label + (node.required ? " *" : "")));
    }

    const schema = node.schema;
    let control;
    if (node.control === "select") {
      control = el("select", { class: "sf-control sf-select" });
      if (node.value === undefined) control.appendChild(el("option", { value: "" }, "请选择…"));
      for (const candidate of schema.enum) {
        const option = el("option", { value: String(candidate) }, String(candidate));
        if (candidate === node.value) option.selected = true;
        control.appendChild(option);
      }
      control.addEventListener("change", () => {
        const chosen = schema.enum.find((candidate) => String(candidate) === control.value);
        if (chosen === undefined) this.model.deleteAt(node.segments);
        else this.model.setAt(node.segments, chosen);
        this._refresh(true);
      });
    } else {
      control = el("input", {
        class: "sf-control sf-input",
        type: schema.type === "integer" || schema.type === "number" ? "number" : "text",
        value: node.value === undefined || node.value === null ? "" : String(node.value),
      });
      if (schema.minLength !== undefined) control.minLength = schema.minLength;
      if (schema.maxLength !== undefined) control.maxLength = schema.maxLength;
      if (schema.minimum !== undefined) control.min = schema.minimum;
      if (schema.maximum !== undefined) control.max = schema.maximum;
      if (schema.type === "integer") control.step = "1";

      let composing = false;
      control.addEventListener("compositionstart", () => { composing = true; });
      control.addEventListener("compositionend", (event) => {
        if (event && event.isComposing) return;
        composing = false;
        this._commitText(schema, node.segments, control.value);
        this._refresh(true);
      });
      control.addEventListener("input", (event) => {
        if (composing || (event && event.isComposing)) return;
        this._commitText(schema, node.segments, control.value);
        this._refresh(false);
      });
      control.addEventListener("blur", (event) => {
        if (composing || (event && event.isComposing)) return;
        this._commitText(schema, node.segments, control.value);
        this._refresh(false);
      });
    }

    control.dataset.controlFor = node.path;
    control.dataset.path = node.path;
    wrap.appendChild(control);
    wrap.appendChild(this._errorSlot(node.segments));
    return wrap;
  }

  _renderBoolean(node) {
    const wrap = el("div", { class: "sf-row sf-row-checkbox" });
    if (node.label) wrap.appendChild(el("span", { class: "sf-label sf-label-inline" }, node.label));
    const control = el("input", {
      type: "checkbox",
      class: "sf-control sf-checkbox",
      checked: node.value === true,
    });
    control.dataset.controlFor = node.path;
    control.dataset.path = node.path;
    control.addEventListener("change", () => {
      this.model.setAt(node.segments, control.checked);
      this._refresh(true);
    });
    wrap.appendChild(control);
    wrap.appendChild(this._errorSlot(node.segments));
    return wrap;
  }

  _renderOneOf(node) {
    const group = el("fieldset", { class: "sf-group sf-oneof" });
    if (node.label) group.appendChild(el("legend", { class: "sf-group-title" }, node.label));

    const selectWrap = el("div", { class: "sf-row" });
    selectWrap.appendChild(el("span", { class: "sf-label" }, "类型"));
    const select = el("select", { class: "sf-control sf-select sf-oneof-select" });
    select.appendChild(el("option", { value: "" }, "请选择类型…"));
    node.branches.forEach((branch) => {
      const option = el("option", { value: String(branch.index) }, branch.label);
      if (branch.index === node.selected) option.selected = true;
      select.appendChild(option);
    });
    selectWrap.appendChild(select);
    selectWrap.appendChild(this._errorSlot(node.segments));
    group.appendChild(selectWrap);

    const body = el("div", { class: "sf-oneof-body" });
    if (node.child) body.appendChild(this._renderNode(node.child));
    group.appendChild(body);

    select.addEventListener("change", () => {
      if (select.value === "") {
        this.model.clearBranch(node.segments);
        this._syncStateMaps();
        this._refresh(true);
        return;
      }
      this.model.selectBranch(node.segments, Number(select.value));
      this._syncStateMaps();
      this._refresh(true);
    });
    return group;
  }

  _errorSlot(segments, className = "sf-errors") {
    const slot = el("div", { class: className });
    slot.dataset.errorFor = SF.buildPointer(segments);
    return slot;
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
      for (const message of messages) {
        node.appendChild(el("div", { class: "sf-error-msg" }, message));
      }
    });
    this.root.querySelectorAll("[data-control-for]").forEach((node) => {
      node.classList.toggle("sf-invalid", byPath.has(node.dataset.controlFor));
    });
  }
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(
      SF,
      require("./errors.js"),
      require("./schema-core.js"),
      require("./schema-normalize.js"),
      require("./schema-expand.js"),
      require("./schema-layout.js"),
      require("./schema-model.js"),
      require("./control-tree.js"),
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
