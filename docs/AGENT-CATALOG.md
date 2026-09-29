# Agent Catalog

Forge is a **router + specialists** swarm for engineering work. `forge` classifies answer, advice, or delivery before setup. Only delivery enters the implement -> review -> refine loop; the default delivery path uses `forge`, `implementer`, and `reviewer`. Read-only advice can request independent analysis without starting implementation or requiring product test gates.

## Agents

| Agent | What it does | When it runs |
| ----- | ------------ | ------------ |
| `forge` | Orchestrator: complexity gate, acceptance contract, bounded loop, integration, Cortex round-trip | always (entry point) |
| `implementer` | Minimal clean performant change; runs the green gate; applies refine findings | authorized delivery |
| `reviewer` | Independent critique of delivery evidence or an explicitly scoped advice artifact | delivery except trivial; useful advice review |
| `architect` | Design/interfaces/data-model/trade-offs (and best-of-N) | complex / greenfield / cross-cutting only |
| `sme-security` | Deep security review of the diff | task flagged: auth/secrets/crypto/untrusted input |
| `sme-performance` | Deep performance review of the diff | task flagged: hot path / large data / latency |
| `sme-domain` | Deep business-rule/invariant review | task flagged: intricate domain logic |
| `sme-a11y` | Deep accessibility review | task flagged: UI / markup |

## Model selection (one default, uniform inheritance)

Forge pins a model on at most **one** agent - the top-level `forge` orchestrator - and lets everyone else inherit:

- **`forge` (top-level):** on **Cursor**, rendered with `model: claude-4.6-sonnet-medium-thinking` (Cursor's Sonnet 4.6 thinking variant). This is just the **default**; the user can pick any other model for the chat and the swarm follows. On **Copilot**, no `model:` is emitted at all - the slug is a Cursor identifier - so forge runs on the user's selected chat model.
- **All specialists** (`implementer`, `reviewer`, `architect`, `sme-*`): rendered with **no `model:` field** on every host, so each inherits its parent's model (the Cursor/Copilot default is "same model as the parent agent"). Since their parent is `forge`, the whole swarm runs on forge's model. The heavy implementation work is done by the sub-agents, so this puts them on the user-chosen model rather than a pinned lighter default.

This replaces the earlier per-agent "model tier" idea (light/standard/reasoning): tiering is gone; there is one default pin plus inheritance.

**1M context = Max Mode (not a slug).** Sonnet 4.6 has a 200k default context window that is **expandable to 1M only by enabling Max Mode** in the chat - there is no separate `claude-4.6-sonnet-1m` identifier (unlike the older Claude 4 Sonnet). So the "1M context window" default cannot be encoded in frontmatter; turn on **Max Mode** in the top-level `forge` chat to get the 1M window. Bonus: Max Mode is also what makes sub-agent model inheritance reliable on Cursor (without it, legacy request-based plans fall back to Composer for subagents). Non-thinking alternative: `claude-4.6-sonnet-medium`.

## The loop

```
gate -> contract -> implement -> green gate -> review -> (refine -> review)* -> deliver
```

- Bound: standard = 1 review cycle, complex = up to 3. Trivial = single implementer pass, no review.
- Each cycle must reduce open blocker/major findings (anti-oscillation); at the bound without approval, Forge stops cleanly and surfaces residual findings.

## Operating modes

- **Ship mode (default):** the single-task loop above; stop at a reviewed diff, never auto-commit.
- **Super mode:** keyword-activated ("super mode" / "build out the whole app"). `forge` plans first (architect + a milestone **todo backlog**), then wraps the ship-mode spine in an outer milestone loop - **define -> design -> build -> test -> document -> review -> commit** per milestone - until the app-level contract is green or the user interrupts. Each reviewer-approved milestone is auto-committed to a dedicated **local branch** (`forge/<slug>`), never pushed. Guards: trivial tasks downgrade to ship mode; clean-tree git pre-flight; a stuck milestone stops and escalates (no infinite loop); runs are resumable from the backlog. Must run **top-level** to spawn the swarm (nested degrades to a serial, self-reviewed role-internal loop).

## Severity taxonomy (gates the loop)

`blocker` and `major` must be fixed and cause another cycle. `minor` and `nit` are logged and surfaced at the end, never looped on. See the `code-review-rubric` skill.

## Relationship to Cortex

Cortex is the role-OS ("runs your role"); Forge is code delivery ("builds your code"). The handoff is one-way: `cortex` routes implementation work to `forge` and folds Forge's structured result into status/sprint comms. `forge` never calls back into `cortex`.

The shared task packet carries Intent, Goal, Anchor, Constraints / non-goals, Acceptance evidence, and Allowed effects. It transfers context and restrictions, not an implementation strategy or additional authority. Use top-level Forge; preserve user-selected models and distinguish independent review from self-review or advice. See [WORKFLOW-DISCIPLINE.md](WORKFLOW-DISCIPLINE.md).

## Capabilities (mapped per tool at install)

Agents declare neutral capabilities (`read-file`, `write-file`, `run-terminal`, `web-fetch`). The installer maps these to each tool's concrete tool names. `run-terminal` is required for the green gate and for graphify-based discovery.
