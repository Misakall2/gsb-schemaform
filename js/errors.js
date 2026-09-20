/**
 * Thrown when a schema itself is unusable: malformed/remote $ref, cycles, etc.
 * This is distinct from a data-validation failure.
 *
 * UMD-ish: plain <script> tags (works from file://) and Node's ESM import.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.SF = Object.assign(root.SF || {}, mod);
})(typeof self !== "undefined" ? self : globalThis, function () {
  class SchemaError extends Error {
    constructor(message, ref) {
      super(ref ? `${message} (at ${ref})` : message);
      this.name = "SchemaError";
      this.ref = ref || null;
    }
  }
  return { SchemaError };
});
