
// --- JSON Pointer helpers (RFC 6901) ---

function pointerEncode(token) {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

function pointerDecode(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** "/users/0/email" -> ["users", "0", "email"] */
function parsePointer(pointer) {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) {
    throw new SF.SchemaError(`Invalid JSON Pointer: ${pointer}`);
  }
  return pointer.slice(1).split("/").map(pointerDecode);
}

/** ["users", 0, "e/0"] -> "/users/0/e~10" */
function buildPointer(segments) {
  if (!segments.length) return "";
  return "/" + segments.map((s) => pointerEncode(s)).join("/");
}

function lookupPointer(root, pointer) {
  const parts = parsePointer(pointer);
  let node = root;
  for (const part of parts) {
    if (node === null || typeof node !== "object" || !(part in node)) {
      throw new SF.SchemaError(`$ref target not found: #${pointer}`, pointer);
  }
    node = node[part];
  }
  return node;
}

function isPlainSchemaObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Clone and inline every supported local $ref once. The caller is
 * responsible for validating refs and proving the ref graph is acyclic.
 */
function expandSchema(root, resolve) {
  const expandedNodes = new Map();

  const cloneValue = (value) => {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (isPlainSchemaObject(value)) return mapObject(value);
    return value;
  };

  const mapObject = (node) => {
    if (typeof node.$ref === "string") {
      const target = resolve(node.$ref);
      if (expandedNodes.has(target)) return expandedNodes.get(target);
      const expanded = {};
      expandedNodes.set(target, expanded);
      Object.assign(expanded, mapObject(target));
      return expanded;
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") continue;
      out[key] = cloneValue(value);
    }
    return out;
  };

  return mapObject(root);
}

/**
 * Schema kernel shared by the validator and the form renderer.
 * Both sides must go through resolveRef so they share one interpretation of
 * the schema (including the same cycle rule).
 */
class SchemaRegistry {
  constructor(rootSchema) {
    if (!rootSchema || typeof rootSchema !== "object") {
      throw new SF.SchemaError("Schema must be an object");
    }
    this.source = rootSchema;
    this._refGraph = null;
    this.assertRefGraphAcyclic();
    this.root = expandSchema(rootSchema, (ref) => this.resolve(ref));
  }

  /**
   * Resolve a $ref. Only same-document refs under #/definitions/... are
   * allowed. Anything with a network/location part is rejected outright.
   */
  resolve(ref) {
    if (typeof ref !== "string" || ref === "") {
      throw new SF.SchemaError(`Invalid $ref: ${String(ref)}`);
    }
    if (ref === "#") {
      throw new SF.SchemaError(
        'Ref "#" (whole-document self reference) is not allowed; ' +
          "only refs into #/definitions/... are supported."
      );
    }
    if (!ref.startsWith("#/definitions/")) {
      throw new SF.SchemaError(
        `Only local refs to #/definitions/... in this document are allowed, got: ${ref}. ` +
          "Remote refs (http://, another file) and pointers outside definitions are forbidden."
      );
    }
    const pointer = ref.slice(1); // strip leading '#'
    return lookupPointer(this.source, pointer);
  }

  /** Follow $ref chains until an ordinary schema object is reached. */
  deref(schema) {
    // The normalized root has every $ref inlined once. This remains as a
    // compatibility shim for callers written against the old Registry API.
    return schema;
  }

  // --- cycle detection over the whole definitions graph ---

  assertRefGraphAcyclic() {
    const graph = this.getRefGraph();
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const node of graph.keys()) color.set(node, WHITE);

    const visit = (node, stack) => {
      color.set(node, GRAY);
      for (const next of graph.get(node) || []) {
        const c = color.get(next);
        if (c === GRAY) {
          const cycle = [...stack.slice(stack.indexOf(next)), next].join(" -> ");
          throw new SF.SchemaError(`Cyclic $ref detected: ${cycle}`);
        }
        if (c === WHITE) visit(next, [...stack, next]);
      }
      color.set(node, BLACK);
    };

    for (const node of graph.keys()) {
      if (color.get(node) === WHITE) visit(node, [node]);
    }
  }

  /**
   * Build a graph: "schema node identity" -> referenced schema nodes.
   * Walks keywords structurally but deliberately skips enum values.
   */
  getRefGraph() {
    if (this._refGraph) return this._refGraph;
    const graph = new Map();

    const childSchemas = (s) => {
      const out = [];
      if (typeof s !== "object" || s === null) return out;
      const push = (v) => {
        if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
      };
      if (s.properties) for (const k of Object.keys(s.properties)) push(s.properties[k]);
      if (s.items) {
        if (Array.isArray(s.items)) s.items.forEach(push);
        else push(s.items);
      }
      if (s.oneOf) s.oneOf.forEach(push);
      if (s.if) push(s.if);
      if (s.then) push(s.then);
      if (s.else) push(s.else);
      if (Array.isArray(s.allOf)) s.allOf.forEach(push);
      // dependencies values are schemas or arrays of property names; only
      // the schema form can contain subschemas / refs. `default` is data
      // and is deliberately never walked.
      if (s.dependencies) {
        for (const k of Object.keys(s.dependencies)) {
          const dep = s.dependencies[k];
          if (dep && typeof dep === "object" && !Array.isArray(dep)) push(dep);
        }
      }
      // draft-07 keeps reusable schemas under definitions; their internal
      // refs are part of the same graph and must participate in cycle checks.
      if (s.definitions) for (const k of Object.keys(s.definitions)) push(s.definitions[k]);
      return out;
    };

    const visit = (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      if (graph.has(node)) return;
      const edges = [];
      graph.set(node, edges);
      if (typeof node.$ref === "string") {
        // Invalid/remote refs throw here as well (registry is single source
        // of truth for what a legal ref is).
        const target = this.resolve(node.$ref);
        edges.push(target);
        visit(target);
      }
      for (const child of childSchemas(node)) {
        visit(child);
        edges.push(child);
      }
    };

    visit(this.source);
    this._refGraph = graph;
    return graph;
  }
}

/** Iterate every schema keyword that may contain subschemas. */
function walkSubschemas(schema, fn) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties) for (const k of Object.keys(schema.properties)) fn(schema.properties[k], "property", k);
  if (schema.items) {
    if (Array.isArray(schema.items)) schema.items.forEach((s, i) => fn(s, "items", i));
    else fn(schema.items, "items", 0);
  }
  if (schema.oneOf) schema.oneOf.forEach((s, i) => fn(s, "oneOf", i));
  if (schema.if) fn(schema.if, "if", 0);
  if (schema.then) fn(schema.then, "then", 0);
  if (schema.else) fn(schema.else, "else", 0);
  if (Array.isArray(schema.allOf)) schema.allOf.forEach((s, i) => fn(s, "allOf", i));
  if (schema.dependencies) {
    for (const k of Object.keys(schema.dependencies)) {
      const dep = schema.dependencies[k];
      if (dep && typeof dep === "object" && !Array.isArray(dep)) fn(dep, "dependencies", k);
    }
  }
}

// UMD-ish: plain <script> tags (works from file://) and Node's ESM import.
(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(SF, require("./errors.js"));
    const mod = factory(SF);
    module.exports = mod;
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.pointerEncode = pointerEncode;
  SF.pointerDecode = pointerDecode;
  SF.parsePointer = parsePointer;
  SF.buildPointer = buildPointer;
  SF.expandSchema = expandSchema;
  SF.SchemaRegistry = SchemaRegistry;
  SF.walkSubschemas = walkSubschemas;
  return SF;
});
