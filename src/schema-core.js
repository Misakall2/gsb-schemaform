// Shared schema machinery used by both the validator and the form renderer.
// Everything here works on the SAME raw schema object; validation rules and
// form structure are never defined twice.

export const SUPPORTED_TYPES = [
  'object', 'array', 'string', 'number', 'integer', 'boolean',
];

const REF_PREFIX = '#/definitions/';

export class SchemaError extends Error {}

function decodePointerSegment(seg) {
  // JSON Pointer unescaping, order matters.
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

// Resolve a local $ref. Only pointers into this document's `definitions`
// section are allowed; anything remote (http, //host, other files) is rejected.
export function resolveRef(root, ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new SchemaError(`$ref 必须是非空字符串，收到: ${String(ref)}`);
  }
  if (ref.startsWith('#')) {
    const fragment = ref.slice(1);
    if (fragment === '') {
      return root;
    }
    if (!fragment.startsWith('/definitions/')) {
      throw new SchemaError(
        `只允许指向本文件 #/definitions 下的本地 $ref，禁止引用: ${ref}`,
      );
    }
    const parts = fragment.split('/').slice(1).map(decodePointerSegment);
    // parts[0] === 'definitions'; nested pointer segments inside definitions
    // are allowed, e.g. #/definitions/common/address.
    let node = root;
    for (const part of parts) {
      if (node === null || typeof node !== 'object' || !(part in node)) {
        throw new SchemaError(`$ref 指向了不存在的位置: ${ref}`);
      }
      node = node[part];
    }
    return node;
  }
  throw new SchemaError(
    `禁止网络/外部 $ref，只允许 #/definitions 下的本地引用: ${ref}`,
  );
}

// Follow $ref chains from `schema`. Returns the final concrete schema.
// `seen` (ref strings) guards against cycles at the ref-chain level too.
export function deref(root, schema, seen = new Set()) {
  let node = schema;
  const chain = new Set(seen);
  while (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (chain.has(ref)) {
      throw new SchemaError(`$ref 成环: ${[...chain, ref].join(' -> ')}`);
    }
    chain.add(ref);
    node = resolveRef(root, ref);
  }
  return node;
}

// Static structural check: walk every subschema reachable from `schema` and
// make sure no $ref cycle exists anywhere, so the form can never recurse
// infinitely while building controls.
export function assertNoRefCycles(root, schema = root, state = {
  // $ref strings currently being expanded along this walk path.
  refs: new Set(),
  // concrete schema objects already fully verified (DAG dedupe).
  done: new WeakSet(),
}) {
  walkRefs(root, schema, state);
  return true;
}

function walkRefs(root, schema, state) {
  let node = schema;
  // Follow ref chains at this entry point, tracking ref strings.
  while (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (state.refs.has(ref)) {
      throw new SchemaError(
        `$ref 成环: ${[...state.refs, ref].join(' -> ')}`);
    }
    state.refs.add(ref);
    node = resolveRef(root, ref);
  }
  if (!node || typeof node !== 'object') {
    return;
  }
  if (state.done.has(node)) return;
  state.done.add(node);

  for (const child of childSchemas(node)) {
    walkRefs(root, child, { refs: new Set(state.refs), done: state.done });
  }
}

// Enumerate the immediate subschemas of one schema node (not following refs
// of the node itself; callers deref first). Covers the draft-07 subset used.
export function childSchemas(node) {
  const children = [];
  const push = (s) => {
    if (s && typeof s === 'object') children.push(s);
  };
  if (node.properties) {
    for (const key of Object.keys(node.properties)) push(node.properties[key]);
  }
  if (typeof node.additionalProperties === 'object') {
    push(node.additionalProperties);
  }
  if (node.items) {
    if (Array.isArray(node.items)) node.items.forEach(push);
    else push(node.items);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key])) node[key].forEach(push);
  }
  for (const key of ['if', 'then', 'else', 'not']) {
    if (node[key]) push(node[key]);
  }
  if (node.$ref) {
    // Resolved/deref'd nodes have no $ref, but keep child walking safe:
    // the target is visited by the caller after deref, nothing extra here.
  }
  return children;
}

// Validate the shape of the schema document itself (cheap, subset-specific).
export function assertValidSchema(root) {
  // One walk that both type-checks every node and proves there is no $ref
  // cycle. `refs` tracks ref strings on the current walk path; `done` memoizes
  // concrete nodes so DAG-shaped reuse does not re-walk repeatedly.
  const done = new WeakSet();
  const walk = (schema, path, refs) => {
    let node = schema;
    while (node && typeof node === 'object'
      && typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (refs.has(ref)) {
        throw new SchemaError(
          `$ref 成环: ${[...refs, ref].join(' -> ')}`);
      }
      refs = new Set(refs);
      refs.add(ref);
      node = resolveRef(root, ref);
    }
    if (node === true || node === false) return;
    if (!node || typeof node !== 'object') {
      throw new SchemaError(`schema 必须是对象 (位于 ${path})`);
    }
    if (done.has(node)) return;
    done.add(node);

    if (node.type !== undefined) {
      const types = [].concat(node.type);
      for (const t of types) {
        if (!SUPPORTED_TYPES.includes(t)) {
          throw new SchemaError(`不支持的 type: ${t} (位于 ${path})`);
        }
      }
    }
    for (const child of childSchemas(node)) walk(child, path, refs);
  };
  walk(root, '#', new Set());
}

export const escapePointer = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

// Build a JSON-pointer style path used for UI error anchors:
// /users/0/email
export const formatPath = (segments) =>
  '/' + segments.map((s) => escapePointer(s)).join('/');
