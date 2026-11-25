# JSON Studio（无图片识别版）开发文档

> **给接手的 AI 的开工提示**
>
> 你要在 DeepSeek Harness（DSH）桌面版的 Web UI 里实现一个名为 **JSON Studio** 的插件：
> 一个主面板，能把 JSON / 类 JSON 文本容错格式化，并以「源码 / 树形 / 表格」三种视图展示；
> 解析失败时也要排版得漂亮；支持「选中一段文本按快捷键直接带着内容打开面板」，
> 快捷键可在 Settings 里录制。
>
> **明确不做**：图片 OCR、图片拖拽/粘贴识别、任何网络请求、任何 LLM 调用。
>
> 本仓库已有一份可运行的参考实现（`E:\selfwork\json-studio`），但它**带 OCR**。
> 允许直接复用其中的 `src/engine.js` 及其测试；UI、宿主、构建、安装请按本文档实现，
> 并严格按第 9 节删掉所有 OCR 相关文件/入口/依赖。最终交付必须是**无 OCR**的版本。
>
> 完成标准见第 8.3 节验收清单；实现完成后请报告：改了哪些文件、跑了哪些测试、安装结果、验证证据。

---

## 1. 目标与范围

### 1.1 产品目标

> **最高优先级原则（用户原话定调）**：目标不是"只接受严格 JSON"，而是**最大程度兼容用户扔进来的任何字符串**——
> 不管它是不是 JSON、是不是被转义/未转义、是不是日志片段。
> 能结构化就结构化；不能结构化也要把它**整理得有可读性**；并**明确提示"这不是严格 JSON，但已经尽力整理展示"**。
> 一句话：**宁可"降级展示"，绝不"白屏 / 报错 / 原样糊一坨"**。

在 DSH Web GUI 左侧栏增加一个图标 **JSON Studio**，点击后在主区域打开全宽面板：

1. **输入**：粘贴标准 JSON、JSON5、JS 对象字面量、Python 字典、NDJSON、JSONP、代码围栏、HTTP 响应体、转义字符串、数组等。
2. **容错解析**：能解析就解析（严格的直接过；宽松的修复后过），并列出修复说明。
3. **兜底展示**：完全解析不了时，按括号层级重排 + 语法高亮 + 标出错误行列，绝不空白。
4. **三视图**：高亮源码（行号）、可折叠树、对象数组表格。
5. **实用操作**：格式化、压缩、键排序、转义、去转义、复制、下载、换行、清空、示例。
6. **选中即开**：在 Harness 任意位置选中文本，按快捷键（默认 `Ctrl+Alt+J`）→ 面板打开并载入选中内容。
7. **快捷键可录制**：Settings → JSON Studio 里录制任意组合（必须含 Ctrl/⌘/Alt），可恢复默认。
8. **中英双语**：跟随 Harness 语言。

### 1.2 非目标（必须不做）

- 图片 OCR、图片上传/拖拽/粘贴识别、`tesseract.js`、任何语言模型/模型服务。
- 任何 `fetch` / HTTP 路由 / WebServer 注册 / 后端进程。
- 任何宿主侧业务逻辑（`/json-studio/status`、`/json-studio/ocr` 都不要）。
- 读写用户文件、上传、遥测、外链。

### 1.3 交付形态

- 一个可被 `plugin_manager install_bundle` 安装的**本地 bundle**（workspace 目录 + `dsh.bundle.patch`）。
- 安装后立即生效：左侧栏图标、主面板、Settings 页三个入口都可见。
- 纯客户端实现（`client.js`），宿主半（`index.js`）只做「bundle 可见性兜底 + 可选热更新」，不含业务。

---

## 2. 运行环境与硬约束

- 目标：DSH 桌面版 profile（默认 `desktop`），Web GUI 由本机 `dsh web` 提供。
- 插件源码放在 workspace（例：`E:\selfwork\json-studio`），**不要**直接改 profile 的 `package.json` / `cordis.patch.yml`。
- 安装只通过 `plugin_manager` 的 `install_bundle`（本地目录）。
- 浏览器端代码由 DSH 的 `window.__ModuleLoader__` 加载，React 从模块表拿，**不能**装第二份 React。
- 不要 `require('@deepseek-ai/dsh-client-*')` 等宿主包；`dsh.client.inject` 只是激活顺序声明。
- 不要 `import` 任何 npm 包到浏览器端；`client.js` 是普通 classic script（非 ESM）。
- 所有可见文案走 locale；颜色走主题 token。
- 不需要 Host 服务（无 `webServer`、无 `clientModules` 强依赖；后者可选）。

---

## 3. 目录与文件

```
json-studio/
├─ package.json              # bundle 清单、dsh.client、files、脚本
├─ cordis.patch.yml          # 插入 host 行（id: json-studio）
├─ index.js                  # host 半：apply()，可选 bundle 可见性兜底/热更新
├─ src/
│  ├─ engine.js              # 容错 JSON 引擎（纯 ESM、无依赖、无 DOM）
│  └─ ui.js                  # 面板 + 图标 + Settings 页 + 快捷键（React，h() 写法）
├─ build.mjs                 # 把 engine 包进 IIFE，与 ui 一起生成 client.js
├─ client.js                 # 生成物，勿手改
├─ locale/en.json
├─ locale/zh.json            # 只放 meta.title / meta.description
├─ icon.svg                  # 插件图标（≤256KiB，SVG/PNG/JPEG/WebP）
├─ test/
│  ├─ engine.test.mjs
│  └─ engine.contract.test.mjs
├─ docs/panel.png            # 可选截图
└─ README.md
```

**不要**创建：`src/ocr.js`、`src/ocr-worker.mjs`、`assets/lang/`、OCR fixtures、OCR 脚本、任何图片入口。

### 3.1 package.json 契约

```json
{
  "name": "@local/dsh-json-studio",
  "version": "1.0.0",
  "private": true,
  "description": "JSON formatter panel for the Harness Web UI: tolerant formatting, tree and table views, graceful display of broken input.",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "icon": "./icon.svg",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    }
  },
  "files": [
    "index.js", "client.js", "cordis.patch.yml",
    "src/engine.js", "src/ui.js", "build.mjs",
    "locale/*.json", "icon.svg", "docs/*.png", "README.md"
  ],
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test test/engine.test.mjs test/engine.contract.test.mjs"
  }
}
```

