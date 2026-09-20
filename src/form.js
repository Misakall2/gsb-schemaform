// Dynamic form renderer driven by the same schema consumed by validator.js.
// No framework: plain DOM. Re-renders on change with focus restored, which
// keeps oneOf / if-then-else branching trivially consistent.

import { deref, formatPath } from './schema-core.js';
import { validate, matches } from './validator.js';

const BRANCH = Symbol('oneOfBranch');
const BRANCH_VALUES = Symbol('oneOfValues');

const isBranchWrapper = (v) =>
  v !== null && typeof v === 'object' && BRANCH in v;

const isObjectSchema = (node) => node
  && (node.type === 'object' || (node.type === undefined && node.properties));

export class SchemaForm {
  constructor(schema, container, { onChange } = {}) {
    this.root = schema;
    this.container = container;
    this.onChange = onChange || (() => {});
    this.errorMap = new Map();
    this.showErrors = false;
    this.container.classList.add('sf');
    this.setData(undefined);
  }

  // Fill the form from external JSON (round-trip support).
  // `quiet` hides the red-error layer (fresh init / reset). Loading JSON with
  // problems passes quiet=false so its errors render immediately.
  setData(data, { quiet = true } = {}) {
    this.showErrors = !quiet;
    this.state = buildState(this.root, data, this.root);
    this.rerender(false);
  }

  // Emitted value. Empty optional numeric fields are omitted; inactive
  // oneOf branch state and inactive if/then branch props are excluded.
  getData() {
    return serialize(this.root, this.state, this.root);
  }

  validate() {
    const data = this.getData();
    const result = validate(this.root, data);
    this.errorMap = new Map(result.errors.map((e) => [e.path, e.message]));
    return { data, result };
  }

  rerender(restoreFocus = true) {
    const activeEl = document.activeElement;
    const focusPath = restoreFocus && activeEl && activeEl.getAttribute
      ? activeEl.getAttribute('data-path')
      : null;
    const caret = focusPath && activeEl.selectionStart != null
      ? activeEl.selectionStart
      : null;

    const { data, result } = this.validate();

    this.container.replaceChildren();
    const body = document.createElement('div');
    body.className = 'sf-body';
    renderNode(this.root, this.state, [], body, this);
    this.container.appendChild(body);

    if (focusPath) {
      const target = this.container.querySelector(
        `[data-path="${cssAttrEscape(focusPath)}"]`,
      );
      if (target) {
        target.focus();
        if (caret != null && target.setSelectionRange) {
          try {
            target.setSelectionRange(caret, caret);
          } catch (_) {
            /* type=number may reject ranges */
          }
        }
      }
    }
    // Until the first edit (or explicit submit), errors stay computed but are
    // hidden, so an empty freshly-rendered form is not a wall of red text.
    this.onChange(data,
      this.showErrors ? result : { valid: result.valid, errors: [] });
  }

  setScalar(path, value) {
    const { holder, key } = this.locate(path);
    holder[key] = value;
    this.showErrors = true;
    this.rerender();
  }

  toggleBoolean(path, checked) {
    this.setScalar(path, checked);
  }

  selectBranch(path, index) {
    this.resolve(path)[BRANCH] = index;
    this.showErrors = true;
    this.rerender();
  }

  addArrayItem(path, itemSchema) {
    this.resolve(path).push(buildState(itemSchema, undefined, this.root));
    this.showErrors = true;
    this.rerender();
  }

  removeArrayItem(path, index) {
    this.resolve(path).splice(index, 1);
    this.showErrors = true;
    this.rerender();
  }

  // Explicit submission: force every error onto its control.
  submit() {
    this.showErrors = true;
    this.rerender(false);
    const { data, result } = this.validate();
    return { data, result };
  }

  // Follow concrete data segments; branch wrappers are transparent.
  resolve(path) {
    let cursor = this.state;
    for (const seg of path) {
      if (isBranchWrapper(cursor)) {
        cursor = cursor[BRANCH_VALUES][cursor[BRANCH]];
      }
      cursor = cursor[seg];
    }
    return cursor;
  }

