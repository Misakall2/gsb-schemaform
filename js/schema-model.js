function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
      if (value !== undefined) {
        out[key] = value;
        any = true;
      }
    }
    return any ? out : undefined;
  }
  return undefined;
}

function objectDefault(schema) {
  return explicitDefault(schema) || {};
}

function materializeDefault(schema) {
  if (!schema || typeof schema !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(schema, "default")) {
    return JSON.parse(JSON.stringify(schema.default));
  }
  if (schema.type === "object") return objectDefault(schema);
  return defaultFor(schema);
}

class SchemaModel {
  constructor(compiled, validate) {
    this.compiled = compiled;
    this.validate = validate;
    this.rootSchema = compiled.root;
    this.data = undefined;
    this.branches = new Map();
    this.stash = new Map();
  }

  getAt(segments) {
    if (segments.length === 0) return this.data;
    let node = this.data;
    for (const key of segments) {
      if (node === undefined || node === null || typeof node !== "object") return undefined;
      node = node[key];
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
      const key = segments[i];
      const nextRaw = segments[i + 1];
      if (node[key] === undefined || node[key] === null || typeof node[key] !== "object") {
        node[key] = /^\d+$/.test(nextRaw) ? [] : {};
      }
      node = node[key];
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

  resetState() {
    this.branches = new Map();
    this.stash = new Map();
  }

  selectBranch(segments, index) {
    const pointer = SF.buildPointer(segments);
    const previous = this.branches.has(pointer) ? this.branches.get(pointer) : null;
    if (previous !== null && previous !== index) {
      this.stashBranch(segments, previous, this.getAt(segments));
    }
    this.branches.set(pointer, index);
    const saved = this.unstashBranch(segments, index);
    this.setAt(segments, saved !== undefined ? saved : defaultFor(this.schemaAt(segments)));
  }

  clearBranch(segments) {
    const pointer = SF.buildPointer(segments);
    const previous = this.branches.has(pointer) ? this.branches.get(pointer) : null;
    if (previous !== null) this.stashBranch(segments, previous, this.getAt(segments));
    this.deleteAt(segments);
    this.branches.delete(pointer);
  }

  stashBranch(segments, branchIndex, value) {
    const pointer = SF.buildPointer(segments);
    if (!this.stash.has(pointer)) this.stash.set(pointer, {});
    this.stash.get(pointer)[branchIndex] = value === undefined
      ? undefined
      : JSON.parse(JSON.stringify(value));
  }

  unstashBranch(segments, branchIndex) {
    const bucket = this.stash.get(SF.buildPointer(segments));
    if (!bucket || !(branchIndex in bucket)) return undefined;
    return bucket[branchIndex];
  }

  setJSON(value) {
    this.resetState();
    this.data = value === undefined ? undefined : this.normalizeValue(this.rootSchema, value);
    this.inferBranches(this.rootSchema, []);
    this.pruneData(this.rootSchema, this.data, []);
    return this.data;
  }

  normalizeValue(schema, value) {
    if (!schema || value === null || value === undefined) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }
    if (Array.isArray(schema.oneOf)) {
      for (const branch of schema.oneOf) {
        if (this.validate(value, branch, this.compiled).valid) {
          return this.normalizeValue(branch, value);
        }
      }
      return JSON.parse(JSON.stringify(value));
    }
    if (Array.isArray(value) && schema.items) {
      return value.map((item) => this.normalizeValue(schema.items, item));
    }
    if (isPlainObject(value)) {
      const { fields, active, hidden } = this.objectPlan(schema, value);
      const propSchemas = {};
      for (const field of fields) {
        if (active.has(field.key)) propSchemas[field.key] = field.schema;
      }
      const out = {};
      for (const key of Object.keys(value)) {
        if (hidden.has(key)) continue;
        const normalized = this.normalizeValue(propSchemas[key] || {}, value[key]);
        if (normalized !== undefined) out[key] = normalized;
      }
      return out;
    }
    if (typeof value === "string" && value === "" && !Array.isArray(schema.enum)) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(value));
  }

  inferBranches(schema, segments) {
    if (!schema || typeof schema !== "object") return;
    if (Array.isArray(schema.oneOf)) {
      const value = this.getAt(segments);
      const matches = schema.oneOf
        .map((branch, index) => ({ index, ok: this.validate(value, branch, this.compiled).valid }))
        .filter((candidate) => candidate.ok);
      const pointer = SF.buildPointer(segments);
      if (matches.length === 1 && !this.branches.has(pointer)) {
        this.branches.set(pointer, matches[0].index);
      }
    }
    const value = this.getAt(segments);
    if (isPlainObject(value) && (schema.properties || schema.if || schema.allOf || schema.dependencies)) {
      const { fields } = this.objectPlan(schema, value);
      for (const field of fields) {
        this.inferBranches(field.schema, [...segments, field.key]);
      }
    }
    if (schema.type === "array" && schema.items && !Array.isArray(schema.items)) {
      const array = this.getAt(segments);
      if (Array.isArray(array)) {
        array.forEach((_, index) => this.inferBranches(schema.items, [...segments, index]));
      }
    }
  }

