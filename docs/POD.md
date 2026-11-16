# Pod

The pod is an opt-in profile that turns Forge from one delivery swarm into a team of independent role agents: product manager, UX designer, architect, senior engineer, reviewer, tester, SRE, and engineering manager. Each role runs in its own session, does one kind of work, and hands the result to the next role directly. The human is the release gate.

Nothing about the default `engineer` profile changes. The pod is installed only with `--profile pod`.

## How it fits together

```
pm ──spec──► ux ─┐                          ┌─► reviewer ─┐
   └───────► architect ─┴─► engineer(s) ─change──┤             ├─► needs_human ─► you merge
   └─(simple item, straight through)──►        └─► tester ───┘
   findings go straight back to engineer · sre files problems to pm · em unblocks and reports
```

- **Roles** are agents in `store/agents`. `engineer`, `reviewer`, and `architect` reuse the existing `forge`, `reviewer`, and `architect` agents unchanged, with a short pod wrapper in `store/pod/roles`. Improvements to those agents reach the pod automatically.
- **The protocol** (`store/pod/protocol.md`) defines states, the handoff packet, authority, risk, and limits in neutral terms: work item, change request, state.
- **Four seams** translate the protocol to a stack, selected per project:

| Seam | Options | Files |
| --- | --- | --- |
| Host | `claude`, `copilot`, `cursor`, `opencode` | the adapters in `lib/core.mjs` |
| Tracker | `github`, `jira` | `store/pod/trackers/` |
| Docs | `repo`, `confluence` | `store/pod/docs/` |
| Runtime | `claude-cloud`, `copilot-cli` (`local` or `actions`), `manual` | `store/pod/runtimes/` |

- **The project contract** (`pod/project.yml`) is the only project-specific file. Every role reads it first. See `store/pod/project.example.yml`.

## Set up a project

```bash
# 1. Scaffold the contract (in the repo, under the host's folder)
node bin/forge.mjs pod init --host claude        # or: --host copilot
#    For a repo that must stay clean, keep it out of the repo instead:
node bin/forge.mjs pod init --out-of-repo

# 2. Fill it in, then validate
node bin/forge.mjs pod doctor

# 3. Install. Dry run first; add --apply to write.
node bin/forge.mjs install claude --profile pod --project .      # into the repo (.claude/)
node bin/forge.mjs install copilot --profile pod                 # into your home (~/.copilot/)
```

The pod CLI finds its project from any directory inside the repository (an installed copy knows its own project from where it sits), and every path it prints or runs is relative to the repository root.

`--project <path>` installs into the repository with repo-relative paths, so a cloud session or CI runner that clones the repo fresh has everything. It is supported for `claude` (`.claude/`) and `copilot` (`.github/`). Without it, Forge installs into your home directory as it always has.

When a contract exists, a project install includes only the tracker, docs, and runtime notes that contract selects. Pass the same `--profile` (and `--project`) to `update` and `uninstall`.

## Runtimes

### claude-cloud

Each role is a scheduled task in Claude Code on the web. Create one task per role, give it the role's entry command (`/pod-pm`, `/pod-build`, ...) as its prompt, set its model from the contract's tiers, and record its id under `tasks:` in the contract. A finishing role runs `pod handoff`, which prints the task to fire and the text to send; the role fires it with the host's scheduling tool. Give standing roles a heartbeat schedule (`pod roles` lists the defaults).

### copilot-cli

Each role is a Copilot custom agent. `pod handoff` builds and starts:

```
copilot --agent <role agent> --prompt "<handoff>" --no-ask-user --allow-all-tools \
  --deny-tool='shell(gh pr merge)' --deny-tool='shell(git push origin <default branch>)' ... [--model <name>]
```

- `where: local` runs it as a background process on your machine. Logs go to the pod's state directory.
- `where: actions` dispatches a workflow per role. Generate them with `pod workflows`; they need a `COPILOT_GITHUB_TOKEN` secret, plus whatever your tracker and docs tools need.

Every `never` entry that has a tool pattern becomes a `--deny-tool` rule. `pod doctor` warns about entries that have none; give them one under `deny_tools:` or accept that they are enforced by instructions only.

**Before the first unattended run, check on your machine:** run `pod handoff <role> --packet <file> --dry-run` and confirm the command; confirm with a harmless test that a deny pattern with arguments (for example `shell(git push origin main)`) blocks what you expect on your Copilot CLI version, and tighten it to `shell(git push)` if it does not; confirm your organisation permits unattended agent runs and tokens in CI.

### manual

