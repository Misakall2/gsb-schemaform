import test from "node:test";
import assert from "node:assert/strict";
import pkg from "../js/validator.js";
const { validate, SchemaRegistry, SchemaError } = pkg;

test("type: 七种基础类型判定", () => {
  const schema = { type: "object" };
  assert.equal(validate({}, schema).valid, true);
  assert.equal(validate([], schema).valid, false);
  assert.equal(validate(null, schema).valid, false);

  // integer 属于 number，number 不容纳小数当 integer
  assert.equal(validate(3, { type: "number" }).valid, true);
  assert.equal(validate(3.5, { type: "integer" }).valid, false);
  assert.equal(validate(3, { type: "integer" }).valid, true);

  for (const [t, v] of [
    ["string", "x"],
    ["boolean", true],
    ["array", [1]],
  ]) {
    assert.equal(validate(v, { type: t }).valid, true);
  }
});

test("required + 错误路径精确到字段", () => {
  const schema = {
    type: "object",
    required: ["email"],
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string" } },
        },
      },
    },
  };
  const r = validate({ users: [{}] }, schema);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === "/users/0/email" && e.keyword === "required"));
});

test("additionalProperties:false 拒绝未定义键，错误挂到该键", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string" } },
  };
  assert.equal(validate({ a: "x" }, schema).valid, true);
  const r = validate({ a: "x", b: 2 }, schema);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === "/b" && e.keyword === "additionalProperties"));
});

test("enum / minimum / maximum / minLength / maxLength / items", () => {
  const schema = {
    type: "object",
    properties: {
      role: { enum: ["a", "b"] },
      n: { type: "integer", minimum: 1, maximum: 3 },
      s: { type: "string", minLength: 2, maxLength: 4 },
      arr: { type: "array", items: { type: "integer" } },
    },
  };
  assert.equal(validate({ role: "a", n: 2, s: "abc", arr: [1, 2] }, schema).valid, true);
  const r = validate({ role: "c", n: 9, s: "toolong", arr: [1, "x"] }, schema);
  const kws = new Set(r.errors.map((e) => `${e.path}:${e.keyword}`));
  assert.ok(kws.has("/role:enum"));
  assert.ok(kws.has("/n:maximum"));
  assert.ok(kws.has("/s:maxLength"));
  assert.ok(kws.has("/arr/1:type"));
});

test("$ref: 本地 definitions 引用（含间接引用）", () => {
  const schema = {
    type: "object",
    required: ["addr"],
    properties: {
      addr: { $ref: "#/definitions/address" },
      alias: { $ref: "#/definitions/addrAlias" },
    },
    definitions: {
      address: {
        type: "object",
        additionalProperties: false,
        required: ["zip"],
        properties: { zip: { type: "string", minLength: 6 } },
      },
      addrAlias: { $ref: "#/definitions/address" },
    },
  };
  assert.equal(
    validate({ addr: { zip: "200000" }, alias: { zip: "200000" } }, schema).valid,
    true
  );
  const bad = validate({ addr: { zip: "1" }, alias: { nope: 1 } }, schema);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.path === "/addr/zip"));
  assert.ok(bad.errors.some((e) => e.path === "/alias/nope"));
});

test("$ref: 禁止远程 / 外部文档引用", () => {
  assert.throws(
    () =>
      validate(
        {},
        { $ref: "https://example.com/schemas/x.json" }
      ),
    SchemaError
  );
  assert.throws(
    () => validate({}, { $ref: "other.json#/definitions/x" }),
    SchemaError
  );
  // dangling local ref
  assert.throws(() => validate({}, { $ref: "#/definitions/missing" }), SchemaError);
});

test("$ref: 直接成环在构造 Registry 时即报错，不会栈溢出", () => {
  const cyclic = {
    definitions: {
      a: { $ref: "#/definitions/b" },
      b: { $ref: "#/definitions/a" },
    },
  };
  assert.throws(() => new SchemaRegistry(cyclic), /Cyclic \$ref/);

  // 自引用
  assert.throws(
    () =>
      new SchemaRegistry({
        definitions: { self: { $ref: "#/definitions/self" } },
      }),
    /Cyclic \$ref/
  );
});

