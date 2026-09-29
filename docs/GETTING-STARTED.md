# Getting Started with Forge

Forge installs a small swarm of code-delivery agents into your AI tool. Adopt it in a few minutes.

## 1. Prerequisites

- Node >= 18.
- An agent-capable tool: GitHub Copilot (VS Code/CLI/IntelliJ), Cursor, or OpenCode.
- Optional but recommended: the [graphify](https://github.com/safishamsi/graphify) skill for low-token code discovery.

## 2. Install

From the repo root:

```bash
node bin/forge.mjs install cursor          # preview (dry run)
node bin/forge.mjs install cursor --apply  # write files
```

Replace `cursor` with `copilot`, `opencode`, or `all`. Omitting the tool selects `all`. Files are written under the tool's home (e.g. `~/.cursor/`). Existing files are backed up once as `*.forge-bak`, and an install manifest (`.forge-manifest.json`) records exactly what was written so uninstall can undo it precisely. Shared files that you may also own (e.g. OpenCode's global `AGENTS.md`) are not overwritten - Forge adds a clearly marked managed block and leaves the rest of the file alone.

The manifest uses schema v2. It stores only the product/tool identity, generation and timestamps, relative managed paths, ownership mode, and SHA-256 content projections. It never stores file contents or secrets. Managed shared files hash only Forge's marked block, so edits outside that block remain yours. Copilot's host-managed `tools:` lines are likewise preserved across install and update.

### Guided wizard: credentials + MCP servers

Once files are written, `install --apply` offers a one-time interactive wizard (in a TTY) to wire up the integrations Forge's agents use: GitHub (official MCP, PAT), Jira (Atlassian Rovo MCP, OAuth), Confluence (community MCP, API token), and Figma (remote MCP, OAuth). Answer `y`/`n` per integration; anything you skip is simply not configured. It:

- Stores credentials securely per OS (macOS Keychain, Windows DPAPI, or chmod-600 env files on Linux) and wires them into your shell profile as a managed block.
- Provisions the selected MCP servers into VS Code's user `mcp.json` and `~/.copilot/mcp-config.json`, tagging each entry `_source: forge` so later runs update/remove only what Forge itself added - a server you or Cortex already configured is left untouched and reported as skipped, never duplicated or overwritten.

Non-interactive sessions (CI, piped input) skip the wizard automatically and print a hint; re-run `node bin/forge.mjs install --apply` in an interactive terminal anytime to open it again (e.g. to add an integration later or rotate a token).

### Safe updates

Preview an update before applying it:

```bash
node bin/forge.mjs update cursor
node bin/forge.mjs update cursor --apply
```

Planning reports every managed resource as `create`, `update`, `unchanged`, `reconciled-append`, `reconciled-sidecar`, `remove`, `stale-kept`, or `absent`. Forge reconciles only current desired paths plus paths in the prior valid manifest; it never sweeps a tool directory, so unrelated user prompts, skills, knowledge bases, agents, and rules survive.

A local edit never blocks the apply. Before writing any managed file Forge copies it into `<base>/.forge-backups/<timestamp>/` (exact bytes and mode) and appends every touched resource to `<base>/.forge-update-log.jsonl`. Your edits are reconciled, not discarded: block/line files (agents, prompts, rules, managed blocks) gain one delimited local-changes section holding your non-installer additions; structured files (JSON/YAML/frontmatter/settings) get a `.local` copy and a `.diff` beside a clean live file. Stale resources you never touched are removed cleanly, edited stale resources are kept as a `.local` sidecar, and an unverifiable v1 resource is preserved rather than deleted. The manifest is written last, so any write failure rolls back from the just-made backups and leaves the prior manifest authoritative. `--force` is accepted for compatibility but is a no-op.

The updater is a **cooperative single-user tool**, not an adversarial atomic-race system: don't run two updaters at once. Concurrent external edits during a run are best-effort captured via the backups and the action log.

Verify:

```bash
node bin/forge.mjs doctor
```

> **VS Code Copilot users - one required setting.** Forge's specialists are hidden from the agent picker and are reached only as subagents, which VS Code allows only when the (experimental) setting **`chat.customAgentInSubagent.enabled`** is on. Without it, Forge cannot spawn `implementer`/`reviewer`/SMEs and every run degrades to a self-reviewed single pass. `doctor` warns when it can see the setting is off. The GitHub toolset likewise needs the GitHub MCP server (`io.github.github/github-mcp-server`) configured in `~/.copilot/mcp.json`; without it those tools are simply unavailable.

