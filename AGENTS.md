# AGENTS.md

给在本仓库里工作的 agent 的指引。代码、注释、提交信息用英文；面向用户的界面文案走 locale；本文件的读者是你（agent）和维护者。

## 这个仓库是什么

一个 DeepSeek Harness（DSH）bundle 插件：在消息输入框下方显示「本轮 / 本会话」的消费估算。它不是普通 npm 库——`package.json` 里的 `dsh.bundle.patch` 让 DSH 的 Loader 把它当成一个插件包加载。

| 文件 | 作用 | 运行时 |
|---|---|---|
| `index.js` | 宿主半边：`spendUsage` 投影、单价文件读写、定时调价、三条本地路由 | Node |
| `client.js` | 客户端半边：dock 条目、面板、计价、编辑器 | 浏览器 |
| `cordis.patch.yml` | 插入插件行 | Loader |
| `locale/*.json` | 插件标题/描述/详情文档路径 | Plugin Manager |
| `docs/` | 详情页图片与中英文文档 | Plugin Manager |
| `icon.svg` | 插件图标 | Plugin Manager |

两个半边通过三条通道协作：**会话投影**（宿主算、客户端读）、**单价文件**（唯一真相源）、**本地 HTTP 路由**（面板与 agent 共用的读写通道）。

## 一、文档规范

1. **README.md 与 README.zh.md 必须同步**。同一个功能、同一条限制，两边都要写到；不允许只有一边更新。英文版是主版本，中文版可以更口语，但事实必须一致。
2. **CHANGELOG.md 用 Keep a Changelog 格式**。每次用户可见的变更都先写进 `## [Unreleased]` 的 `Added / Changed / Fixed / Removed` 之一；发版时把 `Unreleased` 改成 `## [x.y.z] - YYYY-MM-DD`，同时 `package.json` 的 `version` 一起改，并打 `vX.Y.Z` 附注标签。
3. **`locale/*.json` 的两份必须成对**：`meta.title`（英文句首大写、只大写首词与专名）、`meta.description`、`meta.detail` 三项都齐。`meta.description` 要在一段话里讲清三件事：**做什么、怎么用、有什么限制**；不要把功能说明写进 `docs/` 的图片文档。
4. **`docs/DETAIL.md` / `docs/DETAIL.zh.md` 只能是「一行图片 + 替代文本」**，不得有标题、说明、安装步骤。图片放在同目录，替代文本要描述图片内容（不是"示意图"三个字）。
5. **代码注释解释「为什么」，不解释「是什么」**。已有的设计理由要保留：为什么用投影而不是折叠窗口、为什么 `cacheWrite == input`、为什么 `panelMemory` 存在。删掉这些注释等于删掉决策记录。
6. **所有面向用户的字符串走 `t('key')`**，包括按钮、占位、错误。`zh` 与 `en` 两份字典的 key 集合必须完全相同（新增 key 时同时加）。
7. **只写验证过的行为**。已知限制必须同时出现在：README 的「Limits」、面板的提示文案、以及 `meta.description`。当前需要随时列出的限制：节假日未建模、会话累计按当前时段估算、面板编辑器依赖 HTTP 传输、Search/Fetch/OCR/语音不计费。
8. **文档里的命令和路径不得含本机信息**：不要出现 `C:\Users\...`、真实端口、令牌、邮箱。示例路径用相对路径或 `<placeholder>`。

## 二、开发规范

### 运行时边界

