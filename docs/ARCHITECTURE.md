# Architecture

```
GlidrScreen/
  host/                 Windows tray app (Electron 44): capture, WebRTC, input injection
    src/main.js         tray, windows, IPC, settings
    src/host.js         session state machine (HostCore): signaling <-> engine <-> input
    src/signaling.js    ntfy rendezvous client (sealed messages, auto-reconnect)
    src/crypto.js       pairing key -> topic + AES-GCM frames
    src/input.js        SendInput via koffi (mouse, wheel, keys, Unicode text)
    src/displays.js     monitor list (physical px), thumbnails, desktopCapturer source ids
    src/store.js        settings + pairing slots (settings.json in %APPDATA%)
    src/updates.js      update check against the GitHub releases (notify + link only)
    src/selftest.js     headless end-to-end test, plays the phone
    renderer/engine.*   hidden window that owns the RTCPeerConnection (Chromium encoder)
    renderer/ui.*       control panel (QR code, devices, stats, settings)
  android/
    screenview/         Android library, package com.yashraj.glidr.screen
      signal/           SignalCrypto, Pairing (+store, optional m=/b= link params), WakeOnLan, NtfySignaling
      lock/             App lock: PinLock (PBKDF2), LockPolicy (delay, wait after wrong tries), AppLockSession
      net/              ScreenClient (session + reconnect + control API), WebRtcRuntime, Protocol
      input/            PointerMath (acceleration), VideoMapping (touch -> PC coords)
      update/           GitHub release check, off unless the host app passes an UpdateSource
      ui/               GlidrScreenApp (entry), HomeScreen, ViewerScreen, Trackpad, RemoteVideo, Sheets
    app/                thin standalone app: MainActivity + deep link `glidr://screen`
  docs/                 this file, PROTOCOL.md
