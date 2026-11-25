package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.net.MediaFailure
import com.yashraj.glidr.screen.net.MediaMessage
import com.yashraj.glidr.screen.net.MediaNote
import com.yashraj.glidr.screen.net.MediaPhase
import com.yashraj.glidr.screen.net.MediaWant
import com.yashraj.glidr.screen.net.Msg
import com.yashraj.glidr.screen.net.PHONE_MEDIA_MAX_SDP
import com.yashraj.glidr.screen.net.PhoneMediaPort
import com.yashraj.glidr.screen.net.PhoneMediaSession
import com.yashraj.glidr.screen.net.PhoneMediaState
import com.yashraj.glidr.screen.net.PhoneMediaText
import com.yashraj.glidr.screen.ui.PhoneMediaPermissions
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Records every call and lets a test decide how each step goes. */
private class FakePort : PhoneMediaPort {
    val calls = mutableListOf<String>()
    val sent = mutableListOf<String>()
    var prepareFailure: Exception? = null
    var offer: (MediaWant) -> String = { "offer ${it.camera}/${it.microphone}" }
    var sendOk = true
    var acceptFails = false
    override var onCaptureFailed: ((com.yashraj.glidr.screen.net.MediaNote) -> Unit)? = null

    override suspend fun prepareOffer(want: MediaWant): String {
        calls += "prepare ${want.camera}/${want.microphone}/${if (want.front) "front" else "back"}"
        prepareFailure?.let { throw it }
        return offer(want)
    }

    override fun sendOffer(sdp: String): Boolean { calls += "send"; sent += sdp; return sendOk }
    override suspend fun acceptAnswer(sdp: String) { calls += "accept $sdp"; if (acceptFails) throw MediaFailure(MediaNote.Failed) }
    override suspend fun abandon(keep: MediaWant) { calls += "abandon ${keep.camera}/${keep.microphone}" }
    override fun switchCamera(front: Boolean) { calls += "switch ${if (front) "front" else "back"}" }
    override fun halt(camera: Boolean, microphone: Boolean) { calls += "halt ${camera}/${microphone}" }
    override fun release() { calls += "release" }
}

private fun answer(sdp: String = "v=0 answer") = JSONObject().put("t", "renegotiate-answer").put("sdp", sdp)
private fun error(reason: String) = JSONObject().put("t", "renegotiate-error").put("reason", reason)
private val stop = JSONObject().put("t", "media-stop").put("reason", "pc")

@OptIn(ExperimentalCoroutinesApi::class)
class PhoneMediaTest {
    private fun TestScope.session(port: FakePort, timeoutMs: Long = 20_000L) = PhoneMediaSession(backgroundScope, port, timeoutMs)

    // ------------------------------------------------------------------ messages

    @Test fun offerMessageShape() {
        val m = Msg.renegotiate("v=0")
        assertEquals("renegotiate", m.getString("t"))
        assertEquals("v=0", m.getString("sdp"))
        assertEquals(2, m.length())
    }

    @Test fun repliesAreParsed() {
        assertEquals(MediaMessage.Answer("v=0"), MediaMessage.parse(answer("v=0")))
        assertEquals(MediaMessage.Error(MediaNote.PcOff), MediaMessage.parse(error("disabled")))
        assertEquals(MediaMessage.Error(MediaNote.PcBusy), MediaMessage.parse(error("busy")))
        assertEquals(MediaMessage.Error(MediaNote.BadOffer), MediaMessage.parse(error("bad-sdp")))
        assertEquals(MediaMessage.Error(MediaNote.Failed), MediaMessage.parse(error("anything else")))
        assertEquals(MediaMessage.Error(MediaNote.Failed), MediaMessage.parse(JSONObject().put("t", "renegotiate-error")))
        assertEquals(MediaMessage.Stop, MediaMessage.parse(stop))
        assertNull(MediaMessage.parse(JSONObject().put("t", "pong")))
        // an answer that is missing, not text, or too large is not applied
        assertEquals(MediaMessage.Error(MediaNote.BadOffer), MediaMessage.parse(JSONObject().put("t", "renegotiate-answer")))
        assertEquals(MediaMessage.Error(MediaNote.BadOffer), MediaMessage.parse(JSONObject().put("t", "renegotiate-answer").put("sdp", 5)))
        assertEquals(MediaMessage.Error(MediaNote.BadOffer), MediaMessage.parse(answer("x".repeat(PHONE_MEDIA_MAX_SDP + 1))))
        assertEquals(MediaMessage.Answer("x".repeat(PHONE_MEDIA_MAX_SDP)), MediaMessage.parse(answer("x".repeat(PHONE_MEDIA_MAX_SDP))))
    }