test("$ref: 结构内（items/properties）出现的环也报错", () => {
  const schema = {
    definitions: {
      node: {
        type: "object",
        properties: { child: { $ref: "#/definitions/node" } },
      },
      loop: {
        type: "object",
        properties: { a: { $ref: "#/definitions/back" } },
      },
      back: {
        type: "object",
        properties: { b: { $ref: "#/definitions/loop" } },
      },
    },
  };
  assert.throws(() => new SchemaRegistry(schema), /Cyclic \$ref/);
});

test("oneOf: 必须恰好命中一支", () => {
  const schema = {
    oneOf: [
      { type: "object", required: ["cardNo"], properties: { cardNo: { type: "string" } } },
      { type: "object", required: ["balance"], properties: { balance: { type: "number" } } },
    ],
  };
  assert.equal(validate({ cardNo: "123" }, schema).valid, true);
  assert.equal(validate({ balance: 10 }, schema).valid, true);
  // 两支都不符合
  const none = validate({ weird: true }, schema);
  assert.equal(none.valid, false);
  assert.ok(none.errors.some((e) => e.keyword === "oneOf"));
  // 两支同时符合（如果 schema 允许重叠）
  const overlap = {
    oneOf: [{ type: "string" }, { minLength: 1 }],
  };
  const both = validate("x", overlap);
  assert.equal(both.valid, false);
  assert.ok(both.errors.some((e) => /同时符合/.test(e.message)));
});

test("if/then/else: 条件命中走 then，不命中走 else，互斥生效", () => {
  const schema = {
    type: "object",
    properties: { kind: { enum: ["email", "phone"] } },
    if: { properties: { kind: { const: "email" } }, required: ["kind"] },
    then: { required: ["emailAddr"], properties: { emailAddr: { type: "string" } } },
    else: { required: ["phoneNo"], properties: { phoneNo: { type: "string" } } },
  };
  assert.equal(validate({ kind: "email", emailAddr: "a@b.c" }, schema).valid, true);
  // 命中 if 却只给了 else 的字段 -> then 的 required 失败
  const r1 = validate({ kind: "email", phoneNo: "123" }, schema);
  assert.equal(r1.valid, false);
  assert.ok(r1.errors.some((e) => e.path === "/emailAddr" && e.keyword === "required"));

  assert.equal(validate({ kind: "phone", phoneNo: "123" }, schema).valid, true);
  const r2 = validate({ kind: "phone", emailAddr: "a@b.c" }, schema);
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some((e) => e.path === "/phoneNo"));
});

test("错误对象包含 JSON Pointer 路径、keyword 与中文信息", () => {
  const r = validate(
    { users: [{ email: 5 }] },
    {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: { email: { type: "string" } },
          },
        },
      },
    }
  );
  const e = r.errors.find((x) => x.path === "/users/0/email");
  assert.ok(e);
  assert.equal(e.keyword, "type");
  assert.match(e.message, /字符串/);
});

test("if/then: 分支内约束只报错一次，不重复挂红字", () => {
  const schema = {
    type: "object",
    properties: { kind: { enum: ["a", "b"] } },
    if: { properties: { kind: { const: "a" } }, required: ["kind"] },
    then: {
      required: ["code"],
      properties: { code: { type: "string", minLength: 4 } },
    },
  };
  const r = validate({ kind: "a", code: "x" }, schema);
  const hits = r.errors.filter((e) => e.path === "/code" && e.keyword === "minLength");
  assert.equal(hits.length, 1);
  const missing = validate({ kind: "a" }, schema);
  assert.equal(
    missing.errors.filter((e) => e.path === "/code" && e.keyword === "required").length,
    1
  );
});

test("if/then 内可继续嵌套 if/then/else，且不会死循环", () => {
  const schema = {
    type: "object",
    properties: { kind: { enum: ["email", "phone"] } },
    if: { properties: { kind: { const: "email" } }, required: ["kind"] },
    then: {
      properties: { primary: { type: "boolean" } },
      if: { properties: { primary: { const: true } }, required: ["primary"] },
      then: {
        required: ["emailAddr"],
        properties: { emailAddr: { type: "string" } },
      },
    },
  };
  assert.equal(validate({ kind: "email", primary: false }, schema).valid, true);
  assert.equal(
    validate({ kind: "email", primary: true }, schema).valid,
    false
  );
  assert.equal(
    validate({ kind: "email", primary: true, emailAddr: "a@b.c" }, schema).valid,
    true
  );
});

