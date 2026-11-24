package com.yashraj.glidr.screen.net

import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import kotlin.math.min

/** Limits of the phone-to-PC file transfer (docs/PROTOCOL.md, "File transfer"). */
object FileLimits {
    /** The PC refuses anything larger. */
    const val MAX_BYTES = 200L * 1024 * 1024

    /** Largest binary frame on the `files` channel. */
    const val CHUNK = 16_384

    /** Stop sending while the channel holds more than this many unsent bytes... */
    const val PAUSE_ABOVE = 256L * 1024

    /** ...and carry on once it is down to this. */
    const val RESUME_BELOW = 64L * 1024

    /** How many files one share or one pick may queue at once. */
    const val MAX_QUEUED = 25
}

/** Why the PC refused an offer (`file-reject` `reason`). */
enum class RejectReason(val wire: String) {
    Disabled("disabled"), TooBig("too-big"), ViewOnly("view-only"), Busy("busy"), BadName("bad-name"), Unknown("");

    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire && it != Unknown } ?: Unknown }
}

/** What the PC answers on `ctl`. */
sealed interface FileReply {
    val id: String

    data class Accept(override val id: String) : FileReply
    data class Reject(override val id: String, val reason: RejectReason) : FileReply

    /** [ok] false: nothing was kept. [name] is the name the file was saved under (may differ from the offered one). */
    data class Done(override val id: String, val ok: Boolean, val name: String) : FileReply
}

/** Builders and parsers for the file messages. The `files` channel frames are text JSON like the `ctl` ones. */
object FileMsg {
    fun newId(random: java.util.Random = SecureRandom()): String =
        ByteArray(4).also { random.nextBytes(it) }.toHex()

    fun offer(id: String, name: String, size: Long) =
        JSONObject().put("t", "file-offer").put("id", id).put("name", name).put("size", size)

    fun begin(id: String) = JSONObject().put("t", "begin").put("id", id)
    fun end(id: String, sha256: String) = JSONObject().put("t", "end").put("id", id).put("sha256", sha256)
    fun cancel(id: String) = JSONObject().put("t", "cancel").put("id", id)

    /** A `ctl` message from the PC as a [FileReply], or null when it is not one (or is malformed). */
    fun parse(m: JSONObject): FileReply? {
        val id = m.optString("id")
        if (id.isEmpty()) return null
        return when (m.optString("t")) {
            "file-accept" -> FileReply.Accept(id)
            "file-reject" -> FileReply.Reject(id, RejectReason.of(m.optString("reason")))
            "file-done" -> FileReply.Done(id, m.optBoolean("ok", false), m.optString("name"))
            else -> null
        }
    }
}

/** Streaming SHA-256 of what is sent, lower-case hex. */
class Sha256Stream {
    private val md = MessageDigest.getInstance("SHA-256")
    fun update(buf: ByteArray, off: Int, len: Int) = md.update(buf, off, len)
    fun hex(): String = md.digest().toHex()
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

/** Splitting a file into frames and counting progress. Pure. */
object ChunkPlanner {
    /** Length of the next frame when [sent] of [size] bytes are out: [chunk], or what is left, or 0 when done. */
    fun nextLength(sent: Long, size: Long, chunk: Int = FileLimits.CHUNK): Int =
        if (sent >= size) 0 else min(chunk.toLong(), size - sent).toInt()

    /** Number of frames a file of [size] bytes takes (0 for an empty file). */
    fun frames(size: Long, chunk: Int = FileLimits.CHUNK): Long = if (size <= 0) 0 else (size + chunk - 1) / chunk

    /** True while the channel holds too much unsent data; [paused] is whether sending is currently held back (hysteresis). */
    fun shouldPause(buffered: Long, paused: Boolean): Boolean =
        if (paused) buffered > FileLimits.RESUME_BELOW else buffered > FileLimits.PAUSE_ABOVE
}

/** Progress arithmetic and the sizes shown to the user. */
object FileProgress {
    fun fraction(sent: Long, total: Long): Float = if (total <= 0) 0f else (sent.toDouble() / total).toFloat().coerceIn(0f, 1f)

    fun percent(sent: Long, total: Long): Int = (fraction(sent, total) * 100).toInt()

    /** "812 B", "3.4 KB", "12.0 MB". Always one decimal above bytes, decimal point regardless of the phone's language. */
    fun humanSize(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
        else -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
    }

    fun label(sent: Long, total: Long) = "${humanSize(sent)} of ${humanSize(total)}"
}

/** The words shown to the user. Pure so they are testable. */
object FileTexts {
    fun reject(reason: RejectReason) = when (reason) {
        RejectReason.Disabled -> "The PC is not accepting files. Turn on \"Allow receiving files\" and remote control in Glidr Screen on the PC."
        RejectReason.TooBig -> TOO_BIG_LOCAL
        RejectReason.ViewOnly -> "This phone is set to view only on the PC, so it cannot send files."
        RejectReason.Busy -> "The PC is already receiving a file. Try again in a moment."
        RejectReason.BadName -> "The PC could not accept this file."
        RejectReason.Unknown -> "The PC refused the file."
    }

    const val TOO_BIG_LOCAL = "Too big. The PC accepts files up to 200 MB."
    const val UNREADABLE = "Could not read this file."
    const val CHANGED = "The file changed while it was being sent."
    const val NO_ANSWER = "The PC did not answer. Update Glidr Screen on the PC, then try again."
    const val OLD_HOST = "This PC's Glidr Screen is too old to receive files. Update it on the PC."
    const val NOT_CONNECTED = "Not connected to a PC."
    const val CONNECTION_LOST = "The connection dropped. The file was not sent."
    const val NOT_SAVED = "The PC could not save the file, so nothing was kept."
    const val CANCELLED = "Cancelled."
    const val SAVED = "Saved on the PC in Downloads\\Glidr"

    fun saved(name: String) = "$SAVED as $name"

    /** The line under a file's name in the send sheet. */
    fun status(item: FileItem): String = when (item.status) {
        FileStatus.Waiting -> "Waiting"
        FileStatus.Offering -> "Waiting for the PC to accept"
        FileStatus.Sending -> "${FileProgress.percent(item.sent, item.size)}%  ${FileProgress.label(item.sent, item.size)}"
        FileStatus.Finishing -> "Saving on the PC"
        FileStatus.Done, FileStatus.Failed, FileStatus.Cancelled -> item.note ?: ""
    }

    /** "3 files" / "1 file". */
    fun files(n: Int) = if (n == 1) "1 file" else "$n files"
}