- **不要**声明 `tesseract.js` 或任何运行时依赖。
- `files` 必须覆盖所有运行期文件；本地安装是 link，`files` 不裁剪目录，但打包安装会依赖它。
- 版本号变更后要 `remove_bundle` 再 `install_bundle`（见第 8 节）。

### 3.2 cordis.patch.yml

```yaml
- insert:
    - id: json-studio
      name: '@local/dsh-json-studio'
      config:
        watchClientBundle: true
```

- `id` 是 Loader 行 id，必须与 `index.js` 导出的 `name` 一致（建议都用 `json-studio`）。
- 除 `watchClientBundle` 外**不需要任何配置**；快捷键默认值在客户端常量里，用户在 Settings 覆盖。

### 3.3 locale 文件

`locale/en.json`：

```json
{ "meta": { "title": "JSON Studio", "description": "Format JSON and JSON-like text, inspect it as a tree or table, and display broken input gracefully." } }
```

`locale/zh.json`：

```json
{ "meta": { "title": "JSON Studio", "description": "格式化 JSON 与类 JSON 文本，树形/表格查看，解析失败也能漂亮展示。" } }
```

---

## 4. 宿主半（index.js）

无 OCR 后宿主半**没有业务路由**。它只需要：

```js
export const name = 'json-studio'

export function apply(ctx, config) {
  // 1) 环境特定的 bundle 可见性兜底，见 4.1
  ensureBundleVisible(ctx)
  // 2) 可选：开发时的 client 热更新，见 4.2
  if (config?.watchClientBundle !== false) watchClient(ctx, config)
  ctx.logger?.info?.('json-studio: ready')
}
```

### 4.1 为什么需要「bundle 可见性兜底」

这台机器的 DSH Host 进程有一个文件系统视图问题：**构建脚本（node）写出的 `client.js` 可能对 Host 不可见**，
导致 `clientModules` 加载不到浏览器半，安装时出现 `failed to import` / 页面无图标。
判断方法：`apply` 里 `statSync(client.js)` 抛 ENOENT，但系统 `node` 能读到它。

解决方式（幂等、无害）：

```js
import { statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('./client.js', import.meta.url))

function readRealFile(file) {
  const script = `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(file)}))`
  return execFileSync('node', ['-e', script], { maxBuffer: 64 * 1024 * 1024 })
}

function ensureBundleVisible(ctx) {
  try {
    statSync(BUNDLE)
    return
  } catch { /* 对 Host 不可见 */ }
  import('node:fs/promises').then(async ({ writeFile }) => {
    const data = readRealFile(BUNDLE)
    await writeFile(BUNDLE, data) // 通过 Host 写回后即可见
    ctx.logger?.info?.(`json-studio: registered browser bundle (${data.length} bytes)`)
  }).catch((error) => ctx.logger?.warn?.(`json-studio: ${error.message}`))
}
```

- 正常机器（能直接 stat 到）会立即返回，不 spawn。
- `client.js` 必须先在磁盘上存在；`ensureBundleVisible` 只负责「登记」。
- 若目标机器没有 `node` 在 PATH，这一段会失败但插件仍可安装；应跳过或提示。

### 4.2 可选：开发期热更新

编辑 `client.js` 后不想重启 Harness 时：

```js
const PACKAGE = '@local/dsh-json-studio'

function watchClient(ctx, config) {
  let last
  const stat = () => { try { const s = statSync(BUNDLE); return { m: s.mtimeMs, c: s.ctimeMs, s: s.size } } catch { return undefined } }
  ctx.inject(['clientModules'], (scope) => {
    last = stat()
    const timer = setInterval(() => {
      const current = stat()
      if (!current) return
      if (last && current.m === last.m && current.c === last.c && current.s === last.s) return
      last = current
      try { scope.clientModules.rebuilt(PACKAGE) } catch { /* ignore */ }
    }, 300)
    timer.unref?.()
    scope.effect(() => () => clearInterval(timer), 'json-studio: bundle watch')
  })
}
```

- `rebuilt()` 会通知浏览器端 HMR 换模块；只刷新浏览器端，不重启 Host。
- 若目标环境没有 `clientModules` 服务，`ctx.inject` 不会执行回调，安全。

---

## 5. 浏览器端总体结构

`client.js` 由 `build.mjs` 生成，形态固定：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-json-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const __engine = (() => {
      // src/engine.js 去掉顶层 export 后内联
      return { analyzeJson, findJsonCandidates, prettyLoose, tokenizeJson, formatValue, minifyValue, sortKeysDeep, escapeJsonString, unescapeJsonString, summarizeValue }
    })()
    const { /* 同名解构 */ } = __engine

    // src/ui.js 去掉顶层 export 后内联
    // ... 组件与常量 ...
    return { inject: ['slots', 'locale', 'layout'], apply }
  },
})
```

要点：

- **不要**在 factory 顶层做副作用（注册、DOM、定时器）；全部放进 `apply` 的 `ctx.effect` 里。
- `require` 只取 `react`；React 18 的 `createElement`，**不用 JSX**。
- `build.mjs` 会剥离 `export ` 前缀，所以 `engine.js` / `ui.js` 只能使用 `export function` / `export const` 形式，
  不能 `export default`、不能 `export { ... }`、不能有 import（engine）。
- engine 单独包在 IIFE 里，避免与 UI 的顶层 `const` 重名。

### 5.1 常量

```js
const PANEL_ID = 'json-studio'          // main slot 的 key = sidebar.panellist 的 id
const NS = 'local.json-studio'          // locale 命名空间
const STORE_KEY = 'json-studio.v1'      // 草稿/视图偏好
const SHORTCUT_STORE = 'json-studio.shortcut'
const SHORTCUT_EVENT = 'json-studio:shortcut'
const INJECT_EVENT = 'json-studio:inject'
const PENDING_KEY = 'json-studio.pending'
const DEFAULT_SHORTCUT = 'Ctrl+Alt+J'

const MAX_CODE_LINES = 4000
const MAX_HIGHLIGHT_CHARS = 240000
const MAX_TABLE_ROWS = 2000
const MAX_EXPAND_NODES = 3000
const MAX_SELECTION_CHARS = 2000000
```

### 5.2 apply 骨架

```js
const inject = ['slots', 'locale', 'layout']

