# Feature ideas

Brainstormed on 2026-11-25 from four lenses: input and control UX, streaming and data transfer, connectivity and
security, and the PC app and the wider Glidr ecosystem. The ideas come from reading the code, so feasibility notes are
unverified. Nothing here is built or committed to.

Effort: S = under a day, M = a few days, L = a week or more.

## Tier 1: do next (high daily value, small to medium effort)

1. **Keep the PC awake while sharing, and recover after sleep (S).** `powerSaveBlocker` or `SetThreadExecutionState`
   holds the PC awake; a `powerMonitor` resume event restarts signaling (`Signaling.reconnect()`). Default to AC power
   only. Targets the most common "waiting for the PC" cause.
2. **Cursor-follow zoom (M).** The host sends `{"t":"cur","x","y"}` at about 30 Hz; the phone eases pan to keep the
   pointer in the middle third (`VideoViewState`, `RemoteVideo.kt`). Needs a dead zone so it does not fight manual pan.
3. **Custom shortcut deck and gesture bindings (S, M with gestures).** User-defined combos stored in
   `ViewerPrefsStore`, edited in the keyboard sheet, optionally bound to swipes. Uses the existing `combo` message, no
   host change.
4. **Two-way clipboard (S-M).** `clip` messages both ways, opt-in per direction, 256 KB cap, a "Clipboard sent" toast.
   Android 10+ only allows reads while the app is in the foreground, so add a manual "Send clipboard" button.
5. **System audio (M).** Windows loopback capture as a second Opus transceiver, a host toggle and a phone mute. The
   extra m-line grows the offer: re-check the 3900-character frame limit in PROTOCOL.md.
6. **Full-width landscape layout (M).** Video full-bleed, controls as a floating overlay pad and a collapsible tool
   edge. Replaces the fixed 304 dp panel.
7. **Adaptive fps and data-saver mode (S).** `fps` (15/24/30/60) and `saver` in the `quality` message; the phone asks
   for saver on low battery or a metered network.
8. **"PC last seen" presence (M).** The host posts a sealed heartbeat (cached by ntfy); the phone polls it before
   connecting and says "PC went to sleep 12 min ago" instead of timing out. A crashed PC only shows a growing age.
9. **Hardware keyboard and mouse passthrough (M).** Map Android `KeyEvent`s to the existing `key` messages and handle
   hardware mouse pointer events. Android swallows some system combos (Alt-Tab, Win).
10. **Installer with silent auto-update (M).** Per-user installer, SHA-256 checked download from the release, "Restart
    to update". Unsigned builds still trip SmartScreen, so pair it with code signing.

## Tier 2: worthwhile next

11. **File transfer and an Android "Send to PC" share target (M).** A second data channel with backpressure, sanitised
    filenames, a size cap and an accept prompt on the PC.
12. **Encrypt pairing keys with Windows' built-in protection (S).** Electron `safeStorage` in `store.js`, with a
    migration from plaintext. Never delete silently if decryption fails: fall back to "re-pair needed".
13. **Connect alert and session log on the PC (S-M).** A toast when a phone connects, a capped history in `store.js`,
    an optional "ask on PC" mode per phone. Two reports suggested it; it was skipped earlier on purpose.
14. **Connectivity self-test and failure-stage report (S-M).** A "Test connection" button (ntfy round trip, STUN,
    TURN) and a phone message naming the stage that failed.
15. **Wake-on-LAN (M).** MAC and broadcast address in the pairing link, a "Wake PC" button. Same-network only, and
    needs BIOS and network card settings.
16. **Lock-aware sessions (S).** `powerMonitor` lock events tell the phone "PC is locked" instead of a black screen,
    with an optional "end session on lock".
17. **Share one window instead of a whole monitor (M).** `desktopCapturer` window sources and thumbnails; input
    clamped to the window.
18. **Edge and corner trackpad zones, plus precision mode (S).** Bottom strip for horizontal scroll, optional corner
    taps, a second finger for 0.3x pointer speed. Each zone opt-in.
