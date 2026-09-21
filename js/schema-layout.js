function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function evaluateCondition(value, condition, validate) {
  return validate(value, condition).valid;
}

/**
 * One data-dependent layout calculation for an object schema. The renderer,
 * pruning and required-marker logic all consume this result.
 */
function createObjectPlan(root, value, validate) {
  const fields = [];
  const seen = new Set();
  const active = new Set();
  const hidden = new Set();
  const required = new Set();

  const addField = (key, childSchema, isActive) => {
    if (!seen.has(key)) {
      seen.add(key);
      fields.push({ key, schema: childSchema });
    }
    if (isActive) active.add(key);
  };

  const contribute = (schema, isActive) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) {
        addField(key, schema.properties[key], isActive);
      }
    }
    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) contribute(branch, isActive);
    }
    if (schema.dependencies && isPlainObject(value)) {
      for (const trigger of Object.keys(schema.dependencies)) {
        const on = Object.prototype.hasOwnProperty.call(value, trigger);
        const dependency = schema.dependencies[trigger];
        if (dependency && typeof dependency === "object" && !Array.isArray(dependency)) {
          contribute(dependency, isActive && on);
        }
      }
    }
    if (schema.if) {
      const on = validate(value, schema.if);
      contribute(schema.then, isActive && on);
      contribute(schema.else, isActive && !on);
    }
  };

  const collectRequired = (schema, isActive) => {
    if (!schema || typeof schema !== "object") return;
    if (Array.isArray(schema.required) && isActive) {
      schema.required.forEach((key) => required.add(key));
    }
    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach((branch) => collectRequired(branch, isActive));
    }
    if (schema.dependencies && isPlainObject(value)) {
      for (const trigger of Object.keys(schema.dependencies)) {
        const on = Object.prototype.hasOwnProperty.call(value, trigger);
        const dependency = schema.dependencies[trigger];
        if (dependency && typeof dependency === "object" && !Array.isArray(dependency)) {
          collectRequired(dependency, isActive && on);
        } else if (Array.isArray(dependency) && isActive && on) {
          dependency.forEach((key) => required.add(key));
        }
      }
    }
    if (schema.if) {
      const on = validate(value, schema.if);
      collectRequired(schema.then, isActive && on);
      collectRequired(schema.else, isActive && !on);
    }
  };

  contribute(root, true);
  collectRequired(root, true);
  for (const field of fields) {
    if (!active.has(field.key)) hidden.add(field.key);
  }
  return { fields, active, hidden, required };
}

function collectOwnedKeys(schema, out) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties) Object.keys(schema.properties).forEach((key) => out.add(key));
  if (Array.isArray(schema.allOf)) schema.allOf.forEach((branch) => collectOwnedKeys(branch, out));
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((branch) => collectOwnedKeys(branch, out));
  if (schema.then) collectOwnedKeys(schema.then, out);
  if (schema.else) collectOwnedKeys(schema.else, out);
  if (schema.dependencies) {
    for (const dependency of Object.values(schema.dependencies)) {
      if (dependency && typeof dependency === "object" && !Array.isArray(dependency)) {
        collectOwnedKeys(dependency, out);
      }
    }
  }
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) module.exports = factory(SF);
  else factory(SF);
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.evaluateCondition = evaluateCondition;
  SF.createObjectPlan = createObjectPlan;
  SF.collectOwnedKeys = collectOwnedKeys;
  return SF;
});
