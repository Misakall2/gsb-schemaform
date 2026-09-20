import test from "node:test";
import assert from "node:assert/strict";
import { installDomShim, findAll, FakeDocument } from "./dom-shim.mjs";

installDomShim();

const { SchemaForm } = (await import("../js/form.js")).default;
const { validate } = (await import("../js/validator.js")).default;

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "contacts"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 10 },
    age: { type: "integer", minimum: 0, maximum: 120 },
    role: { enum: ["a", "b"] },
    active: { type: "boolean" },
    contacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: { enum: ["email", "phone"] },
          value: { type: "string" },
        },
        if: { properties: { kind: { const: "email" } }, required: ["kind"] },
        then: { properties: { primary: { type: "boolean" } } },
        else: { properties: { sms: { type: "boolean" } } },
      },
    },
    payment: {
      oneOf: [
        {
          title: "card",
          type: "object",
          additionalProperties: false,
          required: ["cardNo"],
          properties: { cardNo: { type: "string", minLength: 4 } },
        },
        {
          title: "balance",
          type: "object",
          additionalProperties: false,
          required: ["balance"],
          properties: { balance: { type: "number", minimum: 0 } },
        },
      ],
    },
  },
};

function mount() {
  const root = FakeDocument.createElement("div");
  const form = new SchemaForm(root, schema);
  return { root, form };
}

test("回填 -> 输出：语义一致，且再次用同一份 schema 校验通过", () => {
  const { form } = mount();
  const input = {
    name: "张三",
    age: 30,
    role: "a",
    active: true,
    contacts: [
      { kind: "email", value: "a@b.com", primary: true },
      { kind: "phone", value: "139", sms: false },
    ],
    payment: { balance: 10 },
  };
  form.setJSON(input);
  const out = JSON.parse(form.toJSONString());
  assert.deepEqual(out, input);
  assert.equal(validate(out, schema).valid, true);
  const submit = form.submit();
  assert.equal(submit.valid, true);
});

test("错误挂到具体路径 /contacts/0/value", () => {
  const { form } = mount();
  form.setJSON({
    name: "x",
    contacts: [{ kind: "email", value: 123 }],
  });
  const result = form.submit();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "/contacts/0/value" && e.keyword === "type"));
});

test("additionalProperties:false 时多出来的键被校验器拒绝", () => {
  const { form } = mount();
  form.setJSON({ name: "x", contacts: [], hacker: 1 });
  const result = form.submit();
  assert.ok(result.errors.some((e) => e.path === "/hacker"));
});

test("oneOf：回填时自动推断支；支选择元数据存在", () => {
  const { form } = mount();
  form.setJSON({ name: "x", contacts: [], payment: { cardNo: "1234" } });
  assert.equal(form.branches.get("/payment"), 0);
  form.setJSON({ name: "x", contacts: [], payment: { balance: 5 } });
  assert.equal(form.branches.get("/payment"), 1);
  // 两支都不像 -> 不猜
  form.setJSON({ name: "x", contacts: [], payment: { weird: true } });
  assert.equal(form.branches.has("/payment"), false);
});

test("oneOf：显式选了支但内容不符合该支 -> 提交失败", () => {
  const { form, root } = mount();
  form.setJSON({ name: "x", contacts: [], payment: { cardNo: "1234" } });
  // 模拟用户在支选择器上改选 balance，但数据仍是 card 的形状
  form.branches.set("/payment", 1);
  form._render();
  const result = form.submit();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "/payment" && e.message.includes("类型")));
});

test("if/then/else：email 行渲染 primary，phone 行渲染 sms，不同时出现", () => {
  const { form, root } = mount();
  form.setJSON({
    name: "x",
    contacts: [
      { kind: "email", value: "a@b.com" },
      { kind: "phone", value: "139" },
    ],
  });
  const paths = new Set(
    findAll(root, "input")
      .map((e) => e.attributes["data-path"])
      .filter(Boolean)
  );
  assert.ok(paths.has("/contacts/0/primary"));
  assert.ok(!paths.has("/contacts/0/sms"));
  assert.ok(paths.has("/contacts/1/sms"));
  assert.ok(!paths.has("/contacts/1/primary"));
});

test("IME 组字期间不校验，compositionend 后才提交一次值", () => {
  const { form, root } = mount();
  form.touched = true; // 让错误面板参与刷新
  form.setJSON({ name: "", contacts: [] });
  const nameInput = root.querySelectorAll("[data-path]").find((e) => e.attributes["data-path"] === "/name");
  assert.ok(nameInput);

  let changeCount = 0;
  form.onChange = () => { changeCount += 1; };

  nameInput.dispatch("compositionstart");
  nameInput.value = "z";
  nameInput.dispatch("input");
  nameInput.value = "zh";
  nameInput.dispatch("input");
  nameInput.value = "张";
  nameInput.dispatch("input");
  assert.equal(changeCount, 0, "组字过程中不应触发刷新/校验");
  assert.equal(form.getAt(["name"]), undefined);

  nameInput.dispatch("compositionend");
  assert.equal(changeCount, 1);
  assert.equal(form.getAt(["name"]), "张");
});

test("数组：添加/删除行后数据与路径重排", () => {
  const { form } = mount();
  form.setJSON({
    name: "x",
    contacts: [
      { kind: "email", value: "first@x.com" },
      { kind: "phone", value: "second" },
    ],
  });
  // 删除第一行（复用内部方法，等价于点击删除按钮）
  const arr = form.getAt(["contacts"]);
  arr.splice(0, 1);
  form._reindexBranchMeta(["contacts"], 0);
  form._render();
  assert.deepEqual(form.getAt(["contacts", 0]), { kind: "phone", value: "second" });

  // 添加一行默认对象
  const cur = form.getAt(["contacts"]);
  cur.push({});
  form.setAt(["contacts"], cur);
  form._render();
  assert.equal(form.getAt(["contacts"]).length, 2);
});

test("数字输入：合法数字转 number，非法文本保留并报类型错", () => {
  const { form } = mount();
  form.setJSON({ name: "x", contacts: [], age: 20 });
  form._commitText({ type: "integer" }, ["age"], "42");
  assert.strictEqual(form.getAt(["age"]), 42);
  form._commitText({ type: "integer" }, ["age"], "abc");
  assert.strictEqual(form.getAt(["age"]), "abc");
  const result = form.submit();
  assert.ok(result.errors.some((e) => e.path === "/age" && e.keyword === "type"));
});