19. **One-handed layout (S).** A `handedness` preference mirrors the scroll strip and monitor chips.
20. **Phone app lock with biometrics (S-M).** `BiometricPrompt` before Connect, key wrapped by the Keystore. Closes the
    documented "stolen unlocked phone" gap.
21. **Per-phone permissions and expiring view-only guest links (M).** `allowControl`, `expiresAt`, `maxSessionMin` on
    the slot, enforced on the PC.
22. **Timed pause and sharing schedule (S).** "Pause for 1 h" and rules (on lock, on battery, outside set hours).
    Show "Resumes at 18:00" in the status pill.
23. **Auto bandwidth and a latency-versus-clarity toggle (M).** Step resolution and bitrate from
    `qualityLimitationReason`, with hysteresis; toggle `degradationPreference` and `contentHint`.
24. **Per-PC input profiles (S).** Key `ViewerPrefs` by pairing id with Reading, Precision and Presentation presets.
25. **Accessibility pass (M).** Semantics on the trackpad, video and monitor chips, on-screen button alternatives to
    multi-finger gestures, larger pad scale. Needs manual TalkBack testing.
26. **AV1 and VP9 codec options (S-M).** Extend `codecPreferences()`; opt-in, because AV1 software encode is heavy.

## Tier 3: larger, riskier or niche

27. **Deeper Glidr integration (L).** Type Unicode through the Screen link, share one pairing, route the trackpad over
    Bluetooth nearby and WebRTC otherwise. Glidr would gain the INTERNET permission, so its privacy text and the Play
    data-safety form change.
28. **macOS host (L).** Per-OS back ends for `input.js` and `autostart.js`; Screen Recording and Accessibility
    permissions and notarization. Linux is blocked by Wayland.
29. **Cursor as a separate overlay stream (M).** Capture without the cursor and draw it locally for less pointer lag.
30. **Session recording on the PC (S-M).** `MediaRecorder` on the captured stream. Needs a clear recording indicator.
31. **Local-network signaling fallback (M).** A small local listener advertised by mDNS for when ntfy.sh is blocked.
32. **Quick actions and power menu (M).** Lock, sleep, restart and custom launchers from an allowlist in
    `settings.json`. This is remote command execution by design: run only allowlisted IDs, never strings from the
    phone, off by default, phone-side confirm for shutdown and restart.
33. **Command line and `glidr-screen://` automation (S).** Harmless verbs only (`pause`, `resume`, `disconnect`,
    `status`).
34. **Per-session key rotation (M-L).** Gives forward secrecy but is the riskiest item: a lost message locks the phone
    out, so it needs a two-phase commit.
35. **Use the phone as the PC's webcam or microphone (L).** Needs in-band renegotiation and a virtual camera on
    Windows.

## Suggested first release

Items 1, 3, 4, 7 and 12 are all small and high value. Items 2 and 6 would then make the biggest improvement to the
viewing experience.

## Status (2026-11-25)

Built and merged into `main` (unit-tested; live behaviour against a real PC is still untested):

* Tier 1: 1 keep awake and resume repair, 2 cursor-follow zoom, 3 shortcut deck (gesture bindings not built),
  4 clipboard sync, 5 system audio (opt-in), 6 full-width landscape layout, 7 adaptive fps and data saver,
  9 hardware keyboard and mouse.
* Tier 2: 12 encrypted pairing keys, 16 lock-aware sessions, 18 edge zones and precision mode, 19 one-handed layout,
  22 timed pause, 24 per-PC input profiles, 25 accessibility (labels and simple-gesture buttons).
* Tier 3: 33 `glidr-screen://` automation links (pause, resume, disconnect only).

Not built: 8 presence, 10 installer and auto-update, 11 file transfer, 13 connect alert and session log (skipped on
purpose), 14 self-test, 15 Wake-on-LAN, 17 window sharing, 20 app lock, 21 per-phone permissions, 23 auto bandwidth,
26 AV1/VP9, 27-32 and 34-35.
