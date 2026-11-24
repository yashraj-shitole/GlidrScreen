package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.net.FileLimits
import com.yashraj.glidr.screen.net.FileLink
import com.yashraj.glidr.screen.net.FileReply
import com.yashraj.glidr.screen.net.FileSender
import com.yashraj.glidr.screen.net.FileSource
import com.yashraj.glidr.screen.net.FileStatus
import com.yashraj.glidr.screen.net.FileTexts
import com.yashraj.glidr.screen.net.RejectReason
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.Random

private class FakeSource(
    override val name: String,
    val data: ByteArray,
    override val size: Long = data.size.toLong(),
    private val shortBy: Int = 0,
) : FileSource {
    var opened = false
    override fun open(): InputStream { opened = true; return ByteArrayInputStream(data.copyOf(data.size - shortBy)) }
}

/** A stand-in for the two data channels: records every frame, models the send buffer. */
private class FakeLink : FileLink {
    var isSupported = true
    var open = true
    override val supported get() = isSupported
    override val isOpen get() = open

    val ctl = mutableListOf<JSONObject>()
    val texts = mutableListOf<JSONObject>()
    val bytes = ByteArrayOutputStream()
    val chunkLens = mutableListOf<Int>()
    /** Everything in the order it was sent: "ctl:file-offer", "begin", "bin", "end", "cancel". */
    val log = mutableListOf<String>()
    var buffered = 0L
    var maxBufferedBeforeSend = 0L
    var roomWaits = 0
    var drainPerWait = Long.MAX_VALUE

    var onCtl: (JSONObject) -> Unit = {}
    var onText: (JSONObject) -> Unit = {}
    var onBinary: (Int) -> Unit = {}

    override fun sendCtl(msg: JSONObject): Boolean { ctl += msg; log += "ctl:" + msg.getString("t"); onCtl(msg); return true }
    override fun sendText(text: String): Boolean {
        val o = JSONObject(text); texts += o; log += o.getString("t"); onText(o); return true
    }
    override fun sendBinary(data: ByteArray, length: Int): Boolean {
        maxBufferedBeforeSend = maxOf(maxBufferedBeforeSend, buffered)
        bytes.write(data, 0, length); chunkLens += length; buffered += length; log += "bin"
        onBinary(chunkLens.size)
        return true
    }
    override fun bufferedAmount() = buffered
    override suspend fun awaitRoom() { roomWaits++; delay(10); buffered = (buffered - drainPerWait).coerceAtLeast(0) }
}

@OptIn(ExperimentalCoroutinesApi::class)
class FileSenderTest {
    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun data(n: Int) = ByteArray(n).also { Random(42).nextBytes(it) }

    private fun TestScope.sender(link: FakeLink?, ids: List<String> = listOf("a1b2c3d4", "b1b2c3d4", "c1b2c3d4")): FileSender {
        var i = 0
        return FileSender(this, { link }, StandardTestDispatcher(testScheduler), replyTimeoutMs = 1_000, doneTimeoutMs = 1_000, newId = { ids[i++ % ids.size] })
    }

    /** The PC accepts every offer and confirms every file as saved under [saved]. */
    private fun FakeLink.acceptAll(s: FileSender, saved: String = "saved.bin", ok: Boolean = true) {
        onCtl = { m -> if (m.getString("t") == "file-offer") s.onReply(FileReply.Accept(m.getString("id"))) }
        onText = { o -> if (o.getString("t") == "end") s.onReply(FileReply.Done(o.getString("id"), ok, if (ok) saved else "")) }
    }

