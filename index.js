/**
 * Host half of the show-me-my-money bundle.
 *
 * Owns the price file and the three local routes the Client half uses:
 *
 *   GET  /plugins/show-me-my-money/prices       -> { ok, path, exists, config, warnings, sync }
 *   POST /plugins/show-me-my-money/prices/save  -> same payload, after writing the file
 *   POST /plugins/show-me-my-money/prices/sync  -> same payload, after re-reading the official page
 *
 * The price file is the single source of truth: the panel's form writes it
 * through the save route, an agent or an editor writes it directly, and the
 * background refresh writes it from DeepSeek's published price list. All three
 * are the same file, so the next read picks up whichever came last.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const READ_PATH = '/plugins/show-me-my-money/prices'

const SAVE_PATH = '/plugins/show-me-my-money/prices/save'

const SYNC_PATH = '/plugins/show-me-my-money/prices/sync'

const FILE_NAME = 'show-me-my-money.json'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** Largest accepted write body; the form sends a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** Automatic price refresh: where from, and how often at the least. */
const DEFAULT_REMOTE = {
  enabled: true,
  url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md',
  intervalMinutes: 360,
}

const MIN_INTERVAL_MINUTES = 15

/** How often the background check looks at the clock; the file decides whether it fetches. */
const TICK_MS = 5 * 60 * 1000

const FETCH_TIMEOUT_MS = 15 * 1000

const MAX_PAGE_CHARS = 1024 * 1024

/**
 * Official DeepSeek price list, CNY per 1,000,000 tokens. `peak` is the
 * Beijing-time window the provider charges double in; every other hour is
 * idle. Cache-write tokens are billed as normal input, which is why the two
 * are equal here.
 */
