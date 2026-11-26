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
or either does not match `[0-9A-Fa-f]{12}` / dotted-quad IPv4. Links without them are exactly the old format. A third
optional parameter, `&l=<IPv4>:<port>`, adds the PC's LAN signaling address (see *LAN signaling* below). See
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
| `req` | p | `sid`, `n` (device name), `ts`, optional `dec` | phone wants a session. `sid` is random per attempt. `dec` lists the video codecs the phone can decode, see *Codecs* |
| `offer` | h | `sid`, `sdp`, `host`, `v` | PC's offer, all ICE candidates included (no trickle) |
| `answer` | p | `sid`, `sdp` | phone's answer, candidates included |
| `busy` / `deny` | h | `sid`, `reason` (deny: `paused`, `no display` or `expired`) | another phone is connected / connection refused. `expired`: this phone's access has ended (see *Per-phone permissions*); the pairing is kept on the PC and works again once access is renewed there |
| `bye` | h or p | `sid`, `reason` | end of session. From the host `reason` may be `time limit`: the phone's per-session limit or its access period ran out |

`from` is `"p"` (phone) or `"h"` (host/PC). Sessions are keyed by `sid`; the host ignores a `sid` it has seen and
requests older than 90 s. A new `req` from the same slot replaces its previous session (reconnect after a network
change). Different slot while a session is live: `busy`.

Non-trickle ICE keeps a connection to **3 rendezvous messages** and the SDP in one frame.

## LAN signaling

The public ntfy.sh allows only about 250 anonymous messages per IP per day and can be down or blocked. On the same
Wi-Fi the phone can reach the PC directly, so the PC also runs a tiny ntfy-**compatible** HTTP server on the local
network and the phone uses its existing rendezvous code with the base `http://<pc-lan-ip>:<port>`. The messages, the
topics and the sealing are exactly those of the rendezvous above; only the base URL differs.

**Pairing link.** `&l=<IPv4>:<port>` is appended after the other parameters (after `m` / `b` when those are present):
the primary LAN adapter's address (the one chosen for Wake-on-LAN) and the server's port, e.g.
`&l=192.168.1.20%3A50123`. The host adds it only when LAN signaling is on and a private IPv4 address is known. The
phone accepts it only as `a.b.c.d:port` with canonical decimal numbers, port 1..65535, and an address in 10/8,
172.16/12, 192.168/16 or 169.254/16; anything else is ignored and the link pairs as if it had no `l`. A link without
`l` is byte-identical to the older format. When the same PC is paired again, an `l` in the new link replaces the stored
one; a link or typed code without it keeps the stored one.

**Endpoints** (all other paths, methods and topics answer 404 / 405):

```
POST /<topic>                  body = one sealed frame (max 4096 bytes)            -> 200 {}
GET  /<topic>/json[?since=X]   long-lived stream of newline-delimited JSON, as ntfy
   {"id":"<id>","time":<unix s>,"event":"open","topic":"<topic>"}                  first line
   {"id":"<id>","time":<unix s>,"event":"message","topic":"<topic>","message":"<frame>"}
   {"id":"<id>","time":<unix s>,"event":"keepalive","topic":"<topic>"}             every 30 s
```

`since` is a message id (replays the buffered messages after it), `all`, or a duration like `30s` / `10m`; without it a
stream carries only new messages, and an id the server does not know replays nothing. Per topic the server keeps the
last 50 frames for 10 minutes, in memory only. The topics served are exactly those derived from the PC's current
pairing slots (including an open, not yet claimed pairing, since the first connection happens on it); removing a phone
removes its topic, buffer and streams.

**What the host does.** A frame POSTed by a phone is opened with the slot's key first; a frame that fails
authentication is answered 400 and is never buffered or passed on. An authentic one is buffered, sent to the open
streams of that topic and handed to the host exactly like a message that arrived from ntfy (`message` event with
`{slotId, msg, serverTime}`), so everything after that (the `sid` and age checks, one session at a time) is unchanged.
An exact repeat of a buffered frame is acknowledged but not delivered a second time. Everything the host publishes
(`offer`, `busy`, `deny`, `bye`, presence markers) goes to **both** ntfy and the LAN buffer, as the same sealed frame. If
ntfy refuses it but a phone received it over the LAN, publishing counts as done.

**What the phone does.** If the PC has a LAN address, each attempt goes LAN first:

1. Subscribe to the LAN base and post `req` there (connect timeout 3 s).
2. If no `offer` has arrived 4 s after the attempt began, or the LAN subscription or post failed earlier, also
   subscribe to the normal base and post the same `req` there (the PC ignores the second copy: same `sid`). The LAN
   keeps listening, so a late LAN offer still counts.
