# Show me my money

在 DeepSeek Harness 的消息输入框下方，估算显示**本轮**与**本会话**的消费金额。

![输入框下方的消费读数](docs/preview.svg)

DSH 只记 token、不记钱。这个 bundle 用**你自己的单价表**把 token 折算成金额，并定期从 DeepSeek 官方价格页更新单价表，把结果放在你本来就在看的地方——输入框下方那条统计行。

## 你会得到什么

- **本轮**：最新一轮里所有已计费调用的花费之和，工具链走得多、数字就一格一格往上走。
- **累计**：整个会话的花费，来自完整持久日志。
- **明细面板**（点读数打开）：最近一次请求 / 本轮 / 本会话三个层级的拆解——模型、四类 token（未缓存输入、缓存命中、缓存写入、输出）、小计，以及各自按哪个时段计价。
- **空闲/高峰两档计价**，因为 DeepSeek 高峰时段价格翻倍。
- **一份真正可维护的单价表**：JSON 文件，编辑器、agent、面板都能写；还能按官方页自动刷新。

## 环境要求

- DeepSeek Harness `0.2.2-rc.5` 或兼容版本（`@deepseek-ai/dsh`）。构建与测试基于该版本。
- Web GUI 或 Desktop 外壳（读数位于浏览器侧的输入框插槽）。

不需要 API key、账号或任何自建服务。

## 安装

1. 把本目录复制/克隆到一个固定位置。
2. 在 DSH 打开 **插件 / Plugins** → **添加插件** → 选择这个本地目录。
3. 安装后会自动激活，并插入一行名为 `show-me-my-money` 的插件行，保持启用。
4. 刷新页面（客户端模块会重新拉取）。

包名即插件 id。仓库里是 `@local/show-me-my-money` 这个本地作用域；若要改名，需同时改 `package.json`、`cordis.patch.yml` 和 `client.js` 里的 `id`。

## 单价

### 文件

```
~/.dsh/show-me-my-money.json          # 设置了 $DSH_HOME 时为 $DSH_HOME/show-me-my-money.json
```

首次激活时用内置默认值创建。字段说明：

| 字段 | 含义 |
|---|---|
| `currency` | 金额前的货币符号。 |
| `remote` | 自动调价：`enabled`、抓取地址、`intervalMinutes`（下限 15）、以及宿主写入的 `lastSyncAt`。 |
| `peak` | 高峰规则：`enabled`、IANA 时区、`weekdays`（0 = 周日）、半开区间 `HH:MM`。设 `enabled: false` 则全天按空闲价。 |
| `perMillion` | 兜底扁平单价，单位「每 100 万 tokens」。 |
| `models` | 按模型 id 覆盖；精确匹配优先，其次按子串，`*` 兜底。每个模型可写 `idle`、`peak`，或直接写四个桶（两档通用）。 |

四个桶都是「每 100 万 tokens」的价格：`input` 未命中缓存的输入，`cacheRead` 缓存命中的输入，`cacheWrite` 写入缓存的输入，`output` 输出（含推理）。DeepSeek 把缓存写入按普通输入计费，所以 `cacheWrite` 与 `input` 相等。

某个字段写错时，面板会报出来并回退到默认值，不会让读数变空；整个文件不是合法 JSON 时整份回退，并显示解析错误。

### 自动调价

宿主每 **6 小时**重新读取一次 DeepSeek 官方价格页；激活时若距上次同步已超期会先同步一次；面板里的 **同步官方价** 按钮可立即触发。它只解析模型价格表，页面上其他布局变化不影响。

同步只写 `models`、`perMillion`、`remote.lastSyncAt`，**不动**你的 `currency` 和 `peak` 规则。抓取或解析失败时文件保持原样，并在面板里说明原因。

因为自动调价拥有 `models`，它会覆盖你手改过的模型行。想自己接管就设 `remote.enabled: false`，或调大 `intervalMinutes`。

### 在面板里改

点读数 → **改单价**：选模型、改空闲/高峰两列、保存。它通过宿主写同一份文件，所以「agent 改文件」和「你在面板里改」始终一致。