const FLASH_IDLE = { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }
const FLASH_PEAK = { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
const PRO_IDLE = { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 }
const PRO_PEAK = { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }

/** Peak: Monday to Friday, 09:00-12:00 and 14:00-18:00 Beijing time. */
const DEFAULT_PEAK = {
  enabled: true,
  timeZone: 'Asia/Shanghai',
  weekdays: [1, 2, 3, 4, 5],
  windows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
}

/** Prices used whenever the file does not supply its own. */
const DEFAULT_CONFIG = {
  currency: '¥',
  peak: DEFAULT_PEAK,
  remote: DEFAULT_REMOTE,
  perMillion: { ...FLASH_IDLE },
  models: {
    'deepseek-flash': { idle: { ...FLASH_IDLE }, peak: { ...FLASH_PEAK } },
    'deepseek-v4-flash': { idle: { ...FLASH_IDLE }, peak: { ...FLASH_PEAK } },
    'deepseek-v4-pro': { idle: { ...PRO_IDLE }, peak: { ...PRO_PEAK } },
    '*': { idle: { ...FLASH_IDLE }, peak: { ...FLASH_PEAK } },
  },
}

const NOTE = 'show-me-my-money 单价表。perMillion 是兜底单价，models 按模型 id 覆盖（精确匹配优先，其次按子串，`*` 在都没匹配上时生效）。每个模型可写 idle（空闲）与 peak（高峰）两套，四个桶的单位都是「每 100 万 tokens」：input = 未命中缓存的输入，cacheRead = 缓存命中的输入，cacheWrite = 写入缓存的输入，output = 输出（含推理）。peak 描述高峰时段：默认北京时间周一至周五 9:00-12:00、14:00-18:00，其余时间按空闲价。改完保存，回到窗口即自动重新读取；也可以在输入框下方的消费读数里点开表格修改。'

const BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output']

/** The harness data root: `$DSH_HOME` when set, else `~/.dsh`. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') {
    try {
      return resolve(configured.trim())
    } catch {
      // A malformed override falls through to the default home.
    }
  }
  return join(homedir(), '.dsh')
}

/** A finite non-negative number, or null. */
function amount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Minutes since midnight for one `HH:MM` clock string, or null. */
function clockMinutes(text) {
  if (typeof text !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  if (hours > 24 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Copy the four recognized buckets out of one object, reporting bad members. */
function readBuckets(raw, path, warnings) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${path} 必须是对象`)
    return undefined
  }
  const out = {}
  for (const bucket of BUCKETS) {
    if (raw[bucket] === undefined) continue
    const value = amount(raw[bucket])
    if (value === null) warnings.push(`${path}.${bucket} 必须是大于等于 0 的数字，已忽略`)
    else out[bucket] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The peak-window rule, with the shipped rule filling every member the file omits. */
function readPeak(raw, warnings) {
  const peak = {
    ...DEFAULT_PEAK,
    weekdays: [...DEFAULT_PEAK.weekdays],
    windows: DEFAULT_PEAK.windows.map(slot => ({ ...slot })),
  }
  if (raw === undefined) return peak
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('peak 必须是对象，已改用默认高峰时段')
    return peak
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') peak.enabled = raw.enabled
    else warnings.push('peak.enabled 必须是布尔值，已忽略')
  }
  if (raw.timeZone !== undefined) {
    if (typeof raw.timeZone === 'string' && raw.timeZone !== '') peak.timeZone = raw.timeZone
    else warnings.push('peak.timeZone 必须是非空字符串，已忽略')
  }
  if (raw.weekdays !== undefined) {
    const days = Array.isArray(raw.weekdays) ? raw.weekdays : null
    if (days !== null && days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) peak.weekdays = [...days]
    else warnings.push('peak.weekdays 必须是 0-6 的整数数组，已忽略')
  }
  if (raw.windows !== undefined) {
    const slots = Array.isArray(raw.windows) ? raw.windows : null
    if (slots !== null && slots.every(slot => clockMinutes(slot?.start) !== null && clockMinutes(slot?.end) !== null)) {
      peak.windows = slots.map(slot => ({ start: String(slot.start).trim(), end: String(slot.end).trim() }))
    } else {
      warnings.push('peak.windows 必须是 {start,end} 的 "HH:MM" 数组，已忽略')
    }
  }
  return peak
}

/** The automatic-refresh rule, with the shipped values filling every omitted member. */
function readRemote(raw, warnings) {
  const remote = { ...DEFAULT_REMOTE }
  if (raw === undefined) return remote
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('remote 必须是对象，已关闭自动调价')
    remote.enabled = false
    return remote
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') remote.enabled = raw.enabled
    else warnings.push('remote.enabled 必须是布尔值，已忽略')
  }
  if (raw.url !== undefined) {
    if (typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url)) remote.url = raw.url
    else warnings.push('remote.url 必须是 http(s) 地址，已忽略')
  }
  if (raw.intervalMinutes !== undefined) {
    const value = amount(raw.intervalMinutes)
    if (value !== null && value >= MIN_INTERVAL_MINUTES) remote.intervalMinutes = value
    else warnings.push(`remote.intervalMinutes 必须是不小于 ${MIN_INTERVAL_MINUTES} 的数字，已忽略`)
  }
  if (typeof raw.lastSyncAt === 'string') remote.lastSyncAt = raw.lastSyncAt
  return remote
}

/** The file body written by activation and by every save. */
function serialize(config) {
  return `${JSON.stringify({ _version: 2, _note: NOTE, ...config }, null, 2)}\n`
}

/** Create the price file when it is absent; an existing file is never touched. */
async function ensureFile(file) {
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(file, serialize(DEFAULT_CONFIG), { flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}

/**
 * Fold one parsed document into the shipped defaults, reporting every member it
 * could not read. Unknown members are ignored rather than rejected, so a
 * hand-edited file may carry a `_note`.
 * @param parsed - the parsed JSON document.
 * @returns the effective config plus human-readable warnings.
 */
function readConfig(parsed) {
  const warnings = []
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: DEFAULT_CONFIG, warnings: ['价格文件顶层必须是一个 JSON 对象'] }
  }
  const config = {
    currency: DEFAULT_CONFIG.currency,
    peak: readPeak(parsed.peak, warnings),
    remote: readRemote(parsed.remote, warnings),
    perMillion: { ...DEFAULT_CONFIG.perMillion },
    models: {},
  }
  if (parsed.currency !== undefined) {
    if (typeof parsed.currency === 'string' && parsed.currency !== '') config.currency = parsed.currency
    else warnings.push('currency 必须是非空字符串，已改用默认值')
  }
  if (parsed.perMillion !== undefined) {
    const buckets = readBuckets(parsed.perMillion, 'perMillion', warnings)
    if (buckets !== undefined) config.perMillion = { ...config.perMillion, ...buckets }
  }
  if (parsed.models !== undefined) {
    if (parsed.models === null || typeof parsed.models !== 'object' || Array.isArray(parsed.models)) {
      warnings.push('models 必须是对象，已忽略')
    } else {
      for (const [modelId, patch] of Object.entries(parsed.models)) {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          warnings.push(`models["${modelId}"] 必须是对象，已忽略`)
          continue
        }
        const entry = {}
        const flat = readBuckets(patch, `models["${modelId}"]`, warnings)
        if (flat !== undefined) entry.flat = flat
        for (const band of ['idle', 'peak']) {
          if (patch[band] === undefined) continue
          const buckets = readBuckets(patch[band], `models["${modelId}"].${band}`, warnings)
          if (buckets !== undefined) entry[band] = buckets
        }
        if (Object.keys(entry).length > 0) config.models[modelId] = entry
      }
    }
  }
  return { config, warnings }
}

function json(status, payload, extraHeaders) {
  return Response.json(payload, { status, headers: { ...NO_STORE, ...extraHeaders } })
}

/** Resolve the configured price file path for one plugin row. */
function priceFile(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return join(dshHome(), FILE_NAME)
}

/**
 * Read the price file for one request.
 * @param file - absolute path of the JSON price file.
 * @returns the wire payload the Client half consumes.
 */
async function readPayload(file) {
  try {
    await ensureFile(file)
  } catch {
    // The file stays absent; the request still answers with the defaults.
  }
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, path: file, exists: false, config: DEFAULT_CONFIG, warnings: ['价格文件不存在，正在使用内置默认单价'] }
    }
    return { ok: false, path: file, exists: false, config: DEFAULT_CONFIG, warnings: [`读取价格文件失败：${error instanceof Error ? error.message : String(error)}`] }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, path: file, exists: true, config: DEFAULT_CONFIG, warnings: [`价格文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`] }
  }
  const { config, warnings } = readConfig(parsed)
  return { ok: true, path: file, exists: true, config, warnings }
}

/**
 * Replace the price file with one validated config.
 * @param file - absolute path of the JSON price file.
 * @param config - the validated config to persist.
 */
async function writePayload(file, config) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, serialize(config), 'utf8')
}

/** Split one Markdown table row into trimmed cells, or null outside a table. */
function splitRow(line) {
  const trimmed = String(line).trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  return trimmed.slice(1, -1).split('|').map(cell => cell.trim())
}

/** The amount a price cell carries: `0.02元`, `¥1`, `13.5`. */
function cellAmount(text) {
  const match = /[0-9]+(?:\.[0-9]+)?/.exec(text ?? '')
  if (match === null) return null
  const value = Number(match[0])
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Read DeepSeek's published price table out of its Markdown page.
 *
 * The table names its model columns in the header row and then spends one row
 * per metric and price band:
 *
 *   | 价格(2) | 百万tokens输入 / （缓存命中） | 空闲时段 | 0.02元 | 0.15元 |
 *
 * Cache-write tokens are billed as normal input, so `cacheWrite` mirrors
 * `input`. The Flash column is copied to `deepseek-v4-flash` and `*`, so an
 * alias or an unknown model still lands on a published price.
 * @param markdown - the fetched page.
 * @returns the models map, plus why it is empty when it is.
 */
function parsePricingPage(markdown) {
  const warnings = []
  const lines = String(markdown).split(/\r?\n/)
  let modelIds = []
  for (const line of lines) {
    const cells = splitRow(line)
    if (cells === null || cells.length < 4) continue
    if (cells[0] !== '模型') continue
    const candidates = cells.slice(3).map(cell => cell.replace(/\(\d+\)/g, '').trim())
    if (candidates.every(id => /^[a-z0-9][a-z0-9.-]*$/i.test(id))) {
      modelIds = candidates
      break
    }
  }
  if (modelIds.length === 0) return { models: {}, warnings: ['没有在页面上找到模型列'] }

  const collected = {}
  for (const id of modelIds) collected[id] = { idle: {}, peak: {} }

  for (const line of lines) {
    const cells = splitRow(line)
    if (cells === null || cells.length < 3 + modelIds.length) continue
    if (!/^价格/.test(cells[0])) continue
    const metric = cells[1] ?? ''
    const bandText = cells[2] ?? ''
    const band = bandText.includes('高峰') ? 'peak' : bandText.includes('空闲') ? 'idle' : null
    if (band === null) continue
    let bucket = null
    if (metric.includes('缓存未命中')) bucket = 'input'
    else if (metric.includes('缓存命中')) bucket = 'cacheRead'
    else if (metric.includes('输出')) bucket = 'output'
    if (bucket === null) continue
    modelIds.forEach((id, index) => {
      const value = cellAmount(cells[3 + index])
      if (value !== null) collected[id][band][bucket] = value
    })
  }

  const models = {}
  for (const id of modelIds) {
    const idle = collected[id].idle
    const peak = collected[id].peak
    if (idle.input === undefined || idle.output === undefined || peak.input === undefined || peak.output === undefined) {
      warnings.push(`模型 ${id} 的价格行不完整，已跳过`)
      continue
    }
    const band = source => ({
      input: source.input,
      cacheRead: source.cacheRead ?? 0,
      cacheWrite: source.input,
      output: source.output,
    })
    models[id] = { idle: band(idle), peak: band(peak) }
  }
  if (Object.keys(models).length === 0) return { models: {}, warnings }

  const flashId = Object.prototype.hasOwnProperty.call(models, 'deepseek-flash') ? 'deepseek-flash' : modelIds[0]
  const flash = models[flashId]
  if (flash !== undefined) {
    const copy = () => ({ idle: { ...flash.idle }, peak: { ...flash.peak } })
    if (models['deepseek-v4-flash'] === undefined) models['deepseek-v4-flash'] = copy()
    models['*'] = copy()
  }
  return { models, warnings }
}

/** Fetch one URL as text, bounded by a timeout and a size cap. */
async function fetchText(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'text/markdown, text/plain;q=0.9, */*;q=0.8',
        'user-agent': 'show-me-my-money/1.0 (DSH plugin)',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_PAGE_CHARS) throw new Error('价格页过大，已放弃本次同步')
    return text
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Re-read the published price list and write it into the price file.
 *
 * Only `models`, `perMillion`, and `remote.lastSyncAt` change: the currency,
 * the peak rule, and every other member stay exactly as the file had them.
 * @param file - absolute path of the JSON price file.
 * @param remote - the effective refresh rule (its `url` is fetched).
 * @returns the parsed result, including any warnings worth showing.
 */
async function syncPrices(file, remote) {
  const text = await fetchText(remote.url)
  const parsed = parsePricingPage(text)
  if (Object.keys(parsed.models).length === 0) {
    throw new Error(parsed.warnings.join('；') || '没有从页面上解析出价格')
  }
  const current = await readPayload(file)
  const config = current.config ?? DEFAULT_CONFIG
  const fallback = parsed.models['*']
  await writePayload(file, {
    ...config,
    perMillion: fallback === undefined ? { ...config.perMillion } : { ...fallback.idle },
    models: parsed.models,
    remote: { ...config.remote, lastSyncAt: new Date().toISOString() },
  })
  return parsed
}

/** Write one JSON response through Node's ServerResponse. */
function sendJson(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...NO_STORE,
    ...extraHeaders,
  })
  res.end(body)
}

/** Read a request body within {@link MAX_BODY_BYTES}. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大')
      error.code = 'ETOOLARGE'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Answer one write: a browser tab on this machine may post, anything else is
 * refused. A cross-site POST always carries an `Origin` that names another
 * host, which is what this check rejects.
 */
function crossOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return false
  const host = req.headers.host
  if (host === undefined) return true
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/** The four usage buckets this plugin carries, in the shape the Client renders. */
const USAGE_BUCKETS = ['uncached', 'cacheRead', 'cacheWrite', 'output']

/**
 * Read one provider usage record into the plugin's bucket shape.
 * @param usage - the `assistant/message` event's usage, however malformed.
 * @returns the buckets, or null when the sample is unusable.
 */
function usageBuckets(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const input = amount(usage.inputTokens)
  const output = amount(usage.outputTokens)
  if (input === null || output === null) return null
  return {
    uncached: input,
    cacheRead: amount(usage.cacheReadTokens) ?? 0,
    cacheWrite: amount(usage.cacheWriteTokens) ?? 0,
    output,
  }
}

/** Two bucket sets added field by field. */
function addBuckets(left, right) {
  const out = {}
  for (const bucket of USAGE_BUCKETS) out[bucket] = left[bucket] + right[bucket]
  return out
}

/** Whether a value is one of this plugin's bucket sets. */
function isBuckets(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return USAGE_BUCKETS.every(bucket => amount(value[bucket]) !== null)
}

/** Whether a value is one `{ time, buckets }` attempt record. */
function isAttempt(value) {
  return value !== null && typeof value === 'object' && typeof value.time === 'number' && isBuckets(value.buckets)
}

/**
 * Whether a value is the whole maintained state. Checked on every write and on
 * every persisted-cache restore, so a hand-edited checkpoint cannot reach the
 * Client as a broken view.
 */
function isSpendUsageState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.last !== null && !isAttempt(value.last)) return false
  if (value.turn === null) return true
  const turn = value.turn
  if (turn === null || typeof turn !== 'object') return false
  if (typeof turn.turn !== 'number' || typeof turn.count !== 'number') return false
  if (!isBuckets(turn.buckets) || !Array.isArray(turn.attempts)) return false
  return turn.attempts.every(isAttempt)
}

/** A minimal schema carrying the registry's `parse` contract without a validator dependency. */
function schemaOf(label) {
  return {
    parse(value) {
      if (!isSpendUsageState(value)) throw new Error(`show-me-my-money: invalid ${label} for spendUsage`)
      return value
    },
  }
}

/**
 * The `spendUsage` session projection: the newest billed attempt and every
 * billed attempt of the newest turn, folded from committed `assistant/message`
 * events over the whole durable log.
 *
 * This is the unit that keeps the composer reading off the loaded conversation
 * window: the Host folds the log once per event, the Client only prices what it
 * receives. Each attempt carries its own timestamp so the Client can price it
 * in the band it was actually made in.
 */
const spendUsageDefinition = {
  key: 'spendUsage',
  stateVersion: 1,
  stateSchema: schemaOf('state'),
  init: () => ({ last: null, turn: null }),
  apply: (state, event) => {
    if (event.type !== 'assistant/message') return state
    const buckets = usageBuckets(event.data.usage)
    if (buckets === null) return state
    const time = typeof event.time === 'number' ? event.time : 0
    const attempt = { time, buckets }
    const last = { time, buckets: { ...buckets } }
    const current = state.turn
    if (current === null || current.turn !== event.data.turn) {
      return { last, turn: { turn: event.data.turn, count: 1, buckets: { ...buckets }, attempts: [attempt] } }
    }
    return {
      last,
      turn: {
        turn: event.data.turn,
        count: current.count + 1,
        buckets: addBuckets(current.buckets, buckets),
        attempts: [...current.attempts, attempt],
      },
    }
  },
  wire: {
    viewSchema: schemaOf('view'),
    view: state => state,
    summary: false,
  },
}

/**
 * Mount the price routes.
 * @param ctx - the Host plugin context.
 * @param config - the plugin row's config; `file` overrides the price-file path.
 */
export function apply(ctx, config = {}) {
  const file = priceFile(config?.file)
  // Best effort: give the user and the agent a populated file to edit before
  // the first request asks for one.
  ensureFile(file).catch(() => {})

  // The reading's session data is a Host projection, not a Client fold: the
  // unit folds committed events once and every Client prices the same value.
  ctx.inject(['sessionProjections'], scope => {
    scope.effect(async () => {
      await scope.sessionProjections.register(spendUsageDefinition)
    }, 'show-me-my-money: spendUsage projection')
  })

  /** In-memory outcome of the last refresh; the file keeps the timestamp. */
  const syncState = { lastError: '', running: false }

  const wirePayload = async () => {
    let body
    try {
      body = await readPayload(file)
    } catch (error) {
      body = { ok: false, path: file, exists: false, config: DEFAULT_CONFIG, warnings: [String(error)] }
    }
    return { ...body, sync: { lastError: syncState.lastError, running: syncState.running } }
  }

  /**
   * One refresh attempt.
   * @param force - ignore the interval and the enabled flag, and propagate failure.
   */
  const runSync = async force => {
    if (syncState.running) return
    syncState.running = true
    try {
      const payload = await readPayload(file)
      const remote = payload.config?.remote ?? DEFAULT_REMOTE
      if (!force) {
        if (remote.enabled !== true) return
        const intervalMs = Math.max(MIN_INTERVAL_MINUTES, Number(remote.intervalMinutes) || DEFAULT_REMOTE.intervalMinutes) * 60_000
        const last = Date.parse(remote.lastSyncAt ?? '')
        if (Number.isFinite(last) && Date.now() - last < intervalMs) return
      }
      await syncPrices(file, { ...remote, url: remote.url || DEFAULT_REMOTE.url })
      syncState.lastError = ''
    } catch (error) {
      syncState.lastError = error instanceof Error ? error.message : String(error)
      if (force) throw error
    } finally {
      syncState.running = false
    }
  }

  // The interval lives in the file, so the clock only decides when to look.
  ctx.effect(() => {
    const tick = () => { void runSync(false) }
    const timer = setInterval(tick, TICK_MS)
    timer.unref?.()
    tick()
    return () => clearInterval(timer)
  }, 'show-me-my-money: price refresh')

  ctx.inject(['webServer'], scope => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: READ_PATH,
      resource: async (request, peer) => {
        if (peer !== undefined && peer?.principal?.kind !== 'owner') {
          return json(403, { ok: false, error: { code: 'E_FORBIDDEN', message: '只允许所有者读取' } })
        }
        const body = await wirePayload()
        return request.method === 'HEAD' ? new Response(null, { status: 200, headers: NO_STORE }) : json(200, body)
      },
    }), 'show-me-my-money: price read')

    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: SAVE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'E_METHOD', message: '只接受 POST' } }, { Allow: 'POST' })
          return
        }
        if (crossOrigin(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'E_ORIGIN', message: '只接受本页面提交' } })
          return
        }
        let text
        try {
          text = await readBody(req)
        } catch (error) {
          const tooLarge = error?.code === 'ETOOLARGE'
          req.resume()
          sendJson(res, tooLarge ? 413 : 400, {
            ok: false,
            error: { code: tooLarge ? 'E_TOO_LARGE' : 'E_BODY', message: tooLarge ? '请求体过大' : String(error) },
          })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'E_JSON', message: error instanceof Error ? error.message : String(error) },
            warnings: ['提交的内容不是合法 JSON'],
          })
          return
        }
        const { config: saved, warnings } = readConfig(parsed)
        if (warnings.length > 0) {
          sendJson(res, 400, { ok: false, warnings })
          return
        }
        try {
          await writePayload(file, saved)
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: { code: 'E_WRITE', message: error instanceof Error ? error.message : String(error) },
            warnings: [`写入价格文件失败：${error instanceof Error ? error.message : String(error)}`],
          })
          return
        }
        const body = await wirePayload()
        sendJson(res, body.ok === false ? 500 : 200, body)
      },
    }), 'show-me-my-money: price write')

    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: SYNC_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'E_METHOD', message: '只接受 POST' } }, { Allow: 'POST' })
          return
        }
        if (crossOrigin(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'E_ORIGIN', message: '只接受本页面提交' } })
          return
        }
        req.resume()
        try {
          await runSync(true)
        } catch (error) {
          sendJson(res, 502, {
            ok: false,
            error: { code: 'E_SYNC', message: error instanceof Error ? error.message : String(error) },
            warnings: [`同步官方价失败：${error instanceof Error ? error.message : String(error)}`],
          })
          return
        }
        const body = await wirePayload()
        sendJson(res, 200, body)
      },
    }), 'show-me-my-money: price sync')
  })
}
