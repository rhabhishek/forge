# Tracker: Jira

- **Work item:** a Jira issue in the contract's `tracker.project_key`. **Change request:** a pull request in the contract's `repo`.
- **State:** the issue's workflow status. The contract's `tracker.states` gives the status name for each pod state. Move the issue with a workflow transition; if the transition you need does not exist, park the item as `needs_human` and say which transition is missing.
- **High-risk marker:** the label `risk-high` on the issue, and a risk line at the top of the pull request.
- **Flags:** the labels `needs-ux` and `needs-design` tell `ux` and `architect` an item in the `design` state is theirs.
- **Linking:** put the issue key in the branch name and the pull request title, so the tracker links them.
- **Epics:** set the parent epic on new issues when the work belongs to one.
- **Handoff packet and results:** a comment on the issue, or on the pull request once one exists. Put a one-line pointer on the issue when the detail is on the pull request.
- **Finding work:** search by project and status, oldest first. An item nobody is working on has no open pull request and no recent status comment.
- **Tools:** use the host's Atlassian tools.
- **Findings:** a Jira issue has no lines to anchor to, so findings on a change are posted inline on the pull request in the code host (see that host's note or tool), and the issue gets one comment that links to the review and gives the verdict and counts.
- **Never:** change workflows, fields, permissions, or sprint scope, and never resolve an issue yourself; the human closes it after merging.
- **Run claims:** `pod claim` and `pod report` write `[pod:claim ...]` and `[pod:report ...]` comments. The report edits the run's claim comment in place, and a run that loses a claim race deletes its own claim, so each run leaves one comment.
