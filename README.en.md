[Русский](README.md) | English

# Compose Visual Bridge

A local visual editor that lets a user select UI elements, make visual changes, and hand the approved intent back to an AI coding agent for transfer into source code. The first production target is Android Jetpack Compose; the protocol itself is not tied to Codex or Claude Code.

**Current version: 0.10.7.** The verified Compose import path links editable browser elements to Kotlin calls and real Android captures. Transfers are prepared in an isolated copy, guarded by source revisions, and validated by an Android build.

## Why it exists

AI coding agents are good at changing UI code, but describing visual adjustments in text is slow and ambiguous. Compose Visual Bridge adds a visual feedback loop:

1. The agent opens a project screen in the editor.
2. You select, move, resize, or edit elements visually.
3. The editor records an immutable handoff describing the intended changes.
4. The agent applies those changes to the real Compose source.
5. Before/after captures and source revisions are used to verify the result.

The editor does **not** silently rewrite application source. The user approves the baseline and explicitly hands the changes back to the agent.

## Highlights

- Import screens from Compose `@Preview` without requiring an emulator for the normal preview path.
- Real Android capture path for native verification and inspection.
- Source mapping from editable elements back to Kotlin calls.
- Text, Column, Row, Box, Card, Button, Spacer and Surface support in the verified browser importer.
- Tree editing, drag/resize, properties, Undo/Redo and before/after comparison.
- Immutable transfer snapshots with revision checks and conflict-safe result handling.
- Local-only server bound to localhost by default.
- Packaged integration for Codex and Claude Code.
- Automated Node integration tests plus browser/Playwright scenarios.

## Install from source

Requires Node.js 22+ for the full Compose import/capture workflow.

```sh
git clone https://github.com/arttvad9r/ComposeVisualBridge.git
cd ComposeVisualBridge
npm ci
npm start
```

Open `http://127.0.0.1:4173/`.

## Verification

```sh
npm test
npx playwright install chromium   # once
npm run test:browser
```

`npm test` packages the agent plugin and runs the model, protocol, source-map, Compose, native-session, live-session, preview and transfer-result suites. Detailed acceptance records live under [`docs/verification/`](docs/verification/).

## Documentation

- [Plugin usage](docs/plugin.md)
- [Compose preview import](docs/previews.md)
- [Native UI capture](docs/native-ui.md)
- [Live app adapter](docs/live-app.md)
- [Protocol](docs/protocol.md)
- [Architecture and development](docs/development.md)
- [Project specification](docs/specs/project.md)
- [Verification history](docs/verification/README.md)

## Status

Compose Visual Bridge is an active development tool, not a general-purpose visual IDE. Arbitrary custom Compose components and perfect theme reproduction still require agent-assisted verification. The project deliberately fails closed when it cannot map or validate a change safely.

## License

MIT. Third-party notices are documented in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
