# Runtime: Copilot CLI

Each role is a custom agent. A handoff starts the next role as a non-interactive Copilot CLI run with the packet as its prompt.

- **To hand off:** run the pod handoff command. It builds the launch command with the role's agent, the packet, no user prompts, and a deny rule for every forbidden action the contract can express as a tool pattern, then starts it. Add `--dry-run` to see the command without running it.
- **Where it runs:** the contract's `runtime.where`.
  - `local`: a background process on this machine. Each concurrent `engineer` must work in its own git worktree on its own branch; never share a working tree between two writers.
  - `actions`: a CI workflow per role, started by dispatch, by its heartbeat schedule, and by change-request events.
- **Model:** passed from the contract's tiers when one is set; otherwise the CLI's default.
- **Deny rules are the control, instructions are the backup.** If the handoff command warns that a `never` entry has no tool pattern, that entry is only enforced by this text. Treat it as forbidden all the same.
- **Status:** `local` keeps the status log on this machine. On `actions` the log does not persist, so also post a one-line status comment on the work item at start and end.
- **Limits:** on `actions` they are counted on the tracker by the handoff command, because a runner starts empty; if the tracker cannot be reached, the handoff is refused. On `local` they are counted from this machine's status log unless the contract sets `limits.ledger: tracker`.
- **Pause:** the pod `pause` command on this machine; on `actions`, any open work item in the tracker's `paused` state. Disabling the workflows stops scheduled starts as well.