1. **零依赖、零构建**。宿主半边按原样被 `import`，客户端半边自己向 `window.__ModuleLoader__` 注册。不要引入打包器、Transpiler 或 npm 依赖。
2. **宿主半边只 import `node:` 内置模块**。本包由 DSH 以 link 方式安装，`@deepseek-ai/*` 的裸导入不保证解析得到；确实需要时，先在已安装的 profile 里验证解析，再把结论写进注释。
3. **客户端半边只能使用浏览器基线模块表**（`react`、`react-dom`、`@deepseek-ai/cordis` 等）。**不要** `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何其他 Harness 客户端包；需要控件时手写，样式只用 `--dsw-alias-*` / `--dsw-radius-*` 主题变量。

### 数据来源

4. **会话数据一律来自宿主投影**：`spendUsage`（本包）、`tokenUsage`、`modelSelection`。客户端**不得**折叠 `ChatSnapshot.legacy.nodes`、不得自行扫描事件、不得读会话日志文件。需要新的派生值时，在 `index.js` 里注册一个投影单元（`ctx.sessionProjections.register`），用 `wire.view` 送到客户端。
5. 投影单元必须满足：`apply` 同步、纯函数、对无关事件**返回同一个 state 引用**；state 是纯 JSON（要能被 checkpoint 序列化）；`wire.summary` 按是否会进会话列表决定。
6. **计价只在一个地方**：`client.js` 的 `resolvePrice` / `costOf` / `bandAt` / `turnCost`。不要把同一套乘法写进宿主。

### 单一真相源

7. **单价只有一个真相源：`~/.dsh/show-me-my-money.json`**（或 `config.file` 指定的文件）。代码里的 `FALLBACK_PRICING` / `DEFAULT_CONFIG` 只是兜底默认值，不得成为第二个可编辑来源。文档、表单、路由都不能绕开这个文件。
8. **新增/改动价格字段**，要同时改四处：宿主 `readConfig`（校验与合并）、客户端 `normalizePricing`（同一套语义）、README 的字段表、面板编辑器（若用户可改）。改结构时提升文件里的 `_version` 并在 CHANGELOG 说明。
9. **自动调价只覆盖价格表**：`models`、`perMillion`、`remote.lastSyncAt`。`currency` 与 `peak` 属于用户，任何同步都不能动它们。

### UI 与生命周期

10. **插槽注册用 `ctx.slots.inject(slot, () => ctx.slots.register(...))`**，id 固定 `spend`，`order: 2`，`locale: NS`。不要在别的 fiber 上注册，也不要直接往 `document.body` 挂 React 根。
11. **一个渲染崩溃会被宿主移除整个插槽条目**——读数会整块消失。因此：可空值读取必须加守卫（本仓库真实事故：编辑表单在 `draft === null` 时仍读 `draft.idle`，导致点开面板即整条目消失）；面板必须包在 `PanelBoundary` 里；新增的渲染路径要按"这里能不能拿到 null"过一遍。
12. **面板开合状态保持在 `panelMemory` 里**，不要挪回组件 state：输入框在焦点变化时会重渲染并可能重建这一行，组件 state 会丢。
13. **Hook 不可条件调用**；`SpendPill` / `SpendPanel` 里已有的顺序不要打乱。
14. **Dismiss 只响应真正的外点**：用 `composedPath()` 判断，并保留打开后 300ms 的宽限期，避免开面板那一下被当成关闭手势。

### 宿主健壮性

15. **`apply()` 不得抛错**：注册一律包在 `ctx.effect` / `ctx.inject` 里；异步注册用 `scope.effect(async () => { await ... })`。
16. **失败要能被看见**：读取失败走 payload 的 `warnings`，同步失败走 `sync.lastError`，绝不让插件崩掉或让读数静默归零。
17. **路由保持现状的安全属性**：写接口校验 `Origin` 与 `Host` 一致；body 上限 64 KiB；抓取超时 15s、页面上限 1 MiB；抓取失败不得改动价格文件。
18. **不做遥测、不加分析、不外发数据**。唯一的出网请求是 `remote.url`，且必须能被 `remote.enabled: false` 完全关掉。

### 版本与发布

19. 新增运行时文件时同步 `package.json` 的 `exports` 与 `files`。
20. 用户可见行为变化 → bump `version` + CHANGELOG + 发版标签；纯注释/内部整理不必 bump。
21. 提交信息用 `<type>(<scope>): <summary>`（`feat` / `fix` / `docs` / `chore` / `refactor`），正文写清**为什么**；一次提交只做一件事，保持 `main` 可发布。

## 三、完成定义（DoD）

改完一处后逐条过：

- [ ] `node --check index.js` 与 `node --check client.js` 通过
- [ ] `package.json`、`locale/*.json` 仍是合法 JSON；中英 locale key 集合一致
- [ ] 新增/变更的行为已写进 README.md **和** README.zh.md
- [ ] 用户可见变更已写进 CHANGELOG 的 `Unreleased`
- [ ] 价格字段变了 → 宿主与客户端的规范化逻辑都已同步
- [ ] 会话数据仍来自投影，客户端没有新增窗口折叠/事件扫描
- [ ] 新增渲染路径没有可空解引用；面板仍在 `PanelBoundary` 内
- [ ] 没有新增依赖、没有引入 `@deepseek-ai/*` 客户端包导入
- [ ] 没有把本机路径、端口、令牌、邮箱写进任何文件
- [ ] 端到端验证过被改的那条路径（见下）

## 四、怎么验证

- **宿主路由**：面板与 agent 共用同一组接口，可以直接打：
  `GET /plugins/show-me-my-money/prices`、`POST .../save`、`POST .../sync`。
  用空 body 打 `save` 应得 400（说明已过方法与来源校验）。
- **投影**：改完 `spendUsage` 后，看会话投影检查点里是否出现 `spendUsage` 行，并把它与"自己折叠一遍日志"的结果对账。
- **客户端**：改 `client.js` 后刷新页面；改 `index.js` 后重载插件行（或重启 DSH）。用已安装的插件当预览，不要造 mock 页面。
- **没有浏览器控制时**，只能声明"语法、清单、路由、数据链路已验证"，**不得**声明"界面已确认"。视觉结论必须写明未验证。

## 五、发版流程

发版 = 一次提交 + 一个附注标签 + 一个 GitHub Release。顺序固定，不要跳步。

1. **对齐变更**：`git log --oneline <上个标签>..HEAD` 过一遍；确认每处用户可见变更都已在 `CHANGELOG.md` 的 `Unreleased` 里，README 中英两份已同步。
2. **改版本号**：`package.json` 的 `version` 改成 `x.y.z`。
3. **收口 CHANGELOG**：把 `## [Unreleased]` 改成 `## [x.y.z] - YYYY-MM-DD`，并在最上面新加一个空的 `## [Unreleased]`。
4. **提交**：`git commit -m "chore(release): x.y.z"`。
5. **打附注标签**（必须 `-a`，轻量标签不带发布信息）：
   ```bash
   git tag -a vX.Y.Z -m "Show me my money X.Y.Z"
   ```
6. **推**：`git push origin main`，再**单独**推标签 `git push origin vX.Y.Z`——普通 push 不会带走标签。
7. **写 Release notes**：从 CHANGELOG 对应小节整理成给用户看的版本（功能、安装、限制），写到仓库**外**的临时文件，不要把 notes 提交进仓库。
8. **建 Release**（在仓库根目录执行，`-R` 可省略，gh 从 origin 推断）：
   ```bash
   gh release create vX.Y.Z --title "Show me my money X.Y.Z" --notes-file <临时文件> --verify-tag
   ```
   `--verify-tag` 会在远端标签不存在时直接报错，避免 gh 用当前 HEAD 现造一个标签。预发布加 `--prerelease`。
9. **验证**：
   ```bash
   gh release view vX.Y.Z --json tagName,isPrerelease,url
   gh release list                     # 第一行应标着 Latest
   gh api repos/{owner}/{repo}/git/ref/tags/vX.Y.Z --jq .object.sha
   ```
   确认标签指向的提交就是要发的那个、列表里标 Latest、没有误标 pre-release。注意不同 gh 版本的 `--json` 字段集合不同（有的版本没有 `isLatest`，用 `gh release list` 看最新标记即可），写进文档的命令必须先在当前版本上跑通。
10. **发错了就回滚**：`gh release delete vX.Y.Z --yes` → `git push origin --delete vX.Y.Z` → `git tag -d vX.Y.Z`，修好后整套重来。**不要**在已删除的同名标签上直接重发。

发版前确认仓库可见性符合预期（`gh repo view --json visibility`）：Release 页面一旦创建就对所有能访问仓库的人可见。

## 六、不要做

- 不要把运行时的 `show-me-my-money.json` / `prices.json` 提交进仓库（`.gitignore` 已覆盖）。
- 不要在代码或文档里硬编码本机路径、真实端口、令牌、个人邮箱。
- 不要为了"顺手"改插件的 id、插槽 id、投影 key 或价格文件路径——它们都是对外契约，改动会打断已安装的实例。
- 不要在没有 CHANGELOG 记录的情况下发布新版本。