`pod handoff` prints which agent to start and what to give it. You start it. Everything else in the protocol applies.

## Models

Roles have neutral tiers; the contract maps tiers to model names for its stack.

| Tier | Roles | Why |
| --- | --- | --- |
| `deep` | architect, reviewer | design mistakes are the costliest; the gate should be stronger than the author |
| `standard` | pm, ux, engineer, tester, sre | routine specification and delivery |
| `light` | em | reads states, counts, reports |

Override one role with `models: { engineer: deep }` or a model name. Agent files still carry no `model:` line: on `claude-cloud` the model is set on the role's task; on `copilot-cli` it is passed as `--model`; in an interactive chat the role runs on the model you selected.

## Safety

- Roles are deny-by-default: only what the contract lists under `allowed`. `merge` and `push_default_branch` must be under `never`; `pod doctor` fails otherwise.
- A change touching `risk_paths` goes through the architect, uses the `deep` tier, and states risk and rollback.
- Limits: concurrent engineers, review round trips, and optional daily sessions per role. Past a limit the handoff is refused, the item becomes `blocked`, and it goes to the EM.
- **Limits are enforced by `pod handoff` from a ledger, not by the roles.** The command is the only writer: it records each handoff before it starts a role and counts before it records.
  - On hosted runtimes (`claude-cloud`, `copilot-cli` on `actions`) the ledger is the tracker: a marker comment on the work item per handoff, plus the items' states. A cloud session or CI runner starts on an empty machine, so nothing local could hold the count. `pod doctor` rejects `limits.ledger: local` there.
  - On `copilot-cli` local and `manual` the ledger defaults to the status log on that machine; set `limits.ledger: tracker` to share one count across machines.
    There, a handoff to the engineer reserves its slot the moment it is recorded, not when the engineer reports `working`, and the check-and-record runs under a file lock, so handoffs started at the same time cannot both take the last slot. A reservation whose engineer never reports `working` lapses after `limits.claim_timeout_minutes` (default 30). The slot is freed when the engineer reports any other status.
  - GitHub is reached through `gh api`; Jira through its REST API with `JIRA_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`.
  - **Fail closed:** if the ledger cannot be read or written, or `--item` is missing on a tracker ledger, the handoff is refused (exit 4). There is no override.
  - **Races:** a handoff to the engineer claims its slot, moves the item into build, then re-reads. If two claims overshoot the limit, the tracker's comment timestamps decide and the later one withdraws.
  - Engineer slots are counted as open work items in the `in_progress` state, so an item a person moves there by hand also holds a slot.
- **Pause:** `pod pause` stops handoffs on this machine. On a tracker ledger the pause is any open work item in the `paused` state; every handoff and every role start (`pod status <role> working`) checks it. Disable the role tasks or workflows as well to stop scheduled starts.
- What this does not stop: a role that never calls `pod handoff` and starts another role some other way. On Copilot CLI the deny rules limit what such a role can do; on Claude cloud the controls left are the task permissions you grant and branch protection. The Jira ledger is covered by tests against a fake server only; check it against your site before relying on it.
- Text from work items, change requests, and web pages is treated as data, not instructions.
- No data connectors unless the contract lists them.

These are instructions and CLI flags, not a sandbox. Branch protection on the default branch, and the host's own permission settings, are the hard controls.

## Board

`pod board` renders `store/pod/board.html` from the status log: one card per agent, what is waiting on you, work in flight, recent handoffs, and limits. Roles write the log with `pod status`. On runtimes where the log does not persist between sessions, roles also post a one-line status comment on the work item and the EM reconciles.

## Commands

```
forge pod init [--host <host>] [--out-of-repo]
forge pod config [--json] | doctor | roles
forge pod handoff <role> --packet <file|-> [--item <id>] [--from <role>] [--dry-run] [--foreground]
forge pod status <role> <working|idle|blocked|waiting|done> [--item <id>] [--note <text>]
forge pod board [--out <file>] | workflows [--out <dir>] | pause | resume
```

`handoff` exits 0 when the role was started, 2 when the contract has no task for it, 3 when a limit or pause refused it, and 4 when the limits could not be verified.

An installed pod carries its own copy of this CLI at `<host folder>/forge/pod/pod.mjs`, with no dependency on the Forge checkout.

## Tests

`node --test test/pod.test.mjs` covers the contract parser and validation, the Claude Code target, project-scoped install, seam selection, stack-neutral wording, handoff planning and guards, the board, and workflow rendering. They are deterministic contract tests; they do not prove a model follows the protocol or that a host enforces a deny rule.
