function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function conditionMatches(value, condition, cache) {
  if (cache.has(condition)) return cache.get(condition);
  const matches = SF.validateNormalized(value, condition).valid;
  cache.set(condition, matches);
  return matches;
}

function mergeObjectSchema(a, b) {
  // Keep the active conditional chain's structural keywords, but drop the
  // condition that selected b. Draft-07 keywords from b win for assertions.
  const { if: _if, then: _then, else: _else, dependencies: _dependencies, ...aRest } = a;
  const merged = { ...aRest, ...b };
  merged.properties = { ...(a.properties || {}), ...(b.properties || {}) };
  merged.required = [...new Set([...(a.required || []), ...(b.required || [])])];
  merged.allOf = [
    ...(Array.isArray(a.allOf) ? a.allOf : []),
    ...(Array.isArray(b.allOf) ? b.allOf : []),
  ];
  merged.dependencies = { ...(a.dependencies || {}), ...(b.dependencies || {}) };
  if (a.additionalProperties === false || b.additionalProperties === false) {
    merged.additionalProperties = false;
  }
  return merged;
}

/**
 * The single data-dependent object model used by validation, pruning,
 * normalization, and control-tree generation.
 */
function createObjectLayout(schema, value) {
  const fields = [];
  const seen = new Set();
  const fieldOwners = new Map();
  const requiredOwners = new Map();
  const active = new Set();
  const required = new Set();
  const conditionCache = new Map();

  const addProperties = (sc, isActive, owner) => {
    if (!isPlainObject(sc) || !sc.properties) return;
    for (const key of Object.keys(sc.properties)) {
      if (!seen.has(key)) {
        seen.add(key);
        fieldOwners.set(key, owner);
        fields.push({ key, schema: sc.properties[key] });
      }
      if (isActive) active.add(key);
    }
  };

  const collectRequired = (sc, isActive, owner) => {
    if (!isPlainObject(sc) || !isActive || !Array.isArray(sc.required)) return;
    sc.required.forEach((key) => {
      required.add(key);
      if (owner === "allOf" || owner === "dependency") requiredOwners.set(key, owner);
    });
  };

  const contribute = (sc, isActive, owner) => {
    if (!isPlainObject(sc)) return;
    addProperties(sc, isActive, owner);
    collectRequired(sc, isActive, owner);

    if (Array.isArray(sc.allOf)) {
      sc.allOf.forEach((branch) => contribute(branch, isActive, owner === "dependency" ? "dependency" : "allOf"));
    }

    if (isPlainObject(sc.dependencies) && isPlainObject(value)) {
      for (const trigger of Object.keys(sc.dependencies)) {
        const dependency = sc.dependencies[trigger];
        const triggered = isActive && Object.prototype.hasOwnProperty.call(value, trigger);
        if (Array.isArray(dependency) && triggered) {
          dependency.forEach((key) => required.add(key));
        } else if (isPlainObject(dependency)) {
            contribute(dependency, triggered, "dependency");
        }
      }
    }

    if (isPlainObject(sc.if)) {
      if (isActive) {
        const matches = conditionMatches(value, sc.if, conditionCache);
        contribute(sc.then, matches, owner);
        contribute(sc.else, !matches, owner);
      } else {
        contribute(sc.then, false, owner);
        contribute(sc.else, false, owner);
      }
    }
  };

  addProperties(schema, true, "direct");
  collectRequired(schema, true);
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((branch) => contribute(branch, true, "allOf"));
  }
  if (isPlainObject(schema.dependencies) && isPlainObject(value)) {
    for (const trigger of Object.keys(schema.dependencies)) {
      const dependency = schema.dependencies[trigger];
      const triggered = Object.prototype.hasOwnProperty.call(value, trigger);
      if (Array.isArray(dependency) && triggered) {
        dependency.forEach((key) => required.add(key));
      } else if (isPlainObject(dependency)) {
        contribute(dependency, triggered, "dependency");
      }
    }
  }
  if (isPlainObject(schema.if)) {
    const matches = conditionMatches(value, schema.if, conditionCache);
    contribute(schema.then, matches, "direct");
    contribute(schema.else, !matches, "direct");
  }

  let effective = schema;
  let current = schema;
  const mergedNodes = new Set();
  while (isPlainObject(current) && isPlainObject(current.if) && !mergedNodes.has(current)) {
    mergedNodes.add(current);
    const matches = conditionMatches(value, current.if, conditionCache);
    const picked = matches ? current.then : current.else;
    if (!isPlainObject(picked)) break;
    effective = mergeObjectSchema(effective, picked);
    current = picked;
  }
  const finalEffective = effective === schema ? { ...schema } : effective;
  finalEffective.required = [...required];

  const hidden = new Set();
  for (const field of fields) {
    if (!active.has(field.key)) hidden.add(field.key);
  }

  const branchOwned = new Set();
  const branchOnly = new Set();
  for (const field of fields) {
    if (
      active.has(field.key) &&
      fieldOwners.get(field.key) === "allOf" ||
      fieldOwners.get(field.key) === "dependency"
    ) {
      branchOwned.add(field.key);
      if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, field.key)) {
        branchOnly.add(field.key);
      }
    }
  }

  const validatorRequired = new Set([...required].filter((key) =>
    requiredOwners.get(key) !== "dependency" && requiredOwners.get(key) !== "allOf"
  ));
  return {
    fields,
    active,
    hidden,
    required: validatorRequired,
    requiredForRendering: required,
    branchOwned,
    branchOnly,
    effective: finalEffective,
  };
}