  locate(path) {
    let cursor = this.state;
    for (const seg of path.slice(0, -1)) {
      if (isBranchWrapper(cursor)) {
        cursor = cursor[BRANCH_VALUES][cursor[BRANCH]];
      }
      cursor = cursor[seg];
    }
    if (isBranchWrapper(cursor)) {
      cursor = cursor[BRANCH_VALUES][cursor[BRANCH]];
    }
    return { holder: cursor, key: path[path.length - 1] };
  }
}

// ---------------------------------------------------------------------------
// State construction / serialization
// ---------------------------------------------------------------------------

function buildState(schema, data, root) {
  const node = deref(root, schema);
  if (!node || typeof node !== 'object') return data ?? null;

  if (Array.isArray(node.oneOf)) {
    let index = node.oneOf.findIndex(
      (branch) => matches(deref(root, branch), data ?? null, root),
    );
    if (index < 0) index = 0;
    return {
      [BRANCH]: index,
      [BRANCH_VALUES]: node.oneOf.map((branch, i) =>
        buildState(branch, i === index ? data : undefined, root)),
    };
  }

  if (node.type === 'object' || (node.type === undefined && node.properties)) {
    const out = {};
    const view = (data && typeof data === 'object' && !Array.isArray(data))
      ? data : {};
    const active = activeConditional(root, node, view);
    const mergedProps = {
      ...(node.properties || {}),
      ...(active.extra?.properties || {}),
    };
    for (const [key, propSchema] of Object.entries(mergedProps)) {
      out[key] = buildState(
        propSchema,
        view && Object.prototype.hasOwnProperty.call(view, key)
          ? view[key] : undefined,
        root,
      );
    }
    // Preserve extra keys from filled JSON (round-trip). They pass through
    // untouched, and are rejected when additionalProperties is false.
    for (const key of Object.keys(view)) {
      if (!(key in mergedProps) && !(key in out)) out[key] = view[key];
    }
    return out;
  }

  if (node.type === 'array') {
    const itemNode = deref(root, node.items || {});
    return Array.isArray(data)
      ? data.map((item) => buildState(itemNode, item, root)) : [];
  }

  if (node.type === 'boolean') return typeof data === 'boolean' ? data : false;

  if (data !== undefined && data !== null) return data;
  return '';
}

function activeConditional(root, node, rawValue) {
  if (!node.if) return { extra: null, kind: null };
  if (conditionMatches(node.if, rawValue, root)) {
    return { extra: node.then ? deref(root, node.then) : null, kind: 'then' };
  }
  return { extra: node.else ? deref(root, node.else) : null, kind: 'else' };
}

// Evaluate an `if` schema against form data. Properties that the if-schema
// checks but the form did not render (because they belong to the inactive
// branch, for example) are ignored, so condition truth tracks visible values.
function conditionMatches(ifSchema, rawValue, root) {
  const ifNode = deref(root, ifSchema);
  if (ifNode.type === 'object' || (ifNode.type === undefined
    && ifNode.properties)) {
    const allowed = new Set(Object.keys(ifNode.properties || {}));
    const view = {};
    for (const [k, v] of Object.entries(rawValue || {})) {
      if (allowed.has(k)) view[k] = v;
    }
    return matches(ifNode, view, root);
  }
  return matches(ifNode, rawValue, root);
}

function serialize(schema, state, root) {
  const node = deref(root, schema);
  if (!node || typeof node !== 'object') return state;

  if (isBranchWrapper(state)) {
    return serializeOneOfWrapper(node, state, root);
  }

  if (Array.isArray(state)) {
    const itemNode = deref(root, node.items || {});
    return state.map((item) => serialize(itemNode, item, root));
  }

  if (state !== null && typeof state === 'object') {
    // Only currently visible props (base + active conditional branch) are
    // serialized, so stale then/else keys never leak into output.
    const view = { ...state };
    const active = activeConditional(root, node,
      prunedForCondition(node, view));
    const mergedProps = {
      ...(node.properties || {}),
      ...(active.extra?.properties || {}),
    };
    const out = {};
    for (const [key, value] of Object.entries(view)) {
      if (key in mergedProps) {
        const propNode = deref(root, mergedProps[key]);
        const ser = isBranchWrapper(value)
          ? serializeOneOfWrapper(propNode, value, root)
          : serialize(mergedProps[key], value, root);
        const emptyStringUnrequired = ser === ''
          && !(node.required || []).includes(key)
          && !(active.extra?.required || []).includes(key);
        if (ser !== undefined && !emptyStringUnrequired) out[key] = ser;
      } else if (node.additionalProperties !== false) {
        out[key] = value;
      } else {
        // additionalProperties: false: keep the key in output so the shared
        // validator rejects it and the error can anchor at this path.
        out[key] = value;
      }
    }
    // A rendered object still exists when all of its fields are empty
    // (required checks then report the missing keys at their paths).
    return Object.keys(out).length || isRenderedObject(node) ? out : undefined;
  }

  if (node.type === 'number' || node.type === 'integer') {
    return serializeNumber(node, state);
  }
  return state;
}

