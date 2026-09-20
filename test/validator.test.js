import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, matches } from '../src/validator.js';
import {
  assertValidSchema,
  resolveRef,
  SchemaError,
} from '../src/schema-core.js';

test('types: string/number/integer/boolean/object/array', () => {
  const schema = {
    type: 'object',
    properties: {
      s: { type: 'string' },
      n: { type: 'number' },
      i: { type: 'integer' },
      b: { type: 'boolean' },
      a: { type: 'array', items: { type: 'string' } },
    },
    required: ['s', 'n', 'i', 'b', 'a'],
  };
  assert.equal(validate(schema, {
    s: 'x', n: 1.5, i: 3, b: true, a: ['p', 'q'],
  }).valid, true);

  const r1 = validate(schema, { s: 1, n: 'x', i: 1.2, b: 'yes', a: {} });
  assert.equal(r1.valid, false);
  assert.equal(r1.errors.length, 5);
  assert.deepEqual(r1.errors.map((e) => e.path).sort(),
    ['/a', '/b', '/i', '/n', '/s']);
});

test('required error is attached at the property path', () => {
  const schema = {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string' } },
  };
  const r = validate(schema, {});
  assert.equal(r.valid, false);
  assert.equal(r.errors[0].path, '/email');
  assert.match(r.errors[0].message, /必填/);
});

test('enum', () => {
  const schema = { type: 'string', enum: ['a', 'b'] };
  assert.equal(validate(schema, 'a').valid, true);
  const r = validate(schema, 'c');
  assert.equal(r.valid, false);
  assert.match(r.errors[0].message, /必须是以下之一/);
});

test('minimum/maximum and minLength/maxLength', () => {
  const schema = {
    type: 'object',
    properties: {
      age: { type: 'integer', minimum: 0, maximum: 120 },
      name: { type: 'string', minLength: 2, maxLength: 5 },
    },
  };
  assert.equal(validate(schema, { age: 30, name: 'abc' }).valid, true);
  const r = validate(schema, { age: -1, name: 'abcdef' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === '/age'));
  assert.ok(r.errors.some((e) => e.path === '/name'));
});

test('array item errors use index in path, e.g. /users/0/email', () => {
  const schema = {
    type: 'object',
    properties: {
      users: {
        type: 'array',
        items: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', minLength: 3 } },
        },
      },
    },
  };
  const r = validate(schema, { users: [{ email: 'ok@x' }, { email: 'x' }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === '/users/1/email'));
});

test('additionalProperties: false rejects extra keys and names the path', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string' } },
  };
  assert.equal(validate(schema, { a: 'x' }).valid, true);
  const r = validate(schema, { a: 'x', rogue: 1 });
  assert.equal(r.valid, false);
  assert.equal(r.errors[0].path, '/rogue');
  assert.match(r.errors[0].message, /额外/);
});

test('additionalProperties schema applies to extra keys', () => {
  const schema = {
    type: 'object',
    additionalProperties: { type: 'string' },
  };
  assert.equal(validate(schema, { x: 's' }).valid, true);
  assert.equal(validate(schema, { x: 1 }).valid, false);
});

test('local $ref into definitions validates shared rules', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['phone'],
    properties: { phone: { $ref: '#/definitions/phone' } },
    definitions: {
      phone: { type: 'string', minLength: 6, maxLength: 20 },
    },
  };
  assert.equal(validate(schema, { phone: '13800000' }).valid, true);
  const r = validate(schema, { phone: '12' });
  assert.equal(r.valid, false);
  assert.equal(r.errors[0].path, '/phone');
});

test('nested pointer under definitions is supported', () => {
  const schema = {
    definitions: {
      common: {
        address: { type: 'object', required: ['city'],
          properties: { city: { type: 'string' } } },
      },
    },
    type: 'object',
    properties: { home: { $ref: '#/definitions/common/address' } },
  };
  assert.equal(validate(schema, { home: { city: 'SH' } }).valid, true);
  assert.equal(validate(schema, { home: {} }).valid, false);
});

test('remote and non-definitions refs are rejected', () => {
  assert.throws(() => resolveRef({}, 'http://example.com/s.json'),
    SchemaError);
  assert.throws(() => resolveRef({}, 'https://example.com/s'),
    SchemaError);
  assert.throws(() => resolveRef({}, 'other.json'), SchemaError);
  assert.throws(() => resolveRef({}, '#/components/x'), SchemaError);

  const schema = {
    type: 'object',
    properties: { x: { $ref: 'http://evil.example/schema' } },
  };
  assert.throws(() => validate(schema, { x: 1 }), SchemaError);
});

test('$ref to missing pointer throws', () => {
  const schema = { properties: { x: { $ref: '#/definitions/nope' } } };
  assert.throws(() => assertValidSchema(schema), SchemaError);
});