function apply(ctx) {
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS,
  }, JsonStudioPanel)), 'json-studio: page')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 55,
    label: () => t('panel'), locale: NS,
  }, SidebarIcon)), 'json-studio: sidebar entry')

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: PANEL_ID, order: 35,
    label: () => t('settingsHeading'),
  }, (props) => h(JsonStudioSettings, { ...props, t }))), 'json-studio: settings section')

  ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon', id: PANEL_ID, order: 35,
  }, SidebarIcon)), 'json-studio: settings icon')

  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'json-studio: dictionaries')

  // CSS 注入
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = PANEL_ID
    style.textContent = PANEL_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'json-studio: styles')

  // 全局快捷键（见 6.9）
  ctx.effect(() => {
    const onKeyDown = (event) => { /* ... */ }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, 'json-studio: shortcut')
}
```

### 5.3 平台契约（必须精确）

| 位置 | 注册 | 说明 |
| --- | --- | --- |
| 主面板 | `slots.register({ name:'main', key:'json-studio', locale:NS }, Panel)` | key 必须等于侧栏 id；`Panel` 会收到 `props.t` |
| 侧栏 | `slots.register({ name:'sidebar.panellist', id:'json-studio', order:55, label:()=>t('panel'), locale:NS }, Icon)` | Icon 收到 `{ size, active }` |
| Settings | `slots.register({ name:'settings.section', id:'json-studio', order:35, label:()=>t('settingsHeading') }, Page)` | Page 只保证收到 `{ close }`；文案用闭包 `t` |
| Settings 图标 | `slots.register({ name:'settings.section.icon', id:'json-studio', order:35 }, Icon)` | 可选；不注册则用默认图标 |
| 布局 | `ctx.layout.selectPanel('json-studio')` | 未注册时抛错，必须 try/catch |
| 语言 | `ctx.locale.bind(NS)` / `ctx.locale.register(NS,{zh,en})` | 注册放在 effect 内 |

- 所有注册都包在 `ctx.effect(() => ..., label)` 里，返回清理函数；插件卸载/热更新时自动注销。
- 不要读写别的插件的 DOM/CSS；不要替换 app root。

---

## 6. 交互与 UI 契约

### 6.1 面板布局

```
┌ header ───────────────────────────────────────────────┐
│ [icon] JSON Studio            [格式化][压缩][键排序]   │
│        format · inspect       [转义][去转义][示例][清空]│
├ body ─────────────────────────────────────────────────┤
│ [输入 pane]                    [结果 pane]            │
│  textarea                      tabs: 源码 | 树形 | 表格│
│  footer hint                   badge / copy / wrap / dl│
│                                error banner (if any)   │
│                                note chips (if any)     │
│                                view                    │
├ footer ───────────────────────────────────────────────┤
│ 模式 · 节点/深度/键 · 截断提示        解析耗时 ms      │
└───────────────────────────────────────────────────────┘
```

- 桌面宽屏左右各 50%，`@media (max-width:980px)` 上下堆叠。
- 面板根 `height:100%; min-height:0; overflow:hidden`，pane 内部滚动。
- 输入框：等宽字体、`tab-size:2`、`wrap="off"`；`Tab` 插入两个空格；`Ctrl/⌘+Enter` 执行「格式化」。

### 6.2 输入

- 受控 `textarea`；粘贴文本原样进入（**不处理图片粘贴**）。
- 输入变化后 130ms（>40k 字符时 320ms）防抖分析。
- 统计：字符数、行数、UTF-8 字节数。
- 无输入时结果区显示空状态：标题、说明、5 个示例 chip、快捷键提示。

### 6.3 工具栏动作（精确语义）

| 动作 | 行为 | 解析失败时 |
| --- | --- | --- |
| 格式化 | `input ← analysis.formatted`，切到源码视图 | 仍可用（= 兜底排版结果） |
| 压缩 | `input ← minifyValue(value)` | toast「当前内容未成功解析」 |
| 键排序 | `input ← formatValue(sortKeysDeep(value))` | 同上 |
| 转义 | `input ← escapeJsonString(input)` | 任意文本都可 |
| 去转义 | `input ← unescapeJsonString(input)`；未变化且不以 `"` 开头时 toast 失败 | 任意文本都可 |
| 示例 | 循环载入 5 个示例：API 响应 / JSON5 配置 / Python 字典 / 损坏片段 / 对象数组 | — |
| 清空 | 清空输入、错误、OCR 无关状态 | — |
| 图片识别 | **不存在** | — |

所有会改输入的动作都把旧值存到 `lastInputRef`（撤销/对比可用，可选）。

### 6.4 结果视图

**源码视图**

- 用 `tokenizeJson(formatted)` 高亮；类型 → CSS 类：`key/string/number/literal/punct/comment/bare/invalid`。
- 每行一个 flex 行，行号 + 内容；`jst-line-error` 高亮 `analysis.error.line`。
- 错误横幅提供「定位错误」按钮，滚动到该行。
- 超过 240k 字符：关闭高亮（纯文本）；超过 4000 行：只渲染前 4000 行并提示。
- 换行开关：`white-space: pre` ↔ `pre-wrap`。

**树形视图**

- 根节点 `$`；对象显示 `{ n 项 }`，数组显示 `[ n 项 ]`。
- 默认展开：根；深度 1 且子项 ≤24；其余折叠。
- 每行 hover 显示「复制路径」按钮，复制 `$.a.b[0]` 形式；`onCopyPath` 走统一 `copyText`。
- 「全部展开 / 全部收起」；`stats.nodes > 3000` 时禁用全部展开。
- 只读；不可编辑。

**表格视图**

- 仅当 `value` 是「对象数组」且列数 ≤40、行数 ≤2000 时可用；否则显示提示文案。
- 列 = 所有对象键的并集（保持首次出现顺序）；数字右对齐；null 灰色斜体；对象/数组单元格用 JSON 摘要。
- 表头 sticky。

### 6.5 状态与提示

- 模式徽标：
  - `strict` 标准（绿）
  - `relaxed` 宽松（蓝）
  - `repaired` 已修复（黄）
  - `fallback` 仅展示（红）