function serializeOneOfWrapper(node, wrapper, root) {
  const branchNode = deref(root, node.oneOf[wrapper[BRANCH]]);
  let ser = serialize(
    node.oneOf[wrapper[BRANCH]],
    wrapper[BRANCH_VALUES][wrapper[BRANCH]],
    root,
  );
  // Drop empty-string optional keys inside the active branch object.
  if (ser && typeof ser === 'object' && !Array.isArray(ser)) {
    const required = new Set([
      ...(branchNode.required || []),
      ...(activeConditional(root, branchNode,
        prunedForCondition(branchNode, ser)).extra?.required || []),
    ]);
    for (const [key, value] of Object.entries(ser)) {
      if (value === '' && !required.has(key)) delete ser[key];
    }
  }
  if (ser === undefined && (branchNode.type === 'object'
    || (branchNode.type === undefined && branchNode.properties))) {
    return {};
  }
  return ser;
}

function isRenderedObject(node) {
  return node.type === 'object'
    || (node.type === undefined && node.properties);
}

// Mid-typing tokens (no complete numeric value yet) are suppressed from
// output: a lone sign, exponent without mantissa digits, etc.
const PARTIAL_NUMBER = /^[+-]?$|^[+-]?\d+\.$|^[+-]?\d*\.?\d+e[+-]?$|^[+-]?\d+\.?\d*e[+-]?$/i;

function serializeNumber(node, state) {
  if (state === '' || state === undefined || state === null) return undefined;
  if (typeof state === 'number') {
    return Number.isFinite(state) ? state : state;
  }
  const raw = String(state);
  const parsed = Number(raw);
  if (Number.isFinite(parsed)
    && (node.type !== 'integer' || Number.isInteger(parsed))) {
    return parsed;
  }
  if (PARTIAL_NUMBER.test(raw.trim())) return undefined; // still typing
  return raw; // unparsable/non-integer: emit string so type check fails
}

