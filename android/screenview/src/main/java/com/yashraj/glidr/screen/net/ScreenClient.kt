package com.yashraj.glidr.screen.net

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.util.Base64
import android.util.Log
import com.yashraj.glidr.screen.signal.NtfySignaling
import com.yashraj.glidr.screen.signal.PairedPc
import com.yashraj.glidr.screen.signal.SignalEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.AudioTrack
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.security.SecureRandom
import kotlin.math.abs
import kotlin.math.roundToInt

private const val TAG = "GlidrScreen"

sealed interface ConnState {
    data object Idle : ConnState
    data class Connecting(val step: String) : ConnState
    data object Live : ConnState
    data class Reconnecting(val attempt: Int) : ConnState
    data class Failed(val reason: String) : ConnState
}

data class LinkStats(val fps: Int, val w: Int, val h: Int, val mbps: Float, val path: String)

/** The session ended in a way that must not be retried automatically. */
private class Fatal(message: String) : Exception(message)

/** The PC never replied to the request (not running, paired pairing removed, wrong signaling server). */
private class NoAnswer(message: String) : Exception(message)

/**
 * One viewing session with a paired PC: signaling handshake, WebRTC peer connection (video receiver + `ctl` data
 * channel), auto-reconnect, and the remote-control API. The PC is the offerer, see docs/PROTOCOL.md.
 */