    @Test fun sendsOfferThenBeginChunksAndEndWithTheRightHash() = runTest {
        val link = FakeLink()
        val s = sender(link)
        val src = FakeSource("Report.pdf", data(40_000))
        link.onCtl = { m ->
            assertFalse("the file is not touched before the PC accepts", src.opened)
            s.onReply(FileReply.Accept(m.getString("id")))
        }
        link.onText = { o -> if (o.getString("t") == "end") s.onReply(FileReply.Done(o.getString("id"), true, "Report (2).pdf")) }
        s.enqueue(listOf(src))
        advanceUntilIdle()

        assertEquals(listOf("ctl:file-offer", "begin", "bin", "bin", "bin", "end"), link.log)
        val offer = link.ctl[0]
        assertEquals("a1b2c3d4", offer.getString("id")); assertEquals("Report.pdf", offer.getString("name")); assertEquals(40_000L, offer.getLong("size"))
        assertEquals(listOf(16_384, 16_384, 7_232), link.chunkLens)
        assertTrue(link.chunkLens.all { it <= FileLimits.CHUNK })
        assertArrayEquals(src.data, link.bytes.toByteArray())
        val end = link.texts.last()
        assertEquals("a1b2c3d4", end.getString("id")); assertEquals(sha(src.data), end.getString("sha256"))
        val item = s.state.value.items.single()
        assertEquals(FileStatus.Done, item.status); assertEquals(40_000L, item.sent)
        assertEquals("Saved on the PC in Downloads\\Glidr as Report (2).pdf", item.note)
        assertFalse(s.state.value.busy)
    }

    @Test fun emptyFileHasNoChunks() = runTest {
        val link = FakeLink(); val s = sender(link); link.acceptAll(s)
        s.enqueue(listOf(FakeSource("empty.txt", ByteArray(0))))
        advanceUntilIdle()
        assertEquals(listOf("ctl:file-offer", "begin", "end"), link.log)
        assertEquals(sha(ByteArray(0)), link.texts.last().getString("sha256"))
        assertEquals(FileStatus.Done, s.state.value.items.single().status)
    }

    @Test fun everyRejectionIsShownInPlainWordsAndNothingIsRead() = runTest {
        for (reason in RejectReason.entries) {
            val link = FakeLink(); val s = sender(link)
            link.onCtl = { m -> s.onReply(FileReply.Reject(m.getString("id"), reason)) }
            val src = FakeSource("a.txt", data(10))
            s.enqueue(listOf(src))
            advanceUntilIdle()
            val item = s.state.value.items.single()
            assertEquals(FileStatus.Failed, item.status)
            assertEquals(FileTexts.reject(reason), item.note)
            assertFalse("rejected: the file was never opened", src.opened)
            assertEquals(listOf("ctl:file-offer"), link.log)
        }
    }

    @Test fun tooBigIsRefusedLocallyWithoutAnOffer() = runTest {
        val link = FakeLink(); val s = sender(link)
        s.enqueue(listOf(FakeSource("huge.iso", ByteArray(0), size = FileLimits.MAX_BYTES + 1)))
        advanceUntilIdle()
        assertEquals(FileTexts.TOO_BIG_LOCAL, s.state.value.items.single().note)
        assertTrue(link.log.isEmpty())
        // exactly the cap is offered
        s.clear()
        s.enqueue(listOf(FakeSource("max.bin", ByteArray(0), size = FileLimits.MAX_BYTES)))
        advanceUntilIdle()
        assertEquals(listOf("ctl:file-offer"), link.log.take(1))
    }

    @Test fun unknownSizeCannotBeOffered() = runTest {
        val link = FakeLink(); val s = sender(link)
        s.enqueue(listOf(FakeSource("x", ByteArray(0), size = -1)))
        advanceUntilIdle()
        assertEquals(FileTexts.UNREADABLE, s.state.value.items.single().note)
        assertTrue(link.log.isEmpty())
    }

    @Test fun oldPcAndNoConnection() = runTest {
        val old = FakeLink().also { it.isSupported = false }
        val s = sender(old)
        s.enqueue(listOf(FakeSource("a", data(3))))
        advanceUntilIdle()
        assertEquals(FileTexts.OLD_HOST, s.state.value.items.single().note)
        assertTrue(old.log.isEmpty())

        val s2 = sender(null)
        s2.enqueue(listOf(FakeSource("a", data(3))))
        advanceUntilIdle()
        assertEquals(FileTexts.NOT_CONNECTED, s2.state.value.items.single().note)
    }

