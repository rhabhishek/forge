# Tracker: GitHub Issues

- **Work item:** an issue in the contract's `repo`. **Change request:** a pull request.
- **State:** a label. The contract's `tracker.states` gives the label for each pod state. An issue carries exactly one pod state label; remove the old one when you add the new one.
- **High-risk marker:** the label `risk: high` on both the issue and the pull request.
- **Flags:** `needs-ux` and `needs-design` labels tell `ux` and `architect` an item in the `design` state is theirs.
- **Linking:** the pull request body says `Closes #<n>` for the issue it fully delivers, `Refs #<n>` for one it only advances.
- **Epics:** a milestone, when the project uses them. Give new issues the milestone of the work they belong to.
- **Handoff packet:** posted on the issue by the handoff command, in the same comment as its marker. **Results:** the run's report (`pod report`, which replaces its claim comment) on the issue, and the inline review on the pull request. Evidence too long for either goes in one comment on the issue, collapsed under `<details>`.
- **Markers:** `<!-- pod:... -->` comments are written only by the pod CLI. Never type one yourself.
- **Finding work:** list open issues by state label, oldest first. An item nobody is working on has no open pull request and no live claim.
- **Tools:** use the host's GitHub tools when present, otherwise the `gh` CLI.
- **Inline review on a pull request:** one review per pass, through the REST endpoint (GraphQL is not available in a cloud session):
  `gh api -X POST repos/<owner>/<repo>/pulls/<n>/reviews --input review.json`
  with `{"commit_id": "<head sha reviewed>", "event": "COMMENT", "body": "**<Role> verdict: <verdict>** <counts, gate>", "comments": [{"path": "<file>", "line": <line in the new file>, "side": "RIGHT", "body": "**[<role> · <severity>]** problem, why, required fix"}]}`.
  Before posting, list the open threads (`gh api repos/<owner>/<repo>/pulls/<n>/comments`) and leave out any finding your role already has open on the same line.
  The line must be part of the diff (`gh api repos/<owner>/<repo>/pulls/<n>/files` lists it); for a deleted line use `"side": "LEFT"`. Keep `event` as `COMMENT`. Reply to a finding with `gh api -X POST repos/<owner>/<repo>/pulls/<n>/comments/<comment id>/replies -f body=...`.
- **Never:** merge, close a pull request you did not open, edit labels' definitions, or change repository settings.