class ScreenClient(
    context: Context,
    private val pc: PairedPc,
    private val scope: CoroutineScope,
    private val iceUrls: List<String> = DEFAULT_STUN,
) {
    private val appContext = context.applicationContext
    private val signaling = NtfySignaling(pc.signalBase, pc.keyBytes)

    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state.asStateFlow()
    private val _video = MutableStateFlow<VideoTrack?>(null)
    val videoTrack: StateFlow<VideoTrack?> = _video.asStateFlow()
    private val _monitors = MutableStateFlow<List<Monitor>>(emptyList())
    val monitors: StateFlow<List<Monitor>> = _monitors.asStateFlow()
    private val _active = MutableStateFlow<Long?>(null)
    val activeMonitor: StateFlow<Long?> = _active.asStateFlow()
    private val _switching = MutableStateFlow(false)
    val switching: StateFlow<Boolean> = _switching.asStateFlow()
    private val _thumbs = MutableStateFlow<Map<Long, Bitmap>>(emptyMap())
    val thumbs: StateFlow<Map<Long, Bitmap>> = _thumbs.asStateFlow()
    private val _stats = MutableStateFlow<LinkStats?>(null)
    val stats: StateFlow<LinkStats?> = _stats.asStateFlow()
    private val _rtt = MutableStateFlow<Int?>(null)
    val rttMs: StateFlow<Int?> = _rtt.asStateFlow()
    private val _control = MutableStateFlow(true)
    /** False when the PC has "Allow remote control" switched off (view only). */
    val controlAllowed: StateFlow<Boolean> = _control.asStateFlow()
    private val _quality = MutableStateFlow(Quality.Auto)
    val quality: StateFlow<Quality> = _quality.asStateFlow()
    private val _hostName = MutableStateFlow(pc.name)
    val hostName: StateFlow<String> = _hostName.asStateFlow()
    private val _videoSize = MutableStateFlow(0 to 0)
    /** Decoded video size in pixels (0 to 0 until the first frame). */
    val videoSize: StateFlow<Pair<Int, Int>> = _videoSize.asStateFlow()

    private val _locked = MutableStateFlow(false)
    /** True while the PC is locked (the lock screen cannot be captured or controlled). Reset when the session ends. */
    val hostLocked: StateFlow<Boolean> = _locked.asStateFlow()
    private val _cursor = MutableStateFlow<Pair<Float, Float>?>(null)
    /** PC pointer position, 0..1 inside the shared display; null until the first `cur` after [setCursorStream] is on. */
    val cursor: StateFlow<Pair<Float, Float>?> = _cursor.asStateFlow()
    private val _incomingClip = MutableSharedFlow<String>(extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    /** Every text the PC pushed (only while [clipboardSync] is on). Never logged. */
    val incomingClipboard: SharedFlow<String> = _incomingClip.asSharedFlow()
    private val _lastClip = MutableStateFlow<String?>(null)
    /** The newest text received from the PC, kept in memory only until the session ends. */
    val lastPcClipboard: StateFlow<String?> = _lastClip.asStateFlow()
    private val _clipSync = MutableStateFlow(false)
    /** What the phone asked for with [setClipboardSync]; asked again after a reconnect. */
    val clipboardSync: StateFlow<Boolean> = _clipSync.asStateFlow()
    private val _audioActive = MutableStateFlow(false)
    /** True while the PC is sharing audio and its track arrived. */
    val audioActive: StateFlow<Boolean> = _audioActive.asStateFlow()
    private val _audioMuted = MutableStateFlow(false)
    /** The phone's own mute switch for the PC audio. Kept across reconnects. */
    val audioMuted: StateFlow<Boolean> = _audioMuted.asStateFlow()
    private val _fps = MutableStateFlow(DEFAULT_FPS)
    /** Frame rate the PC streams at, from `hello` or the last [setStreamQuality]. */
    val fps: StateFlow<Int> = _fps.asStateFlow()
    private val _saver = MutableStateFlow(false)
    /** Data saver as last asked for with [setStreamQuality]. */
    val dataSaver: StateFlow<Boolean> = _saver.asStateFlow()
    private val _mode = MutableStateFlow(StreamMode.Auto)
    /** What the encoder favours, as last asked for with [setStreamMode] / [setStreamQuality]. */
    val streamMode: StateFlow<StreamMode> = _mode.asStateFlow()
    /** Null until the user picks a mode: until then the `quality` messages keep the old shape without `mode`. */
    @Volatile private var chosenMode: StreamMode? = null
    @Volatile private var audioTrack: AudioTrack? = null
    @Volatile private var wantCursor = false
    /** The stream settings the user picked this session; re-sent after a reconnect, null until they pick one. */
    @Volatile private var chosenStream: Triple<Quality, Int?, Boolean?>? = null

    private val _stage = MutableStateFlow("")
    /** The furthest point the current (or last) connection attempt reached, see [ConnectStages]; empty at the start of each attempt. */
    val stage: StateFlow<String> = _stage.asStateFlow()

    private val _diag = MutableStateFlow("")
    /** One line of connection diagnostics (candidate types, ICE state), shown while connecting. */
    val diag: StateFlow<String> = _diag.asStateFlow()
    private val localTypes = java.util.concurrent.ConcurrentHashMap<String, Int>()
    private var remoteSummary = ""
    @Volatile private var iceState = "new"
    @Volatile private var gatherState = "new"
    private var job: Job? = null
    @Volatile private var currentSid: String? = null
    /** True once this client has been live; only then is a new attempt a "reconnect" rather than a first try. */
    @Volatile private var wasLive = false
    private var pcon: PeerConnection? = null
    @Volatile private var dc: DataChannel? = null
    @Volatile private var wantThumbs = false
    private var pingN = 0

    private val accLock = Any()
    private var accDx = 0f
    private var accDy = 0f
    private var accWx = 0f
    private var accWy = 0f

    // ------------------------------------------------------------------ lifecycle

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch { runLoop() }
    }

    fun retry() {
        job?.cancel()
        wasLive = false
        start()
    }

    fun close() {
        val j = job
        job = null
        j?.cancel()
        _state.value = ConnState.Idle
        teardown()
        currentSid?.let { sid ->
            CoroutineScope(Dispatchers.IO).launch {
                runCatching { signaling.publish(JSONObject().put("t", "bye").put("from", "p").put("sid", sid).put("ts", System.currentTimeMillis())) }
            }
        }
        currentSid = null
    }

    /** "Connection lost" is only true after a live session; before that the PC simply has not answered yet. */
    private fun waitingState(attempt: Int): ConnState = when {
        wasLive -> ConnState.Reconnecting(attempt)
        attempt == 0 -> ConnState.Connecting("Waiting for the PC")
        else -> ConnState.Connecting("Still waiting for the PC (try ${attempt + 1})")
    }

    private suspend fun runLoop() {
        var attempt = 0
        var noAnswers = 0
        _state.value = ConnState.Connecting("Contacting PC")
        while (scope.isActive) {
            try {
                connectOnce(attempt)
                // returned normally: connection dropped after being live
                attempt = 1
                noAnswers = 0
            } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
                teardown(); attempt++
                if (attempt > MAX_ATTEMPTS) { _state.value = ConnState.Failed("Timed out"); return }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Fatal) {
                teardown()
                _state.value = ConnState.Failed(e.message ?: "Connection ended")
                return
            } catch (e: NoAnswer) {
                // Silence will not fix itself: one retry covers a slow PC, then say what to check.
                teardown()
                attempt++
                if (++noAnswers >= NO_ANSWER_ATTEMPTS) {
                    _state.value = ConnState.Failed(e.message ?: "The PC did not answer")
                    return
                }
            } catch (e: Exception) {
                Log.w(TAG, "attempt $attempt failed", e)
                teardown()
                attempt++
                if (attempt > MAX_ATTEMPTS) {
                    _state.value = ConnState.Failed(friendly(e))
                    return
                }
            }
            teardown()
            _state.value = waitingState(attempt)
            delay(minOf(1_000L shl (attempt - 1).coerceIn(0, 4), 15_000L))
        }
    }

    private fun friendly(e: Exception): String = when (e) {
        is kotlinx.coroutines.TimeoutCancellationException -> e.message ?: "Timed out"
        is java.net.UnknownHostException, is java.net.ConnectException, is java.net.SocketTimeoutException ->
            "No internet connection"
        else -> e.message ?: "Connection failed"
    }

    private suspend fun connectOnce(attempt: Int) = coroutineScope {
        val sid = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        currentSid = sid
        _stage.value = ""
        val inbox = Channel<JSONObject>(Channel.UNLIMITED)
        val opened = CompletableDeferred<Unit>()
        val sigJob = launch {
            while (isActive) {
                try {
                    signaling.events().collect { ev ->
                        when (ev) {
                            SignalEvent.Open -> opened.complete(Unit)
                            is SignalEvent.Message -> if (ev.json.optString("from") == "h" && ev.json.optString("sid") == sid) inbox.trySend(ev.json)
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // before the first Open this attempt cannot proceed; afterwards the live session must not depend on it
                    if (!opened.isCompleted) { opened.completeExceptionally(e); return@launch }
                }
                delay(2_000)
            }
        }
        try {
            if (attempt == 0) _state.value = ConnState.Connecting("Contacting PC")
            withTimeoutOrNull(15_000) { opened.await() } ?: throw Exception("Could not reach the signaling server. Check your internet connection.")
            _stage.value = ConnectStages.SIGNALING
            signaling.publish(
                JSONObject().put("t", "req").put("from", "p").put("sid", sid).put("ts", System.currentTimeMillis())
                    .put("n", deviceName()),
            )
            _stage.value = ConnectStages.REQUEST_SENT
            _state.value = waitingState(attempt)

            val offer = withTimeoutOrNull(25_000) {
                var found: JSONObject? = null
                while (found == null) {
                    val m = inbox.receive()
                    when (m.optString("t")) {
                        "offer" -> found = m
                        "busy" -> throw Fatal("Another phone is using this PC right now")
                        // the PC gave up before it could send an offer (for example the screen could not be captured)
                        "bye" -> throw Fatal(
                            m.optString("reason").let { why -> if (why.isBlank()) "The PC ended the session" else "The PC could not start the session ($why)" },
                        )
                        "deny" -> throw Fatal(
                            when (val why = m.optString("reason")) {
                                "", "paused" -> "Sharing is paused on the PC"
                                "no display" -> "The PC has no display to share"
                                else -> "The PC refused the connection ($why)"
                            },
                        )
                    }
                }
                found
            } ?: throw NoAnswer(
                "The PC did not answer. Check that Glidr Screen is running on it and online. If it still fails, " +
                    "this phone may have been removed on the PC, or the PC's signaling server changed: pair again.",
            )
            _stage.value = ConnectStages.OFFER
            applyHostName(offer.optString("host"))
            localTypes.clear(); iceState = "new"; gatherState = "new"
            remoteSummary = summary(Regex("a=candidate:.* typ ([a-z]+)").findAll(offer.getString("sdp")).groupingBy { it.groupValues[1] }.eachCount())
            updateDiag()

            _state.value = ConnState.Connecting("Opening a direct connection")
            val ended = CompletableDeferred<String>()
            val connected = CompletableDeferred<Unit>()
            val gathered = CompletableDeferred<Unit>()
            val peer = createPeer(ended, connected, gathered)
            pcon = peer
            setRemote(peer, SessionDescription(SessionDescription.Type.OFFER, offer.getString("sdp")))
            val answer = createAnswer(peer)
            setLocal(peer, answer)
            withTimeoutOrNull(4_000) { gathered.await() }
            val sdp = peer.localDescription.description
            signaling.publish(JSONObject().put("t", "answer").put("from", "p").put("sid", sid).put("ts", System.currentTimeMillis()).put("sdp", sdp))

            val bye = launch {
                for (m in inbox) {
                    if (m.optString("t") == "bye") {
                        ended.complete("bye:" + m.optString("reason"))
                        break
                    }
                }
            }
            try {
                withTimeout(30_000) { connected.await() }
            } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
                throw Exception(
                    "Could not open a direct connection. Both networks may block peer-to-peer traffic; " +
                        "try Wi-Fi on either side, or another network.",
                )
            }
            wasLive = true
            _stage.value = ConnectStages.DIRECT
            _state.value = ConnState.Live
            val workers = launch { runWorkers() }
            val network = watchNetwork { ended.complete("network") }
            val reason = try { ended.await() } finally {
                workers.cancel(); bye.cancel(); network()
            }
            Log.i(TAG, "session ended: $reason")
            if (reason.startsWith("bye:")) {
                val why = reason.removePrefix("bye:")
                throw Fatal(if (why.isBlank()) "The PC ended the session" else "The PC ended the session ($why)")
            }
        } finally {
            sigJob.cancel()
            inbox.close()
        }
    }

    private fun summary(m: Map<String, Int>) = listOf("host", "srflx", "relay").joinToString(" ") { "$it ${m[it] ?: 0}" }

    private fun updateDiag() {
        _diag.value = "You: ${summary(localTypes)} | PC: $remoteSummary | gather $gatherState | ICE $iceState"
        Log.i(TAG, _diag.value)
    }

    private fun applyHostName(name: String) { if (name.isNotBlank()) _hostName.value = name }

    private fun deviceName() = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".take(48)

    private fun teardown() {
        val peer = pcon
        pcon = null
        dc = null
        _video.value = null
        _stats.value = null
        _rtt.value = null
        _switching.value = false
        _locked.value = false
        _cursor.value = null
        _lastClip.value = null
        _audioActive.value = false
        audioTrack = null
        if (peer != null) {
            // give the renderer a moment to detach its sink before the native objects go away
            CoroutineScope(Dispatchers.Default).launch {
                delay(400)
                runCatching { peer.close(); peer.dispose() }
            }
        }
    }

    // ------------------------------------------------------------------ peer connection

    private fun createPeer(ended: CompletableDeferred<String>, connected: CompletableDeferred<Unit>, gathered: CompletableDeferred<Unit>): PeerConnection {
        val factory = WebRtcRuntime.factory(appContext)
        val cfg = PeerConnection.RTCConfiguration(listOf(PeerConnection.IceServer.builder(iceUrls).createIceServer())).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        var graceJob: Job? = null
        val observer = object : PeerConnection.Observer {
            override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) { iceState = s?.name?.lowercase() ?: "?"; updateDiag() }
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {
                gatherState = s?.name?.lowercase() ?: "?"
                updateDiag()
                if (s == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit)
            }
            override fun onIceCandidate(c: IceCandidate?) {
                val type = Regex(" typ ([a-z]+)").find(c?.sdp ?: "")?.groupValues?.get(1) ?: return
                localTypes.merge(type, 1, Int::plus)
                updateDiag()
            }
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
            override fun onAddStream(s: MediaStream?) {}
            override fun onRemoveStream(s: MediaStream?) {}
            override fun onRenegotiationNeeded() {}
            override fun onDataChannel(ch: DataChannel) {
                dc = ch
                ch.registerObserver(object : DataChannel.Observer {
                    override fun onBufferedAmountChange(previous: Long) {}
                    override fun onStateChange() {
                        if (ch.state() == DataChannel.State.CLOSED) ended.complete("channel closed")
                    }
                    override fun onMessage(buffer: DataChannel.Buffer) {
                        if (buffer.binary) return
                        val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                        handleCtl(String(bytes, Charsets.UTF_8))
                    }
                })
            }
            override fun onConnectionChange(s: PeerConnection.PeerConnectionState) {
                when (s) {
                    PeerConnection.PeerConnectionState.CONNECTED -> { graceJob?.cancel(); connected.complete(Unit) }
                    PeerConnection.PeerConnectionState.DISCONNECTED -> {
                        // replace, never stack: an orphaned timer would end the session after it recovered
                        graceJob?.cancel()
                        graceJob = scope.launch { delay(8_000); ended.complete("disconnected") }
                    }
                    PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED -> {
                        if (!connected.isCompleted) connected.completeExceptionally(Exception("Connection failed"))
                        ended.complete("failed")
                    }
                    else -> {}
                }
            }
            override fun onTrack(t: RtpTransceiver) {
                val track = t.receiver.track()
                if (track is VideoTrack) _video.value = track
                if (track is AudioTrack) {
                    track.setEnabled(!_audioMuted.value)
                    audioTrack = track
                    _audioActive.value = true
                }
            }
        }
        return factory.createPeerConnection(cfg, observer) ?: throw Exception("WebRTC is unavailable on this device")
    }

    private suspend fun setRemote(p: PeerConnection, d: SessionDescription) = suspendCancellableCoroutine { c ->
        p.setRemoteDescription(sdpObserver({ c.resumeWith(Result.success(Unit)) }, { c.resumeWith(Result.failure(Exception(it))) }), d)
    }

    private suspend fun setLocal(p: PeerConnection, d: SessionDescription) = suspendCancellableCoroutine { c ->
        p.setLocalDescription(sdpObserver({ c.resumeWith(Result.success(Unit)) }, { c.resumeWith(Result.failure(Exception(it))) }), d)
    }

    private suspend fun createAnswer(p: PeerConnection): SessionDescription = suspendCancellableCoroutine { c ->
        p.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) = c.resumeWith(Result.success(d))
            override fun onCreateFailure(e: String?) = c.resumeWith(Result.failure(Exception(e ?: "createAnswer failed")))
            override fun onSetSuccess() {}
            override fun onSetFailure(e: String?) {}
        }, MediaConstraints())
    }

    private fun sdpObserver(ok: () -> Unit, fail: (String) -> Unit) = object : SdpObserver {
        override fun onCreateSuccess(d: SessionDescription?) {}
        override fun onCreateFailure(e: String?) {}
        override fun onSetSuccess() = ok()
        override fun onSetFailure(e: String?) = fail(e ?: "SDP error")
    }

    // ------------------------------------------------------------------ background workers while live

    private suspend fun runWorkers() = coroutineScope {
        launch { // pointer batching at ~60 Hz with back-pressure
            while (isActive) {
                delay(16)
                flushPointer()
            }
        }
        launch { // RTT over the data channel
            while (isActive) {
                send(Msg.ping(++pingN, System.currentTimeMillis()))
                delay(2_000)
            }
        }
        launch { // link statistics
            var lastBytes = 0.0
            var lastTs = 0.0
            while (isActive) {
                delay(1_000)
                val p = pcon ?: break
                p.getStats { report ->
                    var fps = 0; var w = 0; var h = 0; var bytes = 0.0; var ts = 0.0
                    var pairIds: List<String?> = emptyList()
                    val map = report.statsMap
                    for (s in map.values) {
                        val m = s.members
                        if (s.type == "inbound-rtp" && m["kind"] == "video") {
                            fps = (m["framesPerSecond"] as? Number)?.toDouble()?.roundToInt() ?: 0
                            w = (m["frameWidth"] as? Number)?.toInt() ?: 0
                            h = (m["frameHeight"] as? Number)?.toInt() ?: 0
                            bytes = (m["bytesReceived"] as? Number)?.toDouble() ?: 0.0
                            ts = s.timestampUs / 1000.0
                        }
                        if (s.type == "candidate-pair" && m["nominated"] == true && m["state"] == "succeeded") {
                            pairIds = listOf(m["localCandidateId"] as? String, m["remoteCandidateId"] as? String)
                        }
                    }
                    // relayed when either end of the selected pair is a TURN candidate (the PC may have one configured)
                    val relayed = pairIds.any { id -> id != null && map[id]?.members?.get("candidateType") == "relay" }
                    val mbps = if (lastTs > 0 && ts > lastTs) ((bytes - lastBytes) * 8 / ((ts - lastTs) / 1000.0) / 1_000_000.0).toFloat() else 0f
                    lastBytes = bytes; lastTs = ts
                    if (w > 0) {
                        _stats.value = LinkStats(fps, w, h, mbps, if (relayed) "relay" else "direct")
                        _videoSize.value = w to h
                    }
                }
            }
        }
        if (wantThumbs) send(Msg.thumbs(true))
    }

    // ------------------------------------------------------------------ host -> phone

    private fun handleCtl(text: String) {
        val m = try { JSONObject(text) } catch (_: Exception) { return }
        when (m.optString("t")) {
            "hello" -> {
                _monitors.value = Monitor.parseAll(m.optJSONArray("monitors"))
                _active.value = m.optLong("active")
                _control.value = m.optBoolean("control", true)
                _quality.value = Quality.of(m.optString("quality"))
                applyHostName(m.optString("host"))
                val extras = HostEvents.helloExtras(m)
                extras.locked?.let { _locked.value = it }
                extras.fps?.let { _fps.value = it }
                if (extras.audio == false) _audioActive.value = false
                resendWishes()
            }
            "monitors" -> {
                _monitors.value = Monitor.parseAll(m.optJSONArray("monitors"))
                if (m.has("active")) _active.value = m.optLong("active")
            }
            "control" -> _control.value = m.optBoolean("on", true)
            "active" -> {
                _active.value = m.optLong("id")
                _switching.value = false
                _videoSize.value = m.optInt("w") to m.optInt("h")
            }
            "thumb" -> scope.launch(Dispatchers.Default) {
                val bytes = Base64.decode(m.optString("jpg"), Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { bmp ->
                    _thumbs.update { it + (m.optLong("id") to bmp) }
                }
            }
            "pong" -> _rtt.value = (System.currentTimeMillis() - m.optLong("ts")).toInt().coerceAtLeast(0)
            else -> when (val ev = HostEvents.parse(m)) {
                is HostEvent.Locked -> _locked.value = ev.on
                is HostEvent.Cursor -> if (wantCursor) _cursor.value = ev.x to ev.y
                is HostEvent.Clip -> if (_clipSync.value) { _lastClip.value = ev.text; _incomingClip.tryEmit(ev.text) }
                null -> {}
            }
        }
    }

    /** A new data channel starts from the host's defaults, so ask again for what the user switched on. */
    private fun resendWishes() {
        if (wantCursor) send(Msg.curs(true))
        if (_clipSync.value) send(Msg.clipsync(true))
        chosenStream?.let { (q, fps, saver) ->
            _quality.value = q
            fps?.let { _fps.value = it }
            send(Msg.quality(q, fps, saver, chosenMode))
        }
    }

    // ------------------------------------------------------------------ phone -> host

    fun send(msg: JSONObject): Boolean {
        val ch = dc ?: return false
        if (ch.state() != DataChannel.State.OPEN) return false
        return ch.send(DataChannel.Buffer(ByteBuffer.wrap(msg.toString().toByteArray()), false))
    }

    /** Relative pointer movement in PC pixels; batched and back-pressured, fractions are kept. */
    fun moveBy(dx: Float, dy: Float) = synchronized(accLock) { accDx += dx; accDy += dy }

    /** Scroll in wheel notches (+y = content moves down). */
    fun scrollBy(x: Float, y: Float) = synchronized(accLock) { accWx += x; accWy += y }

    private fun flushPointer() {
        val ch = dc ?: return
        if (ch.bufferedAmount() > 32 * 1024) return // congested: keep accumulating instead of queueing stale moves
        var mx = 0; var my = 0; var wx = 0f; var wy = 0f
        synchronized(accLock) {
            mx = accDx.toInt(); my = accDy.toInt()
            accDx -= mx; accDy -= my
            if (abs(accWx) >= 0.04f || abs(accWy) >= 0.04f) { wx = accWx; wy = accWy; accWx = 0f; accWy = 0f }
        }
        if (mx != 0 || my != 0) send(Msg.move(mx, my))
        if (wx != 0f || wy != 0f) send(Msg.wheel(wx, wy))
    }

    fun click(b: MouseButton = MouseButton.Left) = send(Msg.button(b, "c"))
    fun buttonDown(b: MouseButton) = send(Msg.button(b, "d"))
    fun buttonUp(b: MouseButton) = send(Msg.button(b, "u"))
    fun moveAbsolute(nx: Float, ny: Float) = send(Msg.absolute(nx.coerceIn(0f, 1f), ny.coerceIn(0f, 1f)))
    fun key(name: String) = send(Msg.key(name))
    fun combo(keys: List<String>) = send(Msg.combo(keys))
    fun typeText(s: String) = if (s.isNotEmpty()) send(Msg.text(s)) else false

    fun switchMonitor(id: Long) {
        if (id == _active.value) return
        _switching.value = true
        send(Msg.monitor(id))
        scope.launch { delay(8_000); _switching.value = false } // never leave the spinner stuck
    }

    fun setThumbnails(on: Boolean) {
        wantThumbs = on
        send(Msg.thumbs(on))
    }

    fun setQuality(q: Quality) {
        _quality.value = q
        val prev = chosenStream
        chosenStream = Triple(q, prev?.second, prev?.third)
        send(Msg.quality(q, prev?.second, prev?.third, chosenMode))
    }

    /**
     * Quality preset plus frame rate (one of [FPS_OPTIONS]) and data saver in one message. [mode] (default: keep the
     * current choice, Auto until one is made) is sent along once the user has picked a mode.
     */
    fun setStreamQuality(q: Quality, fps: Int, saver: Boolean, mode: StreamMode? = null) {
        val f = if (fps in FPS_OPTIONS) fps else DEFAULT_FPS
        if (mode != null) { chosenMode = mode; _mode.value = mode }
        _quality.value = q
        _fps.value = f
        _saver.value = saver
        chosenStream = Triple(q, f, saver)
        send(Msg.quality(q, f, saver, chosenMode))
    }

    /** Auto / Fast (latency) / Sharp (clarity): what the PC encoder favours. Re-sent after a reconnect. */
    fun setStreamMode(mode: StreamMode) {
        chosenMode = mode
        _mode.value = mode
        val prev = chosenStream
        chosenStream = Triple(_quality.value, prev?.second, prev?.third)
        send(Msg.quality(_quality.value, prev?.second, prev?.third, mode))
    }

    /**
     * Puts [text] on the PC clipboard. Text over [ClipLimits] is cut first (the caller tells the user, see
     * [ClipLimits.cap]). Returns false when nothing was sent. The text is never logged.
     */
    fun sendClipboard(text: String): Boolean {
        val capped = ClipLimits.cap(text).text
        return capped.isNotEmpty() && send(Msg.clip(capped))
    }

    /** Ask the PC to push its clipboard text changes while [on]. */
    fun setClipboardSync(on: Boolean) {
        _clipSync.value = on
        if (!on) _lastClip.value = null
        send(Msg.clipsync(on))
    }

    /** Start or stop the PC cursor position stream. Turn it off whenever nothing uses it. */
    fun setCursorStream(on: Boolean) {
        wantCursor = on
        if (!on) _cursor.value = null
        send(Msg.curs(on))
    }

    /** Silences (or restores) the PC audio on this phone only. */
    fun setAudioMuted(muted: Boolean) {
        _audioMuted.value = muted
        runCatching { audioTrack?.setEnabled(!muted) }
    }

    // ------------------------------------------------------------------ network changes

    /** Calls [onChange] when the default network switches (Wi-Fi <-> mobile), returns an unregister function. */
    private fun watchNetwork(onChange: () -> Unit): () -> Unit {
        val cm = appContext.getSystemService(ConnectivityManager::class.java) ?: return {}
        var first: Network? = null
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val f = first
                if (f == null) first = network else if (f != network) onChange()
            }
        }
        return try {
            cm.registerDefaultNetworkCallback(cb)
            ({ runCatching { cm.unregisterNetworkCallback(cb) } })
        } catch (_: Exception) {
            {}
        }
    }

    companion object {
        val DEFAULT_STUN = listOf("stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478")
        private const val MAX_ATTEMPTS = 4
        private const val NO_ANSWER_ATTEMPTS = 2
    }
}
