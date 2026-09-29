---
name: prod-monitor
description: "Analyze prod monitoring snapshots produced by a local prod-monitor collector. Use when the user asks to 'analyze prod', 'check the monitor', 'what's the latest prod alert', 'is prod healthy', wants a root-cause read on recent prod errors, or wants a Teams/Slack-ready incident summary drafted. Reads the compact pre-digested snapshot (cheap) instead of re-querying raw logs."
---

# Prod Monitor - Analyzer

A local collector (e.g. `~/.copilot/monitoring`) samples your app's prod logs
on a schedule (cron/launchd) and writes compact, pre-digested state. This
skill is the on-demand analysis half: read the small digest, reason about it,
and draft comms. **Do NOT re-query GCP for a routine "how's prod" - read the
digest first.** Only escalate to a live `gcloud` query (via the `gcp-logging`
skill) when the user wants depth the digest can't give (full stack traces,
specific request/order IDs, longer windows).

This skill assumes you (or your team) already run a collector that writes the
state files below. Adjust the base path and app-specific terms (error codes,
signals) to match your own setup.

## State files to read (small - cheap tokens)

| File | What it holds |
|------|---------------|
| `~/.copilot/monitoring/state/latest.json` | Most recent digest: total, per-code counts, signals, affected entities, samples |
| `~/.copilot/monitoring/state/alert.json` | Details of the most recent anomaly (if any) |
| `~/.copilot/monitoring/state/anomalies.log` | Rolling history of flagged anomalies |
| `~/.copilot/monitoring/state/rolling.log` | One line per run - trend at a glance |
| `~/.copilot/monitoring/state/daily-latest.md` | Newest **daily rollup** (previous UTC day) - read for a daily/"yesterday" view |
| `~/.copilot/monitoring/state/daily/<date>.json` | Per-day rollup digests: per-window peak/mean, top codes, anomaly windows |
| `~/.copilot/monitoring/state/daily-escalation.md` | On anomaly: paste-ready live-investigation brief for the morning deep pass |
| `~/.copilot/monitoring/snapshots/*.json` | Per-run historical digests (for trend comparison) |

## Routine analysis flow

1. Read `state/latest.json` and the last ~20 lines of `state/rolling.log`.
2. Report health: total errors this window, top codes, key signals for your
   app, affected-entity count.
3. Compare to the rolling trend - is this window normal, rising, or spiking?
4. If `alert.json` is recent, explain each anomaly and give a likely root cause.
5. Group related codes (they're usually one root cause at different layers).

## Daily view (previous day)

When the user asks for a **daily** summary or "yesterday", read
`state/daily-latest.md` (or `state/daily/<date>.json`) instead of
`latest.json`. A deterministic rollup, written once a day by the collector's
daily job, aggregates that UTC day's snapshots into **per-window** peak/mean
(overlap-free), top codes, anomaly windows, and new codes. Coverage <100%
means the collector wasn't running for parts of the day (laptop asleep / feed
down) - say so, and treat the summed total as approximate if windows overlap.

## On anomaly: escalate to live analysis

The daily job is deterministic and **only detects** anomalies - it never calls
an LLM. When the rollup flags `escalate: true` (or `latest.json` / `alert.json`
shows an anomaly), the deep pass is done here, by you:

1. Read the ready-made brief at `state/daily-escalation.md` - it lists the
   focus windows and a paste-ready, day-scoped query.
2. **Pull the data yourself** via the `gcp-logging` skill - real stack traces
   and messages for each anomaly window, not just the one redacted sample per
   code.
3. Cluster related codes by root cause; separate human vs bot traffic if your
   app is crawled, and report raw **and** human-only counts; tally real
   affected entities; widen the window if a spike straddles midnight UTC.
4. Deliver a root-cause read + a redacted Teams/Slack draft.

## Known code map (fill in for your app)

Keep a short table here mapping your app's own error/signal codes to what
they mean and who owns them, e.g.:

- `<CODE_A>` - short description - owning team/area
- `<CODE_B>` - short description - owning team/area
- `<INFRA_SIGNAL>` - infra, not app: route to platform/infra, not your team

## Drafting a Teams/Slack message (when asked)

Keep it incident-channel appropriate: severity read, the headline number, the
1-2 root-cause clusters, who should look, and the query to reproduce. Example:

> **Prod - last 35m:** 47 errors (baseline ~30). Cluster: `<CODE_A>` ×26 +
> `<CODE_B>` ×15 on the checkout flow - likely one upstream API issue.
> Separately `<INFRA_SIGNAL>` ×10 (infra issue, not app). Affected entities:
> a handful of sample IDs. Repro: `gcloud logging read … <CODE_B>`.

Always present the draft as text for the user to post - do not attempt to
post to Teams/Slack yourself.

## Deeper investigation (escalate to live query)

When the user wants full traces or a specific entity/window, use the
`gcp-logging` skill's command template against the prod bucket (see that
skill for the project/bucket/view flags).

## Filtering bot traffic (human-only counts)

If your app is public-facing, crawlers (search/social bots, scripted clients)
may hit stateful URLs that need valid session/state, inflating error counts.
When judging **real user impact**, separate humans from bots if the
User-Agent is available in your logs (filter by text match).

Caveats: UA is spoofable (catches *declared* bots only); some error entries
may carry no UA (lower bound); app logs typically have no client IP - if
you're fronted by a CDN/WAF, real bot mitigation and IP-rate analysis lives
there instead. Verify whether a CDN/WAF bot-mitigation layer is actually
configured and whether its edge logs are accessible before relying on them.
`=~` regex filters are slow on long windows - keep the range short. When
reporting a spike, state both the raw total and the human-only total so bot
noise doesn't overstate user impact.

Link your own team's runbook/wiki page for the full bot-filtering query here.

## Managing the collector

- Status:    `~/.copilot/monitoring/install.sh status`
- Run now:   `~/.copilot/monitoring/bin/collect.sh`
- Daily now: `~/.copilot/monitoring/install.sh daily [YYYY-MM-DD]`
- Install:   `~/.copilot/monitoring/install.sh install`
- Uninstall: `~/.copilot/monitoring/install.sh uninstall`

## Rules

- Read-only on GCP. Never modify GCP resources.
- Prefer the pre-digested snapshot over live queries to keep token usage low.
- Redact/aggregate: sensitive IDs (cart/order/guest IDs) should already be
  redacted in digests - keep it that way in any drafted comms unless the user
  asks for specifics.
