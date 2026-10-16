# Security policy

Compose Visual Bridge sits between source code, a local browser editor, AI coding agents, and optional Android devices. Security reports that cross those boundaries are treated as high priority.

## Supported version

Security fixes are made on the current `main` branch and the latest published release.

## Reporting a vulnerability

Do not publish exploit details, credentials, private project paths, or device identifiers in a public issue. If GitHub offers **Report a vulnerability** for this repository, use that private channel. Otherwise contact the repository owner through GitHub first and request a private channel without including sensitive details.

Useful reports include a minimal reproduction, affected version/commit, expected boundary, and the least sensitive logs needed to reproduce the issue.

## Security boundaries

Particularly relevant issues include:

- escaping the localhost-only server boundary;
- reading or modifying files outside the selected project/session;
- bypassing source revision/conflict checks;
- command or path injection through project metadata;
- exposing local `data/`, tokens, captures, or device information;
- applying editor changes to source without the explicit handoff flow.