  evaluateCondition(value, condition) {
    return SF.evaluateCondition(
      value,
      condition,
      (candidate, candidateSchema) => this.validate(candidate, candidateSchema, this.compiled)
    );
  }

  objectPlan(schema, value) {
    return SF.createObjectPlan(
      schema,
      value,
      (conditionValue, conditionSchema) => this.evaluateCondition(conditionValue, conditionSchema)
    );
  }

  pruneData(schema, value, segments) {
    if (!schema || value === null || value === undefined) return;

    if (Array.isArray(schema.oneOf)) {
      const index = this.branches.get(SF.buildPointer(segments));
      if (index !== undefined && schema.oneOf[index]) {
        if (isPlainObject(value)) {
          const ownedBySelected = new Set();
          const ownedByAny = new Set();
          schema.oneOf.forEach((branch, branchIndex) => {
            const keys = new Set();
            SF.collectOwnedKeys(branch, keys);
            for (const key of keys) {
              ownedByAny.add(key);
              if (branchIndex === index) ownedBySelected.add(key);
            }
          });
          for (const key of Object.keys(value)) {
            if (ownedByAny.has(key) && !ownedBySelected.has(key)) delete value[key];
          }
        }
        this.pruneData(schema.oneOf[index], value, segments);
      }
      return;
    }

    if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
      value.forEach((_, index) => this.pruneData(schema.items, value[index], [...segments, index]));
      return;
    }

    if (isPlainObject(value)) {
      const { fields, hidden } = this.objectPlan(schema, value);
      for (const key of hidden) delete value[key];
      for (const field of fields) {
        if (value[field.key] !== undefined) {
          this.pruneData(field.schema, value[field.key], [...segments, field.key]);
        }
      }
    }
  }

  schemaAt(segments) {
    let schema = this.rootSchema;
    let walked = [];
    for (const key of segments) {
      if (Array.isArray(schema.oneOf)) {
        const branchIndex = this.branches.get(SF.buildPointer(walked));
        schema = schema.oneOf[branchIndex ?? 0];
      }

      const parentValue = this.getAt(walked);
      if (isPlainObject(parentValue) &&
          (schema.properties || schema.if || schema.allOf || schema.dependencies)) {
        const { fields } = this.objectPlan(schema, parentValue);
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

  isRequired(segments) {
    if (segments.length === 0) return false;
    const parentSegments = segments.slice(0, -1);
    const key = segments[segments.length - 1];
    const parentSchema = this.schemaAt(parentSegments);
    if (!parentSchema) return false;
    const value = this.getAt(parentSegments);
    if (!isPlainObject(value)) {
      return Array.isArray(parentSchema.required) && parentSchema.required.includes(key);
    }

    const required = new Set(Array.isArray(parentSchema.required) ? parentSchema.required : []);
    const collect = (schema, isActive) => {
      if (!schema || typeof schema !== "object") return;
      if (Array.isArray(schema.required) && isActive) schema.required.forEach((name) => required.add(name));
      if (Array.isArray(schema.allOf)) schema.allOf.forEach((branch) => collect(branch, isActive));
      if (schema.dependencies) {
        for (const trigger of Object.keys(schema.dependencies)) {
          const on = Object.prototype.hasOwnProperty.call(value, trigger);
          const dependency = schema.dependencies[trigger];
          if (dependency && typeof dependency === "object" && !Array.isArray(dependency)) {
            collect(dependency, isActive && on);
          } else if (Array.isArray(dependency) && isActive && on) {
            dependency.forEach((name) => required.add(name));
          }
        }
      }
      if (schema.if) {
        const on = this.evaluateCondition(value, schema.if);
        collect(schema.then, isActive && on);
        collect(schema.else, isActive && !on);
      }
    };
    collect(parentSchema, true);
    return required.has(key);
  }

  reindexBranchMeta(segments, deletedIndex) {
    const depth = segments.length;
    const remap = (map) => {
      const next = new Map();
      for (const [pointer, value] of map) {
        const pathSegments = SF.parsePointer(pointer);
        let matches = pathSegments.length > depth;
        for (let d = 0; matches && d < depth; d++) {
          if (pathSegments[d] !== String(segments[d])) matches = false;
        }
        if (!matches) { next.set(pointer, value); continue; }
        const index = Number(pathSegments[depth]);
        if (!Number.isInteger(index) || Number.isNaN(index)) { next.set(pointer, value); continue; }
        if (index === deletedIndex) continue;
        if (index > deletedIndex) pathSegments[depth] = String(index - 1);
        next.set(SF.buildPointer(pathSegments), value);
      }
      return next;
    };
    this.branches = remap(this.branches);
    this.stash = remap(this.stash);
    this.inferBranches(this.rootSchema, []);
  }
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(SF, require("./schema-core.js"), require("./schema-layout.js"));
    module.exports = factory(SF);
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.SchemaModel = SchemaModel;
  SF.defaultFor = defaultFor;
  SF.explicitDefault = explicitDefault;
  SF.materializeDefault = materializeDefault;
  return SF;
});