也可以把单价放进工作区，改指向另一个文件：

```yaml
- id: show-me-my-money
  name: '@local/show-me-my-money'
  config:
    file: ./prices/show-me-my-money.json   # 相对工作目录解析
```

## 数据从哪来

会话数据以**宿主投影**的形式送到页面，浏览器只负责乘单价。

| 投影 | 提供方 | 读数取什么 |
|---|---|---|
| `spendUsage` | 本 bundle | 最新一次已计费调用，以及本轮每一次调用——由 `assistant/message` 事件在完整持久日志上折叠得出。 |
| `tokenUsage` | `@deepseek-ai/dsh-token-meter` | 整会话的输入、缓存命中、缓存写入、输出 token。 |
| `modelSelection` | `@deepseek-ai/dsh-agent` | 下一次/最近一次调用所用模型，用来选价目。 |

`spendUsage` 注册在 `ctx.sessionProjections` 上：每个已提交事件驱动一次，随其他单元一起 checkpoint；若在会话中途注册，会先折叠已有日志再继续。翻页、压缩、以及浏览器加载窗口的变化都不会让数字漂移。

### 时段判定

DeepSeek 高峰时段为北京时间周一至周五 `09:00-12:00`、`14:00-18:00`，其余（含整个周末）为空闲。每条读数按各自能支撑的精度判档：

- 单次请求用**它自己的时间戳**，08:58 发出的请求在 10:00 看仍是空闲价；
- 一轮按**每次调用各自的时段**分别计价，跨档时标注 `空闲+高峰`；
- 会话累计用**你查看时的时段**，因为持久化的 token 聚合没有逐次时间戳。

## 宿主路由

| 路由 | 用途 |
|---|---|
| `GET /plugins/show-me-my-money/prices` | 生效配置、文件路径、告警、上次刷新结果。 |
| `POST /plugins/show-me-my-money/prices/save` | 用校验过的配置替换文件；返回最新 payload。拒绝跨站 `Origin`、超过 64 KiB 的请求体、以及任何会产生告警的配置。 |
| `POST /plugins/show-me-my-money/prices/sync` | 立即重读官方页；抓取或解析失败返回 `502` 与原因，文件不动。 |

宿主服务器只绑回环地址，所以这些路由只在本机可用；写接口会校验 `Origin` 与 `Host` 是否一致。

## 隐私

- 唯一的外网请求：按 `remote.intervalMinutes` 抓取 `remote.url`。设 `remote.enabled: false` 可完全关闭。
- 其余全部本地：三个会话投影、一份 JSON 文件、上面几条路由。
- 没有遥测、没有账号、没有统计。

## 已知限制

- 所有金额都是「提供商上报的 token × 你的单价」的估算，不是账单。
- 未建模中国法定节假日：实际全天空闲，这里按普通工作日处理。
- 只算 token 用量；Search / Fetch / OCR / 语音的按次费用不在范围内。
- 面板里的编辑器和两个按钮需要页面走 HTTP。若外壳以 `file://` 加载页面（`fetch` 经只转发 GET 的桥），编辑器会报失败，此时用文件改价；自动调价在宿主里跑，不受影响。

## 开发

纯 JavaScript，无构建步骤、无依赖：宿主半边按原样加载，客户端半边自己向 `window.__ModuleLoader__` 注册。

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主：`spendUsage` 投影、单价文件、定时刷新、三条本地路由。 |
| `client.js` | 客户端：dock 条目、面板、计价、编辑器。以 id `spend` 注册进 `conversation.composer.dock`。 |
| `cordis.patch.yml` | 插入插件行。 |
| `locale/*.json` | 插件标题、描述、详情文档路径。 |
| `docs/` | 详情页图片与中英文文档。 |
| `icon.svg` | 插件图标。 |

改完自查：

```powershell
node --check index.js
node --check client.js
```

用已安装的插件当预览：改 `client.js` 后刷新页面；改 `index.js` 后重新加载插件行。

仓库的文档规范与开发规范（含完成定义与各层验证方法）见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)
