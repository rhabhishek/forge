# Pending Work

The durable review-rubric improvements are complete. The lifecycle work below remains intentionally separate and is not included in that delivery.

## Project Memory

- Canonicalize equivalent SSH and HTTPS repository identities without persisting credentials, query strings, or fragments.
- Use collision-resistant namespaces and verify existing namespace ownership.
- Provide an explicit, dry-run-first migration command that preserves the source and never automatically merges populated memory directories.
- Complete race-safe project and global memory writes and no-follow reads.

## Safe Updates

Completed:

- Added an explicit, dry-run-first `update` command with versioned manifests and managed-content hashes.
- Preserved unrelated files and reconciled user edits by type (an inline local-changes section for block/line files; `.local` + `.diff` sidecars for structured files) instead of blocking on conflicts.
- Took a full backup of every managed file before writing it, recorded every touched resource in an append-only action log, and wrote the manifest last with rollback-from-backup on any write failure.
- Honored the effective process umask for newly created resources and manifests while preserving existing-file modes.

The updater is a cooperative single-user tool: don't run two updaters at once. Concurrent external edits during a run are best-effort captured via the backups and the action log; adversarial atomic-race hardening is intentionally out of scope.

## Backups And Restore

- Create a verified backup before every install, update, or forced restore.
- Support listing, verifying, pruning, and restoring backups.
- Restore files, modes, managed blocks, and manifests exactly to their pre-backup state.
- Remove resources that did not exist before the selected backup.
- Create a guard backup before overwriting changes made after the selected backup.
- Keep project memory, credentials, MCP configuration, and unrelated files outside install-restore scope.

## Hardening

- Strengthen publishable-content leak checks and macOS secret storage.
- Enforce private permissions for Forge memory.
- Complete adversarial filesystem-race review before shipping memory changes.