test("同一 Registry 可被复用于多次校验（出表器与校验器共享解析）", () => {
  const registry = new SchemaRegistry({
    definitions: { id: { type: "integer" } },
    $ref: "#/definitions/id",
  });
  assert.equal(validate(1, registry.root, registry).valid, true);
  assert.equal(validate("1", registry.root, registry).valid, false);
});

test("allOf: 同时满足多支才算通过；字段由各支合并而来", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    allOf: [
      { required: ["age"], properties: { age: { type: "integer", minimum: 0 } } },
      { required: ["city"], properties: { city: { type: "string" } } },
    ],
  };
  assert.equal(validate({ name: "x", age: 10, city: "上海" }, schema).valid, true);
  const r = validate({ name: "x" }, schema);
  assert.equal(r.valid, false);
  assert.ok(
    r.errors.some((e) => e.path === "/age" && /allOf 第 1 支/.test(e.message)),
    "第 1 支缺字段的错误应标明支号"
  );
  assert.ok(
    r.errors.some((e) => e.path === "/city" && /allOf 第 2 支/.test(e.message)),
    "第 2 支缺字段的错误应标明支号"
  );
});

test("allOf: 冲突（一支要求 string 一支要求 integer）失败且指出是哪一支", () => {
  const schema = {
    type: "object",
    properties: { v: {} },
    allOf: [
      { properties: { v: { type: "string" } } },
      { properties: { v: { type: "integer" } } },
    ],
  };
  const r = validate({ v: 5 }, schema);
  assert.equal(r.valid, false);
  const tagged = r.errors.find(
    (e) => e.path === "/v" && /allOf 第 1 支/.test(e.message) && /字符串/.test(e.message)
  );
  assert.ok(tagged, "应能从错误里看出是第 1 支要求字符串而值是数字");
  // 第 2 支本身通过；不应再冒出一个第 2 支的噪声错误
  assert.ok(
    !r.errors.some((e) => e.path === "/v" && /allOf 第 2 支/.test(e.message))
  );
});

test("allOf 分支允许 additionalProperties:false 下由分支贡献的键", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string" } },
    allOf: [{ properties: { b: { type: "integer" } } }],
  };
  assert.equal(validate({ a: "x", b: 2 }, schema).valid, true);
  assert.equal(validate({ a: "x", c: 2 }, schema).valid, false);
});

test("dependencies: 数组形式的属性依赖", () => {
  const schema = {
    type: "object",
    properties: {
      billing: { enum: ["invoice", "none"] },
      taxNo: { type: "string" },
    },
    dependencies: { billing: ["taxNo"] },
  };
  assert.equal(validate({}, schema).valid, true);
  assert.equal(validate({ billing: "none" }, schema).valid, false);
  const r = validate({ billing: "invoice" }, schema);
  assert.ok(r.errors.some((e) => e.keyword === "dependencies"));
  assert.equal(validate({ billing: "invoice", taxNo: "91xx" }, schema).valid, true);
});

test("dependencies: schema 形式的字段依赖，错误带依赖标签", () => {
  const schema = {
    type: "object",
    properties: {
      notify: { enum: ["sms", "email"] },
      phone: { type: "string" },
    },
    dependencies: {
      notify: {
        type: "object",
        if: { properties: { notify: { const: "sms" } }, required: ["notify"] },
        then: { required: ["phone"], properties: { phone: { type: "string" } } },
      },
    },
  };
  assert.equal(validate({ notify: "sms", phone: "139" }, schema).valid, true);
  const r = validate({ notify: "sms" }, schema);
  assert.equal(r.valid, false);
  assert.ok(
    r.errors.some((e) => e.path === "/phone" && /依赖 "notify"/.test(e.message))
  );
  // notify=email 不触发 phone 必填
  assert.equal(validate({ notify: "email" }, schema).valid, true);
});