    // ------------------------------------------------------------------ words

    @Test fun tagIsShownWhileAnythingIsOn() {
        assertNull(PhoneMediaText.tag(PhoneMediaState()))
        assertEquals("Camera on", PhoneMediaText.tag(PhoneMediaState(camera = true)))
        assertEquals("Mic on", PhoneMediaText.tag(PhoneMediaState(microphone = true)))
        assertEquals("Camera and mic on", PhoneMediaText.tag(PhoneMediaState(camera = true, microphone = true)))
        // also before the PC has confirmed: the camera is already running then
        assertEquals("Camera on", PhoneMediaText.tag(PhoneMediaState(camera = true, phase = MediaPhase.Starting)))
    }

    @Test fun statusLines() {
        assertEquals("Off. Nothing is sent.", PhoneMediaText.status(PhoneMediaState()))
        assertEquals("Starting...", PhoneMediaText.status(PhoneMediaState(camera = true, phase = MediaPhase.Starting)))
        assertEquals("Sending to the PC", PhoneMediaText.status(PhoneMediaState(camera = true, phase = MediaPhase.Sending)))
        assertEquals("The PC has this switched off", PhoneMediaText.status(PhoneMediaState(note = MediaNote.PcOff)))
        for (n in MediaNote.entries) if (n != MediaNote.None) assertTrue(n.name, PhoneMediaText.note(n).isNotBlank())
    }

    @Test fun explanationNamesWhatIsAsked() {
        assertTrue(PhoneMediaText.explain(true, false).contains("your camera"))
        assertTrue(PhoneMediaText.explain(false, true).contains("your microphone"))
        assertTrue(PhoneMediaText.explain(true, true).contains("camera and microphone"))
        assertTrue(PhoneMediaText.explain(true, false).contains("Camera on"))
    }

    @Test fun onlyMissingPermissionsAreAsked() {
        assertEquals(listOf(PhoneMediaPermissions.CAMERA), PhoneMediaPermissions.missing(true, false) { false })
        assertEquals(listOf(PhoneMediaPermissions.MICROPHONE), PhoneMediaPermissions.missing(false, true) { false })
        assertEquals(listOf(PhoneMediaPermissions.CAMERA, PhoneMediaPermissions.MICROPHONE), PhoneMediaPermissions.missing(true, true) { false })
        assertEquals(listOf(PhoneMediaPermissions.MICROPHONE), PhoneMediaPermissions.missing(true, true) { it == PhoneMediaPermissions.CAMERA })
        assertTrue(PhoneMediaPermissions.missing(true, true) { true }.isEmpty())
        assertTrue(PhoneMediaPermissions.missing(false, false) { false }.isEmpty()) // nothing wanted, nothing asked
    }

    // ------------------------------------------------------------------ start

    @Test fun startingTheCameraNegotiatesOnceAndShowsSending() = runTest {
        val port = FakePort()
        val s = session(port)
        assertEquals(PhoneMediaState(), s.state.value) // nothing starts on its own
        s.setCamera(true)
        runCurrent()
        assertEquals(listOf("prepare true/false/front", "send"), port.calls)
        assertEquals(listOf("offer true/false"), port.sent)
        assertTrue(s.state.value.camera) // the tag is up while waiting for the PC
        assertEquals(MediaPhase.Starting, s.state.value.phase)
        s.onMessage(answer("A1"))
        runCurrent()
        assertEquals("accept A1", port.calls.last())
        assertEquals(PhoneMediaState(camera = true, phase = MediaPhase.Sending), s.state.value)
    }

