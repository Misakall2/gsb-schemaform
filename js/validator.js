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

function validateNormalized(data, rootSchema, options = {}) {
  const branches = options.branches || new Map();
  const errors = [];
  const pathStack = [];

  const run = (nodeSchema, value, prefix = "") => {
    const err = (keyword, message) => {
      errors.push({
        path: SF.buildPointer(pathStack),
        keyword,
        message: prefix ? prefix + message : message,
      });
    };

    const s = nodeSchema;
    if (!s || typeof s !== "object") return;

    if (s.type && !checkType(value, s.type)) {
      const actual = typeOf(value);
      err("type", `类型应为 ${TYPE_LABEL[s.type] || s.type}，实际为 ${TYPE_LABEL[actual] || actual}`);
      return;
    }

    if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, value))) {
      err("enum", "值不在允许的枚举范围内");
    }
    if (Object.prototype.hasOwnProperty.call(s, "const") && !deepEqual(s.const, value)) {
      err("const", `值必须等于 ${JSON.stringify(s.const)}`);
    }

    if (typeof value === "number" && !Number.isNaN(value)) {
      if (s.minimum !== undefined && value < s.minimum) err("minimum", `不能小于 ${s.minimum}`);
      if (s.maximum !== undefined && value > s.maximum) err("maximum", `不能大于 ${s.maximum}`);
    }

    if (typeof value === "string") {
      if (s.minLength !== undefined && value.length < s.minLength) {
        err("minLength", `长度不能少于 ${s.minLength} 个字符`);
      }
      if (s.maxLength !== undefined && value.length > s.maxLength) {
        err("maxLength", `长度不能超过 ${s.maxLength} 个字符`);
      }
    }

    if (Array.isArray(value) && s.items && !Array.isArray(s.items)) {
      value.forEach((item, i) => {
        pathStack.push(i);
        run(s.items, item, prefix, null);
        pathStack.pop();
      });
    }

    const isDataObject = value !== null && typeof value === "object" && !Array.isArray(value);
    const useObjectSemantics = isDataObject && (
      !s.type ||
      s.type === "object" ||
      !!s.properties ||
      Array.isArray(s.required) ||
      s.additionalProperties !== undefined ||
      !!s.dependencies ||
      !!s.if ||
      Array.isArray(s.allOf)
    );
    const layout = useObjectSemantics ? SF.createObjectLayout(s, value) : null;
    const eff = layout ? layout.effective : s;
    if (useObjectSemantics) {
      const props = eff.properties || {};
      for (const key of layout.required) {
        if (!(key in value)) {
          pathStack.push(key);
          err("required", "缺少必填字段");
          pathStack.pop();
        }
      }

      if (eff.additionalProperties === false) {
        const allowed = new Set(
          layout.fields.filter((field) => layout.active.has(field.key)).map((field) => field.key)
        );
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) {
            pathStack.push(key);
            err("additionalProperties", `不允许出现未定义的字段 "${key}"`);
            pathStack.pop();
          }
        }
      }

      for (const key of Object.keys(value)) {
        if (
          Object.prototype.hasOwnProperty.call(props, key) &&
          !layout.branchOnly.has(key)
        ) {
          pathStack.push(key);
          run(props[key], value[key], prefix);
          pathStack.pop();
        }
      }

      if (eff.dependencies) {
        for (const trigger of Object.keys(eff.dependencies)) {
          if (!Object.prototype.hasOwnProperty.call(value, trigger)) continue;
          const dependency = eff.dependencies[trigger];
          if (Array.isArray(dependency)) {
            for (const requiredKey of dependency) {
              if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
                pathStack.push(requiredKey);
                err("dependencies", `字段 "${trigger}" 出现时，依赖字段 "${requiredKey}" 也必须存在`);
                pathStack.pop();
              }
            }
          } else if (dependency && typeof dependency === "object") {
          run(dependency, value, `字段 "${trigger}" 的依赖约束：`);
          }
        }
      }
    }

    if (Array.isArray(eff.oneOf)) {
      const pointer = SF.buildPointer(pathStack);
      if (!branches.has(pointer)) {
        const matched = [];
        eff.oneOf.forEach((branch, i) => {
          if (validateNormalized(value, branch).valid) matched.push(i);
        });
        if (matched.length === 0) err("oneOf", "不符合任何一个可选项");
        else if (matched.length > 1) {
          err("oneOf", `同时符合 ${matched.length} 个可选项，必须只符合一个`);
        }
      } else {
        const selected = branches.get(pointer);
        const selectedBranch = eff.oneOf[selected];
        if (!selectedBranch) {
          err("oneOf", "当前选择的类型不存在");
        } else {
          const before = errors.length;
          run(selectedBranch, value, "");
          if (errors.length > before) err("oneOf", "当前选择的类型与字段内容不符");
        }
      }
    }

    const allOfBranches = Array.isArray(eff.allOf) ? eff.allOf : null;
    if (allOfBranches) {
      allOfBranches.forEach((branch, i) => {
        const before = errors.length;
        run(branch, value, `${prefix}allOf 第 ${i + 1} 支（共 ${allOfBranches.length} 支）：`);
        if (errors.length > before) {
          err("allOf", `未通过 allOf 的第 ${i + 1} 支（${allOfBranches.length} 支必须同时满足）`);
        }
      });
    }
  };

  run(rootSchema, data);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate data against a schema. Pass a Registry to reuse its already
 * normalized and expanded tree.
 */
function validate(data, schema, registry, options = {}) {
  const reg = registry || new SF.SchemaRegistry(schema);
  const rootSchema = schema === reg.source ? reg.root : schema;
  return validateNormalized(data, rootSchema, options);
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(SF, require("./errors.js"), require("./schema-core.js"));
    require("./schema-layout.js");
    module.exports = factory(SF);
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.validate = validate;
  SF.validateNormalized = validateNormalized;
  return {
    validate: SF.validate,
    validateNormalized: SF.validateNormalized,
    SchemaRegistry: SF.SchemaRegistry,
    SchemaError: SF.SchemaError,
  };
});
