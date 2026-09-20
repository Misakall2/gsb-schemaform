// Demo schema exercising every supported draft-07 feature.
// Embedded as JS (not fetched) so the page works from file:// without a server.
const demoSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "用户资料",
  type: "object",
  additionalProperties: false,
  required: ["name", "age", "contacts", "notify"],
  // allOf: 每一支都必须同时满足；字段在表单里与主字段合并展示。
  allOf: [
    {
      // 第 1 支：启用账号必须填写内部工号
      if: {
        type: "object",
        properties: { active: { const: true } },
        required: ["active"],
      },
      then: {
        type: "object",
        required: ["staffNo"],
        properties: {
          staffNo: { type: "string", minLength: 3, title: "内部工号" },
        },
      },
    },
    {
      // 第 2 支：备注长度全局收紧
      type: "object",
      properties: {
        remark: { type: "string", maxLength: 20, title: "备注（allOf 第 2 支收紧）" },
      },
    },
  ],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 20,
      title: "姓名",
    },
    age: {
      type: "integer",
      minimum: 0,
      maximum: 150,
      title: "年龄",
    },
    role: {
      enum: ["admin", "editor", "viewer"],
      title: "角色",
    },
    active: { type: "boolean", title: "启用" },
    // 选了某种通知方式后，下面才出现对应的一组字段（dependencies）。
    notify: { enum: ["sms", "email"], title: "通知方式" },
    // Local $ref into definitions.
    address: { $ref: "#/definitions/address", title: "地址" },
    contacts: {
      type: "array",
      title: "联系方式",
      items: { $ref: "#/definitions/contact" },
    },
    // oneOf: pick a branch first, then fill its fields.
    payment: { $ref: "#/definitions/payment", title: "支付方式" },
  },
  // 字段依赖：notify 出现后，按所选方式出现短信组或邮件组；
  // 切换方式后，另一组的脏值不会进入输出 JSON。
  dependencies: {
    notify: {
      type: "object",
      if: {
        type: "object",
        properties: { notify: { const: "sms" } },
        required: ["notify"],
      },
      then: {
        type: "object",
        required: ["notifyPhone"],
        properties: {
          notifyPhone: { type: "string", minLength: 5, title: "短信接收号码" },
        },
      },
      else: {
        type: "object",
        required: ["notifyEmail"],
        properties: {
          notifyEmail: { type: "string", minLength: 3, title: "通知邮箱" },
        },
      },
    },
  },
  // if/then/else on the root object: 管理员必须填 vipCode。
  if: {
    type: "object",
    properties: { role: { enum: ["admin"] } },
    required: ["role"],
  },
  then: {
    type: "object",
    required: ["vipCode"],
    properties: {
      vipCode: { type: "string", minLength: 4, title: "管理员验证码" },
    },
  },
  else: {
    type: "object",
    properties: {
      auditBy: { type: "string", maxLength: 30, title: "审核人" },
    },
  },
  definitions: {
    address: {
      type: "object",
      additionalProperties: false,
      title: "地址",
      properties: {
        city: { type: "string", title: "城市" },
        zip: { type: "string", minLength: 6, maxLength: 6, title: "邮编" },
      },
    },
    contact: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "value"],
      properties: {
        kind: { enum: ["email", "phone"], title: "类型" },
        value: { type: "string", minLength: 3, title: "内容" },
        // 新增行时默认带上的字段值（default keyword）
        primary: { type: "boolean", title: "主联系方式", default: false },
      },
      // if/then/else inside array items.
      if: {
        type: "object",
        properties: { kind: { const: "email" } },
        required: ["kind"],
      },
      then: {
        type: "object",
        properties: {
          primary: { type: "boolean", title: "主邮箱" },
        },
      },
      else: {
        type: "object",
        properties: {
          sms: { type: "boolean", title: "接收短信" },
        },
      },
      // 字段依赖：选了 email 才出现抄送行；数组形式的依赖让 phone
      // 行必须同时给出语音开关（demo 里以 schema 依赖为主）。
      dependencies: {
        kind: {
          type: "object",
          if: {
            type: "object",
            properties: { kind: { const: "email" } },
            required: ["kind"],
          },
          then: {
            type: "object",
            properties: {
              cc: { type: "string", title: "抄送地址" },
            },
          },
        },
      },
    },
    payment: {
      title: "支付方式",
      oneOf: [
        {
          title: "银行卡",
          type: "object",
          additionalProperties: false,
          required: ["cardNo"],
          properties: {
            cardNo: { type: "string", minLength: 4, title: "卡号" },
          },
        },
        {
          title: "账户余额",
          type: "object",
          additionalProperties: false,
          required: ["balance"],
          properties: {
            balance: { type: "number", minimum: 0, title: "余额" },
          },
        },
      ],
    },
  },
};

const demoData = {
  name: "张三",
  age: 28,
  role: "editor",
  active: true,
  staffNo: "EMP-0427",
  notify: "email",
  notifyEmail: "zhangsan@example.com",
  address: { city: "上海", zip: "200000" },
  contacts: [
    { kind: "email", value: "a@b.com", primary: true, cc: "ops@x.com" },
    { kind: "phone", value: "13800000000", sms: false },
  ],
  payment: { balance: 100 },
  remark: "老用户",
  auditBy: "李雷",
};

// UMD-ish: plain <script> tags (works from file://) and Node's ESM import.
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.SF = Object.assign(root.SF || {}, mod);
})(typeof self !== "undefined" ? self : globalThis, function () {
  return { demoSchema, demoData };
});
