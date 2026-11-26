# Runtime: Claude cloud tasks

Each role is its own scheduled task. A handoff fires the next role's task; the receiving role starts in a new session with the packet as its input.

- **To hand off:** run the pod handoff command. Only if it accepts the handoff does it print the task to fire and the exact text to send. Fire that task with the host's scheduling tool, passing the text unchanged. Never fire a role's task that the command did not print in this session, and never post a handoff marker yourself: the command already recorded it. If the command says there is no task for the role, move the item's state and stop; that role's heartbeat will pick it up. If it says `Already handed off`, fire nothing.
- **Limits:** counted on the tracker by the handoff command, because nothing on this machine survives the session. If the tracker cannot be reached, the handoff is refused.
- **Parallel work:** every fire is a new session, so two handoffs to the same role run side by side, and a scheduled heartbeat can overlap a fired run. `pod claim` (see the protocol's "One run per item") keeps two runs of one role off the same item.
- **Model:** set on each role's task from the contract's tiers. A session cannot change its own model.
- **Sessions are fresh:** nothing survives from an earlier run except what is on the work item, the change request, and in the repository. Write down anything the next session needs.
- **Status:** the status log on this machine does not persist between sessions. On the work item, the run's claim (start) and report (end) are its status: one comment, edited in place. Post no other status comments.
- **Pause:** any open work item in the tracker's `paused` state stops every handoff and every role start. Disabling the role tasks stops scheduled starts as well.
- **Tracker CLI:** in a cloud session the `gh` commands that rely on GraphQL (`gh issue list`, `gh label list`, `gh pr view`, and similar) are refused. Use the host's GitHub tools, or the REST form: `gh api repos/<owner>/<repo>/issues`, `.../labels`, `.../pulls`.