## 3. Use it

- **Run the loop:** invoke the `ship` command/prompt on a task (e.g. "implement PROJ-123" or paste a spec). Forge gates the task, writes an acceptance contract, implements, runs the green gate, reviews, and refines.
- **Shepherd a PR:** invoke `babysit` with a PR URL/number (or on the PR's branch). Forge fixes CI failures and review comments, rebases with `--force-with-lease`, and resolves threads - it never merges; re-invoke to resume while checks are pending.
- **Talk to the orchestrator:** ask the `forge` agent directly for any implementation/refactor/bug-fix work.
- **Capture lessons:** run `remember-eng`, or directly `node bin/forge.mjs remember "<lesson>" --tag perf` - leak-checked and deduped.

> **Invoke Forge at the top level (important).** Forge's whole value is its multi-agent loop (implementer + reviewer + lazy SMEs), and an agent can only spawn subagents when it is itself the **primary/top-level agent**. So start Forge directly - select/run the `forge` agent (or the `ship` command) as the main agent for the turn. **Do not** ask another agent (e.g. Cortex, or a generic chat) to "use Forge" by wrapping it in a nested Task subagent: a nested subagent generally can't fan out, and Forge will fall back to a single, self-reviewed pass.
>
> This is a host/platform behavior Forge can't fully control from its prompt. What it *can* do is **degrade honestly**: when it detects it is nested, it prints a `NOTICE:` line, runs the loop role-internally, and labels its review as *self-performed, not independent* - so you always know whether you got the full swarm or a degraded run. If you see that notice, re-invoke Forge as the top-level agent to get real independent review and parallel fan-out.

## 3a. Model (default + 1M context)

On **Cursor**, Forge pins a default model on **only** the top-level `forge` orchestrator: `claude-4.6-sonnet-medium-thinking` (Cursor's Sonnet 4.6, thinking variant). The specialists it spawns (`implementer`, `reviewer`, `architect`, `sme-*`) declare **no** model and **inherit forge's**, so by default the whole swarm runs on Sonnet 4.6. On **Copilot**, no model is pinned at all - that slug is a Cursor identifier Copilot would not recognize - so `forge` simply runs on whatever chat model you select and the specialists inherit it.

- **You stay in control.** The pin is only a default. Pick any model for the `forge` chat and every sub-agent follows it - "the user chooses, the swarm inherits".
- **1M context window = Max Mode.** Sonnet 4.6 starts at a 200k window and only expands to **1M when you enable Max Mode** in the chat; there is no separate "1M" model id to pin. Turn on **Max Mode** in the top-level `forge` chat to get the 1M window. On Cursor, Max Mode is also what makes sub-agent model inheritance reliable (without it, legacy request-based plans route sub-agents to Composer instead of inheriting).
- Non-thinking alternative: set the chat model to `claude-4.6-sonnet-medium`.

## 4. Where Forge keeps state (your repo stays clean)

Forge writes **nothing** into the repo it edits. All state lives in a canonical store outside any repo, namespaced per project:

```bash
node bin/forge.mjs mem path    # show the memory dir for the current repo
node bin/forge.mjs mem show    # print stored engineering lessons
```

Under `~/.forge/memory/projects/<ns>/`:

- `work-ticket.md` - the live task + acceptance contract + diff/verification/findings.
- `engineering-lessons.md`, `conventions.md`, `toolchain.md` - durable project knowledge fed into runs/reviews.
- `checklists/`, `runs/<date>-<slug>.md`, `ledger.jsonl` - templates, per-run audit log, and metrics.
- `graph/` - graphify output for the project.

Cross-project/personal lessons live in `~/.forge/memory/_global/`. The store is yours and is never committed into your working repo; export/sync is explicit and opt-in.

Forge **never auto-commits or pushes** - it stops at a reviewed diff and a structured result for you to commit.

## 5. With Cortex

If you also run [Cortex](../../cortex), it will hand code work to Forge automatically and fold Forge's result into status/sprint updates. The handoff is one-way.

## 6. Uninstall

```bash
node bin/forge.mjs uninstall cursor --apply
```

Uninstall uses the install manifest (so it removes exactly what was installed, even if the store has since changed), restores any `*.forge-bak` backups the installer took, strips Forge's managed block from shared files like OpenCode's `AGENTS.md` (leaving your own content untouched), and prunes the directories it emptied.