// Evaluate `if` using base props only, so a stale key left by the inactive
// branch cannot flip the condition back and forth.
function prunedForCondition(node, view) {
  const base = node.properties || {};
  const out = {};
  for (const key of Object.keys(base)) {
    if (key in view) out[key] = view[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

const pathString = formatPath;

function renderNode(schema, state, path, parent, form) {
  const node = deref(form.root, schema);
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node.oneOf)) {
    renderOneOf(node, state, path, parent, form);
  } else if (node.type === 'object'
    || (node.type === undefined && node.properties)) {
    renderObject(schema, node, state, path, parent, form);
  } else if (node.type === 'array') {
    renderArray(node, state, path, parent, form);
  } else {
    renderScalarControl(node, state, path, parent, form);
  }
}

function renderObject(rawSchema, node, state, path, parent, form) {
  const active = activeConditional(form.root, node,
    prunedForCondition(node, state));
  const mergedProps = {
    ...(node.properties || {}),
    ...(active.extra?.properties || {}),
  };
  const required = new Set([
    ...(node.required || []),
    ...(active.extra?.required || []),
  ]);

  // Reconcile: make sure fields that appeared due to a branch switch have a
  // state subtree; keep inactive keys in state (values survive toggling) but
  // serialize() excludes them.
  for (const [key, propSchema] of Object.entries(mergedProps)) {
    if (state[key] === undefined) {
      state[key] = buildState(propSchema, undefined, form.root);
    }
  }
  // Drop state keys owned only by the branch that just became inactive,
  // so then and else data can never be submitted together.
  const thenKeys = new Set(Object.keys(node.then?.properties || {}));
  const elseKeys = new Set(Object.keys(node.else?.properties || {}));
  const activeKeys = active.kind === 'then' ? thenKeys
    : active.kind === 'else' ? elseKeys : new Set();
  const inactiveKeys = active.kind === 'then' ? elseKeys : thenKeys;
  for (const key of inactiveKeys) {
    if (!activeKeys.has(key) && !(key in (node.properties || {}))) {
      delete state[key];
    }
  }

  const wrap = el('div', 'sf-object');
  if (active.kind) {
    const hint = el('div', 'sf-branch-hint');
    hint.textContent = active.kind === 'then'
      ? 'if 条件成立，显示 then 字段'
      : 'if 条件不成立，显示 else 字段';
    wrap.appendChild(hint);
  }

  for (const [key, propSchemaRaw] of Object.entries(mergedProps)) {
    const childPath = [...path, key];
    const field = el('div', 'sf-field');
    const id = 'sf-' + childPath.map(cssIdEscape).join('-');

    const label = el('label', 'sf-label');
    label.setAttribute('for', id);
    label.textContent = key;
    if (required.has(key)) {
      const star = el('span', 'sf-required');
      star.textContent = ' *';
      star.title = '必填';
      label.appendChild(star);
    }
    field.appendChild(label);

    const description = deref(form.root, propSchemaRaw).description;
    if (description) {
      const desc = el('div', 'sf-desc');
      desc.textContent = description;
      field.appendChild(desc);
    }

    const control = el('div', 'sf-control');
    renderNode(propSchemaRaw, state[key], childPath, control, form);
    field.appendChild(control);
    attachError(form, childPath, field);
    wrap.appendChild(field);
  }

  // Extra keys carried in from loaded JSON. Rendered as raw editable rows so
  // the round-trip keeps them and additionalProperties:false can flag the
  // exact offending path in the UI.
  for (const key of Object.keys(state)) {
    if (key in mergedProps) continue;
    const childPath = [...path, key];
    const field = el('div', 'sf-field sf-extra');
    const label = el('label', 'sf-label');
    label.textContent = `${key}（额外键）`;
    field.appendChild(label);
    const control = el('div', 'sf-control');
    const input = el('input', 'sf-input');
    input.value = typeof state[key] === 'object'
      ? JSON.stringify(state[key])
      : String(state[key]);
    input.setAttribute('data-path', pathString(childPath));
    input.addEventListener('input', (e) => {
      form.setScalar(childPath, e.target.value);
    });
    control.appendChild(input);
    field.appendChild(control);
    attachError(form, childPath, field);
    wrap.appendChild(field);
  }

  parent.appendChild(wrap);
}

function renderArray(node, state, path, parent, form) {
  const itemSchema = node.items || {};
  const wrap = el('div', 'sf-array');

  state.forEach((itemState, i) => {
    const itemPath = [...path, i];
    const row = el('div', 'sf-array-row');
    const rowHead = el('div', 'sf-array-head');
    const idx = el('span', 'sf-array-index');
    idx.textContent = `第 ${i + 1} 行`;
    const removeBtn = el('button', 'sf-btn sf-btn-danger');
    removeBtn.type = 'button';
    removeBtn.textContent = '删除';
    removeBtn.addEventListener('click', () => form.removeArrayItem(path, i));
    rowHead.append(idx, removeBtn);

    const body = el('div', 'sf-array-body');
    renderNode(itemSchema, itemState, itemPath, body, form);
    row.append(rowHead, body);
    // Scalar items render their control directly; object items anchor errors
    // on their own fields. Attach at row level so scalar item errors show.
    if (!isObjectSchema(deref(form.root, itemSchema))) {
      attachError(form, itemPath, row);
    }
    wrap.appendChild(row);
  });

  const addBtn = el('button', 'sf-btn');
  addBtn.type = 'button';
  addBtn.textContent = '+ 增加一行';
  addBtn.addEventListener('click',
    () => form.addArrayItem(path, itemSchema));
  wrap.appendChild(addBtn);
  parent.appendChild(wrap);
}

function renderOneOf(node, wrapper, path, parent, form) {
  const box = el('fieldset', 'sf-oneof');
  const legend = el('legend', 'sf-legend');
  legend.textContent = '请选择一个分支（oneOf）';
  box.appendChild(legend);

  const select = el('select', 'sf-select');
  select.setAttribute('data-path', pathString(path));
  node.oneOf.forEach((branch, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = branch.title || describeBranch(deref(form.root, branch));
    if (i === wrapper[BRANCH]) option.selected = true;
    select.appendChild(option);
  });
  select.addEventListener('change', (e) => {
    form.selectBranch(path, Number(e.target.value));
  });
  box.appendChild(select);

  const branchBody = el('div', 'sf-oneof-body');
  renderNode(
    node.oneOf[wrapper[BRANCH]],
    wrapper[BRANCH_VALUES][wrapper[BRANCH]],
    path,
    branchBody,
    form,
  );
  box.appendChild(branchBody);

  parent.appendChild(box);
  attachError(form, path, box);
}

function renderScalarControl(node, state, path, parent, form) {
  const pathStr = pathString(path);

  if (node.type === 'boolean') {
    const checkbox = el('input', 'sf-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = state === true;
    checkbox.setAttribute('data-path', pathStr);
    checkbox.addEventListener('change', (e) => {
      form.setScalar(path, e.target.checked);
    });
    parent.appendChild(checkbox);
    return;
  }

  if (Array.isArray(node.enum)) {
    const select = el('select', 'sf-select');
    select.setAttribute('data-path', pathStr);
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '-- 请选择 --';
    select.appendChild(empty);
    const numeric = node.type === 'number' || node.type === 'integer';
    node.enum.forEach((candidate) => {
      const option = document.createElement('option');
      option.value = String(candidate);
      option.textContent = String(candidate);
      if (state !== '' && String(state) === String(candidate)) {
        option.selected = true;
      }
      select.appendChild(option);
    });
    select.addEventListener('change', (e) => {
      const raw = e.target.value;
      form.setScalar(path, raw === '' ? '' : numeric ? Number(raw) : raw);
    });
    parent.appendChild(select);
    return;
  }

  const input = el('input', 'sf-input');
  if (node.type === 'integer') {
    input.type = 'number';
    input.step = '1';
  } else if (node.type === 'number') {
    input.type = 'number';
  } else {
    input.type = 'text';
  }
  if (node.minimum !== undefined) input.min = String(node.minimum);
  if (node.maximum !== undefined) input.max = String(node.maximum);
  if (node.minLength !== undefined) input.minLength = node.minLength;
  if (node.maxLength !== undefined) input.maxLength = node.maxLength;
  input.value = state == null ? '' : String(state);
  input.placeholder = hintFor(node);
  input.setAttribute('data-path', pathStr);

  // IME: while composing pinyin (compositionstart..compositionend) we do not
  // push values into state, so every typed letter cannot turn the field red.
  // The committed value is validated once when composition ends.
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', (e) => {
    composing = false;
    commitText(e.target);
  });
  input.addEventListener('input', (e) => {
    if (!composing) commitText(e.target);
  });

  const commitText = (target) => {
    const raw = target.value;
    // Keep raw text while typing (so "1." / "-" can be entered), parse at
    // serialize time. Invalid tokens surface as type errors immediately.
    form.setScalar(path, raw);
  };

  parent.appendChild(input);
}

function attachError(form, path, container) {
  if (!form.showErrors) return;
  const message = form.errorMap.get(pathString(path));
  if (message) {
    container.classList.add('sf-invalid');
    const error = el('div', 'sf-error');
    error.textContent = message;
    container.appendChild(error);
  }
}

function hintFor(node) {
  const parts = [];
  if (node.type === 'integer') parts.push('整数');
  else if (node.type === 'number') parts.push('数字');
  if (node.minimum !== undefined) parts.push(`>= ${node.minimum}`);
  if (node.maximum !== undefined) parts.push(`<= ${node.maximum}`);
  if (node.minLength !== undefined) parts.push(`最少 ${node.minLength} 字`);
  if (node.maxLength !== undefined) parts.push(`最多 ${node.maxLength} 字`);
  return parts.join('，');
}

function describeBranch(node) {
  if (node.type === 'object' && node.properties) {
    return `对象 { ${Object.keys(node.properties).join(', ')} }`;
  }
  if (node.type) return node.type;
  return '分支';
}

function cssIdEscape(seg) {
  return String(seg).replace(/[^a-zA-Z0-9_-]/g, (c) =>
    '_' + c.charCodeAt(0).toString(16));
}

function cssAttrEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