- 修复说明 chips：`analysis.notes` 每项 code → 本地化标签；最多展示 8 个；
  `nested-json-decoded`（已展开内嵌 JSON）、`percent-decoded`（已 URL 解码）要有专门文案，让用户知道做了什么。
- 错误横幅：`analysis.error.message` + 行/列 + 定位按钮；仅 `!ok` 时显示；
  并附"非严格 JSON，已按最佳格式排版展示"的兜底提示（见 7.9），让用户明确"不是解析失败，是尽力可读化"。
- 底部状态：模式、节点数、深度、键数、解析耗时；若 `analysis.truncated`，按 note 区分「输入过大」/「已截断恢复」。
- toast：复制成功、动作成功、失败原因；2.4s 自动消失。

### 6.6 持久化

`localStorage['json-studio.v1']`（JSON 字符串），防抖 380ms 写入：

```js
{ input: string, view: 'code'|'tree'|'table', wrap: boolean }
```

- 损坏/不可读时回退为空对象；写失败（隐私模式/配额）静默。
- 快捷键覆盖值单独存 `localStorage['json-studio.shortcut']`；空/删除表示用默认。

### 6.7 示例数据

内置 5 个字符串（API 响应、JSON5 配置、Python 字典、损坏片段、对象数组）。
「损坏片段」必须能触发 `repaired`（缺失逗号 + 尾逗号 + 未闭合括号）；
「对象数组」必须能触发表格视图。

### 6.8 空状态

- 文案：标题「粘贴任何看起来像 JSON 的内容」；说明列出支持的类型；底部提示拖入图片的文案**删除**。
- 5 个 chip 对应示例；点击载入并聚焦输入框。
- 显示当前快捷键提示（如 `Ctrl+Alt+J 打开选中内容`）。

### 6.9 全局快捷键（核心）

**默认值**：`Ctrl+Alt+J`（`⌘` 也识别；macOS 上 Cmd 视为 Ctrl 修饰键）。

**选区来源**（按优先级）：

1. `document.activeElement` 是 `TEXTAREA`/`INPUT` 且有非折叠选区 → `value.slice(selectionStart, selectionEnd)`；
2. 否则 `window.getSelection()` 非折叠 → `toString()`；
3. 都没有 → 空字符串。

**匹配规则**：

```js
function parseShortcut(spec) {
  const parts = String(spec || '').split('+').map(p => p.trim()).filter(Boolean)
  if (!parts.length) return null
  const key = parts[parts.length - 1].toLowerCase()
  const mods = parts.slice(0, -1).map(p => p.toLowerCase())
  return {
    key,
    ctrl: mods.some(m => m === 'ctrl' || m === 'control' || m === 'cmd' || m === 'meta'),
    alt: mods.some(m => m === 'alt' || m === 'option'),
    shift: mods.includes('shift'),
  }
}

function matchesShortcut(event, spec) {
  const parsed = parseShortcut(spec)
  if (!parsed) return false
  const pressed = event.key === ' ' ? 'space' : String(event.key || '').toLowerCase()
  if (pressed !== parsed.key) return false
  if (Boolean(event.altKey) !== parsed.alt) return false
  if (Boolean(event.shiftKey) !== parsed.shift) return false
  return Boolean(event.ctrlKey || event.metaKey) === parsed.ctrl
}
```

**触发流程**：

```js
document.addEventListener('keydown', (event) => {
  if (shortcutRecording) return              // Settings 录制时让位
  if (event.repeat || !matchesShortcut(event, currentShortcut(fallback))) return
  const text = readSelectedText().slice(0, MAX_SELECTION_CHARS)
  event.preventDefault()
  if (!text.trim()) { try { ctx.layout.selectPanel(PANEL_ID) } catch {} ; return }
  try { localStorage.setItem(PENDING_KEY, text) } catch {}
  try { ctx.layout.selectPanel(PANEL_ID) } catch {}
  window.dispatchEvent(new CustomEvent(INJECT_EVENT, { detail: { text } }))
}, true)
```

**面板接收**（关键：面板可能还没挂载）：

- 挂载时读 `PENDING_KEY`：有值就采用并清除；
- 同时监听 `INJECT_EVENT`：已挂载时立即采用；
- 采用动作：`input ← text`、`view ← 'code'`、清空错误、toast「已载入选中的文本」、
  `requestAnimationFrame` 后聚焦输入框并置光标到末尾。
- `lastInput` 保存采用前的草稿，便于撤销。

**为什么用 pending + 事件两条路**：`selectPanel` 触发的 React 挂载是异步的，
同步 dispatch 的事件可能在挂载前丢失；pending 兜住这种情况。两条路都做，缺一不可。

### 6.10 Settings 快捷键录制页

**位置**：Settings → JSON Studio（`settings.section`，order 35）。

**UI**：

```
JSON Studio
面板快捷键与行为
┌────────────────────────────────────────────┐
│ 选中内容后打开                              │
│ 在 Harness 任意位置选中文本后按下该快捷键…   │
│                     [Ctrl+Alt+J] [录制] [恢复默认] │
│ （错误提示 / 已保存提示）                    │
└────────────────────────────────────────────┘
录制时按 Esc 取消。快捷键在 Harness 窗口内生效。
```

**交互**：

- 点「录制」→ 进入捕获状态（按钮文案「请按组合键…」），全局 `shortcutRecording = true`，
  此时全局快捷键处理器必须直接 return，避免误触。
- 捕获监听在 `document` 捕获阶段：
  - 纯修饰键（Control/Alt/Shift/Meta/CapsLock/Dead）忽略；
  - `Escape` 取消；
  - 没有 Ctrl/⌘/Alt → 错误「快捷键需要包含 Ctrl、⌘ 或 Alt」；
  - 否则拼 `Ctrl/Alt/Shift + 键名`（字母大写；空格 → `Space`；功能键用 `event.key`），
    保存到 `localStorage['json-studio.shortcut']`，更新显示，退出捕获，提示已保存。
- 「恢复默认」：删除覆盖值，显示默认 `Ctrl+Alt+J`，提示。
- 覆盖值变化时 dispatch `SHORTCUT_EVENT`，面板 footer/空状态标签实时更新。
- 录制值只影响本 profile 本机；不改 patch 配置。

### 6.11 主题与样式

- 根容器依赖主题 token（带 fallback）：

