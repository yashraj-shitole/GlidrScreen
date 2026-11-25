package com.yashraj.glidr.screen.net

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraEnumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

// ---------------------------------------------------------------------------------------------------------------------
// Camera and microphone to the PC (docs/PROTOCOL.md, "Phone camera and microphone").
//
// The phone is the offerer: it adds sendonly camera / microphone transceivers to the running peer connection, sends the
// new offer over `ctl` and applies the PC's answer. This file has three parts:
//   * PhoneMediaState, MediaNote, PhoneMediaText: what the sheet and the viewer tag show (pure);
//   * PhoneMediaSession: the state machine for start / stop / renegotiate behind an injected PhoneMediaPort (pure, tested);
//   * PhoneMediaGlue: the port on top of libwebrtc (camera capturer, audio source, tracks, offer / answer).
// Nothing starts on its own: only the Camera and mic sheet calls in here, and everything stops with the session.
// ---------------------------------------------------------------------------------------------------------------------

/** Largest SDP the PC accepts over the data channel (see the PC's phonemedia.js); a bigger offer is not even sent. */
const val PHONE_MEDIA_MAX_SDP = 60 * 1024

enum class MediaPhase { Idle, Starting, Sending, Stopping }

/** Why something is not (or no longer) running. [PhoneMediaText.note] turns it into words for the person holding the phone. */
enum class MediaNote {
    None,
    PcOff, // the PC owner has this switched off (`disabled`)
    PcBusy, // the PC was still busy with an earlier change (`busy`)
    PcStopped, // the PC asked us to stop (`media-stop`): Stop pressed in its window, or the owner switched it off
    BadOffer, // the PC could not read our offer
    Timeout, // no answer in time
    NoCamera, // no camera, or it stopped working
    Denied, // Android permission refused
    NotConnected,
    Failed,
    Background, // the app left the screen
    StopUnconfirmed, // stopped here, the PC did not confirm
}

/**
 * What the sheet shows and the viewer tag reflects. [camera] / [microphone] say what is switched on right now (so the
 * "Camera on" tag is visible from the moment capture starts until it has stopped); [phase] says whether the PC has
 * confirmed it. [front] is the chosen camera and is kept while the camera is off.
 */
data class PhoneMediaState(
    val camera: Boolean = false,
    val microphone: Boolean = false,
    val front: Boolean = true,
    val phase: MediaPhase = MediaPhase.Idle,
    val note: MediaNote = MediaNote.None,
) {
    val on: Boolean get() = camera || microphone
}

/** The words of the sheet and the tag. Pure so they are tested. */
object PhoneMediaText {
    /** The persistent tag in the viewer while anything is on, or null. Never hidden while capture runs. */
    fun tag(s: PhoneMediaState): String? = when {
        s.camera && s.microphone -> "Camera and mic on"
        s.camera -> "Camera on"
        s.microphone -> "Mic on"
        else -> null
    }

    fun status(s: PhoneMediaState): String = when {
        s.note != MediaNote.None -> note(s.note)
        s.phase == MediaPhase.Starting -> "Starting..."
        s.phase == MediaPhase.Stopping -> "Stopping..."
        s.phase == MediaPhase.Sending && s.on -> "Sending to the PC"
        else -> "Off. Nothing is sent."
    }

    fun note(n: MediaNote): String = when (n) {
        MediaNote.None -> ""
        MediaNote.PcOff -> "The PC has this switched off"
        MediaNote.PcBusy -> "The PC is busy, try again in a moment"
        MediaNote.PcStopped -> "The PC stopped it"
        MediaNote.BadOffer -> "The PC could not use this. Update Glidr Screen on the PC"
        MediaNote.Timeout -> "The PC did not answer"
        MediaNote.NoCamera -> "The camera is not available"
        MediaNote.Denied -> "Android did not allow it"
        MediaNote.NotConnected -> "Not connected to the PC"
        MediaNote.Failed -> "That did not work"
        MediaNote.Background -> "Stopped because the app left the screen"
        MediaNote.StopUnconfirmed -> "Stopped here. The PC did not confirm it"
    }

