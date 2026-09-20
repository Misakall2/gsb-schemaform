// Demo schema exercising every supported draft-07 feature.
// Embedded as JS (not fetched) so the page works from file:// without a server.
const demoSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "用户资料",
  type: "object",
  additionalProperties: false,
  required: ["name", "age", "contacts"],
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
    // Local $ref into definitions.
    address: { $ref: "#/definitions/address", title: "地址" },
    contacts: {
      type: "array",
      title: "联系方式",
      items: { $ref: "#/definitions/contact" },
    },
    // oneOf: pick a branch first, then fill its fields.
    payment: { $ref: "#/definitions/payment", title: "支付方式" },
    // Field dependency: once a notification channel is picked, an
    // extra field group appears (see `dependencies` below). Hidden
    // values are pruned the moment the channel is switched back.
    notify: {
      enum: ["off", "email", "sms"],
      title: "通知方式",
    },
    // Field merged in from an allOf branch below.
    score: { type: "integer", minimum: 0, maximum: 100, title: "评分" },
  },
  // allOf: every branch must hold; the form flattens their
  // properties together with the ones above.
  allOf: [
    {
      properties: {
        score: { type: "integer", minimum: 0, maximum: 100 },
        remark2: { type: "string", maxLength: 20, title: "allOf 附加标签" },
      },
    },
  ],
  dependencies: {
    notify: {
      // Only meaningful when a channel is actually selected; the
      // dependency schema itself branches on which enum value was picked.
      if: {
        type: "object",
        properties: { notify: { const: "email" } },
        required: ["notify"],
      },
      then: {
        required: ["notifyEmail"],
        properties: {
          notifyEmail: { type: "string", minLength: 3, title: "通知邮箱" },
        },
      },
      else: {
        if: {
          type: "object",
          properties: { notify: { const: "sms" } },
          required: ["notify"],
        },
        then: {
          required: ["notifyPhone"],
          properties: {
            notifyPhone: { type: "string", minLength: 3, title: "短信手机号" },
          },
        },
      },
    },
  },
  // if/then/else on the root object: VIP users must fill a vipCode.
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
      remark: { type: "string", maxLength: 50, title: "备注" },
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
        kind: { enum: ["email", "phone"], default: "email", title: "类型" },
        value: { type: "string", minLength: 3, title: "内容" },
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
  address: { city: "上海", zip: "200000" },
  contacts: [
    { kind: "email", value: "a@b.com", primary: true },
    { kind: "phone", value: "13800000000", sms: false },
  ],
  payment: { balance: 100 },
  remark: "老用户",
  score: 80,
  notify: "email",
  notifyEmail: "a@b.com",
};

// UMD-ish: plain <script> tags (works from file://) and Node's ESM import.
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.SF = Object.assign(root.SF || {}, mod);
})(typeof self !== "undefined" ? self : globalThis, function () {
  return { demoSchema, demoData };
});
