package com.yashraj.glidr.screen.net

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.InputStream

/** The data channels a transfer talks through. The WebRTC side lives in [ScreenClient]; tests use a fake. */
interface FileLink {
    /** False for a PC whose Glidr Screen has no `files` channel (older version). */
    val supported: Boolean
    val isOpen: Boolean

    /** A JSON message on `ctl`. */
    fun sendCtl(msg: JSONObject): Boolean

    /** A text frame on `files`. */
    fun sendText(text: String): Boolean

    /** A binary frame on `files`: the first [length] bytes of [data]. [data] may be reused afterwards. */
    fun sendBinary(data: ByteArray, length: Int): Boolean

    /** Bytes handed to the `files` channel and not yet sent. */
    fun bufferedAmount(): Long

    /** Suspends until the buffered amount may have dropped (or a short time has passed). */
    suspend fun awaitRoom()
}

/** One file to send. [size] is -1 when it could not be determined. [open] is called once, on the sending thread. */
interface FileSource {
    val name: String
    val size: Long
    fun open(): InputStream
}

enum class FileStatus { Waiting, Offering, Sending, Finishing, Done, Failed, Cancelled }

data class FileItem(
    val key: Int,
    val name: String,
    val size: Long,
    val status: FileStatus = FileStatus.Waiting,
    val sent: Long = 0,
    /** The words shown under the name once there is something to say (a failure reason, "Saved ..."). */
    val note: String? = null,
) {
    val active get() = status == FileStatus.Offering || status == FileStatus.Sending || status == FileStatus.Finishing
    val finished get() = status == FileStatus.Done || status == FileStatus.Failed || status == FileStatus.Cancelled
}

data class FileQueueState(val items: List<FileItem> = emptyList()) {
    /** Something is waiting or in progress. */
    val busy get() = items.any { !it.finished }
}

/**
 * Sends queued files to the PC one after another (docs/PROTOCOL.md, "File transfer"): offer, wait for accept / reject,
 * stream the bytes in 16 KB frames with back-pressure, then the SHA-256, then wait for the PC's verdict. Streams from
 * the [FileSource], never holds a whole file in memory, and never touches a file until the PC accepted its offer.
 */
