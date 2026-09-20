# JSON Schema 配置表单

按 JSON Schema（draft-07 子集）自动生成表单，填完生成 JSON；校验不过时
红字直接挂在出错控件下方，错误路径形如 `/contacts/0/value`。

纯原生 HTML / CSS / JavaScript（普通 `<script>`，无模块打包），无 npm、无 React/Vue、
无任何第三方 JSON Schema 库。不接后端、不需要登录。

## 怎么打开

直接双击用浏览器打开 `index.html` 即可。脚本按经典 `<script>` 顺序加载、
共享一个全局 `SF` 命名空间，`file://` 下也能运行，不用起服务器
（用 ES Module 的话双击打开会被浏览器 CORS 拦掉）。Node 测试侧同一批
文件走 CommonJS 导出，不需要构建步骤。

如果浏览器对本地模块有限制，也可以用任意静态服务器：

```bash
# 任选其一，然后打开 http://localhost:8000
python3 -m http.server 8000
npx serve .
```

- 左栏是根据 schema 生成的表单，右栏实时显示 JSON。
- “生成 JSON”会用同一份 schema 再校验一遍，通过才算成功。
- “回填示例 JSON”演示 JSON → 表单 → JSON 的回填/再输出；语义不变，
  对象键顺序可能变化。

## 支持的 Schema 子集

- 类型：`type`: `object` / `array` / `string` / `number` / `integer` / `boolean`
- `properties`、`required`
- `additionalProperties: false`（多出来的键报错并挂到该键路径）
- `items`（单个 schema 形式）
- `enum`（渲染为下拉选择）
- `minimum` / `maximum` / `minLength` / `maxLength`
- `const`（demo 的条件里有用到）
- 本地 `$ref`：**只允许**指向本文件 `#/definitions/...`；
  远程 URL、外部文件、`definitions` 之外的指针一律报 `SchemaError`。
  引用图成环在构造时即报错，不会栈溢出。
- `oneOf`：先选哪一支，再渲染该支字段；选了某支但内容不符会校验失败。
- `if` / `then` / `else`：按当前值动态只渲染命中的一边，支持嵌套；
  两边不会同时铺开。

`boolean` 渲染为 checkbox，`enum` 渲染为 select，`array` 可以增删行。
string 输入框在中文输入法组字期间（`compositionstart`~`compositionend`）
不校验，避免打拼音时逐字母变红。

## 目录

```
index.html        页面
styles.css        样式
demo-schema.js    演示用 schema + 示例数据
js/schema-core.js SchemaRegistry：$ref 解析、JSON Pointer、成环检测（唯一规则来源）
js/validator.js   校验器（与表单共用同一份 schema 和同一个 Registry）
js/form.js        SchemaForm：出表、控件事件、错误挂载、JSON 回填
js/errors.js      SchemaError（schema 本身有问题时抛出）
tests/            Node 内置 test runner 的测试
```

出表和校验是两套代码，但都走 `js/schema-core.js` 的 `SchemaRegistry`
（同一份 `$ref` 解析与成环规则），且提交/回填时表单直接调用 `validate`，
不会各写各的规则。

## 跑测试

需要 Node 18+（用到内置 `node:test`）：

```bash
node --test tests/*.test.mjs
```

测试钉死了：`$ref`（含间接引用、远程引用拒绝、悬空引用）、
`oneOf` 恰好一支、`if/then/else`（含嵌套和不重复报错）、
`additionalProperties: false`、循环 `$ref` 报错，以及表单回填、
路径级错误、IME 组字、数组增删等行为。