```css
--dsw-alias-bg-base, --dsw-alias-bg-layer-1/2, --dsw-alias-bg-overlay,
--dsw-alias-border-l1/l2, --dsw-alias-brand-primary,
--dsw-alias-label-primary/secondary,
--dsw-alias-state-error-primary, --dsw-alias-state-warn-primary,
--dsw-alias-state-success-primary
```

- 深/浅色：读取 `--dsw-alias-bg-base` 计算亮度，在根节点设 `data-js-theme="dark|light"`；
  监听 `document.documentElement/body` 的属性变化与 `prefers-color-scheme`。
  语法高亮色只在这里用字面色（键紫、字符串绿、数字琥珀、literal 蓝、注释灰），并按深色给一套更亮的覆盖。
- CSS 类统一前缀 `jst-`；不写全局选择器（除 `.jst-root *` 的滚动条样式）。
- 滚动条统一细化、使用主题色。
- 不要复制宿主组件的 CSS 类；需要按钮/输入样式就自己写。

### 6.12 i18n

- 命名空间 `local.json-studio`；字典 `EN` / `ZH` 都是扁平 key（如 `panel`、`format`、`noteComments`）。
- 所有可见文案必须 `t('key')`；组件优先用 `props.t`（`main` 注册带 `locale`），
  Settings 页用 `apply` 闭包里的 `ctx.locale.bind(NS)`。
- 模式名、note code → label 的映射必须是显式表（未知 code 有兜底文案）。
- 参考实现 `src/ui.js` 里有完整中英文字典；**复制时删除 OCR 相关 key**
  （`imageOcr`、`ocrReading`、`ocrFromImage`、`ocrConfidence`、`ocrUndo`、`ocrFailed`、`ocrNotImage`、`ocrTooLarge`、`ocrEmpty`、`ocrLang*`、`dropTitle`、`dropBody` 等）。

---

## 7. 容错 JSON 引擎契约（src/engine.js）

**实现约束**：纯 ESM；**没有任何 import**；不访问 DOM；所有函数不抛异常（`analyzeJson` 必须始终返回对象）。
允许直接复用参考实现（`E:\selfwork\json-studio\src\engine.js`）及其测试。

### 7.1 导出

```js
analyzeJson(text, options?) -> Analysis
findJsonCandidates(text, options?) -> Candidate[]
prettyLoose(text) -> string
tokenizeJson(text) -> Token[]
formatValue(value, indent = 2) -> string
minifyValue(value) -> string
sortKeysDeep(value) -> any
escapeJsonString(text) -> string      // 带引号的 JSON 字符串字面量
unescapeJsonString(text) -> string
summarizeValue(value) -> Stats
```

`options`：`{ maxBytes = 4_000_000, maxNodes = 200_000, maxDepth = 200 }`。

### 7.2 Analysis

```ts
type Note = { code: string, detail?: string }

type Analysis = {
  ok: boolean,
  mode: 'strict' | 'relaxed' | 'repaired' | 'fallback',
  value?: any,
  formatted: string,           // ok 时是 JSON 美化；失败时是 prettyLoose
  notes: Note[],               // 去重，按发现顺序
  error: null | { message: string, offset: number, line: number, column: number },
  stats: {
    bytes: number, chars: number, lines: number,
    nodes: number, depth: number, keys: number,
    arrays: number, objects: number
  },
  candidates: Array<{ kind: 'object'|'array'|'string'|'number'|'literal', start: number, end: number, preview: string }>,
  truncated: boolean
}
```

- `bytes/chars/lines` 描述**输入原文**；`nodes/depth/keys/arrays/objects` 描述**解析出的值**。
- `summarizeValue` 也返回同一 shape（其 bytes/chars/lines 由值的 `JSON.stringify` 计算）。

### 7.3 模式语义

- `strict`：`JSON.parse` 直接成功。
- `relaxed`：只做了词法级修复（注释、引号、Python/JS 字面量、数字写法、尾逗号、代码围栏、HTTP 头、JSONP、转义字符串展开、零宽字符/弯引号）。
- `repaired`：发明了结构（补逗号、裸词加引号、`=`→`:`、元组→数组、多值包数组、截断补闭合、重复键取最后）。
- `fallback`：无法得到值；`formatted = prettyLoose(text)`，`error` 填行列。

### 7.4 处理流水线（顺序）

1. 去 BOM；去零宽字符；**只把字符串外的弯引号**替换为 ASCII。
2. `JSON.parse` 快速通道（成功即 strict；若结果是「被转义的 JSON 字符串」，再解一层，标 `relaxed` + `escaped-string`）。
3. **内嵌未转义 JSON 修复 + percent 解码 + 多段日志拆分**（见 7.5.1；标 `nested-json-decoded` / `percent-decoded` / `multiple-values`）。这一步必须在宽松解析之前做。
4. 去代码围栏（开/闭都处理，标 `strip-fence`）。
5. HTTP 响应头（有无空行都处理，标 `header-footer`）。
6. JSONP 包装（`cb({...});`，标 `jsonp-wrapper`）。
7. 宽松递归下降解析（见 7.5）。
8. 失败时用候选扫描（平衡的 `{...}` / `[...]`）从前后噪音中提取；多个成功值 → 包数组（`multiple-values`）。
9. 仍失败 → fallback + 错误位置（offset/line/column）。
9. 边界：输入过大 → 截断分析（`input-too-large`，`truncated:true`）；
   节点/深度超限 → note `too-many-nodes` / `too-deep`（strict 路径也要检查）。
10. 生成 `stats`、`candidates`。

### 7.5 宽松解析器必须接受

- `//`、`/* */` 注释；单引号/反引号字符串；未加引号的对象键。
- 尾逗号；缺失的逗号（当下一个 token 能开启新成员/元素时补）。
- `True/False/None/nil/undefined/NaN/Infinity/-Infinity`。
- 数字：`0x1F`、`+1`、`.5`、`1.`、`1e3`、`1_000`。
- `=` 作为 `:`；`;` 作为分隔；`(...)` 作为数组（`tuple-array`）。
- 裸词值：`status: OK`、`msg: hello world`（到 `,` `}` `]` 换行或 `;` 为止；遇到「后跟 `:` 的标识符」时停止）。
- 重复键最后一个胜出；未闭合容器/字符串→部分恢复；结尾多余文字→忽略。
- 顶层多个值（NDJSON）→ 数组；JSONP / 代码围栏 / HTTP 头 / 前后散文。

