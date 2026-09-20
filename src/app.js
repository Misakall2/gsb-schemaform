import { SchemaForm } from './form.js';
import { validate } from './validator.js';
import { SchemaError } from './schema-core.js';

const $ = (id) => document.getElementById(id);

let schema;
let form;

const outputEl = $('json-output');
const statusEl = $('form-status');
const inputEl = $('json-input');
const loadStatusEl = $('load-status');
const schemaInputEl = $('schema-input');
const schemaStatusEl = $('schema-status');

function renderOutput(data, result) {
  outputEl.textContent = JSON.stringify(data, null, 2);
  if (result.errors.length) {
    statusEl.textContent = `校验未通过：${result.errors.length} 个错误（红字挂在对应控件上）`;
    statusEl.className = 'form-status invalid';
  } else {
    statusEl.textContent = '当前输出可通过 schema 校验';
    statusEl.className = 'form-status valid';
  }
}

function boot(schemaDoc) {
  schema = schemaDoc;
  form = new SchemaForm(schema, $('form-root'), {
    onChange: renderOutput,
  });
}

$('btn-submit').addEventListener('click', () => {
  const { data, result } = form.submit();
  renderOutput(data, result);
  if (result.valid) {
    statusEl.textContent = '提交成功：输出 JSON 已通过同一份 schema 校验';
  } else {
    const first = result.errors[0];
    statusEl.textContent =
      `提交失败：${result.errors.length} 个错误，首个位于 ${first.path} — ${first.message}`;
  }
});

$('btn-reset').addEventListener('click', () => {
  form.setData(undefined);
  inputEl.value = '';
  loadStatusEl.textContent = '';
});

$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(outputEl.textContent);
  } catch (_) {
    // file:// or missing permission: select the text instead
    const range = document.createRange();
    range.selectNodeContents(outputEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

$('btn-load').addEventListener('click', () => {
  try {
    const data = JSON.parse(inputEl.value);
    form.setData(data, { quiet: false });
    // Filled data should itself pass; run the shared validator independently.
    const result = validate(schema, data);
    loadStatusEl.textContent = result.valid
      ? '回填成功，且该 JSON 通过 schema 校验'
      : `已回填，但原 JSON 有 ${result.errors.length} 个校验问题（见红字）`;
    loadStatusEl.className = 'load-status '
      + (result.valid ? 'ok' : 'bad');
  } catch (err) {
    loadStatusEl.textContent = `JSON 解析失败: ${err.message}`;
    loadStatusEl.className = 'load-status bad';
  }
});

function applySchemaText() {
  try {
    const doc = JSON.parse(schemaInputEl.value);
    boot(doc); // constructor validates the schema (refs/cycles/types)
    schemaStatusEl.textContent = '已应用';
    schemaStatusEl.className = 'load-status ok';
  } catch (err) {
    const msg = err instanceof SchemaError ? err.message
      : `Schema JSON 解析失败: ${err.message}`;
    schemaStatusEl.textContent = msg;
    schemaStatusEl.className = 'load-status bad';
  }
}

$('btn-apply-schema').addEventListener('click', applySchemaText);

$('btn-reload-demo').addEventListener('click', async () => {
  const text = await (await fetch('./examples/demo-schema.json')).text();
  schemaInputEl.value = JSON.stringify(JSON.parse(text), null, 2);
  applySchemaText();
});

async function main() {
  const resp = await fetch('./examples/demo-schema.json');
  const demo = await resp.json();
  schemaInputEl.value = JSON.stringify(demo, null, 2);
  boot(demo);
}

main().catch((err) => {
  statusEl.textContent =
    `加载失败（如用 file:// 打开，请改用 README 中的本地服务器方式）: ${err.message}`;
  statusEl.className = 'form-status invalid';
});
