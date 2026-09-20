
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  const t = typeof value;
  return t === "number" ? "number" : t;
}

function checkType(value, type) {
  if (!type) return true;
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

const TYPE_LABEL = {
  object: "对象",
  array: "数组",
  string: "字符串",
  number: "数字",
  integer: "整数",
  boolean: "布尔值",
  null: "null",
};

/**
 * Validate `data` against `schema`.
 * Returns { valid, errors:[{path, message, keyword}] }.
 * Throws SchemaError when the schema itself is broken (bad/cyclic $ref ...).
 */
function validate(data, schema, registry) {
  const reg = registry || new SF.SchemaRegistry(schema);
  const errors = [];
  const pathStack = [];
  // Labels of the allOf branch / dependency currently being validated,
  // e.g. ["allOf 第 1 支"]. Errors produced inside get prefixed with them.
  const tagStack = [];

  const err = (keyword, message) => {
    const tag = tagStack.length ? `[${tagStack.join(" / ")}] ` : "";
    errors.push({
      path: SF.buildPointer(pathStack),
      keyword,
      message: tag + message,
      branch: tagStack.length ? tagStack.slice() : null,
    });
  };

  // Merge an active then/else object-schema into the one above it, so the
  // branch is validated exactly once instead of twice (merged properties +
  // a second full run over the branch schema).
  const mergeObjectSchema = (a, b) => {
    // Drop the condition that was just evaluated on `a`, but keep any
    // nested if/then/else contributed by the newly picked branch `b`.
    const { if: _i, then: _t, else: _e, ...aRest } = a;
    const m = { ...aRest, ...b };
    m.properties = { ...(a.properties || {}), ...(b.properties || {}) };
    m.required = [
      ...new Set([...(a.required || []), ...(b.required || [])]),
    ];
    if (
      a.additionalProperties === false ||
      b.additionalProperties === false
    ) {
      m.additionalProperties = false;
    }
    return m;
  };

  // Flatten the chain of active then/else branches for an object value.
  const flattenObjectSchema = (nodeSchema, value) => {
    let cur = nodeSchema;
    const seen = new Set();
    let depth = 0;
    while (cur && typeof cur === "object" && cur.if && depth < 100) {
      if (seen.has(cur)) break; // structurally reused schema node
      seen.add(cur);
      depth += 1;
      const cond = validate(value, cur.if, reg);
      const picked = reg.deref(cond.valid ? cur.then : cur.else);
      if (!picked || typeof picked !== "object") break;
      cur = mergeObjectSchema(cur, picked);
    }
    return cur;
  };

  // Property keys contributed by sibling object facets of an object schema:
  // allOf branches and triggered schema dependencies (and, recursively,
  // their own active then/else branches and nested allOf). Used so that
  // additionalProperties:false does not reject perfectly legal keys that
  // are introduced by those facets.
  const gatherFacetKeys = (nodeSchema, value) => {
    const keys = new Set();
    const seen = new Set();
    const isObj = value !== null && typeof value === "object" && !Array.isArray(value);
    const walk = (raw) => {
      const n = reg.deref(raw);
      if (!n || typeof n !== "object" || seen.has(n)) return;
      seen.add(n);
      if (n.properties) Object.keys(n.properties).forEach((k) => keys.add(k));
      if (Array.isArray(n.allOf)) n.allOf.forEach(walk);
      if (n.if) {
        const cond = SF.validate(value, n.if, reg);
        walk(cond.valid ? n.then : n.else);
      }
      if (isObj && n.dependencies) {
        for (const trigger of Object.keys(n.dependencies)) {
          if (!(trigger in value)) continue;
          const dep = n.dependencies[trigger];
          if (dep && typeof dep === "object" && !Array.isArray(dep)) walk(dep);
        }
      }
    };
    walk(nodeSchema);
    return keys;
  };

  // Run a subschema (one allOf branch, one schema dependency) against the
  // current value, tagging every produced error so users can see WHICH
  // branch failed. Errors duplicating an earlier (path, keyword) pair are
  // dropped: the base-schema check already pinned that exact failure.
  const runTaggedFacet = (label, facetSchema, value, refStack) => {
    const before = errors.length;
    tagStack.push(label);
    run(facetSchema, value, refStack);
    tagStack.pop();
    const known = new Set(
      errors.slice(0, before).map((e) => `${e.path}|${e.keyword}`)
    );
    const fresh = errors.slice(before).filter((e) => {
      const key = `${e.path}|${e.keyword}`;
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    errors.length = before;
    errors.push(...fresh);
  };

  const run = (nodeSchema, value, refStack) => {
    let s = nodeSchema;
    if (s && typeof s === "object" && typeof s.$ref === "string") {
      // draft-07: siblings of $ref are ignored.
      if (refStack.includes(s.$ref)) {
        throw new SF.SchemaError(`Cyclic $ref chain detected at ${s.$ref}`);
      }
      refStack = [...refStack, s.$ref];
      s = reg.deref(s);
    }
    if (!s || typeof s !== "object") return;
    if (s.type && !checkType(value, s.type)) {
      const actual = typeOf(value);
      err("type", `类型应为 ${TYPE_LABEL[s.type] || s.type}，实际为 ${TYPE_LABEL[actual] || actual}`);
      // Type mismatch: deeper checks for this node would be noise.
      return;
    }

    if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, value))) {
      err("enum", "值不在允许的枚举范围内");
    }
    if (Object.prototype.hasOwnProperty.call(s, "const") && !deepEqual(s.const, value)) {
      err("const", `值必须等于 ${JSON.stringify(s.const)}`);
    }

    if (typeof value === "number" && !Number.isNaN(value)) {
      if (s.minimum !== undefined && value < s.minimum)
        err("minimum", `不能小于 ${s.minimum}`);
      if (s.maximum !== undefined && value > s.maximum)
        err("maximum", `不能大于 ${s.maximum}`);
    }

    if (typeof value === "string") {
      if (s.minLength !== undefined && value.length < s.minLength)
        err("minLength", `长度不能少于 ${s.minLength} 个字符`);
      if (s.maxLength !== undefined && value.length > s.maxLength)
        err("maxLength", `长度不能超过 ${s.maxLength} 个字符`);
    }

    if (Array.isArray(value)) {
      if (s.items && !Array.isArray(s.items)) {
        value.forEach((item, i) => {
          pathStack.push(i);
          run(s.items, item, refStack);
          pathStack.pop();
        });
      }
    }

    const isDataObject =
      value !== null && typeof value === "object" && !Array.isArray(value);

    // For object values the active conditional branch is flattened in;
    // primitives/arrays keep running the branch schema separately below.
    const eff = isDataObject && s.if ? flattenObjectSchema(s, value) : s;

    if (isDataObject) {
      const props = eff.properties || {};
      const required = eff.required || [];
      for (const key of required) {
        if (!(key in value)) {
          pathStack.push(key);
          err("required", "缺少必填字段");
          pathStack.pop();
        }
      }
      if (eff.additionalProperties === false) {
        const allowedKeys = new Set(Object.keys(props));
        for (const k of gatherFacetKeys(eff, value)) allowedKeys.add(k);
        for (const key of Object.keys(value)) {
          if (!allowedKeys.has(key)) {
            pathStack.push(key);
            err("additionalProperties", `不允许出现未定义的字段 "${key}"`);
            pathStack.pop();
          }
        }
      }
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(props, key)) {
          pathStack.push(key);
          run(props[key], value[key], refStack);
          pathStack.pop();
        }
      }

      // allOf: EVERY branch must hold. Each is validated on its own and its
      // errors tagged with its index so failures name the branch.
      if (Array.isArray(eff.allOf)) {
        eff.allOf.forEach((branch, i) => {
          runTaggedFacet(`allOf 第 ${i + 1} 支`, branch, value, refStack);
        });
      }

      // dependencies: draft-07 property dependencies (array of names) and
      // schema dependencies (full subschema applied when trigger present).
      if (eff.dependencies) {
        for (const trigger of Object.keys(eff.dependencies)) {
          if (!(trigger in value)) continue;
          const dep = eff.dependencies[trigger];
          if (Array.isArray(dep)) {
            for (const name of dep) {
              if (!(name in value)) {
                pathStack.push(name);
                err(
                  "dependencies",
                  `字段 "${trigger}" 出现时，字段 "${name}" 也必须出现`
                );
                pathStack.pop();
              }
            }
          } else if (dep && typeof dep === "object") {
            runTaggedFacet(`依赖 "${trigger}"`, dep, value, refStack);
          }
        }
      }
    }

    if (Array.isArray(eff.oneOf)) {
      const matched = [];
      eff.oneOf.forEach((branch, i) => {
        const sub = validate(value, branch, reg);
        if (sub.valid) matched.push(i);
      });
      if (matched.length === 0) err("oneOf", "不符合任何一个可选项");
      else if (matched.length > 1) err("oneOf", `同时符合 ${matched.length} 个可选项，必须只符合一个`);
    }

    if (s.if && !isDataObject) {
      const cond = validate(value, s.if, reg);
      if (cond.valid) {
        if (s.then) run(s.then, value, refStack);
      } else if (s.else) {
        run(s.else, value, refStack);
      }
    }
  };

  run(schema, data, []);
  return { valid: errors.length === 0, errors };
}

// UMD-ish: plain <script> tags (works from file://) and Node's ESM import.
(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(SF, require("./errors.js"), require("./schema-core.js"));
    module.exports = factory(SF);
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.validate = validate;
  return { validate: SF.validate, SchemaRegistry: SF.SchemaRegistry, SchemaError: SF.SchemaError };
});