### 7.5.1 内嵌未转义 JSON / 日志行（重点，用户真实需求）

这是**必须实现**的能力：输入常常不是"一条干净的 JSON"，而是**接口日志/抓包文本**，
里面"包着 JSON"，且内层的 JSON **没有正确转义引号**。用户明确要求："自主拆分识别"。

真实样本形态（一行里有多段，用空格 + `;` + `,` 分隔）：

```
{"map":{"data":"{"applicationFormCode":"","buyerEmail":"18300247760@163.com","buyerInfo":{...},"invoiceProductList":{"count":"1","group":[{...}]}}","name":"digital.electronic.invoice.create","sign":"...","version":"2.0"} ,"url":"https://...","desc":"数字化电子发票开具"}  ;  url: https://..., params: {"data":"%7B%22applicationFormCode%22...","name":"..."}
```

问题根因：外层 `"data":"{"applicationFormCode":...}"` 中，内层对象的第一个 `"` 会被普通词法器误判为"外层字符串结束"，
于是紧跟的 `applicationFormCode` 被当成 key，报 `expected ":" after key`，落进 fallback。

**必须在宽松解析器之前先做"嵌套 JSON 修复"预处理。** 算法（已在真实样本上验证可行）：

1. **`scanBalanced(text, start)`**：从 `{` 或 `[` 位置开始，用「引号配对 + 括号栈」扫描找到匹配的结束位置。
   - 遍历字符，遇 `\\` 跳过下一个（转义）；遇 `"` 翻转 `inString`；`inString` 为真时忽略括号；
     否则 `{`/`[` 入栈，`}`/`]` 出栈，栈空时返回 `i+1`。
   - 这段能跨过内部所有未转义引号，正确切出整个内层对象。
2. **`findUnescapedNested(text)`**：用正则 `/"([^"\\]+)"\s*:\s*"\s*([{[}])/g` 找到 `"key":"{` 或 `"key":"[` 模式。
   对每个命中，从 `{`/`[` 位置调 `scanBalanced` 得到结束位置，切出内层 JSON 串并尝试 `JSON.parse`；
   成功则记录该片段 `{ key, start, end, json }`。
3. **percent-encoded 片段**：正则 `/"([A-Za-z_][\w]*)"\s*:\s*"(%[0-9A-Fa-f]{2}[^"]*)"/g`，
   对值用 `decodeURIComponent` 解码，解码后若以 `{`/`[` 开头再 `JSON.parse`。
4. **多段日志拆分**：整行按顶层分隔符切成多段，每段独立走"修复 + 解析"：
   - 分号 `;`、或 `,` 后跟 `标识符:`（如 `url: https://...`、`params: {...}`）是段边界；
   - 注意不能切碎字符串/对象内部——用 `scanBalanced` / 引号状态机判断是否在容器/字符串内，只在顶层切。
   - 每段得到一个解析结果；多段成功 → 包成数组（`multiple-values` + `nested-json-decoded`/`percent-decoded`）。
5. **重写策略**（关键）：不要试图"就地修引号"让原文本可解析，而是**先把可独立解析的内层 JSON
   提取成结构化值**，再拼回一个干净的外层对象。做法二选一：
   - (a) 用 `scanBalanced` 的区间原文，把 `"data":"{...}"` 整段替换为 `"data":<内层JSON对象>`（去掉包裹引号），
     得到合法 JSON 再 `JSON.parse`；
   - (b) 用递归下降解析到该字段时，检测到值位置是 `"{` 且能在其后找到匹配 `{...}`，
     直接把这段当"内嵌对象"解析成 Object，而不是普通字符串。
   参考实现的现有解析器走的就是 (b) 思路的雏形，但需要先识别"伪字符串"边界。

**验证过的实测结果**（用上面的真实样本跑原型）：
- 未转义内层对象切出 1547 字节，`JSON.parse` 直接成功，顶层键
  `applicationFormCode,businessType,buyerEmail,buyerInfo,...,invoiceProductList,...,sellerInfo,...` 全部命中；
- percent 编码片段 `decodeURIComponent` 后也能 `JSON.parse`。

**期望输出**：这类输入应得到 `ok:true`、`mode:'repaired'`（或 `relaxed`，若只做无损解码），
`value` 是一个把内层 JSON 还原为对象/数组的结构（例如 `map.data` 是对象而非字符串），
notes 含 `nested-json-decoded`（未转义提取）或 `percent-decoded`（URL 解码），
并可含 `multiple-values`（多段日志）。绝对不能落到 `fallback`。

**必须新增的 note code**：`nested-json-decoded`、`percent-decoded`，并给中英文标签。

**测试要求**：把上面这段真实样本（可脱敏）存为 `test/fixtures/engine/nested-log.txt`，新增用例断言：
- `ok === true` 且 `mode !== 'fallback'`；
- `value.map.data` 是对象且 `value.map.data.buyerEmail === '18300247760@163.com'`；
- `value.map.data.invoiceProductList.group[0].item === '信息系统服务'`；
- notes 含 `nested-json-decoded`；
- 第二段 percent 数据解码后 `name === 'digital.electronic.invoice.create'`；
- 单独一段纯 percent 编码也能解。

### 7.6 note code 全集

```
bom, zero-width, smart-quotes, strip-fence, strip-prose, header-footer,
comments, single-quotes, unquoted-key, trailing-comma, python-literals,
non-finite, loose-number, equals-colon, missing-comma, bareword-value,
tuple-array, semicolon, trailing-garbage, jsonp-wrapper, escaped-string,
duplicate-key, multiple-values, truncated-input, input-too-large,
too-many-nodes, too-deep, empty-input, unbalanced-brackets, unexpected-token,
nested-json-decoded, percent-decoded
```

UI 需要每个 code 的中英文标签；未知 code 用通用兜底。

### 7.7 其他函数

- `tokenizeJson(text)`：类型 `key|string|number|literal|punct|comment|bare|space|newline|invalid`；
  `tokens.map(t => t.value).join('') === text` 必须恒成立（高亮/定位依赖 offset）。