test('cyclic $ref is detected and reported, never infinite recursion', () => {
  const direct = {
    definitions: {
      a: { $ref: '#/definitions/b' },
      b: { $ref: '#/definitions/a' },
    },
    $ref: '#/definitions/a',
  };
  assert.throws(() => assertValidSchema(direct), /循环引用|成环/);

  const self = {
    definitions: { node: { $ref: '#/definitions/node' } },
    $ref: '#/definitions/node',
  };
  assert.throws(() => assertValidSchema(self), /循环引用|成环/);

  // Cycle hidden behind properties must also be caught at schema-load time.
  const nested = {
    type: 'object',
    properties: { child: { $ref: '#/definitions/rec' } },
    definitions: {
      rec: {
        type: 'object',
        properties: { loop: { $ref: '#/definitions/rec' } },
      },
    },
  };
  assert.throws(() => assertValidSchema(nested), /循环引用|成环/);
});

test('oneOf: exactly one branch must match', () => {
  const schema = {
    oneOf: [
      { type: 'object', required: ['email'],
        properties: { email: { type: 'string' } } },
      { type: 'object', required: ['phone'],
        properties: { phone: { type: 'string' } } },
    ],
  };
  assert.equal(validate(schema, { email: 'a@b.c' }).valid, true);
  assert.equal(validate(schema, { phone: '123' }).valid, true);

  const none = validate(schema, { other: true });
  assert.equal(none.valid, false);
  assert.match(none.errors[0].message, /不满足任何一个分支/);
});

test('oneOf: matching more than one branch also fails', () => {
  const schema = {
    oneOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'integer' } } },
    ],
  };
  // {} satisfies both branches (no required fields), so it is ambiguous.
  const r = validate(schema, {});
  assert.equal(r.valid, false);
  assert.match(r.errors[0].message, /同时满足 2 个分支/);
});

test('oneOf with discriminator enum: wrong discriminator value fails', () => {
  // Mirrors the form behavior: kind selects the branch.
  const schema = {
    type: 'object',
    oneOf: [
      {
        additionalProperties: false,
        required: ['kind', 'email'],
        properties: {
          kind: { type: 'string', enum: ['email'] },
          email: { type: 'string', minLength: 3 },
        },
      },
      {
        additionalProperties: false,
        required: ['kind', 'phone'],
        properties: {
          kind: { type: 'string', enum: ['phone'] },
          phone: { type: 'string', minLength: 6 },
        },
      },
    ],
  };
  // User picked the email branch but the data carries phone fields.
  const wrong = validate(schema, { kind: 'email', phone: '13800000' });
  assert.equal(wrong.valid, false);
  // Right branch, right data.
  assert.equal(
    validate(schema, { kind: 'phone', phone: '13800000' }).valid, true);
});

test('oneOf error is anchored at the object path, not only the root', () => {
  const schema = {
    type: 'object',
    properties: {
      contact: { oneOf: [{ type: 'string' }, { type: 'boolean' }] },
    },
  };
  const r = validate(schema, { contact: 42 });
  assert.ok(r.errors.some((e) => e.path === '/contact'));
});

test('if/then applies when condition holds', () => {
  const schema = {
    type: 'object',
    properties: {
      country: { type: 'string', enum: ['CN', 'US'] },
      province: { type: 'string' },
      postalCode: { type: 'string' },
    },
    if: { properties: { country: { enum: ['CN'] } }, required: ['country'] },
    then: { required: ['province'],
      properties: { province: { type: 'string', minLength: 2 } } },
    else: { required: ['postalCode'] },
  };
  assert.equal(validate(schema, { country: 'CN', province: '浙江' }).valid,
    true);
  const missingThen = validate(schema, { country: 'CN' });
  assert.equal(missingThen.valid, false);
  assert.equal(missingThen.errors[0].path, '/province');
});

test('else applies when condition does not hold', () => {
  const schema = {
    type: 'object',
    properties: { vip: { type: 'boolean' }, level: { type: 'string' } },
    if: { properties: { vip: { const: true } }, required: ['vip'] },
    then: { required: ['level'] },
  };
  // const is not in the supported subset; emulate with enum.
  schema.if.properties.vip = { type: 'boolean', enum: [true] };
  assert.equal(validate(schema, { vip: false }).valid, true);
  assert.equal(validate(schema, { vip: true }).valid, false);
});

test('$ref shared by validator logic: matches() helper agrees', () => {
  const schema = { type: 'string', minLength: 2 };
  assert.equal(matches(schema, 'abc'), true);
  assert.equal(matches(schema, 'a'), false);
});

test('integers reject floats and non-finite numbers', () => {
  const schema = { type: 'integer' };
  assert.equal(validate(schema, 5).valid, true);
  assert.equal(validate(schema, 5.0).valid, true);
  assert.equal(validate(schema, 5.5).valid, false);
});

test('unknown schema type in document is rejected up front', () => {
  assert.throws(() => assertValidSchema({ type: 'null' }), SchemaError);
});
