const SUBSCHEMA_KEYWORDS = {
  properties: "objectEach",
  items: "items",
  oneOf: "array",
  anyOf: "array",
  allOf: "array",
  not: "one",
  if: "one",
  then: "one",
  else: "one",
  definitions: "objectEach",
  dependencies: "dependencies",
};

class CompiledSchema {
  constructor(raw, registry) {
    this.raw = raw;
    this.registry = registry;
    this.root = expandSchema(raw, registry);
  }
}

function expandSchema(root, registry) {
  const expandNode = (node) => {
    let source = node;
    if (node && typeof node === "object" && typeof node.$ref === "string") {
      // Draft-07: siblings beside $ref are ignored.
      source = registry.resolve(node.$ref);
      return expandNode(source);
    }
    if (!source || typeof source !== "object") return source;
    if (Array.isArray(source)) return source.map(expandNode);

    const out = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === "$ref") continue;
      const shape = SUBSCHEMA_KEYWORDS[key];
      if (!shape) {
        out[key] = SF.cloneJson(value);
        continue;
      }
      if (shape === "array" && Array.isArray(value)) {
        out[key] = value.map(expandNode);
      } else if (shape === "one" && value && typeof value === "object") {
        out[key] = expandNode(value);
      } else if (shape === "items") {
        if (Array.isArray(value)) out[key] = value.map(expandNode);
        else if (value && typeof value === "object") out[key] = expandNode(value);
        else out[key] = SF.cloneJson(value);
      } else if (shape === "objectEach" && value && typeof value === "object") {
        out[key] = {};
        for (const [childKey, child] of Object.entries(value)) {
          out[key][childKey] = expandNode(child);
        }
      } else if (shape === "dependencies" && value && typeof value === "object") {
        out[key] = {};
        for (const [trigger, dependency] of Object.entries(value)) {
          out[key][trigger] = Array.isArray(dependency)
            ? SF.cloneJson(dependency)
            : expandNode(dependency);
        }
      } else {
        out[key] = SF.cloneJson(value);
      }
    }
    return out;
  };
  return expandNode(root);
}

function compileSchema(schema) {
  const normalized = SF.normalizeSchema(schema);
  const registry = new SF.SchemaRegistry(normalized);
  return new CompiledSchema(normalized, registry);
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(SF, require("./errors.js"), require("./schema-core.js"), require("./schema-normalize.js"));
    module.exports = factory(SF);
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.CompiledSchema = CompiledSchema;
  SF.compileSchema = compileSchema;
  SF.expandSchema = expandSchema;
  return SF;
});