3. The first base to deliver the `offer` is used for the rest of the attempt: the `answer` and a later `bye` go to that
   same base and the other subscription is closed. `busy`, `deny` and `bye` from the PC end the attempt from either base.

A LAN failure is never an error by itself; the public server is then used as before, and a PC without `l` skips step 1.
The failure screen's "Got as far as" line says *Reached the PC on the local network* or *Reached the signaling server*.

**Security.**

* Plain HTTP, but every frame is AES-256-GCM sealed with the pairing key, so a device on the Wi-Fi sees only random
  bytes, cannot read or alter an offer or answer (the DTLS fingerprints stay authenticated) and cannot forge a frame.
  The usual limit applies: a captured `req` could be replayed to the PC (the same holds on ntfy); the PC ignores a `sid`
  it has seen and exact repeats of a buffered frame.
* The server answers 403 to any peer outside 10/8, 172.16/12, 192.168/16, 169.254/16, fe80::/10 and fc00::/7, before it
  says anything else, so a router port forward cannot expose it. Loopback is refused too, so a tunnel running on the PC
  cannot expose it either. Unknown topics get a plain 404: the server reveals nothing about which topics exist.
* Caps: 4096-byte bodies, 8 KiB of headers, 16 concurrent streams (503 beyond), 15 s to deliver a request, 90 s idle
  sockets, 30 min per stream (the phone just reconnects), slow readers are cut off. Frames are never logged.
* It listens on all interfaces (`0.0.0.0`) only while "Set up connections directly on the local network" is on (default
  on, setting `allowLan`); the port (`lanPort`) is picked at random in 49152-65535 on first start and kept. Windows
  Firewall asks once whether Glidr Screen may accept connections on private networks; declining just leaves ntfy.
* Android: the app allows cleartext HTTP in its network security config for this (see ARCHITECTURE.md).

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
| `online` | about 4 s after the app starts, whenever sharing is switched on, every 2 hours while sharing is on (the public ntfy.sh allows about 250 anonymous messages a day per IP, so markers are posted on changes and refreshed slowly; after an HTTP 429 the host stops posting markers for an hour), and shortly (3 s, for the network) after the PC wakes from sleep |
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
| `online`, 7 min to 2 h old | Last seen 12 min ago (the heartbeat is 2 h, so this is when the PC last reported, not proof that it is still on) |
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
* Codec preference H.264 (hardware encode where available), then VP8 (VP9 and AV1 on request, see *Codecs*). Quality presets cap resolution/bitrate:
  `auto` 1080p / 6 Mbit/s, `low` 540p / 1.2, `balanced` 720p / 3, `high` 1440p / 9. Congestion control is WebRTC's own.

### Codecs

