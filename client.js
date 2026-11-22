/**
 * Money below the composer: one reading for the most recent model request and
 * one for the whole Session.
 *
 * Harness records tokens, not money: every figure here is an ESTIMATE of
 * provider-reported token counts priced by the user's price file. Nothing is
 * read from a billing service and nothing leaves this page.
 *
 *   - most recent request — provider usage of the newest billed attempt in the
 *     loaded conversation window, so it ticks once per completed model call.
 *   - whole Session — the `tokenUsage` projection, which folds the complete
 *     durable Session log, so history paging and compaction never change it.
 *
 * ## Unit prices
 *
 * The Host half owns the price file and serves it at
 * `GET /plugins/show-me-my-money/prices`; this module fetches it on mount, when
 * the window regains focus, and when the panel opens. The shipped defaults
 * below apply only while that route answers with nothing usable.
 */

window.__ModuleLoader__.load({
  id: '@local/show-me-my-money',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'show-me-my-money'

    /** Host route that serves the price file. */
    const PRICE_ROUTE = '/plugins/show-me-my-money/prices'

    /** Host route that replaces the price file with one submitted config. */
    const SAVE_ROUTE = '/plugins/show-me-my-money/prices/save'

    /** Host route that re-reads DeepSeek's published price list. */
    const SYNC_ROUTE = '/plugins/show-me-my-money/prices/sync'

    /**
     * Official DeepSeek price list, CNY per 1,000,000 tokens. `peak` is the
     * Beijing-time window the provider charges double in; every other hour is
     * idle. Cache-write tokens are billed as normal input, which is why the
     * two are equal here.
     */
    const FLASH_IDLE = { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }
    const FLASH_PEAK = { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
    const PRO_IDLE = { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 }
    const PRO_PEAK = { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }

    /** Prices used until the price file supplies others. */
    const FALLBACK_PRICING = {
      currency: '¥',
      peak: {
        enabled: true,
        timeZone: 'Asia/Shanghai',
        weekdays: [1, 2, 3, 4, 5],
        windows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
      },
      perMillion: { ...FLASH_IDLE },
      models: {
        'deepseek-flash': { idle: { ...FLASH_IDLE }, peak: { ...FLASH_PEAK } },
        'deepseek-v4-flash': { idle: { ...FLASH_IDLE }, peak: { ...FLASH_PEAK } },
        'deepseek-v4-pro': { idle: { ...PRO_IDLE }, peak: { ...PRO_PEAK } },
        '*': { idle: { ...FLASH_IDLE }, peak: { ...FLASH_PEAK } },
      },
    }

    const BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output']

    const DICTIONARIES = {
      zh: {
        'pill.turn': '本轮',
        'pill.turnFull': '本轮',
        'pill.total': '累计',
        'pill.totalFull': '本会话累计',
        'panel.title': '消费明细',
        'panel.close': '关闭',
        'panel.crashed': '面板渲染出错，刷新页面即可恢复',
        'panel.latest': '最近一次请求',
        'panel.turn': '本轮',
        'panel.turnCount': '{count} 次调用',
        'panel.total': '本会话累计',
        'panel.model': '模型',
        'panel.priceIdle': '空闲单价',
        'panel.pricePeak': '高峰单价',
        'panel.priceLine': '{input} / {cacheRead} / {cacheWrite} / {output}',
        'panel.priceHint': '每百万 tokens：未命中 / 命中 / 写入 / 输出',
        'panel.bandBasis': '累计按当前时段单价估算',
        'band.peak': '高峰',
        'band.idle': '空闲',
        'band.mixed': '空闲+高峰',
        'panel.uncached': '未缓存输入',
        'panel.cacheRead': '缓存命中',
        'panel.cacheWrite': '缓存写入',
        'panel.output': '输出',
        'panel.tokens': '{tokens} tokens',
        'panel.subtotal': '小计',
        'panel.source': '单价文件',
        'panel.sourceFallback': '未读到价格文件，正在使用内置默认单价',
        'panel.reloadHint': '改完保存，回到窗口即生效。',
        'panel.note': '按上方单价估算，不是账单金额。',
        'form.edit': '改单价',
        'form.title': '单价（每 100 万 tokens）',
        'form.model': '模型',
        'form.input': '未命中',
        'form.cacheRead': '缓存命中',
        'form.cacheWrite': '缓存写入',
        'form.output': '输出',
        'form.idle': '空闲',
        'form.peak': '高峰',
        'form.currency': '货币符号',
        'form.save': '保存',
        'form.cancel': '取消',
        'form.saving': '正在保存…',
        'form.saved': '已保存',
        'form.invalid': '每个单价都要是大于等于 0 的数字',
        'form.failed': '保存失败：{message}',
        'form.peakNote': '高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00；其余时段按空闲价。法定节假日未单独处理。',
        'remote.off': '自动调价：已关闭',
        'remote.pending': '自动调价：官方页 · 尚未同步',
        'remote.synced': '自动调价：官方页 · 上次同步 {time}',
        'remote.failed': '自动调价：上次失败 {message}',
        'remote.syncing': '自动调价：正在同步…',
        'remote.syncNow': '同步官方价',
      },
      en: {
        'pill.turn': 'Turn',
        'pill.turnFull': 'This turn',
        'pill.total': 'Total',
        'pill.totalFull': 'This session',
        'panel.title': 'Spend',
        'panel.close': 'Close',
        'panel.crashed': 'The panel failed to render. Refresh the page.',
        'panel.latest': 'Last request',
        'panel.turn': 'This turn',
        'panel.turnCount': '{count} calls',
        'panel.total': 'This session',
        'panel.model': 'Model',
        'panel.priceIdle': 'Idle price',
        'panel.pricePeak': 'Peak price',
        'panel.priceLine': '{input} / {cacheRead} / {cacheWrite} / {output}',
        'panel.priceHint': 'Per 1M tokens: input / cache read / cache write / output',
        'panel.bandBasis': 'Session totals use the current price band',
        'band.peak': 'Peak',
        'band.idle': 'Idle',
        'band.mixed': 'Idle + peak',
        'panel.uncached': 'Input, uncached',
        'panel.cacheRead': 'Cache read',
        'panel.cacheWrite': 'Cache write',
        'panel.output': 'Output',
        'panel.tokens': '{tokens} tokens',
        'panel.subtotal': 'Subtotal',
        'panel.source': 'Price file',
        'panel.sourceFallback': 'No readable price file; using the built-in defaults',
        'panel.reloadHint': 'Save the file and return to this window.',
        'panel.note': 'Estimated from the prices above; not a bill.',
        'form.edit': 'Edit prices',
        'form.title': 'Price per 1M tokens',
        'form.model': 'Model',
        'form.input': 'Input',
        'form.cacheRead': 'Cache read',
        'form.cacheWrite': 'Cache write',
        'form.output': 'Output',
        'form.idle': 'Idle',
        'form.peak': 'Peak',
        'form.currency': 'Symbol',
        'form.save': 'Save',
        'form.cancel': 'Cancel',
        'form.saving': 'Saving…',
        'form.saved': 'Saved',
        'form.invalid': 'Each price must be a number of zero or more',
        'form.failed': 'Save failed: {message}',
        'form.peakNote': 'Peak runs Monday to Friday, 9:00-12:00 and 14:00-18:00 Beijing time; every other hour is idle. Public holidays are not modelled.',
        'remote.off': 'Auto pricing: off',
        'remote.pending': 'Auto pricing: official page, not synced yet',
        'remote.synced': 'Auto pricing: official page, synced {time}',
        'remote.failed': 'Auto pricing: last attempt failed: {message}',
        'remote.syncing': 'Auto pricing: syncing…',
        'remote.syncNow': 'Sync official prices',
      },
    }

    const CSS = `
.smmm-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.smmm-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}
@media (hover:hover){.smmm-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.smmm-pill[aria-expanded='true']{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.smmm-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:2px}
.smmm-pill svg{width:14px;height:14px;flex:none}
.smmm-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.smmm-seg{white-space:nowrap}
.smmm-num{margin-left:4px;font-variant-numeric:tabular-nums}
.smmm-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
.smmm-panel{position:fixed;z-index:1100;box-sizing:border-box;padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;overflow-x:hidden;overflow-y:auto}
.smmm-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.smmm-titleRight{display:inline-flex;align-items:center;gap:8px;min-width:0}
.smmm-close{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:15px;line-height:1;cursor:pointer}
@media (hover:hover){.smmm-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.smmm-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}
.smmm-titleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}
.smmm-titleLabel svg{width:14px;height:14px;flex:none}
.smmm-titleValue{font-variant-numeric:tabular-nums}
.smmm-rule{margin-bottom:10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.smmm-section{display:flex;justify-content:space-between;gap:12px;margin:10px 0 6px;color:var(--dsw-alias-label-secondary);font-weight:500}
.smmm-sectionValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.smmm-tag{margin-left:6px;padding:0 5px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}
.smmm-details{display:grid;grid-template-columns:minmax(88px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}
.smmm-details dt,.smmm-details dd{min-width:0;margin:0}
.smmm-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.smmm-details .smmm-wide{overflow-wrap:anywhere}
.smmm-foot{margin-top:12px;color:var(--dsw-alias-label-tertiary)}
.smmm-footLine{overflow-wrap:anywhere}
.smmm-warn{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.smmm-btn{appearance:none;box-sizing:border-box;padding:3px 10px;border:1px solid var(--dsw-alias-border-l1,#d9dde3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.smmm-btn:hover{border-color:var(--dsw-alias-border-l2,#b9bfc8);color:var(--dsw-alias-label-primary)}
.smmm-btn:disabled{opacity:.55;cursor:default}
.smmm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:2px}
.smmm-btn-small{margin-top:10px;padding:2px 8px}
.smmm-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#2f6f64);color:#fff}
.smmm-form{margin-top:12px}
.smmm-formTitle{margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-weight:500}
.smmm-grid3{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:center;margin-top:10px}
.smmm-cellHead{color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center}
.smmm-field-top{margin-top:10px}
.smmm-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.smmm-fieldLabel{color:var(--dsw-alias-label-tertiary)}
.smmm-input{box-sizing:border-box;width:100%;min-width:0;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1,#d9dde3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.smmm-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}
select.smmm-input{appearance:auto;cursor:pointer}
.smmm-formNote{margin-top:8px;color:var(--dsw-alias-label-tertiary)}
.smmm-status{margin-top:8px;color:var(--dsw-alias-label-secondary)}
.smmm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
`

    /** One coin glyph for the pill and the panel heading. */
    function coinIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.35,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('circle', { cx: 8, cy: 8, r: 6.1 }),
        h('path', { d: 'M5.9 5.5 8 8.15l2.1-2.65' }),
        h('path', { d: 'M8 8.15v3' }),
        h('path', { d: 'M6.3 9.35h3.4M6.3 10.85h3.4' }),
      )
    }

    /** A finite non-negative number, or null for anything else a provider may report. */
    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    }

    function billedTokens(buckets) {
      return buckets.uncached + buckets.cacheRead + buckets.cacheWrite + buckets.output
    }

    /** The bands one turn's attempts were billed in, deduplicated. */
    function turnBands(pricing, turn, fallback) {
      const bands = new Set()
      for (const attempt of turnAttempts(turn)) {
        bands.add(typeof attempt.time === 'number' ? bandAt(pricing.peak, new Date(attempt.time)) : fallback)
      }
      return bands
    }

    /** The money one turn cost, pricing each attempt in its own band. */
    function turnCost(pricing, model, turn, fallback) {
      let total = 0
      for (const attempt of turnAttempts(turn)) {
        const band = typeof attempt.time === 'number' ? bandAt(pricing.peak, new Date(attempt.time)) : fallback
        total += costOf(attempt.buckets, resolvePrice(pricing, model, band))
      }
      return total
    }

    const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

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

    /** The wall clock of one instant in the configured price-band zone. */
    function zonedClock(date, timeZone) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone,
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(date)
        const found = {}
        for (const part of parts) found[part.type] = part.value
        const weekday = WEEKDAYS[found.weekday]
        const hours = Number(found.hour)
        const minutes = Number(found.minute)
        if (weekday === undefined || !Number.isFinite(hours) || !Number.isFinite(minutes)) return null
        return { weekday, minutes: hours * 60 + minutes }
      } catch {
        // An unusable time zone degrades to the idle band instead of breaking.
        return null
      }
    }

    /** Which price band one instant falls in: `'peak'` or `'idle'`. */
    function bandAt(peak, date) {
      if (peak === undefined || peak === null || peak.enabled === false) return 'idle'
      const clock = zonedClock(date, peak.timeZone ?? 'Asia/Shanghai')
      if (clock === null) return 'idle'
      if (!(peak.weekdays ?? []).includes(clock.weekday)) return 'idle'
      for (const window of peak.windows ?? []) {
        const start = clockMinutes(window?.start)
        const end = clockMinutes(window?.end)
        if (start === null || end === null) continue
        if (clock.minutes >= start && clock.minutes < end) return 'peak'
      }
      return 'idle'
    }

    /** One bucket map with the shipped fallbacks filled in. */
    function bucketsOfConfig(raw) {
      const out = {}
      if (raw === null || typeof raw !== 'object') return out
      for (const bucket of BUCKETS) {
        const value = count(raw[bucket])
        if (value !== null) out[bucket] = value
      }
      return out
    }

    /** A detached copy of a model table, so a caller can never mutate the shipped one. */
    function cloneModels(models) {
      const out = {}
      for (const [id, entry] of Object.entries(models ?? {})) {
        const copy = {}
        if (entry.flat !== undefined) copy.flat = { ...entry.flat }
        if (entry.idle !== undefined) copy.idle = { ...entry.idle }
        if (entry.peak !== undefined) copy.peak = { ...entry.peak }
        out[id] = copy
      }
      return out
    }

    /** Fold one price-file config into the shipped defaults. */
    function normalizePricing(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const currency = typeof source.currency === 'string' && source.currency !== ''
        ? source.currency
        : FALLBACK_PRICING.currency
      const perMillion = { ...FALLBACK_PRICING.perMillion, ...bucketsOfConfig(source.perMillion) }
      const peak = {
        ...FALLBACK_PRICING.peak,
        ...(source.peak !== null && typeof source.peak === 'object' ? source.peak : {}),
      }
      if (typeof peak.enabled !== 'boolean') peak.enabled = FALLBACK_PRICING.peak.enabled
      if (typeof peak.timeZone !== 'string' || peak.timeZone === '') peak.timeZone = FALLBACK_PRICING.peak.timeZone
      if (!Array.isArray(peak.weekdays) || !peak.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) {
        peak.weekdays = FALLBACK_PRICING.peak.weekdays
      }
      if (!Array.isArray(peak.windows) || peak.windows.some(window => clockMinutes(window?.start) === null || clockMinutes(window?.end) === null)) {
        peak.windows = FALLBACK_PRICING.peak.windows
      }
      const models = {}
      if (source.models !== null && typeof source.models === 'object') {
        for (const [modelId, patch] of Object.entries(source.models)) {
          if (patch === null || typeof patch !== 'object') continue
          const entry = {}
          const flat = bucketsOfConfig(patch)
          if (Object.keys(flat).length > 0) entry.flat = flat
          for (const band of ['idle', 'peak']) {
            const buckets = bucketsOfConfig(patch[band])
            if (Object.keys(buckets).length > 0) entry[band] = buckets
          }
          if (Object.keys(entry).length > 0) models[modelId] = entry
        }
      }
      return { currency, peak, perMillion, models: Object.keys(models).length > 0 ? models : cloneModels(FALLBACK_PRICING.models) }
    }

    /** The price entry one model id names, or undefined. */
    function modelEntry(models, model) {
      if (typeof model === 'string' && model !== '') {
        if (Object.prototype.hasOwnProperty.call(models, model)) return models[model]
        for (const key of Object.keys(models)) {
          if (key !== '*' && model.includes(key)) return models[key]
        }
      }
      return models['*']
    }

    /** Effective bucket prices for one model in one price band. */
    function resolvePrice(pricing, model, band) {
      const entry = modelEntry(pricing.models ?? {}, model) ?? {}
      const merged = { ...pricing.perMillion, ...(entry.flat ?? {}), ...(entry[band] ?? {}) }
      return {
        input: count(merged.input) ?? 0,
        cacheRead: count(merged.cacheRead) ?? 0,
        cacheWrite: count(merged.cacheWrite) ?? 0,
        output: count(merged.output) ?? 0,
      }
    }

    /** The bucket prices one model would use in a named band, ignoring the shipped fallbacks. */
    function bandBuckets(pricing, model, band) {
      const entry = modelEntry(pricing.models ?? {}, model) ?? {}
      return { ...pricing.perMillion, ...(entry.flat ?? {}), ...(entry[band] ?? {}) }
    }

    /** Estimated money for one bucket set under one price table. */
    function costOf(buckets, price) {
      return (
        buckets.uncached * price.input
        + buckets.cacheRead * price.cacheRead
        + buckets.cacheWrite * price.cacheWrite
        + buckets.output * price.output
      ) / 1_000_000
    }

    /** Money with enough decimals to keep two significant digits on tiny amounts. */
    function formatMoney(pricing, value) {
      const symbol = pricing.currency ?? ''
      if (!(value > 0)) return `${symbol}0.00`
      const exponent = Math.floor(Math.log10(value))
      const digits = Math.min(6, Math.max(2, 2 - exponent))
      return `${symbol}${value.toFixed(digits)}`
    }

    /** A rate as written in the price line. */
    function formatRate(value) {
      return Number.isFinite(value) ? String(value) : '—'
    }

    function formatTokens(value) {
      return Number.isFinite(value) ? Math.round(value).toLocaleString() : '0'
    }

    /** One form field parsed as a price, or null when it is not a usable amount. */
    function parseAmount(text) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return null
      const value = Number(trimmed)
      return Number.isFinite(value) && value >= 0 ? value : null
    }

    /** The one line shown under the form while a save is in flight or after it settles. */
    function statusMessage(t, status) {
      if (status === null) return ''
      if (status.kind === 'saving') return t('form.saving')
      if (status.kind === 'saved') return t('form.saved')
      return status.message
    }

    /** Persist one edited price table through the Host route. */
    function savePrices(payload) {
      return fetch(SAVE_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      }).then(async response => {
        let body = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (!response.ok || body === null || body.ok !== true) {
          const warnings = body !== null && Array.isArray(body.warnings) ? body.warnings : []
          throw new Error(warnings.length > 0 ? warnings.join('；') : `HTTP ${response.status}`)
        }
        return body
      })
    }

    /** Ask the Host to re-read the published price list now. */
    function syncPricesNow() {
      return fetch(SYNC_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
      }).then(async response => {
        let body = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (!response.ok || body === null || body.ok !== true) {
          const warnings = body !== null && Array.isArray(body.warnings) ? body.warnings : []
          throw new Error(warnings.length > 0 ? warnings.join('；') : `HTTP ${response.status}`)
        }
        return body
      })
    }

    const WITHOUT_PROJECTION = () => undefined

    const NO_ATTEMPTS = Object.freeze([])

    /** The `spendUsage` projection's newest-turn attempts, tolerating an older Host view. */
    function turnAttempts(turn) {
      return turn !== null && turn !== undefined && Array.isArray(turn.attempts) ? turn.attempts : NO_ATTEMPTS
    }

    const EMPTY_PRICE_STATE = Object.freeze({
      pricing: FALLBACK_PRICING,
      path: '',
      exists: false,
      warnings: Object.freeze([]),
      failure: '',
      remote: Object.freeze({}),
      sync: Object.freeze({}),
    })

    const plainObject = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})

    /** Load the Host-owned price file; re-runs on focus and on demand. */
    function usePriceFile() {
      const [state, setState] = useState(EMPTY_PRICE_STATE)
      const load = useCallback(() => {
        let ignore = false
        fetch(PRICE_ROUTE, { cache: 'no-store', credentials: 'same-origin' })
          .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then(payload => {
            if (ignore || payload === null || typeof payload !== 'object') return
            const config = plainObject(payload.config)
            setState({
              pricing: normalizePricing(payload.config),
              path: typeof payload.path === 'string' ? payload.path : '',
              exists: payload.exists === true,
              warnings: Array.isArray(payload.warnings) ? payload.warnings.filter(item => typeof item === 'string') : [],
              failure: '',
              remote: plainObject(config.remote),
              sync: plainObject(payload.sync),
            })
          })
          .catch(error => {
            if (ignore) return
            setState(previous => ({ ...previous, failure: error instanceof Error ? error.message : String(error) }))
          })
        return () => { ignore = true }
      }, [])
      useEffect(() => load(), [load])
      useEffect(() => {
        const onFocus = () => { load() }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [load])
      return { state, reload: load }
    }

    /** One `<dt>/<dd>` pair per bucket plus the subtotal, in provider order. */
    function bucketRows(t, pricing, buckets, cost) {
      const rows = [
        ['uncached', buckets.uncached, 'uncached'],
        ['cacheRead', buckets.cacheRead, 'cacheRead'],
        ['cacheWrite', buckets.cacheWrite, 'cacheWrite'],
        ['output', buckets.output, 'output'],
      ]
      const children = []
      for (const [field, tokens, label] of rows) {
        if (tokens === 0) continue
        children.push(h('dt', { key: `${field}.label` }, t(`panel.${label}`)))
        children.push(h('dd', { key: `${field}.value` }, t('panel.tokens', { tokens: formatTokens(tokens) })))
      }
      children.push(h('dt', { key: 'subtotal.label' }, t('panel.subtotal')))
      children.push(h('dd', { key: 'subtotal.value' }, formatMoney(pricing, cost)))
      return children
    }

    /** One header row: the section name, its chips, and its money. */
    function section(key, name, tags, cost) {
      const chips = (tags ?? []).filter(tag => typeof tag === 'string' && tag !== '')
      return h('div', { key, className: 'smmm-section' },
        h('span', { className: 'smmm-titleLabel' },
          name,
          chips.map((tag, index) => h('span', { key: `${key}.${index}`, className: 'smmm-tag' }, tag)),
        ),
        h('span', { className: 'smmm-sectionValue' }, cost),
      )
    }

    /** The price-file provenance and any diagnostics, shown under the breakdown. */
    function priceSource(t, state) {
      const lines = []
      if (state.path !== '') {
        lines.push(h('div', { key: 'path', className: 'smmm-footLine' }, `${t('panel.source')}：${state.path}`))
      }
      if (!state.exists || state.failure !== '') {
        lines.push(h('div', { key: 'fallback', className: 'smmm-footLine' }, t('panel.sourceFallback')))
      }
      lines.push(h('div', { key: 'hint', className: 'smmm-footLine' }, t('panel.reloadHint')))
      for (const [index, warning] of state.warnings.entries()) {
        lines.push(h('div', { key: `warn.${index}`, className: 'smmm-footLine smmm-warn' }, warning))
      }
      return lines
    }

    /**
     * Keeps a panel bug from blanking the whole dock entry: the host removes an
     * entry whose render throws, which would take the reading down with it.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('show-me-my-money: panel render failed', error)
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    /**
     * The click-open reading detail, portaled to the document body because the
     * docked composer is a containing block for fixed descendants.
     */
    function SpendPanel(props) {
      const {
        t, pricing, priceState, remote, sync, model, latestBuckets, totalBuckets,
        latestCost, totalCost, latestBand, currentBand, box, panelRef, onReload, onClose,
        turnBuckets, turnTotal, turnCount, turnBandLabel,
      } = props
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState(null)
      const [syncing, setSyncing] = useState(false)

      const priceLine = buckets => t('panel.priceLine', {
        input: formatRate(buckets.input),
        cacheRead: formatRate(buckets.cacheRead),
        cacheWrite: formatRate(buckets.cacheWrite),
        output: formatRate(buckets.output),
      })
      const body = []
      if (typeof model === 'string' && model !== '') {
        body.push(h('dt', { key: 'model.label' }, t('panel.model')))
        body.push(h('dd', { key: 'model.value', className: 'smmm-wide' }, model))
      }
      body.push(h('dt', { key: 'idle.label' }, t('panel.priceIdle')))
      body.push(h('dd', { key: 'idle.value', className: 'smmm-wide' }, priceLine(resolvePrice(pricing, model, 'idle'))))
      if (pricing.peak.enabled) {
        body.push(h('dt', { key: 'peak.label' }, t('panel.pricePeak')))
        body.push(h('dd', { key: 'peak.value', className: 'smmm-wide' }, priceLine(resolvePrice(pricing, model, 'peak'))))
      }

      /** A band id rendered through the locale, including the mixed-turn case. */
      const bandText = label => t(`band.${label === 'mixed' ? 'mixed' : label}`)

      const sections = []
      if (latestBuckets !== null) {
        sections.push(section('latest.title', t('panel.latest'), [bandText(latestBand)], formatMoney(pricing, latestCost)))
        sections.push(h('dl', { key: 'latest.buckets', className: 'smmm-details' },
          bucketRows(t, pricing, latestBuckets, latestCost)))
      }
      if (turnBuckets !== null) {
        const chips = [bandText(turnBandLabel)]
        if (turnCount > 1) chips.push(t('panel.turnCount', { count: turnCount }))
        sections.push(section('turn.title', t('panel.turn'), chips, formatMoney(pricing, turnTotal)))
        sections.push(h('dl', { key: 'turn.buckets', className: 'smmm-details' },
          bucketRows(t, pricing, turnBuckets, turnTotal)))
      }
      if (totalBuckets !== null) {
        sections.push(section('total.title', t('panel.total'), [bandText(currentBand)], formatMoney(pricing, totalCost)))
        sections.push(h('dl', { key: 'total.buckets', className: 'smmm-details' },
          bucketRows(t, pricing, totalBuckets, totalCost)))
      }

      /** Every model id the form may edit: the file's entries plus the session's own model. */
      const modelIds = () => {
        const ids = Object.keys(pricing.models).filter(id => id !== '*')
        if (typeof model === 'string' && model !== '' && model !== '*' && !ids.includes(model)) ids.unshift(model)
        if (Object.prototype.hasOwnProperty.call(pricing.models, '*')) ids.push('*')
        return ids.length > 0 ? ids : ['*']
      }

      /** Form state for one model: both bands as text, so a half-typed number survives. */
      const draftFor = modelId => {
        const entry = modelEntry(pricing.models, modelId) ?? {}
        const idle = { ...pricing.perMillion, ...(entry.flat ?? {}), ...(entry.idle ?? {}) }
        const peak = { ...idle, ...(entry.peak ?? {}) }
        const asText = buckets => ({
          input: String(buckets.input ?? 0),
          cacheRead: String(buckets.cacheRead ?? 0),
          cacheWrite: String(buckets.cacheWrite ?? 0),
          output: String(buckets.output ?? 0),
        })
        return {
          model: modelId,
          currency: pricing.currency,
          idle: asText(idle),
          peak: asText(peak),
        }
      }

      const beginEdit = () => {
        setDraft(draftFor(modelIds()[0]))
        setStatus(null)
      }

      const pickModel = modelId => {
        setDraft(draftFor(modelId))
        setStatus(null)
      }

      const editBand = (band, bucket, value) => {
        setDraft(current => (current === null
          ? current
          : { ...current, [band]: { ...current[band], [bucket]: value } }))
      }

      const editCurrency = value => {
        setDraft(current => (current === null ? current : { ...current, currency: value }))
      }

      const cancelEdit = () => {
        setDraft(null)
        setStatus(null)
      }

      const submit = () => {
        if (draft === null) return
        const idle = {}
        const peak = {}
        for (const bucket of BUCKETS) {
          const idleValue = parseAmount(draft.idle[bucket])
          const peakValue = parseAmount(draft.peak[bucket])
          if (idleValue === null || peakValue === null) {
            setStatus({ kind: 'error', message: t('form.invalid') })
            return
          }
          idle[bucket] = idleValue
          peak[bucket] = peakValue
        }
        const currency = draft.currency.trim() === '' ? pricing.currency : draft.currency.trim()
        const models = {}
        for (const [id, entry] of Object.entries(pricing.models)) {
          const copy = {}
          if (entry.flat !== undefined) copy.flat = entry.flat
          if (entry.idle !== undefined) copy.idle = entry.idle
          if (entry.peak !== undefined) copy.peak = entry.peak
          models[id] = copy
        }
        models[draft.model] = { idle, peak }
        setStatus({ kind: 'saving' })
        savePrices({ currency, peak: pricing.peak, remote, perMillion: pricing.perMillion, models })
          .then(() => {
            setDraft(null)
            setStatus({ kind: 'saved' })
            onReload()
          })
          .catch(error => {
            setStatus({
              kind: 'error',
              message: t('form.failed', { message: error instanceof Error ? error.message : String(error) }),
            })
          })
      }

      // The form only exists while a draft does: its fields read `draft`, so
      // building it on the read-only panel would throw on the very first click.
      let form = null
      if (draft !== null) {
        const rows = [
          h('span', { key: 'head.blank' }),
          h('span', { key: 'head.idle', className: 'smmm-cellHead' }, t('form.idle')),
          h('span', { key: 'head.peak', className: 'smmm-cellHead' }, t('form.peak')),
        ]
        for (const bucket of BUCKETS) {
          rows.push(h('span', { key: `${bucket}.label`, className: 'smmm-fieldLabel' }, t(`form.${bucket}`)))
          rows.push(h('input', {
            key: `${bucket}.idle`,
            type: 'text',
            inputMode: 'decimal',
            className: 'smmm-input',
            'aria-label': `${t(`form.${bucket}`)} ${t('form.idle')}`,
            value: draft.idle[bucket],
            onChange: event => editBand('idle', bucket, event.target.value),
          }))
          rows.push(h('input', {
            key: `${bucket}.peak`,
            type: 'text',
            inputMode: 'decimal',
            className: 'smmm-input',
            'aria-label': `${t(`form.${bucket}`)} ${t('form.peak')}`,
            value: draft.peak[bucket],
            onChange: event => editBand('peak', bucket, event.target.value),
          }))
        }

        form = h('div', { key: 'form', className: 'smmm-form' },
          h('div', { className: 'smmm-formTitle' }, t('form.title')),
          h('label', { className: 'smmm-field' },
            h('span', { className: 'smmm-fieldLabel' }, t('form.model')),
            h('select', {
              className: 'smmm-input',
              value: draft.model,
              onChange: event => pickModel(event.target.value),
            }, modelIds().map(id => h('option', { key: id, value: id }, id))),
          ),
          h('div', { className: 'smmm-grid3' }, rows),
          h('label', { className: 'smmm-field smmm-field-top' },
            h('span', { className: 'smmm-fieldLabel' }, t('form.currency')),
            h('input', {
              type: 'text',
              className: 'smmm-input',
              value: draft.currency,
              onChange: event => editCurrency(event.target.value),
            }),
          ),
          h('div', { className: 'smmm-formNote' }, t('form.peakNote')),
          status === null
            ? null
            : h('div', { className: `smmm-status${status.kind === 'error' ? ' smmm-warn' : ''}` }, statusMessage(t, status)),
          h('div', { className: 'smmm-actions' },
            h('button', { type: 'button', className: 'smmm-btn', onClick: cancelEdit }, t('form.cancel')),
            h('button', {
              type: 'button',
              className: 'smmm-btn smmm-btn-primary',
              disabled: status !== null && status.kind === 'saving',
              onClick: submit,
            }, t('form.save')),
          ),
        )
      }

      const remoteEnabled = remote.enabled === true

      /** The auto-pricing status line: source, last sync, or the failure that stopped it. */
      const remoteText = () => {
        if (!remoteEnabled) return t('remote.off')
        if (syncing || sync.running === true) return t('remote.syncing')
        if (typeof sync.lastError === 'string' && sync.lastError !== '') {
          return t('remote.failed', { message: sync.lastError })
        }
        if (typeof remote.lastSyncAt === 'string' && remote.lastSyncAt !== '') {
          const when = new Date(remote.lastSyncAt)
          return t('remote.synced', { time: Number.isNaN(when.getTime()) ? remote.lastSyncAt : when.toLocaleString() })
        }
        return t('remote.pending')
      }

      const startSync = () => {
        setSyncing(true)
        setStatus(null)
        syncPricesNow()
          .then(() => {
            setStatus({ kind: 'saved' })
            onReload()
          }, error => {
            setStatus({
              kind: 'error',
              message: t('form.failed', { message: error instanceof Error ? error.message : String(error) }),
            })
          })
          .then(() => { setSyncing(false) })
      }

      const foot = h('div', { key: 'foot', className: 'smmm-foot' },
        priceSource(t, priceState),
        h('div', { key: 'remote', className: 'smmm-footLine' }, remoteText()),
        status === null || status.kind === 'saving'
          ? null
          : h('div', { className: `smmm-footLine${status.kind === 'error' ? ' smmm-warn' : ''}` }, statusMessage(t, status)),
        h('div', { key: 'actions', className: 'smmm-actions' },
          remoteEnabled
            ? h('button', {
              key: 'sync',
              type: 'button',
              className: 'smmm-btn smmm-btn-small',
              disabled: syncing,
              onClick: startSync,
            }, t('remote.syncNow'))
            : null,
          h('button', { key: 'edit', type: 'button', className: 'smmm-btn smmm-btn-small', onClick: beginEdit }, t('form.edit')),
        ),
        h('div', { key: 'basis', className: 'smmm-footLine' }, t('panel.bandBasis')),
        h('div', { key: 'note', className: 'smmm-footLine' }, t('panel.priceHint'), ' · ', t('panel.note')),
      )

      return ReactDOM.createPortal(
        h('div', {
          ref: panelRef,
          className: 'smmm-panel',
          role: 'dialog',
          'aria-label': t('panel.title'),
          style: {
            left: `${box.left}px`,
            bottom: `${box.bottom}px`,
            width: `${box.width}px`,
            maxHeight: `${box.maxHeight}px`,
          },
        },
          h('div', { className: 'smmm-title' },
            h('span', { className: 'smmm-titleLabel' }, coinIcon(), t('panel.title')),
            h('span', { className: 'smmm-titleRight' },
              h('span', { className: 'smmm-titleValue' }, totalCost === null ? '' : formatMoney(pricing, totalCost)),
              h('button', {
                type: 'button',
                className: 'smmm-close',
                'aria-label': t('panel.close'),
                title: t('panel.close'),
                onClick: onClose,
              }, '×'),
            ),
          ),
          h('div', { className: 'smmm-rule', 'aria-hidden': true }),
          h('dl', { className: 'smmm-details' }, body),
          sections,
          draft === null ? foot : form,
        ),
        document.body,
      )
    }

    /**
     * The panel's open flag, kept outside the dock entry.
     *
     * The composer re-renders on focus changes, and a re-registration of the
     * dock slot tears this entry down and rebuilds it. Component state would
     * be lost at exactly the moment the reader starts clicking the panel, so
     * the flag lives here and a real unmount clears it shortly after.
     */
    const panelMemory = { open: false }

    /** The composer-dock control: this turn and the whole Session, side by side. */
    function SpendPill(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : WITHOUT_PROJECTION
      const usage = useProjection('tokenUsage')
      const selection = useProjection('modelSelection')
      // Session data arrives as a Host projection, already folded over the
      // whole durable log; this component only prices it.
      const spend = useProjection('spendUsage')
      const { state: priceState, reload } = usePriceFile()

      const [open, setOpenState] = useState(panelMemory.open)
      const [openCount, setOpenCount] = useState(0)
      const [box, setBox] = useState(null)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const openedAt = useRef(0)
      const forgetTimer = useRef(null)

      const setOpen = value => {
        panelMemory.open = value
        setOpenState(value)
      }
      const openPanel = () => {
        openedAt.current = Date.now()
        setOpenCount(count => count + 1)
        setOpen(true)
      }
      const closePanel = () => setOpen(false)

      // A remount within the grace period keeps the panel; a real unmount forgets it.
      useEffect(() => {
        if (forgetTimer.current !== null) {
          clearTimeout(forgetTimer.current)
          forgetTimer.current = null
        }
        return () => {
          forgetTimer.current = setTimeout(() => { panelMemory.open = false }, 600)
        }
      }, [])

      useEffect(() => {
        if (!open) return
        reload()
      }, [open, reload])

      const model = selection
        ? (selection.next ?? selection.lastUsed)?.model
        : undefined
      const pricing = priceState.pricing
      const readings = spend !== null && typeof spend === 'object' ? spend : null
      const latest = readings === null ? null : (readings.last ?? null)
      const turn = readings === null ? null : (readings.turn ?? null)
      const currentBand = bandAt(pricing.peak, new Date())
      const latestBand = latest !== null && typeof latest.time === 'number'
        ? bandAt(pricing.peak, new Date(latest.time))
        : currentBand

      const total = usage === undefined || usage === null
        ? null
        : {
          uncached: count(usage.uncachedInputTokens) ?? 0,
          cacheRead: count(usage.cacheReadTokens) ?? 0,
          cacheWrite: count(usage.cacheWriteTokens) ?? 0,
          output: count(usage.outputTokens) ?? 0,
        }
      const shownTotal = total !== null && billedTokens(total) > 0 ? total : null
      const latestBuckets = latest === null ? null : latest.buckets
      const latestCost = latestBuckets === null
        ? null
        : costOf(latestBuckets, resolvePrice(pricing, model, latestBand))
      const totalCost = shownTotal === null
        ? null
        : costOf(shownTotal, resolvePrice(pricing, model, currentBand))
      const turnBuckets = turn === null || turn === undefined ? null : (turn.buckets ?? null)
      const turnTotal = turn === null ? null : turnCost(pricing, model, turn, currentBand)
      const bands = turn === null ? [] : [...turnBands(pricing, turn, currentBand)]
      const turnBandLabel = bands.length > 1 ? 'mixed' : (bands[0] ?? currentBand)

      useEffect(() => {
        if (!open) return undefined
        const inside = (element, event) => {
          if (element === null) return false
          const path = typeof event.composedPath === 'function' ? event.composedPath() : []
          return path.includes(element) || element.contains(event.target)
        }
        const onKeyDown = event => {
          if (event.key === 'Escape') closePanel()
        }
        const onPointerDown = event => {
          // A click that lands during the opening gesture must never dismiss.
          if (Date.now() - openedAt.current < 300) return
          if (inside(panelRef.current, event) || inside(rootRef.current, event)) return
          closePanel()
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      useEffect(() => {
        if (!open) return
        const anchor = rootRef.current
        if (anchor === null) return
        const rect = anchor.getBoundingClientRect()
        const width = Math.min(320, Math.max(240, window.innerWidth - 24))
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
        const bottom = Math.max(12, window.innerHeight - rect.top + 8)
        const maxHeight = Math.max(120, window.innerHeight - bottom - 12)
        setBox({ left, bottom, width, maxHeight })
      }, [open])

      const segments = []
      if (turnTotal !== null) segments.push({ key: 'turn', word: t('pill.turn'), value: formatMoney(pricing, turnTotal) })
      if (totalCost !== null) segments.push({ key: 'total', word: t('pill.total'), value: formatMoney(pricing, totalCost) })
      if (segments.length === 0) return null

      const plainText = segments
        .map(segment => `${t(segment.key === 'turn' ? 'pill.turnFull' : 'pill.totalFull')} ${segment.value}`)
        .join(' · ')
      const children = []
      segments.forEach((segment, index) => {
        if (index > 0) children.push(h('span', { key: `${segment.key}.sep`, className: 'smmm-sep', 'aria-hidden': true }, '·'))
        children.push(h('span', { key: segment.key, className: 'smmm-seg' },
          segment.word,
          h('span', { className: 'smmm-num' }, segment.value),
        ))
      })

      return h('span', {
        ref: rootRef,
        className: 'smmm-anchor',
        'data-composer-stat': 'spend',
      },
        h('button', {
          type: 'button',
          className: 'smmm-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': plainText,
          title: plainText,
          onClick: () => openPanel(),
        },
          coinIcon(),
          h('span', { className: 'smmm-label' }, children),
        ),
        open && box !== null
          ? h(PanelBoundary, {
            key: `panel.${openCount}`,
            fallback: h('div', {
              className: 'smmm-panel',
              role: 'status',
              style: { left: `${box.left}px`, bottom: `${box.bottom}px`, width: `${box.width}px` },
            }, h('div', { className: 'smmm-footLine smmm-warn' }, t('panel.crashed'))),
          }, h(SpendPanel, {
            t, pricing, priceState, model,
            remote: priceState.remote, sync: priceState.sync,
            latestBuckets, totalBuckets: shownTotal, latestCost, totalCost,
            turnBuckets, turnTotal, turnCount: turn === null || turn === undefined ? 0 : (turn.count ?? turnAttempts(turn).length),
            latestBand, currentBand, turnBandLabel, box, panelRef, onReload: reload, onClose: closePanel,
          }))
          : null,
      )
    }

    /** Attach the plugin stylesheet; removing the returned disposer detaches it. */
    function installStyles() {
      const element = document.createElement('style')
      element.dataset.dshPlugin = NS
      element.textContent = CSS
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'show-me-my-money: styles')
        for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
          ctx.effect(() => ctx.locale.register(NS, locale, dictionary), `show-me-my-money: ${locale} dictionary`)
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'spend',
          order: 2,
          locale: NS,
        }, SpendPill))
      },
    }
  },
})