    /** What is said before Android asks, so the system dialog is never a surprise. */
    fun explain(camera: Boolean, microphone: Boolean): String {
        val what = when {
            camera && microphone -> "your camera and microphone"
            camera -> "your camera"
            else -> "your microphone"
        }
        return "Glidr Screen needs $what to send ${if (camera && microphone) "them" else "it"} to your PC. " +
            "Android will ask you next. It is only used while \"${if (camera && microphone) "Camera and mic on" else if (camera) "Camera on" else "Mic on"}\" shows on this screen."
    }

    const val DENIED_HELP = "Permission was not given. You can allow it in the Android settings for this app."
}

/** The PC's answer to a `renegotiate`, or its request to stop. */
sealed interface MediaMessage {
    data class Answer(val sdp: String) : MediaMessage
    data class Error(val note: MediaNote) : MediaMessage
    data object Stop : MediaMessage

    companion object {
        /** Tolerant: anything that is not one of the three messages (or an answer that is empty or too large) gives null or an [Error]. */
        fun parse(m: JSONObject): MediaMessage? = when (m.optString("t")) {
            "renegotiate-answer" -> {
                val sdp = m.opt("sdp") as? String
                if (sdp.isNullOrEmpty() || sdp.length > PHONE_MEDIA_MAX_SDP) Error(MediaNote.BadOffer) else Answer(sdp)
            }
            "renegotiate-error" -> Error(
                when (m.opt("reason") as? String) {
                    "disabled" -> MediaNote.PcOff
                    "busy" -> MediaNote.PcBusy
                    "bad-sdp" -> MediaNote.BadOffer
                    else -> MediaNote.Failed
                },
            )
            "media-stop" -> Stop
            else -> null
        }
    }
}

/** What the local tracks should be. */
data class MediaWant(val camera: Boolean, val microphone: Boolean, val front: Boolean)

/** A problem the port can name; the session shows [note]. */
class MediaFailure(val note: MediaNote, message: String? = null) : Exception(message ?: note.name)

/** Everything the session needs from libwebrtc and the data channel. Faked in the tests. */
interface PhoneMediaPort {
    /** Makes the local tracks match [want] (starts capture for new ones, removes the others) and returns the finished offer. */
    suspend fun prepareOffer(want: MediaWant): String

    /** Sends the offer to the PC; false when the data channel is not open. */
    fun sendOffer(sdp: String): Boolean

    /** Applies the PC's answer. Throws when it cannot be applied. */
    suspend fun acceptAnswer(sdp: String)

    /** The offer was not completed: roll it back and drop every local track that is not in [keep]. */
    suspend fun abandon(keep: MediaWant)

    /** Switches the running camera between front and back without renegotiating. */
    fun switchCamera(front: Boolean)

    /**
     * Stops the camera and / or the microphone at once (the tracks stay until the next offer removes them; a halted one
     * is started afresh by the next [prepareOffer] that wants it). Never blocks.
     */
    fun halt(camera: Boolean = true, microphone: Boolean = true)

    /** Stops and frees everything. The connection is going away, nothing is negotiated. Never blocks. */
    fun release()

    /** Set by the session: called when the camera stops by itself (unplugged, taken by another app, error). */
    var onCaptureFailed: ((MediaNote) -> Unit)?
}

/**
 * Start / stop / renegotiate. One negotiation at a time; asking for more while one runs is folded into the next one.
 *
 * Failure rule: whatever a failed negotiation was meant to add is switched off again and the reason is shown; what was
 * already running and still wanted stays. A stop never needs the PC: capture is halted at once ([PhoneMediaPort.halt]),
 * the renegotiation only tidies up the PC's window afterwards.
 */
