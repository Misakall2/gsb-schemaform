function buildControlTree(model, schema, segments, labelText = "", top = false, requiredValue) {
  const path = SF.buildPointer(segments);
  const value = model.getAt(segments);
  const label = schema.title || labelText;

  if (Array.isArray(schema.oneOf)) {
    const selected = model.branches.has(path) ? model.branches.get(path) : null;
    return {
      kind: "oneOf",
      schema,
      segments,
      path,
      value,
      label,
      selected,
      branches: schema.oneOf.map((branch, index) => ({
        index,
        schema: branch,
        label: branchTitle(branch, index),
      })),
      child: selected == null ? null : buildControlTree(
        model,
        schema.oneOf[selected],
        segments,
        "",
        false
      ),
    };
  }

  if (
    schema.type === "object" ||
    (!schema.type && (schema.properties || Array.isArray(schema.allOf) || schema.if || schema.dependencies))
  ) {
    const plan = model.objectPlan(schema, value);
    return {
      kind: "object",
      schema,
      segments,
      path,
      value,
      label,
      fields: plan.fields
        .filter((field) => plan.active.has(field.key))
        .map((field) => buildControlTree(
          model,
        field.schema,
        [...segments, field.key],
        field.key,
        false,
        plan.required.has(field.key)
      )),
    };
  }

  if (schema.type === "array") {
    const array = Array.isArray(value) ? value : [];
    return {
      kind: "array",
      schema,
      segments,
      path,
      value,
      label,
      items: array.map((_, index) => buildControlTree(
        model,
        schema.items || {},
        [...segments, index],
        "",
        false
      )),
    };
  }

  if (schema.type === "boolean") {
    return {
      kind: "boolean",
      schema,
      segments,
      path,
      value,
      label,
      required: requiredValue !== undefined ? requiredValue : model.isRequired(segments),
    };
  }

  return {
    kind: "primitive",
    schema,
    segments,
    path,
    value,
    label,
    required: requiredValue !== undefined ? requiredValue : (segments.length ? model.isRequired(segments) : false),
    control: Array.isArray(schema.enum) ? "select" : "input",
  };
}

function branchTitle(branch, index) {
  if (!branch || typeof branch !== "object") return `选项 ${index + 1}`;
  if (branch.title) return branch.title;
  if (branch.type === "object" && branch.properties) {
    return "对象: " + Object.keys(branch.properties).join(", ");
  }
  if (branch.const !== undefined) return String(branch.const);
  if (Array.isArray(branch.enum) && branch.enum.length === 1) return String(branch.enum[0]);
  return `选项 ${index + 1}`;
}

(function (root, factory) {
  const SF = (root.SF = root.SF || {});
  if (typeof module === "object" && module.exports) {
    Object.assign(SF, require("./schema-core.js"), require("./schema-model.js"));
    module.exports = factory(SF);
  } else {
    factory(SF);
  }
})(typeof self !== "undefined" ? self : globalThis, function (SF) {
  SF.buildControlTree = buildControlTree;
  SF.branchTitle = branchTitle;
  return SF;
});
