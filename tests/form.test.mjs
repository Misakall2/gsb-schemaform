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

// ---------- allOf / dependencies / 数组对象默认值（新增） ----------

const allOfSchema = {
  type: "object",
  additionalProperties: false,
  required: ["v"],
  properties: { v: {} },
  allOf: [
    { required: ["a"], properties: { a: { type: "string", title: "A" } } },
    { required: ["b"], properties: { b: { type: "integer", title: "B" } } },
  ],
};

test("allOf：多支字段合并到同一个对象里一起渲染", () => {
  const root = FakeDocument.createElement("div");
  const form = new SchemaForm(root, allOfSchema);
  form.setJSON({ v: 1, a: "x", b: 2 });
  const paths = new Set(
    findAll(root, "input").map((e) => e.attributes["data-path"]).filter(Boolean)
  );
  assert.ok(paths.has("/v"));
  assert.ok(paths.has("/a"));
  assert.ok(paths.has("/b"));
  // 每个字段只渲染一次
  assert.equal(
    findAll(root, "input").filter((e) => e.attributes["data-path"] === "/a").length,
    1
  );
  const submit = form.submit();
  assert.equal(submit.valid, true);
  // 输出 JSON 再用同一份 schema 校验必须过
  assert.equal(validate(JSON.parse(form.toJSONString()), allOfSchema).valid, true);
});

test("allOf 冲突：提交失败且错误指出是哪一支", () => {
  const schema = {
    type: "object",
    properties: { v: {} },
    allOf: [
      { properties: { v: { type: "string" } } },
      { properties: { v: { type: "integer" } } },
    ],
  };
  const root = FakeDocument.createElement("div");
  const form = new SchemaForm(root, schema);
  form.setJSON({ v: 5 });
  const result = form.submit();
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.path === "/v" && /allOf 第 1 支/.test(e.message)
    ),
    "应指出第 1 支（要求字符串）失败"
  );
});

test("字段依赖：枚举触发后另一组出现；隐藏后脏值不带出去", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      notify: { enum: ["sms", "email"], title: "通知方式" },
    },
    dependencies: {
      notify: {
        type: "object",
        if: { properties: { notify: { const: "sms" } }, required: ["notify"] },
        then: {
          required: ["phone"],
          properties: { phone: { type: "string", title: "手机号" } },
        },
      },
    },
  };
  const root = FakeDocument.createElement("div");
  const form = new SchemaForm(root, schema);

  form.setJSON({ notify: "sms", phone: "13900000000" });
  let paths = new Set(
    findAll(root, "input").map((e) => e.attributes["data-path"]).filter(Boolean)
  );
  assert.ok(paths.has("/phone"), "触发后依赖组字段应出现");
  assert.equal(form.submit().valid, true);

  // 用户改成 email：sms 的 phone 组隐藏，值必须被清掉
  form.setAt(["notify"], "email");
  form._refresh(true);
  paths = new Set(
    findAll(root, "input").map((e) => e.attributes["data-path"]).filter(Boolean)
  );
  assert.ok(!paths.has("/phone"), "依赖组隐藏后不应再渲染");
  const out = JSON.parse(form.toJSONString());
  assert.deepEqual(out, { notify: "email" }, "隐藏字段的脏值不能带进输出");
  assert.equal(validate(out, schema).valid, true);

  // 切回 sms：phone 也不会带着旧值回来
  form.setAt(["notify"], "sms");
  form._refresh(true);
  assert.equal(form.getAt(["phone"]), undefined);
});

test("数组 object 行：新增行带 schema 默认值；删中间行后错误路径跟随", () => {
  const schema = {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "value"],
          properties: {
            kind: { enum: ["email", "phone"], title: "类型" },
            value: { type: "string", minLength: 4, title: "内容" },
            primary: { type: "boolean", default: true, title: "主要" },
            channel: { type: "string", default: "web", title: "渠道" },
          },
        },
      },
    },
  };
  const root = FakeDocument.createElement("div");
  const form = new SchemaForm(root, schema);
  form.setJSON({
    items: [
      { kind: "email", value: "a@b.com" },
      { kind: "phone", value: "bad" }, // minLength 会挂错在 /items/1/value
      { kind: "email", value: "c@d.com" },
    ],
  });

  let result = form.submit();
  assert.ok(result.errors.some((e) => e.path === "/items/1/value"));

  // 点第二行的删除按钮（删中间行）
  const delButtons = findAll(root, "button").filter((b) => b._innerHTML === "" && /删除/.test(b.textContent));
  assert.equal(delButtons.length, 3);
  delButtons[1].dispatch("click");

  assert.deepEqual(form.getAt(["items"]).map((r) => r.value), ["a@b.com", "c@d.com"]);

  // 原第三行现在是第二行；让它的 value 非法，错误应挂在新的下标
  form.setAt(["items", 1, "value"], "x");
  result = form.submit();
  assert.ok(
    result.errors.some((e) => e.path === "/items/1/value"),
    "删中间行后错误路径要跟着重排"
  );
  assert.ok(
    !result.errors.some((e) => e.path.startsWith("/items/2")),
    "不应残留已删除行下标 2 的路径"
  );

  // 新增一行：带上 schema 声明的默认值（boolean/string），不臆造空串 0
  const addBtn = findAll(root, "button").find((b) => /添加一行/.test(b.textContent));
  addBtn.dispatch("click");
  const rows = form.getAt(["items"]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[2], { primary: true, channel: "web" });
});

test("allOf 与旧的 oneOf 共存，oneOf 选支仍然工作", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      payment: {
        oneOf: [
          { title: "card", type: "object", required: ["cardNo"], properties: { cardNo: { type: "string", minLength: 4 } } },
          { title: "balance", type: "object", required: ["balance"], properties: { balance: { type: "number", minimum: 0 } } },
        ],
      },
    },
    allOf: [{ properties: { remark: { type: "string", title: "备注" } } }],
  };
  const root = FakeDocument.createElement("div");
  const form = new SchemaForm(root, schema);
  form.setJSON({ name: "x", remark: "r", payment: { cardNo: "1234" } });
  assert.equal(form.branches.get("/payment"), 0);
  const paths = new Set(
    findAll(root, "input").map((e) => e.attributes["data-path"]).filter(Boolean)
  );
  assert.ok(paths.has("/remark"), "allOf 合并字段在");
  assert.ok(paths.has("/payment/cardNo"), "oneOf 选中支的字段在");
  assert.equal(form.submit().valid, true);
});