    @Test fun microphoneAfterCameraKeepsTheCamera() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        s.setMicrophone(true); runCurrent(); s.onMessage(answer()); runCurrent()
        assertEquals(PhoneMediaState(camera = true, microphone = true, phase = MediaPhase.Sending), s.state.value)
        assertEquals(listOf("offer true/false", "offer true/true"), port.sent)
    }

    @Test fun twoTogglesWhileBusyAreOneMoreOffer() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent() // waiting for the PC
        s.setMicrophone(true); runCurrent() // folded into the next round, not sent now
        assertEquals(1, port.sent.size)
        s.onMessage(answer()); runCurrent()
        assertEquals(listOf("offer true/false", "offer true/true"), port.sent)
        s.onMessage(answer()); runCurrent()
        assertEquals(MediaPhase.Sending, s.state.value.phase)
        assertTrue(s.state.value.camera && s.state.value.microphone)
    }

    // ------------------------------------------------------------------ the PC says no

    @Test fun pcSwitchedOffTurnsTheCameraBackOffAndSaysSo() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent()
        s.onMessage(error("disabled")); runCurrent()
        assertEquals(PhoneMediaState(camera = false, phase = MediaPhase.Idle, note = MediaNote.PcOff), s.state.value)
        assertEquals("abandon false/false", port.calls.last())
        assertEquals("The PC has this switched off", PhoneMediaText.status(s.state.value))
        // a new try starts clean
        s.setCamera(true)
        assertEquals(MediaNote.None, s.state.value.note)
    }

    @Test fun refusedMicrophoneLeavesTheRunningCamera() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        s.setMicrophone(true); runCurrent(); s.onMessage(error("busy")); runCurrent()
        assertEquals(PhoneMediaState(camera = true, microphone = false, phase = MediaPhase.Sending, note = MediaNote.PcBusy), s.state.value)
        assertEquals("abandon true/false", port.calls.last())
    }

    @Test fun noAnswerInTimeFails() = runTest {
        val port = FakePort()
        val s = session(port, timeoutMs = 1_000)
        s.setMicrophone(true); runCurrent()
        advanceTimeBy(999); runCurrent()
        assertTrue(s.state.value.microphone)
        advanceTimeBy(2); runCurrent()
        assertEquals(PhoneMediaState(phase = MediaPhase.Idle, note = MediaNote.Timeout), s.state.value)
        // a late answer changes nothing
        s.onMessage(answer()); runCurrent()
        assertFalse(s.state.value.microphone)
    }

    @Test fun portProblemsAreShown() = runTest {
        val denied = FakePort().apply { prepareFailure = MediaFailure(MediaNote.Denied) }
        val s1 = session(denied)
        s1.setCamera(true); runCurrent()
        assertEquals(MediaNote.Denied, s1.state.value.note)
        assertFalse(s1.state.value.camera)
        assertTrue(denied.sent.isEmpty()) // nothing was sent to the PC

        val broken = FakePort().apply { prepareFailure = IllegalStateException("boom") }
        val s2 = session(broken)
        s2.setMicrophone(true); runCurrent()
        assertEquals(MediaNote.Failed, s2.state.value.note)

        val offline = FakePort().apply { sendOk = false }
        val s3 = session(offline)
        s3.setCamera(true); runCurrent()
        assertEquals(MediaNote.NotConnected, s3.state.value.note)
        assertFalse(s3.state.value.camera)

        val huge = FakePort().apply { offer = { "x".repeat(PHONE_MEDIA_MAX_SDP + 1) } }
        val s4 = session(huge)
        s4.setCamera(true); runCurrent()
        assertEquals(MediaNote.BadOffer, s4.state.value.note)
        assertTrue(huge.sent.isEmpty()) // the PC would only refuse it

        val cannotApply = FakePort().apply { acceptFails = true }
        val s5 = session(cannotApply)
        s5.setCamera(true); runCurrent(); s5.onMessage(answer()); runCurrent()
        assertEquals(MediaNote.Failed, s5.state.value.note)
        assertFalse(s5.state.value.camera)
    }

    @Test fun answersNobodyAskedForAreIgnored() = runTest {
        val port = FakePort()
        val s = session(port)
        s.onMessage(answer()); s.onMessage(error("disabled")); runCurrent()
        assertEquals(PhoneMediaState(), s.state.value)
        assertTrue(port.calls.isEmpty())
    }

    // ------------------------------------------------------------------ stop

    @Test fun switchingOffStopsCaptureAtOnceThenTellsThePc() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        port.calls.clear()
        s.setCamera(false)
        assertEquals(listOf("halt true/false"), port.calls) // before any negotiation
        assertFalse(s.state.value.camera) // the tag is gone at once
        runCurrent()
        assertEquals(listOf("halt true/false", "prepare false/false/front", "send"), port.calls)
        s.onMessage(answer()); runCurrent()
        assertEquals(PhoneMediaState(phase = MediaPhase.Idle), s.state.value)
    }

    @Test fun cameraOffDoesNotStopTheMicrophone() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        s.setMicrophone(true); runCurrent(); s.onMessage(answer()); runCurrent()
        port.calls.clear()
        s.setCamera(false); runCurrent(); s.onMessage(answer()); runCurrent()
        assertTrue(port.calls.contains("halt true/false"))
        assertFalse(port.calls.contains("halt true/true"))
        assertEquals(PhoneMediaState(microphone = true, phase = MediaPhase.Sending), s.state.value)
    }

    @Test fun aStopThePcDoesNotConfirmIsStillAStop() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        s.setCamera(false); runCurrent(); s.onMessage(error("failed")); runCurrent()
        assertEquals(PhoneMediaState(phase = MediaPhase.Idle, note = MediaNote.StopUnconfirmed), s.state.value)
    }

    @Test fun cameraBackOnAfterAHaltStartsAfresh() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        port.calls.clear()
        // off and on again before the PC heard about the first: the old capture is gone, so a new one has to be negotiated
        s.setCamera(false)
        s.setCamera(true)
        runCurrent()
        assertTrue(port.calls.contains("prepare false/false/front") || port.calls.contains("prepare true/false/front"))
        s.onMessage(answer()); runCurrent()
        // however many rounds it took, it ends up on and sending
        while (s.state.value.phase == MediaPhase.Starting || s.state.value.phase == MediaPhase.Stopping) { s.onMessage(answer()); runCurrent() }
        assertEquals(PhoneMediaState(camera = true, phase = MediaPhase.Sending), s.state.value)
    }

    @Test fun thePcAskingToStopStopsEverything() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        s.setMicrophone(true); runCurrent(); s.onMessage(answer()); runCurrent()
        port.calls.clear()
        s.onMessage(stop)
        assertEquals("halt true/true", port.calls.first())
        assertFalse(s.state.value.camera || s.state.value.microphone)
        assertEquals(MediaNote.PcStopped, s.state.value.note)
        runCurrent() // the removal is negotiated afterwards
        assertEquals(listOf("prepare false/false/front", "send"), port.calls.drop(1))
        s.onMessage(answer()); runCurrent()
        assertEquals(MediaPhase.Idle, s.state.value.phase)
        assertEquals(MediaNote.PcStopped, s.state.value.note) // still says why
    }

    @Test fun leavingTheScreenStopsAndExplains() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        s.stopAll(MediaNote.Background)
        assertFalse(s.state.value.camera)
        assertEquals(MediaNote.Background, s.state.value.note)
    }

    @Test fun stopAllWithNothingOnSaysNothing() = runTest {
        val port = FakePort()
        val s = session(port)
        s.stopAll(MediaNote.Background)
        runCurrent()
        assertEquals(PhoneMediaState(), s.state.value)
        assertTrue(port.sent.isEmpty()) // nothing to tell the PC
    }

    @Test fun stopAllBeforeThePcAnsweredFreesWhatWasStarted() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent() // waiting for the PC, nothing negotiated yet
        s.stopAll(MediaNote.Background)
        assertFalse(s.state.value.camera)
        s.onMessage(answer()); runCurrent() // the answer arrives anyway: the camera is then removed again
        assertTrue(port.sent.size >= 2)
        assertEquals("offer false/false", port.sent.last())
    }

    @Test fun captureFailureStopsTheCamera() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        port.onCaptureFailed!!.invoke(MediaNote.NoCamera)
        assertFalse(s.state.value.camera)
        assertEquals(MediaNote.NoCamera, s.state.value.note)
    }

    // ------------------------------------------------------------------ the camera itself

    @Test fun frontBackIsRememberedAndAppliedWhileTheCameraRuns() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setFront(false) // camera off: only remembered
        runCurrent()
        assertTrue(port.calls.isEmpty())
        assertFalse(s.state.value.front)
        s.setCamera(true); runCurrent()
        assertEquals("prepare true/false/back", port.calls.first()) // starts on the chosen one
        s.onMessage(answer()); runCurrent()
        port.calls.clear()
        s.setFront(true); runCurrent()
        assertEquals(listOf("switch front"), port.calls) // no renegotiation
        assertTrue(s.state.value.front)
        assertEquals(MediaPhase.Sending, s.state.value.phase)
    }

    // ------------------------------------------------------------------ session end

    @Test fun whenTheLinkClosesEverythingIsReleasedAndForgotten() = runTest {
        val port = FakePort()
        val s = session(port)
        s.setFront(false)
        s.setCamera(true); runCurrent(); s.onMessage(answer()); runCurrent()
        s.setMicrophone(true); runCurrent() // a negotiation is in flight
        port.calls.clear()
        s.onLinkClosed()
        assertEquals(listOf("halt true/true", "release"), port.calls)
        assertEquals(PhoneMediaState(front = false), s.state.value) // the chosen camera is kept
        runCurrent()
        assertEquals(1, port.calls.count { it == "release" }) // the cancelled round did not do anything else
        assertNotNull(s.state.value)
        // a later session starts from scratch
        s.setCamera(true); runCurrent()
        assertTrue(port.calls.last() == "send")
    }
}
