---
name: android-emu
description: Use whenever Android work needs an emulator, ADB, APK installation, instrumentation tests, screenshots, UI interaction, or device-specific verification on this machine. Shared AVDs must be leased with android-emu; never use an unleased emulator or the owner's physical phone.
---

# Shared Android emulator workflow

`android-emu` is the authority for emulator lifecycle and ownership on this machine.

## Fixed emulator fleet

This machine has exactly four AVDs, and agents must work only on them:

| AVD | Purpose |
|---|---|
| `oneplus-13s-1` | phone |
| `oneplus-13s-2` | phone |
| `oneplus-15` | phone |
| `oneplus-pad3` | tablet |

- Never create, clone, copy, rename, or delete AVDs (`avdmanager create avd`, `android avd create`, Android Studio Device Manager, copying `~/.android/avd/*.avd`, etc.), not even "temporarily" or for a different API level, screen size, or low-end profile.
- Never install new system images just to make another AVD.
- If none of the four fits the task (for example, it needs a different API level or a low-end device), or all of them are busy, stop device work and tell the user. Do not work around it with a new emulator.
- `android-emu claim` refuses AVDs outside the fleet. If `android-emu status` prints a warning about an extra AVD, do not use it; report it to the user.

## Acquire

1. Run `android-emu status`.
2. Run `android-emu claim [AVD...]` for a suitable free AVD. With no names it chooses a free phone (`oneplus-13s-1`, `oneplus-13s-2`, `oneplus-15`). Use `oneplus-pad3` for tablet coverage.
   Run it directly (or with your tool's own background mode). Never detach it with `( … &)`, `nohup` or `setsid`: the lease could not find its owner and `claim` will refuse.
3. Capture the printed `ANDROID_SERIAL=emulator-NNNN`.
4. Pass that serial explicitly to every device command; shell environment does not reliably persist between tool calls.

```bash
adb -s emulator-NNNN shell ...
ANDROID_SERIAL=emulator-NNNN ./gradlew :app:connectedDebugAndroidTest
android ... --device=emulator-NNNN
```

## Rules

- Never create new AVDs; use only the four fleet AVDs above.
- Never launch an AVD directly with `emulator @...` or `android emulator`; use `android-emu claim`.
- Never use a `busy` or `orphan` emulator shown by `android-emu status`.
- Never install, test, run ADB commands, or otherwise modify the owner's physical Android phone, even if `adb devices` shows it.
- If no suitable AVD is free, RAM is insufficient, or a required clean snapshot is missing, stop device work and tell the user. Do not bypass the lease system.
- `--force`, `claim --cold`, and `save-clean` may bypass ownership or change the clean baseline. Use them only when the user explicitly asks.

## Release

Always release the lease when device work ends, including after failures:

```bash
android-emu release
```

Do not keep an idle emulator leased for later. The next claim boots from the clean snapshot.