class FileSender(
    private val scope: CoroutineScope,
    private val link: () -> FileLink?,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val replyTimeoutMs: Long = 20_000,
    private val doneTimeoutMs: Long = 90_000,
    private val newId: () -> String = { FileMsg.newId() },
) {
    private val _state = MutableStateFlow(FileQueueState())
    val state: StateFlow<FileQueueState> = _state.asStateFlow()

    private val lock = Any()
    private val sources = HashMap<Int, FileSource>()
    private var nextKey = 0
    private var workerRunning = false
    @Volatile private var cancelAll = false
    @Volatile private var inbox: Channel<Any>? = null
    @Volatile private var currentId: String? = null

    private object Closed
    private object Poke

    /** Adds [list] to the queue (at most [FileLimits.MAX_QUEUED]) and starts sending if nothing is running. */
    fun enqueue(list: List<FileSource>) {
        if (list.isEmpty()) return
        val start = synchronized(lock) {
            if (!_state.value.busy) { _state.value = FileQueueState(); sources.clear() } // a new batch replaces a finished one
            if (!workerRunning) cancelAll = false
            val room = (FileLimits.MAX_QUEUED - _state.value.items.size).coerceAtLeast(0)
            val added = list.take(room).map { src ->
                val key = nextKey++
                sources[key] = src
                FileItem(key, src.name, src.size)
            }
            _state.update { it.copy(items = it.items + added) }
            val s = !workerRunning && added.isNotEmpty()
            if (s) workerRunning = true
            s
        }
        if (start) scope.launch(dispatcher) { runQueue() }
    }

    /** A `file-accept` / `file-reject` / `file-done` from the PC. Replies for any other transfer are dropped. */
    fun onReply(reply: FileReply) {
        if (reply.id == currentId) inbox?.trySend(reply)
    }

    /** The connection (or the `files` channel) went away: the transfer in progress fails. */
    fun linkClosed() { inbox?.trySend(Closed) }

    /** Stops the transfer in progress and drops everything still waiting. */
    fun cancel() {
        cancelAll = true
        synchronized(lock) {
            _state.update { s ->
                s.copy(items = s.items.map { if (it.status == FileStatus.Waiting) it.copy(status = FileStatus.Cancelled, note = FileTexts.CANCELLED) else it })
            }
        }
        inbox?.trySend(Poke)
    }

    /** Empties the list once nothing is running (the sheet's "Done"). */
    fun clear() {
        synchronized(lock) {
            if (!_state.value.busy) { _state.value = FileQueueState(); sources.clear() }
        }
    }

    private suspend fun runQueue() {
        while (true) {
            val item = synchronized(lock) {
                val next = _state.value.items.firstOrNull { it.status == FileStatus.Waiting }
                if (next == null) { workerRunning = false; cancelAll = false }
                next
            } ?: return
            try {
                sendOne(item, synchronized(lock) { sources[item.key] })
            } catch (e: CancellationException) {
                synchronized(lock) { workerRunning = false }
                throw e
            }
        }
    }

    private fun update(key: Int, f: (FileItem) -> FileItem) {
        _state.update { s -> s.copy(items = s.items.map { if (it.key == key) f(it) else it }) }
    }

    private fun fail(key: Int, note: String) = update(key) { it.copy(status = FileStatus.Failed, note = note) }

    private suspend fun sendOne(item: FileItem, src: FileSource?) {
        val key = item.key
        if (src == null) return fail(key, FileTexts.UNREADABLE)
        if (cancelAll) return update(key) { it.copy(status = FileStatus.Cancelled, note = FileTexts.CANCELLED) }
        if (src.size < 0) return fail(key, FileTexts.UNREADABLE)
        if (src.size > FileLimits.MAX_BYTES) return fail(key, FileTexts.TOO_BIG_LOCAL)
        val l = link() ?: return fail(key, FileTexts.NOT_CONNECTED)
        if (!l.supported) return fail(key, FileTexts.OLD_HOST)

        val id = newId()
        val box = Channel<Any>(Channel.UNLIMITED)
        inbox = box
        currentId = id
        var offered = false
        try {
            update(key) { it.copy(status = FileStatus.Offering) }
            if (!l.sendCtl(FileMsg.offer(id, src.name, src.size))) return fail(key, FileTexts.CONNECTION_LOST)
            offered = true
            when (val r = await(box, replyTimeoutMs) { it is FileReply.Accept || it is FileReply.Reject }) {
                is FileReply.Accept -> {}
                is FileReply.Reject -> return fail(key, FileTexts.reject(r.reason))
                Closed -> return fail(key, FileTexts.CONNECTION_LOST)
                Poke -> return cancelled(key, l, id, offered)
                else -> return fail(key, FileTexts.NO_ANSWER)
            }

            update(key) { it.copy(status = FileStatus.Sending, sent = 0) }
            if (!l.sendText(FileMsg.begin(id).toString())) return fail(key, FileTexts.CONNECTION_LOST)
            val sha = Sha256Stream()
            val buf = ByteArray(FileLimits.CHUNK)
            var sent = 0L
            var paused = false
            val input = try { src.open() } catch (e: Exception) {
                if (e is CancellationException) throw e
                l.sendText(FileMsg.cancel(id).toString())
                return fail(key, FileTexts.UNREADABLE)
            }
            input.use {
                while (sent < src.size) {
                    if (cancelAll) return cancelled(key, l, id, offered)
                    if (!l.isOpen) return fail(key, FileTexts.CONNECTION_LOST)
                    paused = ChunkPlanner.shouldPause(l.bufferedAmount(), paused)
                    while (paused && !cancelAll && l.isOpen) {
                        l.awaitRoom()
                        paused = ChunkPlanner.shouldPause(l.bufferedAmount(), true)
                    }
                    if (cancelAll) return cancelled(key, l, id, offered)
                    val want = ChunkPlanner.nextLength(sent, src.size)
                    val n = try { it.read(buf, 0, want) } catch (e: java.io.IOException) {
                        l.sendText(FileMsg.cancel(id).toString())
                        return fail(key, FileTexts.UNREADABLE)
                    }
                    if (n < 0) { // shorter than it said it was
                        l.sendText(FileMsg.cancel(id).toString())
                        return fail(key, FileTexts.CHANGED)
                    }
                    if (n == 0) continue
                    sha.update(buf, 0, n)
                    if (!l.sendBinary(buf, n)) return fail(key, FileTexts.CONNECTION_LOST)
                    sent += n
                    update(key) { f -> f.copy(sent = sent) }
                }
            }
            if (!l.sendText(FileMsg.end(id, sha.hex()).toString())) return fail(key, FileTexts.CONNECTION_LOST)
            update(key) { it.copy(status = FileStatus.Finishing) }
            when (val r = await(box, doneTimeoutMs) { it is FileReply.Done }) {
                is FileReply.Done ->
                    if (r.ok) update(key) { it.copy(status = FileStatus.Done, sent = src.size, note = FileTexts.saved(r.name)) }
                    else fail(key, FileTexts.NOT_SAVED)
                Closed -> fail(key, FileTexts.CONNECTION_LOST)
                Poke -> cancelled(key, l, id, offered)
                else -> fail(key, FileTexts.NO_ANSWER)
            }
        } finally {
            inbox = null
            currentId = null
            box.close()
        }
    }

    private fun cancelled(key: Int, l: FileLink, id: String, offered: Boolean) {
        if (offered) l.sendText(FileMsg.cancel(id).toString())
        update(key) { it.copy(status = FileStatus.Cancelled, note = FileTexts.CANCELLED) }
    }

    /** The first message [accept] likes, [Closed], [Poke], or null after [ms]. */
    private suspend fun await(box: Channel<Any>, ms: Long, accept: (FileReply) -> Boolean): Any? = withTimeoutOrNull(ms) {
        var result: Any? = null
        while (result == null) {
            when (val m = box.receive()) {
                Closed, Poke -> result = m
                is FileReply -> if (accept(m)) result = m
            }
        }
        result
    }
}
