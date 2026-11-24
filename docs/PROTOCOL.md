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
| `busy` / `deny` | h | `sid`, `reason` (deny: `paused` or `no display`) | another phone is connected / connection refused |
| `bye` | h or p | `sid`, `reason` | end of session |

`from` is `"p"` (phone) or `"h"` (host/PC). Sessions are keyed by `sid`; the host ignores a `sid` it has seen and
requests older than 90 s. A new `req` from the same slot replaces its previous session (reconnect after a network
change). Different slot while a session is live: `busy`.

Non-trickle ICE keeps a connection to **3 rendezvous messages** and the SDP in one frame.

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

## Security model

* Possession of the 128-bit pairing key is the only credential. It is created on the PC, shown on the PC screen, and
  stored on the phone in app-private storage excluded from backup.
* The offer/answer are sealed with that key, so the DTLS fingerprints inside them are authenticated: a rendezvous
  operator or network attacker cannot insert themselves into the media path.
* Remove a phone on the PC and its key stops working immediately. Pairing again generates a new key.
* Not covered: a phone that is stolen *and* unlocked can use its pairing. Use the PC's *Pause sharing* / *Remove*.
