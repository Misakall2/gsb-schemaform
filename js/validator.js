
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
 * Property names contributed exclusively by allOf branches or by
 * dependency schemas whose trigger is present (following nested
 * if/then/else). Keys already present in `baseProps` are excluded:
 * those stay on the normal property loop, while the branch run adds
 * the branch's extra constraints on top.
 */
function collectBranchOwnedProps(reg, validate, rootSchema, value, baseProps) {
  const owned = new Set();
  const visit = (sc, isActive) => {
    const d = reg.deref(sc);
    if (!d || typeof d !== "object") return;
    if (isActive && d.properties) {
      for (const k of Object.keys(d.properties)) {
        if (!Object.prototype.hasOwnProperty.call(baseProps, k)) owned.add(k);
      }
    }
    if (Array.isArray(d.allOf)) d.allOf.forEach((b) => visit(b, isActive));
    if (isActive && d.dependencies) {
      for (const trigger of Object.keys(d.dependencies)) {
        const on = Object.prototype.hasOwnProperty.call(value, trigger);
        const dep = d.dependencies[trigger];
        if (dep && typeof dep === "object" && !Array.isArray(dep)) visit(dep, on);
      }
    }
    if (d.if) {
      const on = validate(value, d.if, reg).valid;
      visit(d.then, isActive && on);
      visit(d.else, isActive && !on);
    }
  };
  visit(rootSchema, true);
  return owned;
}

/**
 * Validate `data` against `schema`.
 * Returns { valid, errors:[{path, message, keyword}] }.
 * Throws SchemaError when the schema itself is broken (bad/cyclic $ref ...).
 */
function validate(data, schema, registry) {
  const reg = registry || new SF.SchemaRegistry(schema);
  const errors = [];
  const pathStack = [];

  const err = (keyword, message) => {
    errors.push({ path: SF.buildPointer(pathStack), keyword, message });
  };

  // Merge an active then/else object-schema into the one above it, so the
  // branch is validated exactly once instead of twice (merged properties +
  // a second full run over the branch schema).
  const mergeObjectSchema = (a, b) => {
    // Drop the condition that was just evaluated on `a`, but keep any
    // nested if/then/else contributed by the newly picked branch `b`.
    const { if: _i, then: _t, else: _e, allOf: _ao, dependencies: _dp, ...aRest } = a;
    const m = { ...aRest, ...b };
    m.properties = { ...(a.properties || {}), ...(b.properties || {}) };
    m.required = [
      ...new Set([...(a.required || []), ...(b.required || [])]),
    ];
    m.allOf = [...(Array.isArray(a.allOf) ? a.allOf : []), ...(Array.isArray(b.allOf) ? b.allOf : [])];
    m.dependencies = { ...(a.dependencies || {}), ...(b.dependencies || {}) };
    if (
      a.additionalProperties === false ||
      b.additionalProperties === false
    ) {
      m.additionalProperties = false;
    }
    return m;
  };

  // Property names contributed by allOf branches and by dependency schemas
  // whose trigger property is present. Used to widen additionalProperties:
  // false so merged-in keys are not reported as unknown. Nested
  // if/then/else/allOf inside a contributing branch are followed too.
  const collectAllowedProps = (nodeSchema, value, out) => {
    const follow = (sc) => {
      const d = reg.deref(sc);
      if (!d || typeof d !== "object") return;
      if (d.properties) Object.keys(d.properties).forEach((k) => out.add(k));
      if (d.if) {
        const cond = validate(value, d.if, reg);
        follow(cond.valid ? d.then : d.else);
      }
      if (Array.isArray(d.allOf)) d.allOf.forEach(follow);
      if (d.dependencies) {
        for (const trigger of Object.keys(d.dependencies)) {
          if (Object.prototype.hasOwnProperty.call(value, trigger)) {
            const dep = d.dependencies[trigger];
            if (dep && typeof dep === "object" && !Array.isArray(dep)) follow(dep);
          }
        }
      }
    };
    follow(nodeSchema);
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

  const run = (nodeSchema, value, refStack, prefix = "") => {
    // Local error reporter: when a branch (allOf / dependency schema) runs
    // in place of a sub-validator, every failure message is tagged with
    // the branch label so the UI can say WHICH branch rejected the value.
    const err = (keyword, message) => {
      errors.push({
        path: SF.buildPointer(pathStack),
        keyword,
        message: prefix ? prefix + message : message,
      });
    };
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
    // An object-shape schema need not declare type:"object":
    // if/then and allOf branches routinely carry only
    // properties/required/additionalProperties.
    const objectLike =
      isDataObject &&
      (!s.type ||
        s.type === "object" ||
        !!s.properties ||
        Array.isArray(s.required) ||
        s.additionalProperties !== undefined ||
        !!s.dependencies);
    const useObjectSemantics = isDataObject && objectLike;

    // For object values the active conditional branch is flattened in;
    // primitives/arrays keep running the branch schema separately below.
    const eff = useObjectSemantics && s.if ? flattenObjectSchema(s, value) : s;

    if (useObjectSemantics) {
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
        const allowed = new Set(Object.keys(props));
        collectAllowedProps(eff, value, allowed);
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) {
            pathStack.push(key);
            err("additionalProperties", `不允许出现未定义的字段 "${key}"`);
            pathStack.pop();
          }
        }
      }
      const branchOwned = collectBranchOwnedProps(reg, validate, eff, value, props);
      for (const key of Object.keys(value)) {
        // Branch-only keys (allOf / active dependency schemas) are
        // validated by the branch runs below, so each failure gets
        // attributed to the branch that imposed it.
        if (Object.prototype.hasOwnProperty.call(props, key) && !branchOwned.has(key)) {
          pathStack.push(key);
          run(props[key], value[key], refStack, prefix);
          pathStack.pop();
        }
      }
      // dependencies (draft-07): property-presence form (arrays of required
      // names) and schema form (the dependency schema runs against the same
      // object, and may itself carry if/then, allOf, etc.).
      if (eff.dependencies) {
        for (const trigger of Object.keys(eff.dependencies)) {
          if (!Object.prototype.hasOwnProperty.call(value, trigger)) continue;
          const dep = eff.dependencies[trigger];
          if (Array.isArray(dep)) {
            for (const req of dep) {
              if (!Object.prototype.hasOwnProperty.call(value, req)) {
                pathStack.push(req);
                err("dependencies", `字段 "${trigger}" 出现时，依赖字段 "${req}" 也必须存在`);
                pathStack.pop();
              }
            }
          } else if (dep && typeof dep === "object") {
            run(dep, value, refStack, `字段 "${trigger}" 的依赖约束：`);
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

    // allOf: every branch must pass. Failures run in place so they land on
    // the exact value path, each message tagged with its branch index; a
    // summary error on the current node names the failing branch(es).
    const allOfBranches = Array.isArray(eff.allOf)
      ? eff.allOf
      : useObjectSemantics
        ? null
        : s.allOf;
    if (Array.isArray(allOfBranches)) {
      allOfBranches.forEach((branch, i) => {
        const before = errors.length;
        run(branch, value, refStack, `${prefix}allOf 第 ${i + 1} 支（共 ${allOfBranches.length} 支）：`);
        if (errors.length > before) {
          err("allOf", `未通过 allOf 的第 ${i + 1} 支（${allOfBranches.length} 支必须同时满足）`);
        }
      });
    }

    if (s.if && !useObjectSemantics) {
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
