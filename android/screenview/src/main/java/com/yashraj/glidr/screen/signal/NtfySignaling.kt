package com.yashraj.glidr.screen.signal

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Events from the rendezvous topic. */
sealed interface SignalEvent {
    /** The subscription is live; messages published from now on will be seen. */
    data object Open : SignalEvent
    class Message(val json: JSONObject) : SignalEvent
}

/**
 * Rendezvous over an ntfy topic (https://ntfy.sh, self-hostable). Only a few small sealed messages pass through
 * it per connection and nothing is trusted from it: every message is AES-GCM sealed with the pairing key.
 */
class NtfySignaling(private val base: String, key: ByteArray) {
    private val slot = SignalCrypto.deriveSlot(key)
    private val root = base.trimEnd('/')

    /** Live stream of authentic messages (and [SignalEvent.Open]); ends with an exception on network failure. */
    fun events(): Flow<SignalEvent> = callbackFlow {
        val conn = URL("$root/${slot.topic}/json").openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 120_000 // ntfy sends a keepalive every 45 s
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                conn.inputStream.bufferedReader().useLines { lines ->
                    for (line in lines) {
                        if (line.isBlank()) continue
                        val ev = try { JSONObject(line) } catch (_: Exception) { continue }
                        when (ev.optString("event")) {
                            "open" -> trySend(SignalEvent.Open)
                            "message" -> {
                                val plain = SignalCrypto.open(slot.encKey, ev.optString("message")) ?: continue
                                val obj = try { JSONObject(plain) } catch (_: Exception) { continue }
                                trySend(SignalEvent.Message(obj))
                            }
                        }
                    }
                }
                close()
            } catch (e: Exception) {
                close(e)
            }
        }
        awaitClose { conn.disconnect() }
    }

    suspend fun publish(obj: JSONObject) = withContext(Dispatchers.IO) {
        val conn = URL("$root/${slot.topic}").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "text/plain")
            conn.outputStream.use { it.write(SignalCrypto.seal(slot.encKey, obj.toString()).toByteArray()) }
            check(conn.responseCode in 200..299) { "signaling HTTP ${conn.responseCode}" }
        } finally {
            conn.disconnect()
        }
    }
}
