# gsb-schemaform

Vanilla HTML, CSS, JavaScript. No npm.

按一份 JSON Schema（draft-07 子集）同时驱动**动态出表**和**校验**，
填完直接吐出 JSON。校验器和表单共用同一份 schema 与同一套
`$ref` 解析/规则实现，不会各写各的规则。

## 怎么打开页面

页面通过 `fetch` 加载示例 schema，直接双击 `index.html`（`file://`）在
部分浏览器下会被本地文件策略拦住。推荐在仓库根目录起一个静态服务器：

```bash
# 任选其一，都不需要装任何依赖
python3 -m http.server 8000
# 或者 Node（Node 18+ 自带 corepack 之外也可以直接用 npx；
# 不想联网也可以用上面的 python）
```

然后浏览器打开 <http://localhost:8000/>。

页面左侧是表单，右侧实时显示输出 JSON，并提供：

- “校验并生成 JSON”：按同一份 schema 校验，错误红字挂到对应控件；
- “从 JSON 回填”：粘贴 JSON 回填表单，再输出语义一致（键顺序可变）；
- “Schema”折叠区：可直接改 schema 并重建表单；非法 schema（含 `$ref`
  成环、外链引用、不支持的 type）会报错且不会建表。

## 怎么跑测试

只用 Node 自带测试运行器，零第三方依赖（需要 Node 18+）：

```bash
npm test
# 或
node --test 'test/**/*.test.js'
```

- `test/validator.test.js`：钉死类型、`required`、`enum`、
  `minimum/maximum`、`minLength/maxLength`、`additionalProperties`、
  本地 `$ref`、外链 `$ref` 拒绝、**`$ref` 成环保错（不死递归）**、
  `oneOf`（含选错支）、`if/then/else`，以及错误路径形如
  `/users/0/email`。
- `test/form.test.js`：用一个极小的假 DOM 钉死出表/序列化/回填往返、
  数组增删、oneOf 分支切换、if/then 与 else 动态互斥显示、
  分支数据不串、错误挂在控件节点上。

## 目录结构

```
index.html              页面
styles.css              样式
examples/demo-schema.json  覆盖全部关键字的示例
src/schema-core.js      共享层：本地 $ref 解析、外链拒绝、环检测
src/validator.js        校验器（出表和测试都调用它）
src/form.js             动态表单（object/array/enum/checkbox/oneOf/if…）
src/app.js              页面接线
test/                   node:test 测试
```

## 支持的 Schema 子集

- `type`：`object` `array` `string` `number` `integer` `boolean`
- `properties` / `required`
- `additionalProperties: false`（多出来的键拒绝并报错）或 schema
- `items`（数组单项 schema，可增删行）
- `enum`（渲染为下拉选择）
- `minimum` / `maximum` / `minLength` / `maxLength`
- 本地 `$ref`：**只允许** `#/definitions/...`（含 definitions 下的嵌套
  指针）；`http(s)://`、其它文件、`#/components` 等一律报错，绝不联网
- `oneOf`：先选分支再渲染该分支字段；数据必须恰好满足一个分支
- `if` / `then` / `else`：按当前值动态只显示命中的分支，then 与 else
  不会同时铺开，未激活分支的字段不会进入输出 JSON

## 行为约定

- 任何控件改值立即校验，错误信息挂到 JSON Pointer 路径对应控件，
  例如 `/users/0/email`；不只是在顶部报一句 invalid。
- 中文输入法组字（`compositionstart`～`compositionend`）期间不校验，
  落字后只校验一次，不会每个拼音字母把输入框打红。
- 数字框允许打到一半（如 `1.`、`-`、`1e3` 的中间态），未成形的数字
    不会误报类型错；成形但不合规（超界、integer 填小数）立即报错。
- 空的可选数字键不会出现在输出中；空表单首次渲染不显示满屏红字，
  首次改值或点提交后才挂错误。
- 输出 JSON 再用同一份 schema 校验必须通过；JSON 回填表单再输出，
  数据语义一致（对象键顺序可能变化）。

不做登录，不接后端。
