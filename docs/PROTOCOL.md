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
| `busy` / `deny` | h | `sid` | another phone is connected / sharing is paused |
| `bye` | h or p | `sid`, `reason` | end of session |

`from` is `"p"` (phone) or `"h"` (host/PC). Sessions are keyed by `sid`; the host ignores a `sid` it has seen and
requests older than 90 s. A new `req` from the same slot replaces its previous session (reconnect after a network
change). Different slot while a session is live: `busy`.

Non-trickle ICE keeps a connection to **3 rendezvous messages** and the SDP in one frame.

## Media

* PC is the offerer and sends one video track; the phone is receive-only. No audio.
* **24 fps** (`maxFramerate = 24`, capture `maxFrameRate = 24`, `degradationPreference = maintain-framerate`).
* Codec preference H.264 (hardware encode where available), then VP8. Quality presets cap resolution/bitrate:
  `auto` 1080p / 6 Mbit/s, `low` 540p / 1.2, `balanced` 720p / 3, `high` 1440p / 9. Congestion control is WebRTC's own.
* ICE: STUN only (Google, Cloudflare). **No TURN by default**, so media never goes through a relay. A TURN server can
  be added in the host settings file (`turn`) for networks where peer-to-peer is impossible (symmetric NAT on both sides).

## Data channel `ctl` (reliable, ordered, JSON text)

Created by the PC. All coordinates are physical pixels on the PC's virtual desktop.

PC to phone:

| message | meaning |
|---------|---------|
| `{"t":"hello","v":1,"host","os","fps":24,"control":bool,"quality","monitors":[Monitor],"active":id}` | sent when the channel opens |
| `{"t":"monitors","monitors":[...],"active":id}` | layout changed (plugged/unplugged/resolution) |
| `{"t":"active","id","w","h"}` | the shared display changed |
| `{"t":"thumb","id","w","h","jpg":"<base64 JPEG>"}` | preview of one monitor, every 1.5 s while requested |
| `{"t":"pong","n","ts"}` | answer to `ping` |

`Monitor = {id, name, x, y, w, h, scale, primary}`.

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
| `{"t":"quality","p":"auto"/"low"/"balanced"/"high"}` | change preset |
| `{"t":"ping","n","ts"}` | RTT probe |

Input is ignored when the PC has "Allow remote control" off (`hello.control = false`; the phone shows *View only*).
The pointer is confined to the shared display; buttons and keys still held when the session ends are released.

## Security model

* Possession of the 128-bit pairing key is the only credential. It is created on the PC, shown on the PC screen, and
  stored on the phone in app-private storage excluded from backup.
* The offer/answer are sealed with that key, so the DTLS fingerprints inside them are authenticated: a rendezvous
  operator or network attacker cannot insert themselves into the media path.
* Remove a phone on the PC and its key stops working immediately. Pairing again generates a new key.
* Not covered: a phone that is stolen *and* unlocked can use its pairing. Use the PC's *Pause sharing* / *Remove*.
