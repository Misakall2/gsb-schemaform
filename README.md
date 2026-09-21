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
- `allOf`：多支必须同时满足；表单把各支字段合并平铺渲染，校验失败时
  错误信息会标明「allOf 第几支（共 N 支）」，并在当前节点挂一条
  allOf 汇总错误；`additionalProperties:false` 会把 allOf 合并进来的键
  视为合法字段。
- `dependencies`（字段依赖）：支持数组形式（某字段出现时另一些字段必填）
  与 schema 形式（依赖 schema 可再套 `if/then/else`，实现「某个枚举选了
  才出现另一组」）。依赖分组隐藏时，其名下的旧值会立即从数据模型中
  删除，提交、回填、实时 JSON 都不会把脏值带出去；切走 `if/then`
  分支时同理。
- `default`：数组元素是 object 时，新增行按 schema 声明的 `default`
  构造（含嵌套对象的属性默认）；没有声明默认的行仍是空对象。删除
  中间行后，剩余行的字段路径与错误下标自动重排。

`boolean` 渲染为 checkbox，`enum` 渲染为 select，`array` 可以增删行。
string 输入框在中文输入法组字期间（`compositionstart`~`compositionend`）
不校验，避免打拼音时逐字母变红。

## 目录

```
index.html        页面
styles.css        样式
demo-schema.js    演示用 schema + 示例数据
js/schema-normalize.js 规范化 schema（深拷贝，保持原语义）
js/schema-core.js      SchemaRegistry：JSON Pointer、本文件 $ref 解析、成环检测
js/schema-expand.js    $ref 一次性展开，输出校验器和出表器共享的树
js/schema-layout.js    if/then/else、allOf、dependencies 的统一数据布局计算
js/schema-model.js     JSON 数据、oneOf 选支、回填推断、隐藏值剪枝
js/control-tree.js     从展开 schema + 数据模型生成控件树
js/validator.js        只消费展开后的 schema 树做校验
js/form.js             SchemaForm：控件事件、DOM 渲染、错误挂载、JSON 回填
js/errors.js           SchemaError（schema 本身有问题时抛出）
tests/            Node 内置 test runner 的测试
```

一份外部 schema 进入页面后只编译一次：规范化、循环检测、`$ref` 展开
得到同一棵 schema 树，校验器和控件树都消费它。oneOf 选支状态只存在
`SchemaModel` 的数据层，隐藏的 if/then/else、dependencies 和未选中的
oneOf 分支值都会在数据层剪掉，DOM 只负责展示当前控件树。

## 跑测试

需要 Node 18+（用到内置 `node:test`）：

```bash
node --test tests/*.test.mjs
```

测试钉死了：`$ref`（含间接引用、远程引用拒绝、悬空引用）、
 `oneOf` 恰好一支、`if/then/else`（含嵌套和不重复报错）、
 `allOf` 多支合并与分支定位报错、依赖字段显隐与隐藏清值、
 数组 object 新增行默认值与删中间行后路径重排、
 `additionalProperties: false`、循环 `$ref` 报错，以及表单回填、
 路径级错误、IME 组字、数组增删等行为。
