# Contributing

Contributions that make Compose Visual Bridge safer, easier to verify, or easier to use with real Compose projects are welcome.

## Development setup

Requirements: Node.js 22+ for the full Compose import/capture path.

```bash
npm ci
npm start
```

The local server binds to localhost by default. Do not change that default in a contribution without a clear security rationale.

## Before opening a pull request

Run the checks relevant to your change:

```bash
npm test
npm run test:browser
git diff --check
```

Browser tests require Chromium installed through Playwright (`npx playwright install chromium`). Documentation-only changes do not need the browser suite.

## Safety invariants

Changes must preserve the core handoff model:

- the browser editor must not silently rewrite application source;
- source transfer uses an isolated project copy and revision checks;
- ambiguous mappings and stale captures fail closed;
- user data under `data/` stays local and out of Git;
- native/device operations remain scoped to the explicitly selected project and device.

If a change intentionally alters one of these boundaries, document the rationale and add regression coverage.

## Documentation

Keep `README.md` focused on the public English overview. Update `README.ru.md` when user-facing behavior changes materially, and add verification evidence under `docs/verification/` for changes that claim a new supported workflow.
