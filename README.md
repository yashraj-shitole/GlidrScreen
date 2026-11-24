# Glidr Screen

See your Windows PC on your phone and control it with a trackpad, keyboard and shortcuts, from anywhere with internet.
Video goes **directly phone <-> PC over WebRTC** (24 fps, encrypted). There is no media server and no relay.

| Part | Folder | Tech |
|------|--------|------|
| PC app (tray) | `host/` | Electron 44, WebRTC, `SendInput` via koffi |
| Phone app + embeddable library | `android/` | Kotlin, Compose, WebRTC; `:screenview` is the library, `:app` a thin shell |
| Design docs | `docs/` | [ARCHITECTURE](docs/ARCHITECTURE.md), [PROTOCOL](docs/PROTOCOL.md) |

## Download (v2.0.0)
- **Phone app:** [GlidrScreen-2.0.0.apk](https://github.com/yashraj-shitole/GlidrScreen/releases/download/v2.0.0/GlidrScreen-2.0.0.apk). Android 10 or newer; allow installing from your browser or file manager.
- **PC app:** [GlidrScreen-2.0.0-win-x64.zip](https://github.com/yashraj-shitole/GlidrScreen/releases/download/v2.0.0/GlidrScreen-2.0.0-win-x64.zip). Unzip anywhere and run `GlidrScreen.exe` (Windows 10 or newer, x64).

All downloads are on the [Releases page](https://github.com/yashraj-shitole/GlidrScreen/releases). The APK is signed
with a debug key and the PC app is not code-signed, so Windows SmartScreen warns on first run.

## Use it

1. **PC:** `cd host && npm install && npm start` (or build an exe with `npm run dist`, output `host/dist/GlidrScreen-win32-x64/GlidrScreen.exe`).
2. Click **Pair a new phone**: a QR code and a code appear.
3. **Phone:** install the app (`cd android && gradlew.bat installDebug`), tap **Scan QR** (or **Enter code**).
4. Pick the PC, tap **Connect**. Works on the same Wi-Fi or from any other network.

## Features

### Phone app

**See the PC**
* Live picture of the PC at 24 fps, hardware decoded. Pinch to zoom, drag to pan while zoomed, one tap to reset.
* Rotate to landscape for a full-width picture with floating controls that fold away to a handle. The screen stays on
  while you are connected.
* Status line with fps, resolution, bitrate, ping and the connection path (switch off with *Show stats*).
* Stream quality: Auto, 540p, 720p or 1440p, frame rate 15 / 24 / 30 / 60, a *Data saver* switch, and a delivery mode
  (*Auto*, *Fast* for lowest delay, *Sharp* for text clarity). Auto mode lowers and raises resolution and bitrate by
  itself when the link changes.
* *Follow pointer*: while zoomed in, the view follows the PC's mouse pointer.
* Optional PC audio (switched on in the PC app) with a mute chip. A banner tells you when the PC is locked.

**Trackpad**
* Laptop-style gestures: one finger moves the pointer, tap clicks, two-finger tap right-clicks, three-finger tap
  middle-clicks, two fingers scroll, tap-then-drag drags.
* Scroll strip on the right edge of the pad.
* Left and right mouse buttons under the pad. Hold one to keep it pressed, so they drag too.
* *Direct touch*: tap the picture to click that exact spot on the PC, like a touchscreen.
* Pointer speed (0.5x to 3.5x), pointer acceleration (Off / Low / Med / High), scroll speed and natural scrolling.
* Optional extras, all off until you switch them on: a sideways scroll strip along the bottom edge, a bottom-right
  corner right-click, *Precision mode* (a second resting finger slows the pointer), three-finger swipes (Win+Tab,
  Win+D, previous and next virtual desktop), left-handed and one-handed layouts, and on-screen Middle / Up / Down
  buttons for people who cannot use multi-finger gestures.
* Input settings are remembered per PC, with Reading, Precision and Presentation presets.
* An attached Bluetooth or USB keyboard and mouse control the PC directly.

**Multiple monitors**
* Numbered chips (**1 2 ...**) on the picture jump straight to a monitor; *Next display* cycles through them.
* The *Displays* sheet draws every monitor in its real layout with live previews. Tap one to view and control it.

**Keyboard sheet**
* Type with the phone keyboard; every character goes straight to the PC.
* Latch Ctrl, Alt, Shift and Win for combos, plus Esc, Tab, Enter, Backspace, Delete, arrows, Home/End, PgUp/PgDn and F1 to F12.
* One-tap Windows shortcuts: copy, paste, cut, undo, select all, save, find, Alt+Tab, show desktop, task view,
  Task Manager, snip, lock, close window, refresh and full screen.
* Media keys: volume, mute, previous, play/pause, next.
* Type a phrase in any language (sent as Unicode text, so it is not limited to the PC's keyboard layout).
* Your own shortcuts: build combos (for example OBS or Premiere keys), pin up to four under the mouse buttons.

**Windows and files**
* *Displays* sheet has a *Windows* tab: share a single application window instead of a whole monitor. Input follows
  the window, and it falls back to the main monitor if the window closes.
* Send files to the PC from the viewer or from the Android share sheet (200 MB limit, saved in DownloadsGlidr on the
  PC, never opened automatically; the PC can switch receiving off).

**Clipboard**
* Send the phone's clipboard text to the PC, paste the PC's clipboard on the phone, or keep them in sync. Text goes
  straight to the PC over the encrypted link, never through a server (256 KB limit, opt-in).

**Connection**
* Each PC card shows what it was last seen doing ("PC online", "went to sleep 12 min ago", "Glidr Screen was closed").
* Optional *App lock*: a PIN (4-8 digits, stored only as a salted hash) guards the app and its paired PCs, with a
  growing wait after wrong tries. There is no recovery: clearing the app data removes the lock and the pairings.
* *Wake* button for PCs that advertise Wake-on-LAN (same Wi-Fi, and it must be enabled in the PC's BIOS and adapter).
* When a connection fails, the screen says how far it got (reached the signaling server, request sent, offer received...).
* Pair once by scanning a QR code (or typing the code / pasting the link). Paired PCs are listed; forget one any time.
* Connects from any network, not only the same Wi-Fi, and reconnects on its own when the link drops.
* Midnight (dark) and Paper (light) themes, haptics on clicks.
* Update banner when a newer release is on GitHub.

### PC app (Windows tray)
* Runs quietly in the tray and can start with Windows.
* *Pair a new phone* shows a QR code, a code and a copyable link. Lists paired phones and every monitor.
* *Sharing* switch to pause or resume accepting connections; *Allow remote control* switch for a view-only mode
  (the phone shows a "View only" tag).
* Disconnect the phone from the panel or the tray menu.
* Default quality (Auto / 540p / 720p / 1440p) and video codec (Auto prefers hardware H.264, or H.264 / VP8).
* Keeps the PC awake while sharing, and reconnects after sleep or unlock. Tray items to pause for an hour or until
  tomorrow morning.
* Per phone: a *View only* switch, an access limit (always, 1 hour, 1 day, 7 days), and *Pair a guest* for a one-hour
  view-only link.
* Optional: share the PC's audio, end the session when the PC locks, two-way clipboard (the phone asks for it).
* *Test connection* checks the signaling server, STUN and the PC's clock.
* `glidr-screen://pause`, `resume` and `disconnect` links for scripts and Stream Deck buttons (nothing else is accepted).
* Advanced: PC name and your own signaling (ntfy) server.
* Checks GitHub for updates and shows a download link. The start-with-Windows entry repairs itself if the copy it
  pointed to was moved or broken.

### Privacy and security
* Video, mouse and keyboard go directly between phone and PC over WebRTC (DTLS-SRTP). No media server, no relay of ours.
* The pairing key never leaves the two devices, and is encrypted at rest on the PC with Windows' own protection. The
  rendezvous server only passes three sealed setup messages (AES-256-GCM, keys from HKDF-SHA256) and never sees the
  video or your input.
* No account, no sign-up.

### Embeddable
`:screenview` is an Android library, so the viewer can be dropped into another app (embedding it in Glidr is planned,
see [ARCHITECTURE](docs/ARCHITECTURE.md)).
`:app` is a thin standalone shell around it with the `glidr://screen` deep link.

## Updates

Both apps ask GitHub for the latest release of **yashraj-shitole/GlidrScreen** (PC: 15 s after start and daily, tray
menu and panel footer "Check for updates"; phone: on start and from the PC list). A newer version shows a banner with a
Download button; nothing installs itself. The phone skips the check when Google Play installed it.

To publish: bump `version` in `host/package.json` and `versionName`/`versionCode` in `android/app/build.gradle.kts`,
then create a GitHub release tagged `vX.Y.Z` with the phone `.apk` and the PC package (an `.exe` or a `*win*.zip` of
`host/dist/GlidrScreen-win32-x64`) attached.

## Test

```
host:    npm test                 crypto vectors, store, pause timer, permissions, Wake-on-LAN, adaptation, clipboard...
         node test/input.test.js  moves the real cursor a few px and back
         node test/signaling.test.js   live round trip through ntfy.sh
         npm run selftest         full end to end: plays the phone, 24 fps video, monitor switch, mouse, quality
android: gradlew.bat :screenview:testDebugUnitTest   crypto cross-compat with the host, pointer math, parsing, shortcuts, protocol messages
```

## Honest limits

* Tested: PC host end to end (self-test, packaged exe), Android app on the emulator connected to the real host
  (pairing by deep link, video, trackpad, monitor switch). **Not yet tested on a real phone** or across two different
  networks; the emulator sat behind the same router as the PC. Newer features (audio, clipboard, pointer follow,
  hardware keyboard and mouse, Wake-on-LAN, per-phone access limits) are unit-tested and the host self-test passes,
  but they have not been tried live between a real phone and PC.
* Peer-to-peer fails when both sides are behind symmetric NAT (some mobile carriers). IPv6 normally avoids it. A TURN
  server can be added in `settings.json` (`turn`), at the price of relayed media.
* The rendezvous defaults to the public ntfy.sh. It only carries sealed messages; point both apps at your own ntfy server
  for full control (host > Settings > Advanced; the QR carries the URL to the phone).
* Windows blocks capture and input for the lock screen, UAC prompts and elevated windows unless the host runs as admin.
* Not code-signed: Windows SmartScreen will warn on first run. Play Store release needs signing and a privacy policy
  (the app uses the internet permission and the Google code scanner).
