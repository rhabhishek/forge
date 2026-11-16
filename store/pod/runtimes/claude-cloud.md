# Runtime: Claude cloud tasks

Each role is its own scheduled task. A handoff fires the next role's task; the receiving role starts in a new session with the packet as its input.

- **To hand off:** run the pod handoff command. It prints the task to fire and the exact text to send. Fire that task with the host's scheduling tool, passing the text unchanged. If the command says there is no task for the role, move the item's state and stop; that role's heartbeat will pick it up.
- **Parallel work:** every fire is a new session, so two handoffs to the same role run side by side.
- **Model:** set on each role's task from the contract's tiers. A session cannot change its own model.
- **Sessions are fresh:** nothing survives from an earlier run except what is on the work item, the change request, and in the repository. Write down anything the next session needs.
- **Status:** the status log on this machine does not persist between sessions. Also post a one-line status comment on the work item at start and end, so `em` and the board can reconstruct who is doing what.
- **Pause:** the tracker's `paused` state on any open work item, or disabled role tasks, mean stop.
- **Tracker CLI:** in a cloud session the `gh` commands that rely on GraphQL (`gh issue list`, `gh label list`, `gh pr view`, and similar) are refused. Use the host's GitHub tools, or the REST form: `gh api repos/<owner>/<repo>/issues`, `.../labels`, `.../pulls`.
