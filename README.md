# Glidr Screen

See your Windows PC on your phone and control it with a trackpad, keyboard and shortcuts, from anywhere with internet.
Video goes **directly phone <-> PC over WebRTC** (24 fps, encrypted). There is no media server and no relay.

| Part | Folder | Tech |
|------|--------|------|
| PC app (tray) | `host/` | Electron 44, WebRTC, `SendInput` via koffi |
| Phone app + embeddable library | `android/` | Kotlin, Compose, WebRTC; `:screenview` is the library, `:app` a thin shell |
| Design docs | `docs/` | [ARCHITECTURE](docs/ARCHITECTURE.md), [PROTOCOL](docs/PROTOCOL.md) |

## Use it

1. **PC:** `cd host && npm install && npm start` (or build an exe with `npm run dist`, output `host/dist/GlidrScreen-win32-x64/GlidrScreen.exe`).
2. Click **Pair a new phone**: a QR code and a code appear.
3. **Phone:** install the app (`cd android && gradlew.bat installDebug`), tap **Scan QR** (or **Enter code**).
4. Pick the PC, tap **Connect**. Works on the same Wi-Fi or from any other network.

On the phone: one finger moves the pointer, tap clicks, two-finger tap right-clicks, two fingers scroll, tap-then-drag drags,
the right edge is a scroll strip. Chips **1 2** on the picture and the Displays / Next display buttons switch monitors;
the Displays sheet shows every monitor with live previews in their real layout. Keyboard sheet: typing, modifiers,
arrows, F-keys, shortcuts, media keys and any-language phrases. Pinch to zoom the picture; *Direct touch* clicks where you tap.

## Updates

Both apps ask GitHub for the latest release of **yashraj-shitole/GlidrScreen** (PC: 15 s after start and daily, tray
menu and panel footer "Check for updates"; phone: on start and from the PC list). A newer version shows a banner with a
Download button; nothing installs itself. The phone skips the check when Google Play installed it.

To publish: bump `version` in `host/package.json` and `versionName`/`versionCode` in `android/app/build.gradle.kts`,
then create a GitHub release tagged `vX.Y.Z` with the phone `.apk` and the PC package (an `.exe` or a `*win*.zip` of
`host/dist/GlidrScreen-win32-x64`) attached. Until the repo has a release, both apps say "no releases yet".

## Test

```
host:    npm test                 crypto vectors
         node test/input.test.js  moves the real cursor a few px and back
         node test/signaling.test.js   live round trip through ntfy.sh
         npm run selftest         full end to end: plays the phone, 24 fps video, monitor switch, mouse, quality
android: gradlew.bat :screenview:testDebugUnitTest   crypto cross-compat with the host, pointer math, parsing
```

## Honest limits

* Tested: PC host end to end (self-test, packaged exe), Android app on the emulator connected to the real host
  (pairing by deep link, video, trackpad, monitor switch). **Not yet tested on a real phone** or across two different
  networks; the emulator sat behind the same router as the PC.
* Peer-to-peer fails when both sides are behind symmetric NAT (some mobile carriers). IPv6 normally avoids it. A TURN
  server can be added in `settings.json` (`turn`), at the price of relayed media.
* The rendezvous defaults to the public ntfy.sh. It only carries sealed messages; point both apps at your own ntfy server
  for full control (host > Settings > Advanced; the QR carries the URL to the phone).
* Windows blocks capture and input for the lock screen, UAC prompts and elevated windows unless the host runs as admin.
* Not code-signed: Windows SmartScreen will warn on first run. Play Store release needs signing and a privacy policy
  (the app uses the internet permission and the Google code scanner).