function branchTitle(schema, index) {
  if (schema.title) return schema.title;
  if (schema.type === "object" && schema.properties) {
    return "对象: " + Object.keys(schema.properties).join(", ");
  }
  if (schema.const !== undefined) return String(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length === 1) return String(schema.enum[0]);
  return `选项 ${index + 1}`;
}

function buildControlTree(schema, value, segments, branches, labelText) {
  const pointer = SF.buildPointer(segments);
  const label = schema.title || labelText || "";

  if (Array.isArray(schema.oneOf)) {
    const selected = branches.has(pointer) ? branches.get(pointer) : null;
    return {
      kind: "oneOf",
      schema,
      value,
      segments,
      pointer,
      label,
      options: schema.oneOf.map((branch, i) => ({ index: i, label: branchTitle(branch, i) })),
      selected,
      branch: selected != null && schema.oneOf[selected]
        ? buildControlTree(schema.oneOf[selected], value, segments, branches, "")
        : null,
    };
  }

  if (schema.type === "object") {
    const layout = createObjectLayout(schema, value);
    return {
      kind: "object",
      schema,
      value,
      segments,
      pointer,
      label,
      children: layout.fields
        .filter((field) => layout.active.has(field.key))
        .map((field) => buildControlTree(
          field.schema,
          isPlainObject(value) ? value[field.key] : undefined,
          segments.concat(field.key),
          branches,
          field.key
        )),
      errorPointer: pointer,
    };
  }

  if (schema.type === "array") {
    const items = schema.items || {};
    const arr = Array.isArray(value) ? value : [];
    return {
      kind: "array",
      schema,
      value: arr,
      segments,
      pointer,
      label,
      items,
      rows: arr.map((item, i) => buildControlTree(items, item, segments.concat(i), branches, "")),
      errorPointer: pointer,
    };
  }

  const control = Array.isArray(schema.enum)
    ? "select"
    : schema.type === "boolean"
      ? "checkbox"
      : "input";
  return {
    kind: "control",
    control,
    schema,
    value,
    segments,
    pointer,
    label,
  };
}

function collectOwnedKeys(schema, out) {
  if (!isPlainObject(schema)) return;
  if (schema.properties) Object.keys(schema.properties).forEach((key) => out.add(key));
  if (Array.isArray(schema.allOf)) schema.allOf.forEach((branch) => collectOwnedKeys(branch, out));
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((branch) => collectOwnedKeys(branch, out));
  if (schema.then) collectOwnedKeys(schema.then, out);
  if (schema.else) collectOwnedKeys(schema.else, out);
  if (schema.dependencies) {
    for (const dependency of Object.values(schema.dependencies)) {
      if (isPlainObject(dependency)) collectOwnedKeys(dependency, out);
    }
  }
}

