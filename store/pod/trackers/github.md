# Tracker: GitHub Issues

- **Work item:** an issue in the contract's `repo`. **Change request:** a pull request.
- **State:** a label. The contract's `tracker.states` gives the label for each pod state. An issue carries exactly one pod state label; remove the old one when you add the new one.
- **High-risk marker:** the label `risk: high` on both the issue and the pull request.
- **Flags:** `needs-ux` and `needs-design` labels tell `ux` and `architect` an item in the `design` state is theirs.
- **Linking:** the pull request body says `Closes #<n>` for the issue it fully delivers, `Refs #<n>` for one it only advances.
- **Epics:** a milestone, when the project uses them. Give new issues the milestone of the work they belong to.
- **Handoff packet and results:** a comment on the issue, or on the pull request once one exists.
- **Finding work:** list open issues by state label, oldest first. An item nobody is working on has no open pull request and no recent status comment.
- **Tools:** use the host's GitHub tools when present, otherwise the `gh` CLI.
- **Never:** merge, close a pull request you did not open, edit labels' definitions, or change repository settings.
