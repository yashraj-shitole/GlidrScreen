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
    src/selftest.js     headless end-to-end test, plays the phone
    renderer/engine.*   hidden window that owns the RTCPeerConnection (Chromium encoder)
    renderer/ui.*       control panel (QR code, devices, stats, settings)
  android/
    screenview/         Android library, package com.yashraj.glidr.screen
      signal/           SignalCrypto, Pairing (+store), NtfySignaling
      net/              ScreenClient (session + reconnect + control API), WebRtcRuntime, Protocol
      input/            PointerMath (acceleration), VideoMapping (touch -> PC coords)
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
