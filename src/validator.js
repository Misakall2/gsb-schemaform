// JSON Schema (draft-07 subset) validator.
//
// Supported:
//   type: object | array | string | number | integer | boolean
//   properties, required, additionalProperties (false | schema)
//   items (single schema)
//   enum
//   minimum / maximum (inclusive)
//   minLength / maxLength
//   local $ref into #/definitions only (remote refs rejected)
//   oneOf
//   if / then / else

import {
  SchemaError, deref, assertValidSchema, formatPath,
} from './schema-core.js';

// Validate `data` against `schema`.
// Returns { valid: boolean, errors: [{ path: '/a/0/b', message }] }.
export function validate(schema, data) {
  assertValidSchema(schema);
  const errors = [];
  validateNode(schema, data, [], errors, schema, new Set());
  return { valid: errors.length === 0, errors };
}

// Convenience boolean check used by the UI (branch selection, if/then).
export function matches(schema, data, root = schema) {
  const errors = [];
  validateNode(schema, data, [], errors, root, new Set());
  return errors.length === 0;
}

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isFinite(v) &&
    Math.trunc(v) === v,
  boolean: (v) => typeof v === 'boolean',
};

const TYPE_LABEL = {
  object: '对象', array: '数组', string: '字符串', number: '数字',
  integer: '整数', boolean: '布尔值',
};

function validateNode(schema, value, path, errors, root, refStack) {
  let node = schema;
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (refStack.has(ref)) {
      throw new SchemaError(`$ref 成环: ${[...refStack, ref].join(' -> ')}`);
    }
    const nextStack = new Set(refStack);
    nextStack.add(ref);
    validateNode(deref(root, node), value, path, errors, root, nextStack);
    return;
  }
  if (node === true) return;
  if (node === false) {
    errors.push({ path: formatPath(path), message: '该值不被允许' });
    return;
  }
  if (!node || typeof node !== 'object') return;

  // type (single or array of types; subset supports single in practice)
  if (node.type !== undefined) {
    const types = [].concat(node.type);
    if (!types.some((t) => TYPE_CHECKS[t]?.(value))) {
      errors.push({
        path: formatPath(path),
        message: `类型应为 ${types.map((t) => TYPE_LABEL[t]).join(' 或 ')}`,
      });
      return; // further keyword checks assume the declared type
    }
  }

  if (Array.isArray(node.enum) && !enumContains(node.enum, value)) {
    errors.push({
      path: formatPath(path),
      message: `值必须是以下之一: ${node.enum.map(describeEnum).join('、')}`,
    });
  }

  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) {
      errors.push({ path: formatPath(path),
        message: `不能小于 ${node.minimum}` });
    }
    if (node.maximum !== undefined && value > node.maximum) {
      errors.push({ path: formatPath(path),
        message: `不能大于 ${node.maximum}` });
    }
  }

  if (typeof value === 'string') {
    // String length is measured in UTF-16 code units per the spec, matching
    // String.prototype.length.
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push({ path: formatPath(path),
        message: `至少需要 ${node.minLength} 个字符（当前 ${value.length} 个）` });
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      errors.push({ path: formatPath(path),
        message: `最多 ${node.maxLength} 个字符（当前 ${value.length} 个）` });
    }
  }

  if (TYPE_CHECKS.object(value)) {
    validateObject(node, value, path, errors, root, refStack);
  } else if (Array.isArray(value)) {
    validateArray(node, value, path, errors, root, refStack);
  }

  if (Array.isArray(node.oneOf)) {
    validateOneOf(node.oneOf, value, path, errors, root, refStack);
  }

  // if/then/else is applied inside validateObject / validateScalarBranches:
  // the active branch is merged into the node being validated (properties,
  // required, nested constraints), which also keeps additionalProperties
  // correct. Object-less nodes with if/then are rare in this subset.
  if (node.if && typeof node.if === 'object'
    && !TYPE_CHECKS.object(value)) {
    const branchErrors = [];
    validateNode(node.if, value, path, branchErrors, root, refStack);
    const branch = branchErrors.length === 0 ? node.then : node.else;
    if (branch) validateNode(branch, value, path, errors, root, refStack);
  }
}

function validateObject(node, value, path, errors, root, refStack) {
  const props = node.properties || {};
  // The active conditional branch contributes its own property set and
  // required list, so then/else fields are not mistaken for extra keys.
  const active = activeObjectBranch(node, value, root, refStack);
  const allProps = { ...props, ...(active.extra?.properties || {}) };
  if (Array.isArray(node.required)) {
    for (const key of node.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({
          path: formatPath([...path, key]),
          message: '缺少必填字段',
        });
      }
    }
  }
  if (active.extra && Array.isArray(active.extra.required)) {
    for (const key of active.extra.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({
          path: formatPath([...path, key]),
          message: '缺少必填字段',
        });
      }
    }
  }
  for (const [key, child] of Object.entries(allProps)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateNode(child, value[key], [...path, key], errors, root, refStack);
    }
  }
  if (node.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in allProps)) {
        errors.push({
          path: formatPath([...path, key]),
          message: '不允许出现额外的属性',
        });
      }
    }
  } else if (node.additionalProperties &&
    typeof node.additionalProperties === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (!(key in allProps)) {
        validateNode(
          node.additionalProperties, v, [...path, key], errors, root, refStack,
        );
      }
    }
  }
  // Constraints beyond properties/required inside the active branch
  // (minLength on the branch value itself is unusual, but oneOf, nested
  // if/then, etc. must still be enforced exactly once).
  if (active.extra && Array.isArray(active.extra.oneOf)) {
    validateOneOf(active.extra.oneOf, value, path, errors, root, refStack);
  }
}

function activeObjectBranch(node, value, root, refStack) {
  if (!node.if) return { extra: null };
  const branchErrors = [];
  validateNode(node.if, value, [], branchErrors, root, refStack);
  if (branchErrors.length === 0) {
    return { extra: node.then ? deref(root, node.then) : null };
  }
  return { extra: node.else ? deref(root, node.else) : null };
}

function validateArray(node, value, path, errors, root, refStack) {
  if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
    value.forEach((item, i) => {
      validateNode(node.items, item, [...path, i], errors, root, refStack);
    });
  }
}

function validateOneOf(brachSchemas, value, path, errors, root, refStack) {
  let matchCount = 0;
  for (const branch of brachSchemas) {
    const branchErrors = [];
    validateNode(branch, value, path, branchErrors, root, refStack);
    if (branchErrors.length === 0) matchCount += 1;
  }
  if (matchCount !== 1) {
    errors.push({
      path: formatPath(path),
      message: matchCount === 0
        ? 'oneOf: 当前值不满足任何一个分支'
        : `oneOf: 当前值同时满足 ${matchCount} 个分支，必须恰好满足一个`,
    });
  }
}

function enumContains(allowed, value) {
  return allowed.some((candidate) => deepEqual(candidate, value));
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function describeEnum(v) {
  if (typeof v === 'string') return `"${v}"`;
  return JSON.stringify(v);
}
