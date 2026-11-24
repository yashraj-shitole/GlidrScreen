package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.net.ChunkPlanner
import com.yashraj.glidr.screen.net.FileItem
import com.yashraj.glidr.screen.net.FileLimits
import com.yashraj.glidr.screen.net.FileMsg
import com.yashraj.glidr.screen.net.FileNames
import com.yashraj.glidr.screen.net.FileProgress
import com.yashraj.glidr.screen.net.FileReply
import com.yashraj.glidr.screen.net.FileStatus
import com.yashraj.glidr.screen.net.FileTexts
import com.yashraj.glidr.screen.net.RejectReason
import com.yashraj.glidr.screen.net.Sha256Stream
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/** Pure parts of the phone-to-PC file transfer (docs/PROTOCOL.md, "File transfer"). */
class FileTransferTest {
    private fun flat(o: JSONObject) = o.keys().asSequence().associateWith { o.get(it) }
    private fun assertJson(expected: String, actual: JSONObject) =
        assertEquals(flat(JSONObject(expected)), flat(JSONObject(actual.toString())))

    @Test fun limitsMatchTheProtocol() {
        assertEquals(209_715_200L, FileLimits.MAX_BYTES)
        assertEquals(16_384, FileLimits.CHUNK)
        assertEquals(262_144L, FileLimits.PAUSE_ABOVE)
    }

    @Test fun idIsEightLowerCaseHexDigits() {
        repeat(50) { assertTrue(Regex("[0-9a-f]{8}").matches(FileMsg.newId())) }
        assertEquals(FileMsg.newId(Random(7)), FileMsg.newId(Random(7)))
        assertFalse(FileMsg.newId(Random(1)) == FileMsg.newId(Random(2)))
    }

    @Test fun offerBeginEndCancelMessages() {
        assertJson("""{"t":"file-offer","id":"a1b2c3d4","name":"My \"file\".pdf","size":123456789012}""", FileMsg.offer("a1b2c3d4", "My \"file\".pdf", 123_456_789_012L))
        assertJson("""{"t":"begin","id":"a1b2c3d4"}""", FileMsg.begin("a1b2c3d4"))
        assertJson("""{"t":"end","id":"a1b2c3d4","sha256":"ab"}""", FileMsg.end("a1b2c3d4", "ab"))
        assertJson("""{"t":"cancel","id":"a1b2c3d4"}""", FileMsg.cancel("a1b2c3d4"))
    }

    @Test fun repliesParse() {
        assertEquals(FileReply.Accept("a1"), FileMsg.parse(JSONObject("""{"t":"file-accept","id":"a1"}""")))
        assertEquals(FileReply.Reject("a1", RejectReason.TooBig), FileMsg.parse(JSONObject("""{"t":"file-reject","id":"a1","reason":"too-big"}""")))
        assertEquals(FileReply.Done("a1", true, "x (2).txt"), FileMsg.parse(JSONObject("""{"t":"file-done","id":"a1","ok":true,"name":"x (2).txt"}""")))
        assertEquals(FileReply.Done("a1", false, ""), FileMsg.parse(JSONObject("""{"t":"file-done","id":"a1","ok":false,"name":""}""")))
        assertEquals(FileReply.Done("a1", false, ""), FileMsg.parse(JSONObject("""{"t":"file-done","id":"a1"}""")))
    }

    @Test fun malformedOrOtherRepliesAreNull() {
        assertNull(FileMsg.parse(JSONObject("""{"t":"file-accept"}""")))
        assertNull(FileMsg.parse(JSONObject("""{"t":"pong","id":"a1"}""")))
        assertNull(FileMsg.parse(JSONObject("{}")))
    }

    @Test fun everyRejectReasonHasItsOwnWords() {
        assertEquals(RejectReason.Disabled, RejectReason.of("disabled"))
        assertEquals(RejectReason.TooBig, RejectReason.of("too-big"))
        assertEquals(RejectReason.ViewOnly, RejectReason.of("view-only"))
        assertEquals(RejectReason.Busy, RejectReason.of("busy"))
        assertEquals(RejectReason.BadName, RejectReason.of("bad-name"))
        assertEquals(RejectReason.Unknown, RejectReason.of("something-new"))
        assertEquals(RejectReason.Unknown, RejectReason.of(""))
        assertEquals(RejectReason.Unknown, RejectReason.of(null))
        val texts = RejectReason.entries.map { FileTexts.reject(it) }
        assertEquals("every reason says something different", texts.size, texts.toSet().size)
        assertTrue(FileTexts.reject(RejectReason.Disabled).contains("Allow receiving files"))
        assertTrue(FileTexts.reject(RejectReason.TooBig).contains("200 MB"))
        assertTrue(FileTexts.reject(RejectReason.ViewOnly).contains("view only"))
        assertTrue(FileTexts.reject(RejectReason.Busy).contains("already receiving"))
    }