    @Test fun silenceFromThePcTimesOut() = runTest {
        val link = FakeLink(); val s = sender(link)
        val src = FakeSource("a", data(3))
        s.enqueue(listOf(src))
        advanceUntilIdle()
        assertEquals(FileTexts.NO_ANSWER, s.state.value.items.single().note)
        assertFalse(src.opened)
        assertTrue("a late accept for a finished transfer is ignored", run { s.onReply(FileReply.Accept("a1b2c3d4")); true })
    }

    @Test fun pcCouldNotSaveIt() = runTest {
        val link = FakeLink(); val s = sender(link); link.acceptAll(s, ok = false)
        s.enqueue(listOf(FakeSource("a", data(100))))
        advanceUntilIdle()
        val item = s.state.value.items.single()
        assertEquals(FileStatus.Failed, item.status); assertEquals(FileTexts.NOT_SAVED, item.note)
    }

    @Test fun noVerdictAfterTheEndFrameTimesOut() = runTest {
        val link = FakeLink(); val s = sender(link)
        link.onCtl = { m -> s.onReply(FileReply.Accept(m.getString("id"))) }
        s.enqueue(listOf(FakeSource("a", data(100))))
        advanceUntilIdle()
        assertEquals(FileTexts.NO_ANSWER, s.state.value.items.single().note)
        assertEquals("end", link.log.last())
    }

    @Test fun backPressurePausesAboveTwoFiftySixKbAndResumesBelowSixtyFour() = runTest {
        val link = FakeLink().also { it.drainPerWait = 100L * 1024 }
        val s = sender(link); link.acceptAll(s)
        val src = FakeSource("big.bin", data(2 * 1024 * 1024 + 5))
        s.enqueue(listOf(src))
        advanceUntilIdle()
        assertEquals(FileStatus.Done, s.state.value.items.single().status)
        assertTrue("it waited for the buffer to drain", link.roomWaits > 0)
        assertTrue("never sent into a buffer above the limit", link.maxBufferedBeforeSend <= FileLimits.PAUSE_ABOVE)
        assertArrayEquals(src.data, link.bytes.toByteArray())
        assertEquals(sha(src.data), link.texts.last().getString("sha256"))
    }

    @Test fun cancelMidTransferStopsAndTellsThePc() = runTest {
        val link = FakeLink(); val s = sender(link); link.acceptAll(s)
        link.onBinary = { n -> if (n == 2) s.cancel() }
        s.enqueue(listOf(FakeSource("a.bin", data(100_000)), FakeSource("b.bin", data(10))))
        advanceUntilIdle()
        val items = s.state.value.items
        assertEquals(FileStatus.Cancelled, items[0].status)
        assertEquals("the waiting file is dropped too", FileStatus.Cancelled, items[1].status)
        assertEquals(FileTexts.CANCELLED, items[0].note)
        assertEquals(2, link.chunkLens.size)
        assertEquals("cancel", link.log.last())
        assertEquals("a1b2c3d4", link.texts.last().getString("id"))
        assertTrue(link.log.none { it == "end" })
        assertFalse(s.state.value.busy)
        // the next batch works again
        link.acceptAll(s)
        s.enqueue(listOf(FakeSource("c.bin", data(10))))
        advanceUntilIdle()
        assertEquals(FileStatus.Done, s.state.value.items.single().status)
    }

    @Test fun cancelWhileWaitingForTheAccept() = runTest {
        val link = FakeLink(); val s = sender(link)
        link.onCtl = { s.cancel() }
        val src = FakeSource("a.bin", data(100))
        s.enqueue(listOf(src))
        advanceUntilIdle()
        assertEquals(FileStatus.Cancelled, s.state.value.items.single().status)
        assertFalse(src.opened)
        assertEquals(listOf("ctl:file-offer", "cancel"), link.log)
    }

    @Test fun connectionLostMidTransferFailsIt() = runTest {
        val link = FakeLink(); val s = sender(link); link.acceptAll(s)
        link.onBinary = { n -> if (n == 2) link.open = false }
        s.enqueue(listOf(FakeSource("a.bin", data(100_000))))
        advanceUntilIdle()
        val item = s.state.value.items.single()
        assertEquals(FileStatus.Failed, item.status); assertEquals(FileTexts.CONNECTION_LOST, item.note)
    }

