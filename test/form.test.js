import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, fire } from './fake-dom.js';
import { SchemaForm } from '../src/form.js';
import { validate } from '../src/validator.js';

installFakeDom();

function makeContainer() {
  return document.createElement('div');
}

function setText(form, path, value) {
  form.setScalar(path, value);
}

test('object fields render and emitted JSON passes the same schema', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'integer', minimum: 0 },
    },
  };
  const form = new SchemaForm(schema, makeContainer());
  setText(form, ['name'], '张三');
  setText(form, ['age'], '30');
  const data = form.getData();
  assert.deepEqual(data, { name: '张三', age: 30 });
  assert.equal(validate(schema, data).valid, true);
});

test('empty optional numeric key is omitted; invalid integer fails', () => {
  const schema = {
    type: 'object',
    properties: { age: { type: 'integer' } },
  };
  const form = new SchemaForm(schema, makeContainer());
  assert.deepEqual(form.getData(), {});
  form.setScalar(['age'], '1.5');
  assert.equal(validate(schema, form.getData()).valid, false);
  form.setScalar(['age'], '7');
  assert.equal(validate(schema, form.getData()).valid, true);
});

test('boolean uses checkbox-like boolean state', () => {
  const schema = {
    type: 'object',
    properties: { vip: { type: 'boolean' } },
  };
  const form = new SchemaForm(schema, makeContainer());
  assert.deepEqual(form.getData(), { vip: false });
  form.toggleBoolean(['vip'], true);
  assert.deepEqual(form.getData(), { vip: true });
});

test('array rows can be added and removed and paths include index', () => {
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
  const form = new SchemaForm(schema, makeContainer());
  form.addArrayItem(['users'], schema.properties.users.items);
  form.addArrayItem(['users'], schema.properties.users.items);
  form.setScalar(['users', 1, 'email'], 'a@b.c');

  let r = validate(schema, form.getData());
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === '/users/0/email'));

  form.setScalar(['users', 0, 'email'], 'x@y.z');
  r = validate(schema, form.getData());
  assert.equal(r.valid, true);

  form.removeArrayItem(['users'], 0);
  assert.deepEqual(form.getData(), { users: [{ email: 'a@b.c' }] });
});

test('oneOf: choosing a branch renders its fields and output validates', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['contact'],
    properties: {
      contact: {
        oneOf: [
          {
            title: '邮箱',
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'email'],
            properties: {
              kind: { type: 'string', enum: ['email'] },
              email: { type: 'string', minLength: 3 },
            },
          },
          {
            title: '电话',
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'phone'],
            properties: {
              kind: { type: 'string', enum: ['phone'] },
              phone: { type: 'string', minLength: 6 },
            },
          },
        ],
      },
    },
  };
  const form = new SchemaForm(schema, makeContainer());
  // Default branch index 0 (email). Fill email data.
  form.setScalar(['contact', 'email'], 'a@b.c');

  // User switches to the phone branch: email-branch data must not leak,
  // and the result must FAIL until phone fields are completed.
  form.selectBranch(['contact'], 1);
  let data = form.getData();
  // Active branch's empty required keys stay (they must fail validation);
  // the inactive branch's email key must not leak through.
  assert.equal('email' in data.contact, false);
  assert.equal(validate(schema, data).valid, false);

  form.setScalar(['contact', 'phone'], '13800000');
  data = form.getData();
  // kind still empty -> enum/required fails; choose it via the enum control.
  assert.deepEqual(data.contact, { kind: '', phone: '13800000' });
  form.setScalar(['contact', 'kind'], 'phone');
  assert.equal(validate(schema, form.getData()).valid, true);

  // Switching back to email branch with phone-shaped data must fail.
  form.selectBranch(['contact'], 0);
  // email value survived the branch toggle.
  form.setScalar(['contact', 'kind'], 'email');
  assert.equal(validate(schema, form.getData()).valid, true);
});

test('if/then/else renders and validates dynamically, never both branches', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['country'],
    properties: {
      country: { type: 'string', enum: ['CN', 'US'] },
    },
    if: { properties: { country: { enum: ['CN'] } }, required: ['country'] },
    then: {
      required: ['province'],
      properties: { province: { type: 'string', minLength: 2 } },
    },
    else: {
      required: ['postalCode'],
      properties: { postalCode: { type: 'string', minLength: 3 } },
    },
  };
  const form = new SchemaForm(schema, makeContainer());
  form.setScalar(['country'], 'US');
  // else branch active
  assert.equal(
    validate(schema, form.getData()).errors.some((e) =>
      e.path === '/postalCode'), true);
  form.setScalar(['postalCode'], '90001');
  assert.equal(validate(schema, form.getData()).valid, true);

  // Switch condition to CN: postalCode must disappear from output and
  // province becomes required.
  form.setScalar(['country'], 'CN');
  const data = form.getData();
  assert.equal('postalCode' in data, false);
  assert.equal('province' in data, true);
  assert.equal(validate(schema, data).valid, false);
  form.setScalar(['province'], '浙江');
  assert.equal(validate(schema, form.getData()).valid, true);
});

test('round-trip: JSON -> form -> JSON keeps semantics', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'tags', 'contact'],
    properties: {
      name: { type: 'string' },
      vip: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      contact: {
        oneOf: [
          {
            title: '邮箱',
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'email'],
            properties: {
              kind: { type: 'string', enum: ['email'] },
              email: { type: 'string' },
            },
          },
          {
            title: '电话',
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'phone'],
            properties: {
              kind: { type: 'string', enum: ['phone'] },
              phone: { $ref: '#/definitions/phone' },
            },
          },
        ],
      },
    },
    definitions: {
      phone: { type: 'string', minLength: 6 },
    },
  };
  const original = {
    name: '李四',
    vip: true,
    tags: ['a', 'b'],
    contact: { kind: 'phone', phone: '13912345678' },
  };
  const form = new SchemaForm(schema, makeContainer());
  form.setData(original);
  const again = form.getData();
  assert.deepEqual(again, original);
  assert.equal(validate(schema, again).valid, true);
});

test('local $ref rules are reused by the form and validator alike', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['phone'],
    properties: { phone: { $ref: '#/definitions/phone' } },
    definitions: { phone: { type: 'string', minLength: 6 } },
  };
  const form = new SchemaForm(schema, makeContainer());
  form.setScalar(['phone'], '12345');
  assert.equal(validate(schema, form.getData()).valid, false);
  form.setScalar(['phone'], '123456');
  assert.equal(validate(schema, form.getData()).valid, true);
});

test('errors are attached at the control path inside the rendered tree', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['email'],
    properties: { email: { type: 'string', minLength: 3 } },
  };
  const container = makeContainer();
  const form = new SchemaForm(schema, container);
  form.setScalar(['email'], 'x'); // triggers showErrors
  const { result } = form.submit();
  assert.equal(result.valid, false);
  const errNode = container.find((n) =>
    n.className === 'sf-error' && /email|字符/.test(n.textContent));
  assert.ok(errNode);
});