class PhoneMediaSession(
    private val scope: CoroutineScope,
    private val port: PhoneMediaPort,
    private val replyTimeoutMs: Long = REPLY_TIMEOUT_MS,
) {
    private val _state = MutableStateFlow(PhoneMediaState())
    val state: StateFlow<PhoneMediaState> = _state.asStateFlow()

    private val lock = Any()
    /** What the PC has been told about (the last answered offer). */
    @Volatile private var applied = MediaWant(camera = false, microphone = false, front = true)
    private var worker: Job? = null
    @Volatile private var pending: CompletableDeferred<MediaMessage>? = null
    /** Capture was stopped on this phone but the PC has not been told yet; wanting it again then means starting it afresh. */
    @Volatile private var haltedCamera = false
    @Volatile private var haltedMic = false

    init {
        port.onCaptureFailed = { note -> stopAll(note) }
    }

    fun setCamera(on: Boolean) {
        if (on == _state.value.camera) return
        if (!on && applied.camera) haltedCamera = true
        _state.update { it.copy(camera = on, note = MediaNote.None) }
        if (!on) port.halt(camera = true, microphone = false)
        kick()
    }

    fun setMicrophone(on: Boolean) {
        if (on == _state.value.microphone) return
        if (!on && applied.microphone) haltedMic = true
        _state.update { it.copy(microphone = on, note = MediaNote.None) }
        if (!on) port.halt(camera = false, microphone = true)
        kick()
    }

    /** Front or back camera. Remembered while the camera is off; applied at once while it runs. */
    fun setFront(front: Boolean) {
        if (front == _state.value.front) return
        _state.update { it.copy(front = front) }
        kick()
    }

    /** Everything off (the app left the screen, Stop, an error, the PC asked for it). Capture ends now; the PC is told afterwards. */
    fun stopAll(note: MediaNote = MediaNote.None) {
        if (applied.camera) haltedCamera = true
        if (applied.microphone) haltedMic = true
        port.halt()
        _state.update { if (it.on) it.copy(camera = false, microphone = false, note = note) else it } // nothing was on: nothing to explain
        val idle = synchronized(lock) { worker?.isActive != true && !applied.camera && !applied.microphone }
        if (idle) {
            port.release() // nothing was negotiated: just free what was started
            _state.update { it.copy(phase = MediaPhase.Idle) }
        } else kick()
    }

    /** `renegotiate-answer`, `renegotiate-error` or `media-stop` from the PC. */
    fun onMessage(m: JSONObject) {
        when (val msg = MediaMessage.parse(m)) {
            is MediaMessage.Answer, is MediaMessage.Error -> pending?.complete(msg)
            MediaMessage.Stop -> stopAll(MediaNote.PcStopped)
            null -> {}
        }
    }

    /** The connection is gone: nothing can be negotiated any more, so everything is released and forgotten. */
    fun onLinkClosed() {
        val j = synchronized(lock) { worker.also { worker = null } }
        j?.cancel()
        pending?.cancel()
        pending = null
        port.halt()
        port.release()
        applied = MediaWant(false, false, _state.value.front)
        haltedCamera = false
        haltedMic = false
        _state.value = PhoneMediaState(front = _state.value.front)
    }

    private fun kick() {
        synchronized(lock) {
            if (worker?.isActive == true) return
            worker = scope.launch { reconcile() }
        }
    }

    private suspend fun reconcile() {
        while (true) {
            val s = _state.value
            val want = MediaWant(s.camera, s.microphone, s.front)
            val same = want.camera == applied.camera && want.microphone == applied.microphone
            if (same && !(want.camera && haltedCamera) && !(want.microphone && haltedMic)) break
            if (!negotiate(want)) break
        }
        val s = _state.value
        if (applied.camera && s.front != applied.front) {
            port.switchCamera(s.front)
            applied = applied.copy(front = s.front)
        } else if (!applied.camera) applied = applied.copy(front = s.front)
        _state.update { it.copy(phase = if (it.on) MediaPhase.Sending else MediaPhase.Idle) }
    }

    /** One offer / answer round. Returns false when it failed (the state has been put right). */
    private suspend fun negotiate(want: MediaWant): Boolean {
        val removing = (applied.camera && !want.camera) || (applied.microphone && !want.microphone)
        val adding = (want.camera && (!applied.camera || haltedCamera)) || (want.microphone && (!applied.microphone || haltedMic))
        _state.update { it.copy(phase = if (adding) MediaPhase.Starting else MediaPhase.Stopping) }
        val hc0 = haltedCamera // the halts this round takes care of; one that arrives meanwhile stays for the next round
        val hm0 = haltedMic
        // what survives a failure: what the PC already has, is still wanted and was not halted
        val keep = MediaWant(applied.camera && want.camera && !hc0, applied.microphone && want.microphone && !hm0, want.front)
        suspend fun fail(note: MediaNote): Boolean {
            port.abandon(keep)
            applied = keep
            if (hc0) haltedCamera = false
            if (hm0) haltedMic = false
            // a failed stop is still a stop: the capture is gone, so it is not reported as an error unless nothing was removed
            val shown = if (!adding && removing) MediaNote.StopUnconfirmed else note
            _state.update { it.copy(camera = keep.camera, microphone = keep.microphone, phase = if (keep.camera || keep.microphone) MediaPhase.Sending else MediaPhase.Idle, note = shown) }
            return false
        }
        val sdp = try {
            port.prepareOffer(want)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: MediaFailure) {
            return fail(e.note)
        } catch (e: Exception) {
            return fail(MediaNote.Failed)
        }
        if (sdp.isEmpty() || sdp.length > PHONE_MEDIA_MAX_SDP) return fail(MediaNote.BadOffer)
        val reply = CompletableDeferred<MediaMessage>()
        pending = reply
        if (!port.sendOffer(sdp)) { pending = null; return fail(MediaNote.NotConnected) }
        val r = try { withTimeoutOrNull(replyTimeoutMs) { reply.await() } } finally { pending = null }
        return when (r) {
            null -> fail(MediaNote.Timeout)
            is MediaMessage.Error -> fail(r.note)
            is MediaMessage.Answer -> try {
                port.acceptAnswer(r.sdp)
                applied = want
                if (hc0) haltedCamera = false
                if (hm0) haltedMic = false
                true // the note (if any) stays: it is cleared when the person switches something, not when the PC confirms
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(MediaNote.Failed)
            }
            MediaMessage.Stop -> fail(MediaNote.PcStopped) // not delivered here, but keeps the when exhaustive
        }
    }

    companion object {
        /** The PC itself gives up after 15 s. */
        const val REPLY_TIMEOUT_MS = 20_000L
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// libwebrtc glue
// ---------------------------------------------------------------------------------------------------------------------

private class VideoLeg(
    val capturer: CameraVideoCapturer,
    val helper: SurfaceTextureHelper,
    val source: VideoSource,
    val track: VideoTrack,
    val transceiver: RtpTransceiver,
    var deviceName: String,
)

private class AudioLeg(val source: AudioSource, val track: AudioTrack, val transceiver: RtpTransceiver)

/**
 * [PhoneMediaPort] on the shared peer connection: Camera2 capture at 720p / 24 fps into a video track, the microphone
 * with echo cancellation, noise suppression and automatic gain, each added as its own sendonly transceiver (never
 * `addTrack`, which could reuse the transceiver that carries the PC's screen). [peer] is the live connection (null
 * between sessions), [sendCtl] writes to the `ctl` channel.
 */
class PhoneMediaGlue(
    context: Context,
    private val peer: () -> PeerConnection?,
    private val sendCtl: (JSONObject) -> Boolean,
) : PhoneMediaPort {
    private val app = context.applicationContext
    private val io = CoroutineScope(Dispatchers.IO)
    private val legs = Any()
    private var video: VideoLeg? = null
    private var audio: AudioLeg? = null
    @Volatile private var videoHalted = false
    @Volatile private var audioHalted = false
    override var onCaptureFailed: ((MediaNote) -> Unit)? = null

    private fun granted(permission: String) = ContextCompat.checkSelfPermission(app, permission) == PackageManager.PERMISSION_GRANTED

    override suspend fun prepareOffer(want: MediaWant): String {
        val pc = peer() ?: throw MediaFailure(MediaNote.NotConnected)
        if (pc.signalingState() != PeerConnection.SignalingState.STABLE) throw MediaFailure(MediaNote.PcBusy)
        withContext(Dispatchers.IO) {
            // removals first, so a section that is dropped can be reused by one that is added in the same offer
            if (!want.camera) dropVideo()
            if (!want.microphone) dropAudio()
            // a leg that was halted (stopped on this phone, not yet removed on the PC) is replaced by a fresh one
            if (want.camera && videoHalted) dropVideo()
            if (want.microphone && audioHalted) dropAudio()
            if (want.camera && synchronized(legs) { video } == null) startVideo(pc, want.front)
            if (want.microphone && synchronized(legs) { audio } == null) startAudio(pc)
        }
        val offer = createOffer(pc)
        setLocal(pc, offer)
        awaitGathered(pc)
        return pc.localDescription?.description ?: throw MediaFailure(MediaNote.Failed, "no local description")
    }

    override fun sendOffer(sdp: String): Boolean = sendCtl(Msg.renegotiate(sdp))

    override suspend fun acceptAnswer(sdp: String) {
        val pc = peer() ?: throw MediaFailure(MediaNote.NotConnected)
        setRemote(pc, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    override suspend fun abandon(keep: MediaWant) {
        val pc = peer()
        if (pc != null && pc.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
            runCatching { setLocal(pc, SessionDescription(SessionDescription.Type.ROLLBACK, "")) }
        }
        withContext(Dispatchers.IO) {
            if (!keep.camera) dropVideo()
            if (!keep.microphone) dropAudio()
        }
    }

    override fun switchCamera(front: Boolean) {
        val leg = synchronized(legs) { video } ?: return
        val enumerator = enumerator()
        val name = deviceFor(enumerator, front) ?: return
        if (name == leg.deviceName) return
        leg.capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCamera: Boolean) { leg.deviceName = name }
            override fun onCameraSwitchError(errorDescription: String?) { onCaptureFailed?.invoke(MediaNote.NoCamera) }
        }, name)
    }

    override fun halt(camera: Boolean, microphone: Boolean) {
        val v: VideoLeg?
        val a: AudioLeg?
        synchronized(legs) { v = video; a = audio }
        if (microphone && a != null) {
            audioHalted = true
            runCatching { a.track.setEnabled(false); a.transceiver.sender.setTrack(null, false) } // recording stops with the sender
        }
        if (camera && v != null) {
            videoHalted = true
            io.launch { runCatching { v.capturer.stopCapture() } }
        }
    }

    override fun release() {
        io.launch {
            dropVideo()
            dropAudio()
        }
    }

    // -------------------------------------------------------------- legs

    private fun startVideo(pc: PeerConnection, front: Boolean) {
        if (!granted(Manifest.permission.CAMERA)) throw MediaFailure(MediaNote.Denied)
        val factory = WebRtcRuntime.factory(app)
        val enumerator = enumerator()
        val name = deviceFor(enumerator, front) ?: throw MediaFailure(MediaNote.NoCamera)
        val capturer = enumerator.createCapturer(name, object : CameraVideoCapturer.CameraEventsHandler {
            override fun onCameraError(errorDescription: String?) { onCaptureFailed?.invoke(MediaNote.NoCamera) }
            override fun onCameraDisconnected() { onCaptureFailed?.invoke(MediaNote.NoCamera) }
            override fun onCameraFreezed(errorDescription: String?) { onCaptureFailed?.invoke(MediaNote.NoCamera) }
            override fun onCameraOpening(cameraName: String?) {}
            override fun onFirstFrameAvailable() {}
            override fun onCameraClosed() {}
        }) ?: throw MediaFailure(MediaNote.NoCamera)
        val helper = SurfaceTextureHelper.create("PhoneCameraThread", WebRtcRuntime.eglBase(app).eglBaseContext)
        val source = factory.createVideoSource(false)
        try {
            capturer.initialize(helper, app, source.capturerObserver)
            capturer.startCapture(CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS)
        } catch (e: Exception) {
            runCatching { capturer.dispose() }
            source.dispose()
            helper.dispose()
            throw MediaFailure(MediaNote.NoCamera, e.message)
        }
        val track = factory.createVideoTrack("phone-camera", source)
        val tr = pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf(STREAM_ID)))
        synchronized(legs) { video = VideoLeg(capturer, helper, source, track, tr, name) }
    }

    private fun startAudio(pc: PeerConnection) {
        if (!granted(Manifest.permission.RECORD_AUDIO)) throw MediaFailure(MediaNote.Denied)
        val factory = WebRtcRuntime.factory(app)
        val constraints = MediaConstraints().apply {
            for (key in listOf("googEchoCancellation", "googNoiseSuppression", "googAutoGainControl", "googHighpassFilter", "echoCancellation", "noiseSuppression", "autoGainControl")) {
                optional.add(MediaConstraints.KeyValuePair(key, "true"))
            }
        }
        val source = factory.createAudioSource(constraints)
        val track = factory.createAudioTrack("phone-microphone", source)
        val tr = pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf(STREAM_ID)))
        synchronized(legs) { audio = AudioLeg(source, track, tr) }
    }

    private fun dropVideo() {
        videoHalted = false
        val leg = synchronized(legs) { video.also { video = null } } ?: return
        runCatching { leg.capturer.stopCapture() }
        runCatching { leg.transceiver.stopStandard() }
        runCatching { leg.capturer.dispose() }
        runCatching { leg.track.dispose() }
        runCatching { leg.source.dispose() }
        runCatching { leg.helper.dispose() }
    }

    private fun dropAudio() {
        audioHalted = false
        val leg = synchronized(legs) { audio.also { audio = null } } ?: return
        runCatching { leg.track.setEnabled(false) }
        runCatching { leg.transceiver.stopStandard() }
        runCatching { leg.track.dispose() }
        runCatching { leg.source.dispose() }
    }

    private fun enumerator(): CameraEnumerator = if (Camera2Enumerator.isSupported(app)) Camera2Enumerator(app) else Camera1Enumerator(false)

    private fun deviceFor(e: CameraEnumerator, front: Boolean): String? =
        e.deviceNames.firstOrNull { if (front) e.isFrontFacing(it) else e.isBackFacing(it) } ?: e.deviceNames.firstOrNull()

    // -------------------------------------------------------------- SDP plumbing

    private suspend fun createOffer(p: PeerConnection): SessionDescription = suspendCancellableCoroutine { c ->
        p.createOffer(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) = c.resumeWith(Result.success(d))
            override fun onCreateFailure(e: String?) = c.resumeWith(Result.failure(MediaFailure(MediaNote.Failed, e ?: "createOffer failed")))
            override fun onSetSuccess() {}
            override fun onSetFailure(e: String?) {}
        }, MediaConstraints())
    }

    private suspend fun setLocal(p: PeerConnection, d: SessionDescription) = suspendCancellableCoroutine { c ->
        p.setLocalDescription(observer({ c.resumeWith(Result.success(Unit)) }, { c.resumeWith(Result.failure(MediaFailure(MediaNote.Failed, it))) }), d)
    }

    private suspend fun setRemote(p: PeerConnection, d: SessionDescription) = suspendCancellableCoroutine { c ->
        p.setRemoteDescription(observer({ c.resumeWith(Result.success(Unit)) }, { c.resumeWith(Result.failure(MediaFailure(MediaNote.Failed, it))) }), d)
    }

    private fun observer(ok: () -> Unit, fail: (String) -> Unit) = object : SdpObserver {
        override fun onCreateSuccess(d: SessionDescription?) {}
        override fun onCreateFailure(e: String?) {}
        override fun onSetSuccess() = ok()
        override fun onSetFailure(e: String?) = fail(e ?: "SDP error")
    }

    /** New sections ride on the existing transport, so gathering is normally complete already; wait a moment if it is not. */
    private suspend fun awaitGathered(p: PeerConnection) {
        withTimeoutOrNull(GATHER_WAIT_MS) {
            while (p.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) delay(50)
        }
    }

    companion object {
        const val CAMERA_WIDTH = 1280
        const val CAMERA_HEIGHT = 720
        const val CAMERA_FPS = 24
        private const val STREAM_ID = "glidr-phone"
        private const val GATHER_WAIT_MS = 2_000L
    }
}