```

## Decisions

**No media server.** Video flows phone <-> PC over WebRTC, found through STUN. There is no SFU, no TURN and no
relay of ours. The one shared dependency is a *rendezvous* for the three offer/answer messages; it only sees
AES-GCM sealed blobs, is replaceable (any ntfy server, default ntfy.sh) and is not on the media path. A fully
serverless rendezvous would mean typing SDP blobs by hand on every connection, which is not usable from "anywhere".

**Why WebRTC.** DTLS-SRTP encryption, NAT traversal, congestion control, jitter buffer and hardware codecs on both
ends are already solved; reimplementing them over raw UDP would be less reliable. Chromium (Electron) gives
hardware H.264 encode on Intel/NVIDIA/AMD through Media Foundation; Android decodes through MediaCodec.

**Why Electron on the PC.** Per-monitor capture plus an encoder and a full WebRTC stack in one supported runtime.
Input injection is the only native part and uses `SendInput` through koffi (prebuilt, no compiler needed).

**The PC offers.** It owns the video track and the data channel, so the phone is a pure receiver and codec
negotiation is decided by the PC's preference list.

**Non-trickle ICE.** Candidates are gathered before sending. Three rendezvous messages per connection, and
ntfy's anonymous rate limits are never an issue.

**One display at a time on the wire.** Encoding every monitor continuously would multiply CPU and bandwidth.
Instead the phone shows all displays as a layout map with 1.5 s previews (JPEG over the data channel) and
switches the video track with `replaceTrack` (no renegotiation, about a second).

**Library plus app.** `:screenview` exposes one composable, `GlidrScreenApp`, and has no dependency on the app
module, so the Glidr app can host it as a container later (see below).

## Layout system

The phone UI uses the same spacing and radius tokens as the Glidr app (`Space` and `Radius` in
`screenview/.../ui/Theme.kt`), so the two look the same if `:screenview` is embedded in Glidr. Sources: Material
Design layout metrics (components on an 8 dp grid, type and icons on a 4 dp sub-grid, 16 dp side margins, 48 dp touch
targets with at least 8 dp between neighbours) and Apple's HIG (44 pt minimum hit area).

* Screen gutter 16. Items inside a group 8. A label above its control, or stacked components (trackpad, mouse buttons,
  tool row) 12. Sections 24.
* Card padding 16 in lists, 20 in dialogs and sheets; pill text padding 20.
* Touch targets 48. Key chips and segmented options are 44 (the HIG minimum) so a row of them fits a phone.
* Radii come from one scale: 12 key, 16 chip, 20 control, 24 card, 28 sheet, 32 pad. Nested shapes follow
  `inner = outer - inset` (segmented control 16 - 4 = 12).
* Bottom sheets stop at 560 dp wide so landscape and tablets keep a readable column.
* Use `Space.*` and `Radius.*`, not dp literals. The only literals left are sizes, hairlines (1, 2) and drawn graphics.

## Embedding in the Glidr app (future scope)

1. Add `include(":screenview")` pointing at this module (git submodule, composite build `includeBuild`, or publish an AAR).
2. Open it from a Glidr screen: `GlidrScreenApp(onClose = { navigateBack() })`. Pass `pendingLink` for deep links.
3. Theme: it reads the same Midnight/Paper tokens; to follow Glidr's accent call `ScreenTheme(light, accent)` yourself
   and use the `ScreenViewModel`-free pieces (`ViewerScreen`, `HomeScreen`) directly.
4. Manifest merge adds `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE`, `MODIFY_AUDIO_SETTINGS`.
   Glidr's own README says the phone app has no internet permission today; embedding changes that, so update the
   privacy statement and the Play data-safety form.
5. Fonts are namespaced (`gs_geist`), so there is no resource clash with Glidr's `geist`.
6. One `PeerConnectionFactory` per process is created lazily by `WebRtcRuntime`; it does not interfere with
   `BluetoothHidDevice`, so the trackpad could later route to Bluetooth when the PC is nearby and WebRTC otherwise.

## Limits worth knowing

* **Symmetric NAT on both ends** (some carrier-grade NATs) cannot be traversed without a relay. IPv6 usually works
  anyway. The app reports this explicitly ("Could not open a direct connection"). Add a TURN server only if you accept
  relayed media.
* The PC app cannot capture or control the lock screen, UAC prompts or elevated windows (Windows isolates them).
  Run the host as administrator to control elevated windows.
* 24 fps is the cap, not a guarantee: under heavy congestion resolution drops first (`maintain-framerate`).

## App lock

A stolen, unlocked phone would otherwise have full access to every paired PC, so the app can be locked with a PIN
(Home screen footer, "App lock"). Code: `screenview/.../lock/` plus `ui/LockScreen.kt` and `ui/LockSettingsSheet.kt`.

* **PIN.** 4 to 8 digits; all-the-same-digit and straight runs (1234, 4321) are refused. It is never stored: a random
  16-byte salt and PBKDF2WithHmacSHA256 (120 000 rounds, 256 bit), base64, in the private preferences file
  `glidr_screen_lock`. Backup is off (`allowBackup=false`) and `data_extraction_rules.xml` excludes every shared
  preference from cloud backup and device transfer, so the file never leaves the phone. Comparison is constant-time and
  fails closed: a damaged stored value never verifies and never throws.
* **When it locks.** At every app start, and when the app has been in the background (Activity stopped, tracked with a
  lifecycle observer in `GlidrScreenApp`) for at least the chosen delay: Immediately, 1 minute (default) or 5 minutes,
  on a monotonic clock. The unlocked state is in memory only. It never interrupts an app that stays in the foreground,
  even in a live session. The QR scanner is a screen of its own: coming back from it within 3 minutes does not lock.
* **Wrong tries.** After 5 in a row the next try is refused for 30 s, then 1 min, 5 min and 15 min (the cap). Tries made
  in the settings sheet count too. The counter and the deadline are persisted, so killing the app does not reset them;
  a clock set back cannot stretch the wait, a clock set forward can shorten it (no trusted time source offline).
* **What the lock covers.** While locked, `LockScreen` is the only thing composed: no PC list, no video, no sheets, no
  pairing prompt, no hardware-keyboard forwarding, and nothing for a screen reader to find behind it. `pair` and
  `connect` refuse while locked, the update check waits, and a `glidr://` pairing link stays pending and is handled after
  unlock. Files shared to the app wait in the queue as before; nothing is read until a PC is connected.
* **Live session in the background.** The session is not ended when the app is left, and there is no foreground service,
  so it continues only as long as Android keeps the process and network running. Coming back after the delay shows the
  lock screen and the session resumes after unlock if it is still alive.
* **Forgotten PIN.** There is no reset and no recovery. Clearing the app's data removes the lock and all pairings.