- `prettyLoose(text)`：按 `{[(` 深度缩进；`{`/`[` 后换行，`,` 后换行，`:` 后空格，闭合前回退缩进；
  保留注释/裸词；空容器保持 `{}`/`[]`；对已美化文本幂等；空输入返回 `''`。
- `formatValue`：`JSON.stringify`，循环引用替换为 `"[Circular]"`，永不抛。
- `sortKeysDeep`：对象键 `localeCompare` 升序，数组保序，循环安全。
- `escapeJsonString` / `unescapeJsonString`：`"a\"b"` ↔ `a"b`；非法转义返回原输入。
- `summarizeValue`：迭代遍历（防爆栈），循环安全。

### 7.8 引擎测试（必须）

- `test/engine.test.mjs`：参考实现已有的 21 个用例。
- `test/engine.contract.test.mjs`：参考实现已有的 76 个独立契约用例。
- 命令：`node --test test/engine.test.mjs test/engine.contract.test.mjs`。
- 关键断言：
  - strict/relaxed/repaired/fallback 四态；
  - 每种接受形式 + 对应 note；
  - garbage 表不抛异常、始终有 error；
  - `prettyLoose` 幂等；
  - tokenize 值拼接 === 原文；
  - `maxBytes/maxNodes/maxDepth` 的 note；
  - 转义/去转义/排序/循环安全；
  - **7.5.1 真实日志样本**：`value.map.data` 还原为对象、percent 片段解码成功、多段拆开、notes 正确、绝不 fallback。

### 7.9 兜底可读性（"不是 JSON 也要好看"的硬要求）

当输入**无论如何都无法结构化**时（纯文本、HTML、乱码、半截括号），`analyzeJson` 仍必须返回一个
"可用结果"，UI 必须把它展示得像排过版的代码，而不是错误信息糊脸：

- `mode:'fallback'`，`ok:false`，但 `formatted = prettyLoose(text)` **必须非空**（除非输入本身为空）。
- `prettyLoose` 的输出要求：
  - 按 `{[(` 深度缩进（2 空格/层）；`{`/`[` 后换行，`,` 后换行，`:` 后一个空格，闭合符前回退缩进；
  - 空容器 `{}`/`[]` 保持在一行；
  - **保留所有原始 token**（裸词、注释、乱码都不能丢），只加缩进与换行；
  - 对已经排好版的文本再次调用应保持幂等；
  - 任意字符串调用都不抛异常。
- UI 层：fallback 时仍走源码视图高亮（`tokenizeJson` 对烂文本也要能对 token 上色），
  顶部 error 横幅显示"无法严格解析 + 行/列"，但**结果区必须展示 `formatted`**，不能空白。
- 提示语要传达"不是严格 JSON，但已尽力整理"：例如模式徽标 `仅展示` + 提示
  "已按最佳格式排版，内容为非严格 JSON"，让用户知道这是**可读化**而非**解析失败**。
- 中英文都要有这条兜底提示文案（新增 i18n key，例如 `notStrictHint`）。

**边界情况**：`''` / 纯空白 → `formatted:''`、空状态展示；其余任何输入 `formatted` 都应非空。

---

## 8. 构建、安装、验证

### 8.1 构建

```bash
node build.mjs --check
```

- `build.mjs` 必须：
  - 读 `package.json`、`src/engine.js`、`src/ui.js`；
  - 用窄正则去掉顶层 `export `（只支持 `export function/const/let/class`）；
  - 校验 10 个 engine 导出都存在；
  - 把 engine 包进 IIFE 并解构导出，再内联 UI；
  - 生成带 `window.__ModuleLoader__.load({ id, factory })` 的 `client.js`；
  - `--check` 时跑 `node --check`。
- `client.js` 是生成物，永远不要手改；改 `src/*.js` 后重新 build。
- 输出应是普通脚本（无 ESM import/export、无顶层 await）。

### 8.2 安装

```text
plugin_manager install_bundle target=<绝对目录>
```

- 首次安装：`application` 必须是 `applied`。
- 已安装后改版本/代码：先 `remove_bundle target=@local/dsh-json-studio`，再 `install_bundle`。
- 不要手写 profile 的 `package.json` / `cordis.patch.yml`；不要 `pnpm` 直装。
- 安装后如果 entry 未激活，读 `error.diagnostic`；
  常见原因是 `client.js` 对 Host 不可见（见 4.1）或 `client.js` 语法错误。

### 8.3 验收清单（Definition of Done）

安装后逐项确认：

1. 左侧栏出现 **JSON Studio** 图标；点击打开主面板。
2. `main`、`sidebar.panellist`、`settings.section` 三个注册点在实时 Slot 检查中都为 `active`。
3. 粘贴标准 JSON → `标准`，源码高亮 + 行号正确。
4. 粘贴 JSON5（注释/单引号/裸键/尾逗号）→ `宽松`，notes 正确。
5. 粘贴缺逗号/未闭合括号 → `已修复`，值尽量恢复，notes 正确。
6. 粘贴 `}{` 等垃圾 → `仅展示`，错误行高亮、可定位，文本被缩进重排（非白屏），并显示"非严格 JSON，已尽力排版"提示。
7. **粘贴 7.5.1 的真实日志样本**（未转义内嵌 JSON + percent 编码 + 多段）→ `已修复`/`宽松`（不是"仅展示"），
   `map.data` 还原为对象，`buyerEmail`/`invoiceProductList.group[0].item` 可见，notes 显示已展开内嵌 JSON / 已 URL 解码。
8. 树形：展开/收起、复制路径；表格：对象数组出表格，非对象数组出提示。
9. 压缩/键排序/转义/去转义/复制/下载/换行/清空/示例全部可用。
10. 刷新页面后草稿、视图、换行偏好保留。
11. 在输入框选中一段文本 → 按 `Ctrl+Alt+J` → 面板载入该段（若面板未打开则打开）。
12. 在设置里把快捷键录成 `Ctrl+Shift+K` → 面板 footer 与空状态显示新键；按新键生效；旧键失效。
13. 录制时按 Esc 取消；无 Ctrl/⌘/Alt 的组合被拒绝；恢复默认后回到 `Ctrl+Alt+J`。
14. 中英文界面切换正常；无残留 OCR 文案/按钮/入口。
15. 粘贴任意非 JSON 乱码 → 结果区仍有缩进排版的可读文本（7.9），不是白屏/纯报错，且有"非严格 JSON"提示。
16. `node --test ...` 全绿（含 7.5.1 真实样本用例）；`node --check client.js` 通过。

