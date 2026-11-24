# Glidr Screen protocol v1

Phone and PC talk **directly** over WebRTC (DTLS-SRTP video + SCTP data channel). The only thing that touches a
third party is the *rendezvous*: three tiny sealed messages used to exchange the SDP offer and answer.

```
 Phone                         rendezvous (ntfy topic)                        PC host
   |  req {sid, n}   --------------------->  (sealed, AES-256-GCM)  --------->  |
   |                                                                            | capture + createOffer,
   |  <---------------------------------------------------------   offer {sdp}  | gather ICE (non-trickle)
   |  setRemote(offer), createAnswer, gather ICE                                |
   |  answer {sdp}  --------------------------------------------------------->  |
   |                                                                            |
   |<===================  ICE (STUN) -> direct UDP, DTLS-SRTP video  =========>|
   |<===================  data channel "ctl": JSON control + input  ===========>|
```

## Pairing

The PC creates a random 128-bit **pairing key**. It is shown once, as a QR code, a link or a 26-character code:

```
glidr://screen?v=1&k=<base64url key>&n=<PC name>&s=<signaling base URL>
code: base32(key), e.g. AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4
```

The link may carry two optional Wake-on-LAN parameters, appended after `s`: `&m=<12 hex digits, upper case>` (the PC's
network adapter MAC address) and `&b=<IPv4>` (that adapter's directed broadcast address, e.g. `192.168.1.255`). The host
adds them only when it found a physical adapter and **both** are valid; a phone ignores a link where only one is present
or either does not match `[0-9A-Fa-f]{12}` / dotted-quad IPv4. Links without them are exactly the old format. See
*Wake-on-LAN* below.

Unclaimed pairings expire after 15 minutes. After the first request the slot is permanent until the PC removes it
("Paired phones" -> Remove). One slot per phone; each has its own key and topic.

## Rendezvous and crypto

```
encKey = HKDF-SHA256(ikm=key, salt="glidr-screen/v1", info="enc",   32 bytes)   // single-block expand
topic  = "gs-" + base32lower(HKDF-SHA256(key, salt, info="topic", 20 bytes))   // 35 chars
frame  = base64url_nopad( nonce[12] || AES-256-GCM(gzip(json)) || tag[16] ),  AAD = "glidr-screen/1"
```

Frames are POSTed to `<base>/<topic>` and read from `<base>/<topic>/json` (ntfy). The server cannot read or forge
messages; anything that fails authentication is dropped. Default base is `https://ntfy.sh`; any ntfy server works
(self-host for full control). Limit: a frame must stay under 3900 characters (ntfy caps bodies at 4096 bytes).

Reference implementations: `host/src/crypto.js`, `.../signal/SignalCrypto.kt`. Both are tested against the same
known-answer vectors (`host/test/crypto.test.js`, `SignalCryptoTest.kt`).

### Messages (plaintext JSON inside the frame)

| t | from | fields | meaning |
|---|------|--------|---------|
| `req` | p | `sid`, `n` (device name), `ts` | phone wants a session. `sid` is random per attempt |
| `offer` | h | `sid`, `sdp`, `host`, `v` | PC's offer, all ICE candidates included (no trickle) |
| `answer` | p | `sid`, `sdp` | phone's answer, candidates included |
| `busy` / `deny` | h | `sid`, `reason` (deny: `paused`, `no display` or `expired`) | another phone is connected / connection refused. `expired`: this phone's access has ended (see *Per-phone permissions*); the pairing is kept on the PC and works again once access is renewed there |
| `bye` | h or p | `sid`, `reason` | end of session. From the host `reason` may be `time limit`: the phone's per-session limit or its access period ran out |

`from` is `"p"` (phone) or `"h"` (host/PC). Sessions are keyed by `sid`; the host ignores a `sid` it has seen and
requests older than 90 s. A new `req` from the same slot replaces its previous session (reconnect after a network
change). Different slot while a session is live: `busy`.

Non-trickle ICE keeps a connection to **3 rendezvous messages** and the SDP in one frame.

## Presence

When the PC is asleep, switched off or Glidr Screen is closed, a phone can only time out. So the host leaves small
sealed *last seen* markers on every paired topic, and the phone reads the newest one to say what probably happened.

```
{"t":"presence","from":"h","ts":<ms epoch>,"state":"online"|"sleep"|"paused"|"quit"}
```

Sealed like every other message and published with ntfy's `Cache: yes`; a sealed marker is under 200 characters. The
host publishes to every claimed slot that has a readable key (not to an open pairing, not to a slot that needs
re-pairing):

| state | when |
|-------|------|
| `online` | about 4 s after the app starts, whenever sharing is switched on, every 5 minutes while sharing is on, and shortly (3 s, for the network) after the PC wakes from sleep |
| `sleep` | the PC is going to sleep (Windows `suspend`; best effort, the request may not leave in time) |
| `paused` | sharing was paused (also sent at start-up and after waking when sharing is off) |
| `quit` | the app is closing; the host waits at most 1.5 s for this to be sent |

A phone that is claimed later gets a marker right away. Publishing failures are ignored. The host ignores presence frames
(its own echo is `from: "h"`, and anything from `"p"` is not a request); a phone never publishes presence.

The phone does a one-shot poll, `GET <base>/<topic>/json?poll=1&since=12h`, opens each `message` with the slot key and
keeps the newest authentic presence from `h`. With no marker (ntfy keeps messages for about 12 hours on the public
server, a self-hosted one may differ) the answer is "no sign of the PC". The age is taken from the marker's own `ts`
(the ntfy `time` is the fallback when `ts` is missing or more than a minute in the future). Suggested wording:

| newest marker | text |
|---------------|------|
| `online`, under 7 min old | PC online |
| `online`, 7 min to 2 h old | Last seen 12 min ago (the heartbeat is 5 min, so older means the app probably stopped) |
| `online`, over 2 h old | Last seen 3 h ago (same wording, the unit just grows) |
| `sleep` | PC went to sleep 12 min ago |
| `paused` | Sharing paused on the PC |
| `quit` | Glidr Screen was closed 3 h ago |
| none | No sign of the PC in the last 12 hours |

Clocks of the PC and the phone are assumed to be roughly in step. This is a hint, not a guarantee: a PC that lost power
or network leaves its last `online` marker and nothing else.

## Per-phone permissions and guest links

These are settings of the PC's slot for a phone; the protocol only shows their effect. All are optional, and a slot
without them has full access forever.

* `viewOnly`: the phone may watch but not control. `hello.control` is `false` (and `control` `{"on":false}` is sent when
  the PC toggles it live), and input and `clip` messages are ignored, exactly as when the PC's global "Allow remote
  control" is off. Control is allowed only when the global switch is on **and** the phone is not view only.
* `expiresAt` (ms epoch, 0 = never): after it, a `req` from that phone is answered with `deny` reason `expired`. A
  session still running at that moment ends with `bye` reason `time limit`.
* `maxSessionMin` (0 = unlimited): a session ends with `bye` reason `time limit` that many minutes after the request was
  accepted.
* Guest pairing ("Pair a guest"): an ordinary pairing whose slot is `viewOnly`, has `maxSessionMin` 60 and gets
  `expiresAt` = 1 hour after the phone **claims** it (first `req`), not after the QR code was shown. Guest links never
  contain the `m` / `b` Wake-on-LAN parameters.

A phone should treat `deny` `expired` and `bye` `time limit` as final until the user renews access on the PC, and
should not retry in a loop.

## Wake-on-LAN

The phone can wake a sleeping PC on the same LAN by sending a standard magic packet (6 x `FF`, then the MAC from `m`
repeated 16 times) as a UDP broadcast to `b`, port 9. The host picks the adapter for `m` / `b` from the OS interface
list, skipping loopback, virtual and VPN adapters (vEthernet, Hyper-V, VirtualBox, VMware, Docker, WSL, TAP,
Tailscale and similar), all-zero MACs and link-local addresses, and preferring a private IPv4 address. It only works
when Wake-on-LAN is enabled in the PC's BIOS and in the network adapter's settings, and from the same network.

## Media

* PC is the offerer and sends one video track; the phone is receive-only. **Audio is optional and off by default**
  (see *Audio* below).
* Frame rate is per session: **24 fps by default**, or what the phone asks for in `quality` (see the table below).
  The capture `maxFrameRate`, the encoder `maxFramerate` and `degradationPreference = maintain-framerate` all follow it.
* Codec preference H.264 (hardware encode where available), then VP8. Quality presets cap resolution/bitrate:
  `auto` 1080p / 6 Mbit/s, `low` 540p / 1.2, `balanced` 720p / 3, `high` 1440p / 9. Congestion control is WebRTC's own.

### Frame rate and data saver

The phone sends `{"t":"quality","p":<preset>,"fps":<n>,"saver":<bool>}`. `fps` must be 15, 24, 30 or 60; anything else
(or a missing `fps`) means 24. The host then caps it per preset:

| preset | resolution | bitrate | max fps | notes |
|--------|-----------|---------|---------|-------|
| `low` | 540p | 1.2 Mbit/s | 30 | 60 is clamped to 30 |
| `balanced` | 720p | 3 Mbit/s | 60 | |
| `auto` | 1080p | 6 Mbit/s | 60 | |
| `high` | 1440p | 9 Mbit/s | 30 | 60 is clamped to 30 (1440p60 overloads most encoders) |

* 60 fps raises the preset bitrate by 1.4x (4.2 Mbit/s for `balanced`, 8.4 for `auto`).
* `saver: true` forces **15 fps**, halves the preset bitrate and sets the track's `contentHint` to `detail`
  (sharpness over smoothness). Whatever `fps` was sent is ignored.
* `contentHint` is `motion` for 24 fps and above, `detail` below that or in saver mode.
* The effective rate is reported in `hello.fps` when the channel opens. A later `quality` message does not echo the
  clamped value, so the phone should apply the table above (it is deterministic) or read it off the measured video.
* A missing or unknown `p` is ignored (unknown) or keeps the current preset (missing).

#### Delivery mode (`mode`)

`quality` may also carry `"mode":"auto"|"latency"|"clarity"` (optional). It chooses how the host reacts to congestion;
the preset above is always the ceiling and the host never exceeds it.

| mode | degradationPreference | contentHint | adaptation |
|------|-----------------------|-------------|------------|
| `auto` (default) | `maintain-framerate` | from the fps rules above | steps down after 2 consecutive bad stats samples, up after 6 clean ones |
| `latency` | `maintain-framerate` | `motion` | same ladder, steps down after 1 bad sample |
| `clarity` | `maintain-resolution` | `detail` | never lowers resolution below the preset; only bitrate and frame rate give way |

* A sample is taken every 2 s and is *bad* when the encoder reports `qualityLimitationReason` `bandwidth` or `cpu`, or
  the RTT is over 250 ms. A step down first shrinks the picture (`scaleResolutionDownBy`, never below a 360p
  equivalent), then lowers the bitrate; it is applied with `setParameters`, without renegotiation. After a failed
  step up the next one waits twice as long (6, 12, 24, 48 samples), so a link that cannot carry the preset settles
  instead of flapping.
* A missing `mode` keeps the session's current mode (a new session starts in `auto`); an unknown value means `auto`.
  Older hosts ignore the field, so a phone may always send it.
* The mode is per session and not reported in `hello`; the host's own stats carry the active mode and adaptation step.

### Audio (optional)

When the PC's `shareAudio` setting is on, the host captures system audio (Windows loopback) and adds it to the offer
as a second `sendonly` transceiver (Opus, 48 kHz stereo, one BUNDLE transport; the data channel moves to the third
m-section). If audio capture fails the host logs it and continues with video only. `hello.audio` is `true` only when an
audio track really is in the offer, so a phone must look at `hello.audio` (or at the presence of an audio m-section),
never assume it. The phone stays receive-only; muting is local. The audio section adds roughly 800 bytes of SDP, about
350 characters to the sealed offer frame (a representative offer is 2.6 kB of the 3.9 kB limit, see
`host/test/offer-size.test.js`). Switching the shared monitor keeps the same audio track.
* ICE: STUN only (Google, Cloudflare). **No TURN by default**, so media never goes through a relay. A TURN server can
  be added in the host settings file (`turn`) for networks where peer-to-peer is impossible (symmetric NAT on both sides).

## Data channel `ctl` (reliable, ordered, JSON text)

Created by the PC. All coordinates are physical pixels on the PC's virtual desktop.

PC to phone:

| message | meaning |
|---------|---------|
| `{"t":"hello","v":1,"host","os","fps":24,"control":bool,"quality","monitors":[Monitor],"active":id,"locked":bool,"audio":bool}` | sent when the channel opens. `fps` is the session's current frame rate, `locked` the PC lock state, `audio` whether system audio is in the offer. Older hosts omit `locked` / `audio` (treat as `false`) |
| `{"t":"locked","on":bool}` | the PC was locked / unlocked during the session (a locked Windows desktop cannot be captured or controlled) |
| `{"t":"clip","s":"<text>"}` | PC clipboard text changed. Only while the phone has `clipsync` on; text only, at most 256 KB (262144 chars), empty text is never sent, and text the phone just set is not echoed back |
| `{"t":"cur","x":0..1,"y":0..1}` | PC cursor position, normalised inside the shared display (clamped to 0..1). Only while the phone has `curs` on, at most ~30 per second, and only when the position changed |
| `{"t":"monitors","monitors":[...],"active":id}` | layout changed (plugged/unplugged/resolution) |
| `{"t":"active","id","w","h"}` | the shared display changed |
| `{"t":"thumb","id","w","h","jpg":"<base64 JPEG>"}` | preview of one monitor, every 1.5 s while requested |
| `{"t":"control","on":bool}` | "Allow remote control" was switched on the PC during the session |
| `{"t":"pong","n","ts"}` | answer to `ping` |

`Monitor = {id, name, x, y, w, h, scale, primary}`. `id` is Chromium's display id: on Windows an unsigned 32-bit
hash that is often above 2^31, so parse it as a 64-bit integer.

Phone to PC:

| message | meaning |
|---------|---------|
| `{"t":"mv","dx","dy"}` | relative pointer move in PC pixels (phone applies sensitivity and acceleration) |
| `{"t":"abs","x","y"}` | absolute pointer position, 0..1 inside the shared display |
| `{"t":"btn","b":"l"/"r"/"m","a":"d"/"u"/"c"}` | button down / up / click |
| `{"t":"wheel","x","y"}` | scroll in notches (+y = up) |
| `{"t":"key","k","a":"d"/"u"/"p"}` | key by name (`Enter`, `Ctrl`, `F5`, `a`, ...) |
| `{"t":"combo","keys":["Ctrl","Shift","Esc"]}` | hold in order, release in reverse |
| `{"t":"text","s"}` | type Unicode text (any script, via `KEYEVENTF_UNICODE`) |
| `{"t":"monitor","id"}` | switch the shared display (video track is replaced without renegotiation) |
| `{"t":"thumbs","on":bool}` | start / stop monitor previews |
| `{"t":"quality","p":"auto"/"low"/"balanced"/"high","fps":15/24/30/60,"saver":bool}` | change preset; `fps` and `saver` are optional (see *Frame rate and data saver*) |
| `{"t":"clip","s":"<text>"}` | set the PC clipboard text. Ignored when "Allow remote control" is off; text longer than 256 KB (262144 chars) or empty is dropped silently. The host never logs it |
| `{"t":"clipsync","on":bool}` | when on, the host pushes PC clipboard text changes as `clip` (polled about every 500 ms). The current clipboard is not pushed when it is switched on, only later changes |
| `{"t":"curs","on":bool}` | start / stop the `cur` cursor position stream (the host also stops it when the session ends) |
| `{"t":"ping","n","ts"}` | RTT probe |

Input is ignored when the PC has "Allow remote control" off (`hello.control = false`, later `control`; the phone shows *View only*).
The pointer is confined to the shared display; buttons and keys still held when the session ends are released.
`clip` follows the same rule; `clipsync` and `curs` only read PC state and work in view-only mode too.

Unknown messages are ignored by both sides, so the protocol version stays 1: a phone talking to an older host simply
never receives `clip`, `cur` or `locked`, and an older phone never sends the new messages.

## Window sharing

Besides whole monitors, the phone can view **one application window**. Everything is optional: an older host ignores
the messages below (the phone sees no `windows` list and shows only the displays), and an older phone never sends them.

Phone to PC:

| message | meaning |
|---------|---------|
| `{"t":"windows","on":bool}` | start / stop the window list and window previews (like `thumbs`). The phone turns it on while its window picker is open |
| `{"t":"source","kind":"window","id":"<window id>"}` | share this window. `id` is an `id` from the latest `windows` list |
| `{"t":"source","kind":"monitor","id":<monitor id>}` | share this monitor: exactly the same as `{"t":"monitor","id"}` |

PC to phone:

| message | meaning |
|---------|---------|
| `{"t":"windows","list":[{"id","title","w","h"}]}` | the windows on offer, front to back |
| `{"t":"wthumb","id","w","h","jpg":"<base64 JPEG>"}` | preview of one window |
| `{"t":"active","kind":"window","id","title","w","h"}` | the shared source is now this window. `w` x `h` is the captured size. For monitors the `active` message is unchanged (no `kind`) |
| `{"t":"source-error","id","reason":"gone"}` | the window could not be shared (see below) |

* **List.** While `windows` is on the host sends the list immediately and then re-checks every 2 s, sending a new
  `windows` message **only when something changed** (a window opened or closed, a title or size changed). `id` is an
  opaque string (today `window:<HWND>:0`, the Electron capture id); treat it as a token, never parse it. `title` is the
  window title with control characters removed, at most 80 characters. `w` / `h` are the window's size in physical pixels.
  At most **30** windows are listed. The host skips windows with an empty title, minimised windows, windows smaller than
  120 px in either direction, and its own windows (Glidr Screen).
* **Previews.** Every 3 s the host sends a `wthumb` for each of the **first 12** windows of the list: JPEG quality 55, at
  most 384x216, aspect ratio kept. Both streams stop when `windows` is turned off or the session ends, and start again
  from scratch when it is turned on again.
* **Untrusted text.** Window titles come from other programs (a web page chooses its own tab title). A phone must show
  them as plain text. The host never writes a title to a log.
* **Switching.** The host accepts an `id` only if it is in the list it last computed (when the list was never started it
  looks once itself) **and** the window still exists and is not minimised. Otherwise it answers `source-error` with
  `reason` `gone` and changes nothing. The same answer is sent if the capture of the window then fails. On success the
  video track is replaced without renegotiation, like a monitor switch, and `active` with `kind` `window` follows.
  Audio stays the system-wide track.
* **Input.** While a window is shared, `abs` (0..1) maps to the window's **current** bounds, and pointer movement is
  clamped to them, so the phone cannot click outside the shared window. The host reads the bounds with `GetWindowRect`
  (refined with the DWM visible frame so the invisible resize border is not counted) at most every 250 ms, so a moved or
  resized window keeps working. `cur` is normalised to the window as well. When a window is chosen the host also brings
  it to the front (best effort), because a click is delivered to whatever is on top at that screen position.
* **Fall back.** When the shared window is closed or minimised the host sends `source-error` (`reason` `gone`, `id` of
  that window) **once** and switches back to the primary monitor, which produces the normal monitor `active` message.
  After that the window is forgotten; the phone may pick it (or another) again from the list.
* The `monitors` message and `hello` keep describing displays; `active` there is the last shared **monitor** while a
  window is shown. A phone tracks "what is shared" from the `active` messages it receives.

## File transfer (phone to PC)

The phone can send files to the PC. The PC creates a **second** data channel next to `ctl`, labelled `files` (reliable,
ordered). A phone must route incoming channels by `channel.label()`: `ctl` is JSON control, `files` carries file bytes.
Older hosts have no `files` channel and ignore `file-offer`; the phone treats a missing answer as "not supported".

Control messages travel on `ctl`:

| message | direction | meaning |
|---------|-----------|---------|
| `{"t":"file-offer","id":"<8 hex>","name":"<file name>","size":<bytes>}` | phone to PC | ask to send one file. `id` is 8 lower-case hex digits, unique per transfer |
| `{"t":"file-accept","id"}` | PC to phone | go ahead and stream the file on `files` |
| `{"t":"file-reject","id","reason"}` | PC to phone | refused, nothing was created. `reason` is `disabled`, `too-big`, `view-only`, `busy` or `bad-name` |
| `{"t":"file-done","id","ok":bool,"name":"<saved name>"}` | PC to phone | the transfer finished. `ok:true`: the file was saved under `name` (which may differ from the offered name). `ok:false`: nothing was kept (`name` is empty) |

Data on `files`, after `file-accept`:

1. a text frame `{"t":"begin","id"}`;
2. binary frames of **at most 16384 bytes**, in order, exactly `size` bytes in total. The sender pauses when
   `bufferedAmount` is above 256 KB and resumes on `bufferedamountlow`;
3. a text frame `{"t":"end","id","sha256":"<64 hex digits, SHA-256 of the whole file>"}`.

The PC replies with `file-done` once the file is on disk. To cancel, the phone sends a text frame `{"t":"cancel","id"}` on
`files` (optional; the PC then deletes the partial file and answers `file-done` `ok:false`). If the phone stops sending for
60 s, or never sends `begin` within 30 s of the accept, the PC gives up the same way.

Rules the host enforces:

* **Refused** (`disabled`) unless the PC-wide "Allow remote control" is on **and** the new setting `allowFiles` ("Allow
  receiving files from the phone", on by default) is on; `view-only` for a view-only phone (see *Per-phone permissions*).
  The check is made on every offer.
* **Size cap 200 MB** (209,715,200 bytes): a larger offer is answered `too-big` before anything is accepted.
* **One transfer at a time**: a second offer while one runs is answered `busy`. A malformed offer (no name, size not a
  non-negative integer, bad id) is answered `bad-name`.
* **Name**: any path is stripped (both `/` and `\`); control characters, `<>:"|?*` and bidi overrides are removed; leading
  dots and trailing dots / spaces are dropped; reserved Windows device names (`CON`, `NUL`, `COM1`, ...) get a `_`
  prefix; at most 120 characters (the extension is kept); an empty result becomes `file`.
* **Where**: the PC's `Downloads\Glidr` folder, created when missing; nowhere else. An existing name gets `name (2).ext`,
  `name (3).ext`, ...
* **Safety**: bytes are streamed to a temp file (`.<id>.glidr-part`) in that folder, never buffered whole, and the file is
  renamed to its final name **only** when the byte count and the SHA-256 match; otherwise the partial file is deleted.
  The host never opens or runs the received file.
* **Abort**: the transfer is cut off, and the partial file deleted, when the session ends, when the `files` channel
  closes, or when "Allow remote control" or "Allow receiving files" is switched off (the phone then gets `file-done`
  `ok:false`).
* The PC shows a tray notification "Received <name> from <phone>". File names, contents and hashes are not logged
  (except at debug level).

## Security model

* Possession of the 128-bit pairing key is the only credential. It is created on the PC, shown on the PC screen, and
  stored on the phone in app-private storage excluded from backup.
* The offer/answer are sealed with that key, so the DTLS fingerprints inside them are authenticated: a rendezvous
  operator or network attacker cannot insert themselves into the media path.
* Remove a phone on the PC and its key stops working immediately. Pairing again generates a new key.
* Not covered: a phone that is stolen *and* unlocked can use its pairing. Use the PC's *Pause sharing* / *Remove*.
