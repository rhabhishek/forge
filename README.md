# Forge

A Cortex-adjacent **staff-engineer code-delivery swarm**. Where Cortex *runs your role*, Forge *builds your code* - via a bounded **implement -> review -> refine** loop instead of a single pass from the plain model.

> Cortex thinks, Forge builds. The two are siblings: Cortex may hand code work to Forge; Forge never calls back into Cortex.

## Intent before setup

Forge distinguishes **answer**, **advice**, and **delivery** before tools or memory setup. Questions and analysis stay read-only by default, including audit and graph state. An explicitly requested saved plan permits only that artifact, not implementation. Code delivery retains the acceptance contract, green gate, and independent review; `/ship` is a thin task-packet entry point, not another workflow definition.

Handoffs preserve the goal, source anchor, constraints, acceptance evidence, and allowed effects. Recovery responds to a lack of new evidence, not tool/message counts; long, productive work stays intact. External coaching tools provide optional recommendations, never product gates or runtime dependencies. See [docs/WORKFLOW-DISCIPLINE.md](docs/WORKFLOW-DISCIPLINE.md) for the contract and validation cases.

## Why

A single-pass model rationalizes its own output. Forge adds an adversarial, evidence-backed review step and only iterates on what matters:

- **`forge`** (orchestrator) classifies the task, writes an acceptance-checklist contract (business rules + edge cases), and runs the loop.
- **`implementer`** writes the minimal, clean, performant change and runs a **green gate** (tests + lint + typecheck + build, including the existing suite) before review.
- **`reviewer`** is a fresh-eyes critic that scores the diff against the rubric + contract and returns a severity-tagged verdict. Only `blocker`/`major` findings cause another refine cycle.

## Lean core + lazy escalation

The default **delivery** path is `forge -> implementer -> reviewer`. Heavier roles spawn only when the task warrants:

- **`architect`** - complex/greenfield/cross-cutting design.
- **`sme-security` / `sme-performance` / `sme-domain` / `sme-a11y`** - deep single-dimension review, escalated from the reviewer's default inline lenses only when flagged.

## Token & speed discipline

- Prefer a useful existing **graphify** graph for relationship queries; use scoped source/test reads for local work. Generate a graph only when authorized and worthwhile.
- Bounded, early-exit loop; severity taxonomy stops over-iteration; diff-scoped review.
- One model for the whole swarm: a default pinned only on the top-level `forge` agent (Cursor render); every specialist inherits the parent's model.
- Parallel where independent (SME review panel, best-of-N, partitioned impl in worktrees); sequential spine.

## Compounding memory (your repo stays clean)

Authorized persistent state - work-ticket, lessons, conventions, toolchain, run logs, and the project graph - lives in `~/.forge/memory/`, namespaced per project, never the working repository. Answer/advice does not bootstrap or write memory. Delivery with audit persistence prohibited keeps its contract and evidence in the conversation without waiving verification. Explicitly captured lessons remain leak-checked, deduped, and capped; recurring findings can become rubric checks or regression tests.

```bash
node bin/forge.mjs mem path                       # memory dir for this repo
node bin/forge.mjs remember "<lesson>" --tag perf # record (leak-checked)
```

## Install

```bash
node bin/forge.mjs install cursor          # dry run
node bin/forge.mjs install cursor --apply  # write files
node bin/forge.mjs update cursor           # preview a safe reconcile
node bin/forge.mjs update cursor --apply   # back up, write fresh, preserve your edits
node bin/forge.mjs doctor                  # verify
```

Supported tools: `copilot`, `cursor`, `opencode`, or `all`. Omitting the tool selects `all` consistently for install, update, and uninstall. Update is dry-run by default and considers only current desired paths plus paths owned by the Forge manifest. Unrelated paths survive. `install --apply` also offers a one-time interactive wizard to store credentials and provision the MCP servers Forge's agents use (GitHub, Jira, Confluence, Figma) - it never overwrites a server you or Cortex already configured, and non-interactive sessions skip it automatically. See [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

Updates are backup-first and edit-preserving. Before writing any managed file, Forge copies it into `<base>/.forge-backups/<timestamp>/` (exact bytes and mode) and records every touched resource in an append-only `<base>/.forge-update-log.jsonl`. Your edits are reconciled, not discarded: block/line files (agents, prompts, rules, managed blocks) gain one delimited local-changes section holding your non-installer additions; structured files (JSON/YAML/frontmatter/settings) get a `.local` copy and a `.diff` beside a clean live file. The manifest is written last, and any write failure restores from the just-made backups and leaves the prior manifest in place.

The updater is a **cooperative single-user tool**, not an adversarial atomic-race system: don't run two updaters at once. Concurrent external edits during a run are best-effort captured via the backups and the action log.

## Delivery modes: ship (default) and super

- **Ship mode (default)** - one task, the bounded loop, stop at a reviewed diff, never auto-commit.
- The detailed super-mode recipe is loaded only when selected; ordinary answers, advice, and ship tasks do not load it.
- **Super mode** - say "super mode" / "build out the whole app". Forge plans first (architect + a milestone **todo backlog**), then runs a recursive **define -> design -> build -> test -> document -> review -> commit** loop per milestone until the app-level contract is green or you interrupt. Each reviewer-approved milestone is **auto-committed to a dedicated local branch** (`forge/<slug>`) - never pushed. Trivial tasks downgrade back to ship mode; a stuck milestone stops and escalates instead of looping forever; runs are resumable from the milestone backlog. Run it **top-level** (enable Cursor's Max Mode for model inheritance) so it can spawn the swarm.

## Use

In your tool, run the `ship` command/prompt on a task, or just talk to the `forge` agent (say "super mode" for the recursive build-out). Capture lessons with `remember-eng`. Run `babysit` on an open PR to drive it to mergeable (CI + review threads, rebase with `--force-with-lease`) - it never merges.