    @Test fun linkClosedWhileWaitingForTheAnswer() = runTest {
        val link = FakeLink(); val s = sender(link)
        link.onCtl = { s.linkClosed() }
        s.enqueue(listOf(FakeSource("a.bin", data(100))))
        advanceUntilIdle()
        assertEquals(FileTexts.CONNECTION_LOST, s.state.value.items.single().note)
    }

    @Test fun aFileThatShrankIsCancelled() = runTest {
        val link = FakeLink(); val s = sender(link); link.acceptAll(s)
        s.enqueue(listOf(FakeSource("a.bin", data(50_000), shortBy = 10_000)))
        advanceUntilIdle()
        val item = s.state.value.items.single()
        assertEquals(FileStatus.Failed, item.status); assertEquals(FileTexts.CHANGED, item.note)
        assertEquals("cancel", link.log.last())
        assertTrue(link.log.none { it == "end" })
    }

    @Test fun severalFilesGoOneAfterAnother() = runTest {
        val link = FakeLink(); val s = sender(link)
        link.acceptAll(s)
        val a = data(20_000); val b = data(5)
        s.enqueue(listOf(FakeSource("a.bin", a), FakeSource("b.bin", b)))
        advanceUntilIdle()
        assertEquals(
            listOf("ctl:file-offer", "begin", "bin", "bin", "end", "ctl:file-offer", "begin", "bin", "end"),
            link.log,
        )
        assertEquals(listOf("a1b2c3d4", "b1b2c3d4"), link.ctl.map { it.getString("id") })
        assertEquals(listOf(FileStatus.Done, FileStatus.Done), s.state.value.items.map { it.status })
        assertArrayEquals(a + b, link.bytes.toByteArray())
    }

    @Test fun oneRejectedFileDoesNotStopTheNext() = runTest {
        val link = FakeLink(); val s = sender(link)
        link.onCtl = { m ->
            val id = m.getString("id")
            s.onReply(if (m.getString("name") == "no.bin") FileReply.Reject(id, RejectReason.TooBig) else FileReply.Accept(id))
        }
        link.onText = { o -> if (o.getString("t") == "end") s.onReply(FileReply.Done(o.getString("id"), true, "yes.bin")) }
        s.enqueue(listOf(FakeSource("no.bin", data(10)), FakeSource("yes.bin", data(10))))
        advanceUntilIdle()
        assertEquals(listOf(FileStatus.Failed, FileStatus.Done), s.state.value.items.map { it.status })
    }

    @Test fun repliesForAnotherTransferAreIgnored() = runTest {
        val link = FakeLink(); val s = sender(link)
        link.onCtl = { m ->
            s.onReply(FileReply.Accept("deadbeef")) // not ours
            s.onReply(FileReply.Done("deadbeef", true, "x"))
            s.onReply(FileReply.Accept(m.getString("id")))
        }
        link.onText = { o -> if (o.getString("t") == "end") s.onReply(FileReply.Done(o.getString("id"), true, "mine.bin")) }
        s.enqueue(listOf(FakeSource("a.bin", data(10))))
        advanceUntilIdle()
        assertEquals("Saved on the PC in Downloads\\Glidr as mine.bin", s.state.value.items.single().note)
    }

    @Test fun queueIsCappedAndAFinishedBatchIsReplaced() = runTest {
        val link = FakeLink(); val s = sender(link); link.acceptAll(s)
        s.enqueue(List(40) { FakeSource("f$it", data(1)) })
        advanceUntilIdle()
        assertEquals(FileLimits.MAX_QUEUED, s.state.value.items.size)
        s.enqueue(listOf(FakeSource("again", data(1))))
        advanceUntilIdle()
        assertEquals(listOf("again"), s.state.value.items.map { it.name })
        s.clear()
        assertTrue(s.state.value.items.isEmpty())
        assertNull(link.ctl.firstOrNull { it.optString("name") == "f25" })
    }
}