    @Test fun sha256KnownAnswers() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Sha256Stream().also { val b = "abc".toByteArray(); it.update(b, 0, b.size) }.hex())
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Sha256Stream().hex())
        // fed in pieces, and only the first [len] bytes of a reused buffer count
        val s = Sha256Stream()
        val buf = "xabcx".toByteArray()
        s.update(buf, 1, 1); s.update(buf, 2, 2)
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", s.hex())
    }

    @Test fun chunkPlanner() {
        assertEquals(16_384, ChunkPlanner.nextLength(0, 100_000))
        assertEquals(100_000 - 6 * 16_384, ChunkPlanner.nextLength(6L * 16_384, 100_000))
        assertEquals(0, ChunkPlanner.nextLength(100_000, 100_000))
        assertEquals(0, ChunkPlanner.nextLength(0, 0))
        assertEquals(5, ChunkPlanner.nextLength(0, 5))
        assertEquals(0L, ChunkPlanner.frames(0))
        assertEquals(1L, ChunkPlanner.frames(1))
        assertEquals(1L, ChunkPlanner.frames(16_384))
        assertEquals(2L, ChunkPlanner.frames(16_385))
        assertEquals(12_800L, ChunkPlanner.frames(FileLimits.MAX_BYTES))
        // the frames add up to the size
        var sent = 0L; var n = 0L
        while (true) { val l = ChunkPlanner.nextLength(sent, 1_000_001); if (l == 0) break; sent += l; n++ }
        assertEquals(1_000_001L, sent); assertEquals(ChunkPlanner.frames(1_000_001), n)
    }

    @Test fun backPressureHasHysteresis() {
        assertFalse(ChunkPlanner.shouldPause(256L * 1024, paused = false)) // exactly at the limit still sends
        assertTrue(ChunkPlanner.shouldPause(256L * 1024 + 1, paused = false))
        assertTrue("stays paused above the low mark", ChunkPlanner.shouldPause(100L * 1024, paused = true))
        assertFalse("resumes at the low mark", ChunkPlanner.shouldPause(64L * 1024, paused = true))
        assertFalse(ChunkPlanner.shouldPause(0, paused = true))
        assertFalse(ChunkPlanner.shouldPause(100L * 1024, paused = false))
    }

    @Test fun progressMaths() {
        assertEquals(0f, FileProgress.fraction(0, 0), 0f)
        assertEquals(0f, FileProgress.fraction(5, -1), 0f)
        assertEquals(0.5f, FileProgress.fraction(50, 100), 0f)
        assertEquals(1f, FileProgress.fraction(150, 100), 0f)
        assertEquals(0, FileProgress.percent(0, 100))
        assertEquals(33, FileProgress.percent(1, 3))
        assertEquals(100, FileProgress.percent(100, 100))
    }

    @Test fun humanSizes() {
        assertEquals("0 B", FileProgress.humanSize(0))
        assertEquals("812 B", FileProgress.humanSize(812))
        assertEquals("1.0 KB", FileProgress.humanSize(1024))
        assertEquals("3.4 KB", FileProgress.humanSize(3_500))
        assertEquals("1.0 MB", FileProgress.humanSize(1024 * 1024))
        assertEquals("200.0 MB", FileProgress.humanSize(FileLimits.MAX_BYTES))
        assertEquals("1.2 MB of 3.4 MB", FileProgress.label(1_258_291, 3_565_158))
    }

    @Test fun statusLines() {
        val base = FileItem(1, "a.pdf", 2_000_000)
        assertEquals("Waiting", FileTexts.status(base))
        assertEquals("Waiting for the PC to accept", FileTexts.status(base.copy(status = FileStatus.Offering)))
        assertEquals("50%  1.0 MB of 2.0 MB", FileTexts.status(base.copy(status = FileStatus.Sending, size = 2_097_152, sent = 1_048_576)))
        assertEquals("Saving on the PC", FileTexts.status(base.copy(status = FileStatus.Finishing)))
        assertEquals("Saved on the PC in Downloads\\Glidr as a (2).pdf", FileTexts.status(base.copy(status = FileStatus.Done, note = FileTexts.saved("a (2).pdf"))))
        assertEquals(FileTexts.CANCELLED, FileTexts.status(base.copy(status = FileStatus.Cancelled, note = FileTexts.CANCELLED)))
        assertEquals("1 file", FileTexts.files(1))
        assertEquals("3 files", FileTexts.files(3))
    }

    @Test fun offeredNamesCarryNoPath() {
        assertEquals("a.txt", FileNames.display("a.txt"))
        assertEquals("a.txt", FileNames.display("primary:Download/docs/a.txt"))
        assertEquals("a.txt", FileNames.display("C:\\x\\a.txt"))
        assertEquals("file", FileNames.display(null))
        assertEquals("file", FileNames.display("  "))
        assertEquals("file", FileNames.display("dir/"))
        assertEquals(200, FileNames.display("n".repeat(500)).length)
    }
}