function pruneFormData(schema, value, segments, branches) {
  if (!isPlainObject(schema) || value === null || value === undefined) return;

  if (Array.isArray(schema.oneOf)) {
    const pointer = SF.buildPointer(segments);
    const index = branches.get(pointer);
    if (index !== undefined && schema.oneOf[index]) {
      if (isPlainObject(value)) {
        const ownedBySelected = new Set();
        const ownedByAny = new Set();
        schema.oneOf.forEach((branch, branchIndex) => {
          const keys = new Set();
          collectOwnedKeys(branch, keys);
          keys.forEach((key) => {
            ownedByAny.add(key);
            if (branchIndex === index) ownedBySelected.add(key);
          });
        });
        Object.keys(value).forEach((key) => {
          if (ownedByAny.has(key) && !ownedBySelected.has(key)) delete value[key];
        });
      }
      pruneFormData(schema.oneOf[index], value, segments, branches);
    }
    return;
  }

  if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
    value.forEach((_, i) => pruneFormData(schema.items, value[i], segments.concat(i), branches));
    return;
  }

  if (isPlainObject(value) && (
    schema.type === "object" ||
    schema.properties ||
    Array.isArray(schema.required) ||
    schema.additionalProperties !== undefined ||
    schema.dependencies ||
    schema.if ||
    Array.isArray(schema.allOf)
  )) {
    const layout = createObjectLayout(schema, value);
    layout.hidden.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(value, key)) delete value[key];
    });
    for (const field of layout.fields) {
      if (layout.active.has(field.key) && value[field.key] !== undefined) {
        pruneFormData(field.schema, value[field.key], segments.concat(field.key), branches);
      }
    }
  }
}

function inferBranches(schema, getValue, segments, branches) {
  if (!isPlainObject(schema)) return;
  const value = getValue(segments);

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf
      .map((branch, i) => ({ i, valid: SF.validateNormalized(value, branch).valid }))
      .filter((result) => result.valid);
    const pointer = SF.buildPointer(segments);
    if (matches.length === 1 && !branches.has(pointer)) branches.set(pointer, matches[0].i);
  }

  if (isPlainObject(value) && (
    schema.type === "object" ||
    schema.properties ||
    schema.if ||
    Array.isArray(schema.allOf) ||
    schema.dependencies
  )) {
    const layout = createObjectLayout(schema, value);
    for (const field of layout.fields) {
      inferBranches(field.schema, getValue, segments.concat(field.key), branches);
    }
  }

  if (schema.type === "array" && schema.items && !Array.isArray(schema.items) && Array.isArray(value)) {
    value.forEach((_, i) => inferBranches(schema.items, getValue, segments.concat(i), branches));
  }
}

function findSchemaAt(schema, segments, getValue, branches, walked = []) {
  let current = schema;
  for (const key of segments) {
    if (Array.isArray(current.oneOf)) {
      const pointer = SF.buildPointer(walked);
      const index = branches.has(pointer) ? branches.get(pointer) : 0;
      current = current.oneOf[index] || current.oneOf[0];
    }

    const parentValue = getValue(walked);
    if (
      isPlainObject(parentValue) &&
      (current.type === "object" || current.properties || current.if || Array.isArray(current.allOf) || current.dependencies)
    ) {
      const layout = createObjectLayout(current, parentValue);
      const hit = layout.fields.find((field) => field.key === key);
      if (!hit) return current;
      current = hit.schema;
    } else if (current.type === "array" && current.items && !Array.isArray(current.items)) {
      current = current.items;
    } else {
      return current;
    }

    walked = walked.concat(key);
  }
  return current;
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    module.exports = factory(SF);
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.createObjectLayout = createObjectLayout;
  SF.buildControlTree = buildControlTree;
  SF.pruneFormData = pruneFormData;
  SF.inferBranches = inferBranches;
  SF.findSchemaAt = findSchemaAt;
  SF.branchTitle = branchTitle;
  return SF;
});
