# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-11-22

First public release.

### Added

- A spend reading in `conversation.composer.dock`, beside the built-in session
  statistics: **this turn** and **whole session**, in one line.
- A click-open panel with a breakdown for **the most recent request**, **this
  turn** and **the whole session**: model route, tokens per bucket, subtotal,
  and the price band each figure was priced in.
- Idle/peak pricing. Peak is DeepSeek's published rule — Beijing time, Monday to
  Friday, 09:00-12:00 and 14:00-18:00 — and each reading is priced the way its
  own data allows: a request uses its own timestamp, a turn sums its attempts
  each in its own band, and the session total uses the band in effect when you
  look. A turn that crossed the boundary is labelled `idle + peak`.
- A price file at `~/.dsh/show-me-my-money.json` (`$DSH_HOME` when set), holding
  the currency symbol, the peak rule, a fallback table, and per-model idle/peak
  prices with `*` as the catch-all.
- Automatic pricing: the Host re-reads DeepSeek's published price page every six
  hours (floor 15 minutes, configurable), once per activation when stale, and on
  the panel's **Sync official prices** button. A refresh replaces only the model
  table and keeps your currency and peak rule; a failed fetch or parse leaves the
  file untouched and reports the reason in the panel.
- An in-panel editor: pick a model, edit its idle and peak columns, save. It
  writes the same file an agent or a text editor would.
- Two local routes so the panel and agents share one source of truth:
  `GET /plugins/show-me-my-money/prices` and
  `POST /plugins/show-me-my-money/prices/save` (plus `/sync`).
- A Host projection, `spendUsage`, that folds committed `assistant/message`
  events over the whole durable log. The Client only applies prices, so paging,
  compaction and the loaded-history cut cannot move the figures.
- English and Chinese strings; English and Chinese plugin metadata with a
  feature image.

### Notes

- Every figure is an estimate: provider-reported tokens times the prices in the
  file, not an invoice. Chinese public holidays and the non-token fees on the
  price page (Search, Fetch, OCR, speech) are not modelled.
- Tested against DeepSeek Harness `0.2.2-rc.5` (`@deepseek-ai/dsh`).