The phone's `req` may carry `"dec":["h264","vp8","vp9","av1"]`: the lower-case names of the video codecs it can really
**decode** (from the decoder factory's supported list, not a guess), de-duplicated, at most these four names. The host
ignores the field when it is not an array of 1 to 8 of those strings, and then treats the phone as an older one.

* No (or invalid) `dec`: the offer holds H.264 then VP8, exactly as before. VP9 and AV1 are never offered.
* `dec` present: the offer only holds codecs the phone listed, so a missing decoder never produces a black picture.
* The host setting `codec` is `auto`, `h264`, `vp8`, `vp9` or `av1`. `auto` never picks VP9 or AV1 (they can be heavy
  to encode on the PC); they are explicit opt-ins. With `vp9` / `av1` the offer is that codec, then H.264, then VP8,
  and only if the phone listed it. If it did not, the host silently uses the `auto` order.
* The phone decodes whatever the offer selects; the codec in use is reported in the host's stats.

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
* ICE: STUN (Google, Cloudflare) by default; media goes peer to peer. For mobile data (a phone behind a carrier NAT cannot be
  reached by hole punching) the PC can add, in order of preference for the connection: (1) a router port mapping and (2) a
  relay.
  * **Port mapping (UPnP / IGD)**, setting `useUpnp` (on by default). When the offer is ready the host asks the router to
    forward one UDP port to the host candidate's own port, only if the router's WAN address is public (not private or
    100.64.0.0/10), and adds one `typ srflx` candidate with the router's address and that port next to the host candidate. The
    request carries a one hour lease, the mapping is deleted when the session ends or the app quits, and the whole step
    is limited to 2.5 s (the offer is sent unchanged on any failure). Nothing changes on the phone.
  * **Relay (TURN)**, setting `turn` ({urls, username, credential}, edited in Advanced). The PC uses it for its own
    candidates and adds `"turn":{"urls":[...],"username":"...","credential":"..."}` to the sealed `offer`, so the phone allocates
    its own relay address from the same server. Only `turn:` / `turns:` addresses are accepted (at most 4); a phone that does
    not know the field ignores it.

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

## Quick actions

From the phone's menu the PC can be locked, put to sleep, restarted or shut down, and launchers the PC owner prepared
can be started, without navigating the remote desktop. This is remote command execution by design, so it is **off by
default** and built so the phone can only *pick* from a list the PC owns. Older hosts ignore `action` (the phone sees no
`actions` in `hello` and shows no chip); older phones never send it.

Messages on `ctl`:

| message | direction | meaning |
|---------|-----------|---------|
| `hello.actions` = `[{"id","label","danger":bool}]` | PC to phone | the actions the phone may use right now: only the enabled ones, **empty** when the master switch is off, when "Allow remote control" is off or when this phone is view only. Missing = not supported. `id` is 1..24 characters of `a-z 0-9 -` |
| `{"t":"actions","list":[...]}` | PC to phone | the same list again, whenever the PC owner changes the master switch, the enabled list or the launchers (or control is switched) during a session |
| `{"t":"action","id":"<id>","confirm":true\|false}` | phone to PC | run the action with this id. `confirm` is optional (false); only `true` counts |
| `{"t":"action-result","id","ok":bool,"reason"}` | PC to phone | the answer. `ok:true`: the process was started (the PC does not wait for it to finish). `reason` when `ok:false`: `disabled`, `unknown`, `view-only`, `rate`, `confirm` or `failed` |

**The phone never sends a command, a path or an argument, only an id.** The PC looks the id up in its own list. A
message whose `id` is not a string of the allowed shape, or that is not an object, is ignored without a reply; a
well-formed id the PC does not have (a launcher removed while the phone still shows it) gets `unknown`. Nothing else in
the message is read.

Built-in actions (fixed ids, fixed argument lists, started with `shell:false` from `System32`, no string building):

| id | label | what runs | default |
|----|-------|-----------|---------|
| `lock` | Lock PC | `rundll32.exe user32.dll,LockWorkStation` | on |
| `sleep` | Sleep | `rundll32.exe powrprof.dll,SetSuspendState 0,1,0` | on |
| `restart` | Restart PC | `shutdown.exe /r /t 15 /c "Glidr Screen"` | **off**, danger |
| `shutdown` | Shut down PC | `shutdown.exe /s /t 15 /c "Glidr Screen"` | **off**, danger |
| `cancel-shutdown` | Cancel shutdown | `shutdown.exe /a` | on whenever `restart` or `shutdown` is on |

Rules the host enforces, in this order, on every `action`:

1. **Known id**, else `unknown` (or ignored, see above).
2. **Master switch** `allowActions` (default **false**) and the action individually enabled by the PC owner, else
   `disabled`. When the master switch is first turned on only `lock` and `sleep` are enabled; `restart`, `shutdown` and
   every launcher must be switched on one by one in the PC app.
3. **Control**: the PC-wide "Allow remote control" must be on and the phone must not be view only, else `view-only`.
4. **Danger** (`restart`, `shutdown`) needs `confirm:true`, else `confirm` and nothing runs. The phone shows its own
   confirmation first. Both start after a **15 s delay** so the PC owner can cancel at the PC (`shutdown /a`), and
   `cancel-shutdown` is available to the phone too. A refused request does not use up the rate limit.
5. **Rate limit**, per paired phone and kept across reconnects: at most one action per **2 s** and **6 per minute**,
   else `rate`.
6. The process is started detached, without a shell, and not waited for; if it cannot be started the answer is `failed`.

**Launchers** are defined **only in the PC app** (never by the phone): up to **12** entries `{id, label, path, args[]}`.
The host generates the `id` (8 lower-case hex digits). `path` is an existing local `.exe`, `.bat`, `.cmd` or `.lnk` file
on a drive letter (no UNC or device paths), or an `https://` URL (no credentials; a URL takes no arguments). Arguments are
stored and passed as an **array**, one string per argument (limits: 16 arguments of at most 512 characters, label at most
40): a path or argument containing `&`, `;`, `|`, `$()`, quotes or `%VAR%` reaches the program as that single argument
and no shell ever sees it. `.exe` is started directly, `.lnk` and URLs are opened with `explorer.exe`. `.bat` / `.cmd`
go through `cmd.exe /d /c <path> <args>`, which parses its own command line, so they are only accepted when the path has
no cmd special characters and every argument is plain (`A-Za-z0-9 . _ : \ / @ + -`, no spaces). New launchers start
switched off. Launcher paths and arguments are never sent to the phone (only `id`, `label`, `danger:false`).

The host logs only the action id and the outcome (at debug level), never a path or an argument.

## Recording

The PC owner can save what the phone is viewing to a video file on the PC. Nothing is recorded by default. Recording
starts only when the PC owner switches on "Record every session on this PC" (setting `recordSessions`, off by default) or
when the phone taps **Record** and the PC owner allows that ("Let the phone start and stop recording", setting
`allowPhoneRecording`, on by default). The phone is always told while it happens, and there is no way to hide it.

PC to phone (on `ctl`):

| message | meaning |
|---------|---------|
| `hello.recording` | `true` when the PC is recording this session from the moment the channel opens, else `false`. Older hosts omit it (treat as `false`) |
| `hello.recctl` | `true` when the PC owner lets this phone start and stop recording (the phone then shows a Record button), else `false`. Older hosts omit it (treat as `false`) |
| `{"t":"recctl","on":bool}` | the PC owner switched that permission during the session. Anything but `"on":true` means "no Record button"; a recording the phone started stops when it is switched off |
| `{"t":"recording","on":bool}` | a recording started or stopped during the session (the PC owner switched the setting, the 2 GB limit was reached, or the PC could not keep recording). Anything but `"on":true` means "not recording" |

Phone to PC (on `ctl`): `{"t":"record","on":bool}`, the Record button. While `allowPhoneRecording` is on the PC starts or
stops recording this session and answers with `recording` (announced before any video is written, like any other
recording); while it is off the PC starts nothing and answers `recording` with what is really happening. Asking to start
twice does not make a second file.

The phone shows a red dot and "PC is recording" over the picture for as long as it is `true`, and resets it when the
session ends. A host that does not record never sends `recording`; a phone that does not know it ignores it (and
then cannot show the tag, so upgrade the phone app before switching recording on).

Privacy rules the host follows:

* Off unless the PC owner switches "Record every session" on, or the phone asks while that is allowed; the settings are
  read from the PC's own settings file and only a real `true` counts for `recordSessions`. Switching either on or off
  applies at once, also in a live session.
* The disclosure comes first: `hello.recording` is `true` in the first message of the session, and `recording` is sent
  when the PC starts recording, before any video is written.
* Files are only ever created in `<Videos>\Glidr` (`app.getPath('videos')`), named `Glidr-<phone name>-<YYYYMMDD-HHMMSS>.webm`
  (the phone name is sanitised like received files: no path characters, no reserved Windows names, at most 40
  characters). A name that exists is never overwritten (`-2`, `-3`, ...). A monitor or window switch continues in
  `...-2.webm`.
* A file stops at 2 GB (the phone is told `recording` `false`), files under 1 KB are deleted, and the file is closed when
  the session ends for any reason: viewer left, time limit, engine crash, app quit.
* The tray tooltip says "Recording", the live card in the control panel shows "Recording", and a tray balloon at the end
  says "Saved a recording of <phone name>" (name only, no path).
* File names and paths are never logged (only at debug level, `GLIDR_DEBUG`).

Inside the PC app: the engine window records the captured screen (and the shared audio) with `MediaRecorder`
(`video/webm;codecs=vp9,opus`, falling back to vp8 and plain `video/webm`; 4 Mbit/s; a chunk every 2 s) beside the WebRTC
sender, so the live stream is not touched. Chunks go to the main process as `rec-chunk` events with a segment number;
the main process answers each with `rec-ack`, and the engine drops chunks while too much is unacknowledged (32 MB).
The recording is a second copy of what the phone sees, at the PC's own capture size: it is not what the phone decoded.

## Phone camera and microphone

The phone can send its **camera** and / or **microphone** to the PC over the connection that is already running. The PC
shows the camera in a window and plays the microphone through an audio output the PC owner chooses. It is **on by
default**, with no approval step: the PC owner can switch it off in the Settings card, and the phone asks its own user for
the Android camera and microphone permissions. Older hosts ignore `renegotiate` (the phone then gets no answer and gives up
after 20 s); older phones never send it.

**This is not a webcam or a microphone device.** Windows cannot expose a network camera or microphone without a
virtual-device driver, and this project ships none. The PC side is a window and an audio output (see the README for
using the window as a webcam through OBS Virtual Camera, and a virtual audio cable as the microphone).

The rendezvous is not involved (it only carries `req`, `offer` and `answer`). The phone is the **offerer** here: it adds
`sendonly` transceivers for the camera video and / or the microphone audio to the existing peer connection, creates a new
offer, waits for ICE gathering to finish (new sections ride on the existing BUNDLE transport, so this is normally
instant) and sends the whole SDP as text on `ctl`. Stopping removes the transceivers and renegotiates the same way.

| message | direction | meaning |
|---------|-----------|---------|
| `{"t":"renegotiate","sdp":"<offer>"}` | phone to PC | a new offer for the running connection |
| `{"t":"renegotiate-answer","sdp":"<answer>"}` | PC to phone | the answer; apply it with `setRemoteDescription` |
| `{"t":"renegotiate-error","reason":"disabled\|busy\|bad-sdp\|failed"}` | PC to phone | refused, nothing changed on the PC. The phone rolls its offer back and switches off what it tried to add |
| `{"t":"media-stop","reason":"pc\|disabled"}` | PC to phone | the PC owner pressed **Stop** (`pc`) or switched the feature off, or the phone became view only (`disabled`). The phone stops capture at once and sends a `renegotiate` that removes its tracks |

Rules the host enforces, in this order, on every `renegotiate`:

1. **One at a time.** While an answer is pending, another `renegotiate` gets `busy`. The engine has 15 s to answer, then
   the phone gets `failed` and may try again.
2. **The SDP is validated** before anything touches the peer connection, else `bad-sdp`: a string of at most **60 KiB**
   (61440 characters; the data channel itself allows 256 KB), printable ASCII plus CR / LF, starting with `v=0`, at most
   8 m-sections, of kind `video`, `audio` and **at most one `application`**, and at most **one video and one audio
   section in which the phone sends** (port not 0, direction `sendonly` or `sendrecv`): the camera and the microphone,
   nothing more. A real re-offer necessarily repeats the sections that already exist (the PC's screen video, the optional
   PC audio, and the data channels as one SCTP section), so those pass; a second `m=application`, `text`, `message` or any
   other kind does not. The SDP is never logged.
3. **Policy**, only for an offer in which the phone sends something: the setting `allowPhoneMedia` ("Allow the phone to
   send its camera and microphone", default **on**), the PC-wide "Allow remote control" and a phone that is not view only
   must all hold, else `disabled`. An offer in which the phone sends nothing (it is stopping) is always answered, so a
   phone is never left half-way through a negotiation.
4. The engine applies it (`setRemoteDescription`, `createAnswer`, `setLocalDescription`, gathering) and the answer is sent
   as `renegotiate-answer`. An answer over 60 KiB or an engine error becomes `failed` (or `bad-sdp` when the offer could not
   be parsed by the engine).

The check is repeated while the camera runs: switching the setting or "Allow remote control" off, or making the phone
view only, immediately stops showing and playing what arrives and sends `media-stop`. The PC owner can also press **Stop**
in the camera window or close it. A phone that keeps sending after `media-stop` is not shown or played (the PC only
attaches tracks to the window when a renegotiation it accepted has just finished); it can only appear again through a new
`renegotiate`, which is refused with `disabled` while the feature is off.

On the PC, incoming tracks that the PC did not create are shown in the engine window, which main shows (titled "Glidr
Screen: phone camera") only while a track arrives: the video in a `<video>` (contain, black background, mirror toggle),
the audio in an `<audio>` element sent to the chosen output with `setSinkId` (remembered as `phoneMediaSink`), with a
mute button and a **Stop** button, under an unmissable "Phone camera" label. The engine renderer owns the peer
connection and a `MediaStream` cannot cross windows, so there is no second window. Nothing on the PC is captured or
recorded; the window needs no capture permission.

On the phone, the camera is Camera2 at 1280x720 and 24 fps (front or back, switchable without renegotiating), the
microphone has echo cancellation, noise suppression and automatic gain control requested. Both are added with
`addTransceiver(track, sendonly)`, never `addTrack` (which could reuse the transceiver that receives the PC's screen).
The Android permissions `CAMERA` and `RECORD_AUDIO` are requested only when the person switches the camera or microphone
on, after saying why. A "Camera on" / "Mic on" tag is shown for as long as capture runs, and everything stops when the
session ends or the app leaves the screen.

## Security model

* Possession of the 128-bit pairing key is the only credential. It is created on the PC, shown on the PC screen, and
  stored on the phone in app-private storage excluded from backup.
* The offer/answer are sealed with that key, so the DTLS fingerprints inside them are authenticated: a rendezvous
  operator or network attacker cannot insert themselves into the media path.
* Remove a phone on the PC and its key stops working immediately. Pairing again generates a new key.
* Not covered: a phone that is stolen *and* unlocked can use its pairing. Use the PC's *Pause sharing* / *Remove*.
