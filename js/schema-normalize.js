function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Normalize the input without changing its JSON Schema semantics.
 * $schema and other documentation metadata stay available on compiled root.
 */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") {
    throw new SF.SchemaError("Schema must be an object");
  }
  return cloneJson(schema);
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(SF, require("./errors.js"));
    module.exports = factory(SF);
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.normalizeSchema = normalizeSchema;
  SF.cloneJson = cloneJson;
  return SF;
});