---

## 9. 从参考实现裁剪（重要）

参考实现位于 `E:\selfwork\json-studio`，**带 OCR**。按下面清单删除/改写，确保最终无 OCR：

| 路径/内容 | 处理 |
| --- | --- |
| `src/engine.js` | **保留**（与 OCR 无关） |
| `test/engine*.test.mjs` | **保留** |
| `src/ui.js` | 保留骨架；删除所有 OCR 状态、按钮、拖拽/粘贴图片、`readFileAsDataUrl`、`ocrLangs`/语言下拉、OCR 横幅、`STATUS_ENDPOINT`/`OCR_ENDPOINT`、相关 i18n key |
| `src/ocr.js`、`src/ocr-worker.mjs` | **删除** |
| `assets/lang/**` | **删除** |
| `test/ocr.test.mjs`、`test/fixtures/ocr/**` | **删除** |
| `scripts/make-ocr-fixtures.py`、`scripts/measure-ocr.mjs` | **删除** |
| `package.json` 的 `tesseract.js` 依赖、OCR files、`assets/lang/*`、OCR 测试脚本 | **删除** |
| `index.js` 的 `webServer`/`/json-studio/ocr`/`/json-studio/status`/OCR engine 初始化 | **删除**；保留 `apply` + 4.1 兜底（+ 可选 4.2） |
| `cordis.patch.yml` 的 `maxImageBytes`/`ocrLangs`/`devLab` | **删除**；只留 `watchClientBundle` |
| `README.md` 的 OCR 章节/依赖/限制 | **删除** |
| `lab/`（开发 harness） | 可删；若要保留，去掉 OCR 按钮与 `/ocr-sample.png` |
| `docs/*.png` | 保留面板截图；OCR 截图删除 |

> 参考实现的 `index.js` 目前包含 OCR 路由和 `tesseract` 子进程，**不要照抄**。
> 无 OCR 后宿主半应接近空：`apply()` 只做兜底/热更新/日志。

---

## 10. 常见坑

1. **`main` key 与侧栏 id 必须一致**：`layout.selectPanel` 用同一个字符串；不一致会“点了没反应”。
2. **factory 里不要有副作用**：注册、样式、监听器都放 `apply` 的 `ctx.effect`；否则热更新重复注册/泄漏。
3. **不要 `require` 宿主包**：只用 `react`；样式/控件自己写，保证随 Harness 升级不崩。
4. **client.js 不能有 ESM 语法**：build 后跑 `node --check`；不要顶层 await。
5. **Host 可能看不见 build 产物**：见 4.1；安装报 import 失败时先查这个。
6. **`ctx.layout.selectPanel` 会抛**：未注册/时序未到时 try/catch，pending 仍保留，下次打开面板会载入。
7. **快捷键事件顺序**：监听用捕获阶段；录制时必须让全局处理器短路，否则会边录边打开面板。
8. **同步 dispatch 会赶在面板挂载前**：必须同时写 pending；只做事件会偶发丢失。
9. **主题**：UI 颜色只用 token；语法高亮字面色要有深色覆盖；不要写死背景/文字色。
10. **CSS 前缀**：全部 `jst-`，避免污染宿主；滚动条规则限定 `.jst-root *`。
11. **Settings 页只保证 `close` prop**：不要依赖 `t` prop；用闭包。
12. **不要改 profile 文件**：安装、依赖、patch 全部由 `plugin_manager` 处理。
13. **删除 OCR 要彻底**：依赖、文件、路由、按钮、文案、测试、fixtures、README 都要清；验收时全局搜 `ocr|tesseract|image`。
14. **大输入保护**：渲染行数/高亮字符/表格行/展开节点都要有上限，否则会卡死页面。

---

## 11. 附录：给接手 AI 的执行顺序

1. 读本文档（尤其 1.1 最高优先级原则、7.5.1 内嵌 JSON、7.9 兜底可读性）+ 参考实现的 `src/engine.js`、`src/ui.js`、`build.mjs`、`index.js`。
2. 复制 `src/engine.js` 与两个 engine 测试；跑通测试。
3. **实现 7.5.1 的内嵌未转义 JSON / percent 解码 / 多段日志拆分**（用真实样本验证），并补 7.9 兜底可读性。
4. 基于参考 `src/ui.js` **删 OCR**，保留面板/树/表/快捷键/Settings，补"非严格 JSON"兜底提示文案。
5. 重写 `index.js` 为「无路由 + bundle 兜底 + 可选热更新」。
6. 清理 `package.json`、`cordis.patch.yml`、locale、README、files 列表。
7. `node build.mjs --check`。
8. `plugin_manager install_bundle`，按 8.3 逐项验收。
9. 报告：文件清单、测试命令与结果、安装 `application`、实时 Slot 注册证据、手动验收结果、已知限制。

---

## 12. 参考数据速查

- 默认快捷键：`Ctrl+Alt+J`（支持 `Ctrl/⌘/Alt(+Shift)+键`）。
- 快捷键覆盖 key：`json-studio.shortcut`；录制事件：`json-studio:shortcut`。
- 载入选区事件：`json-studio:inject`；pending key：`json-studio.pending`。
- 草稿 key：`json-studio.v1`。
- 面板 id / 主面板 key / 侧栏 id / Settings id：统一 `json-studio`。
- locale 命名空间：`local.json-studio`。
- 引擎默认边界：4 MB / 200k 节点 / 200 层。
- 新增 note：`nested-json-decoded`（已展开未转义内嵌 JSON）、`percent-decoded`（已 URL 解码）。
- 真实日志样本见 7.5.1 + `test/fixtures/engine/nested-log.txt`；兜底可读性见 7.9。

**一句话产品哲学（交给接手 AI 的最高准则）**：任何字符串进来都要"有模有样地展示出来"——
能解析成 JSON 就结构化；不能就尽力排版 + 明确告知"非严格 JSON，已尽力整理"，绝不白屏。
- UI 边界：4000 行、240k 高亮字符、2000 表格行、3000 展开节点、2M 选中字符。
- 参考实现测试规模：engine 21 + contract 76 = 97 个引擎用例（全部应通过）。
