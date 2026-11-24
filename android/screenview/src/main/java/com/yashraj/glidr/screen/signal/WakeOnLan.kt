package com.yashraj.glidr.screen.signal

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/** Wake-on-LAN: the "magic packet" and how it is sent. Pure helpers are separate so they can be unit tested. */
object WakeOnLan {
    const val PORT = 9
    private val MAC = Regex("^[0-9A-Fa-f]{12}$")
    private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

    /** 12 hex characters (case-insensitive) to 6 bytes, or null for anything else. */
    fun parseMac(text: String?): ByteArray? {
        val t = text?.trim() ?: return null
        if (!MAC.matches(t)) return null
        return ByteArray(6) { t.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    /** The MAC as stored: 12 upper-case hex characters, or null if [text] is missing or malformed. */
    fun cleanMac(text: String?): String? = parseMac(text)?.joinToString("") { "%02X".format(it) }

    /** A dotted IPv4 address (four numbers 0..255), or null. */
    fun parseIpv4(text: String?): ByteArray? {
        val m = IPV4.matchEntire(text?.trim() ?: return null) ?: return null
        val parts = m.groupValues.drop(1).map { it.toInt() }
        if (parts.any { it > 255 }) return null
        return ByteArray(4) { parts[it].toByte() }
    }

    /** The address in canonical dotted form (no leading zeros), or null if malformed. */
    fun cleanBroadcast(text: String?): String? = parseIpv4(text)?.joinToString(".") { (it.toInt() and 0xFF).toString() }

    /** 6 bytes of 0xFF followed by the MAC 16 times: 102 bytes. */
    fun magicPacket(mac: ByteArray): ByteArray {
        require(mac.size == 6) { "A MAC address is 6 bytes" }
        val out = ByteArray(6 + 16 * 6)
        for (i in 0 until 6) out[i] = 0xFF.toByte()
        for (r in 0 until 16) mac.copyInto(out, 6 + r * 6)
        return out
    }

    fun magicPacket(mac: String): ByteArray = magicPacket(requireNotNull(parseMac(mac)) { "Not a MAC address" })

    /** Where the packet goes: the PC network's broadcast address when known, then the limited broadcast. */
    fun targets(broadcast: String?): List<String> = (listOfNotNull(cleanBroadcast(broadcast)) + "255.255.255.255").distinct()

    /** Sends the magic packet by UDP broadcast to port 9. Success when at least one destination accepted it. */
    suspend fun send(mac: String, broadcast: String?): Result<Unit> = withContext(Dispatchers.IO) {
        val packet = try {
            magicPacket(mac)
        } catch (e: IllegalArgumentException) {
            return@withContext Result.failure(e)
        }
        var sent = 0
        var last: Throwable? = null
        try {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                for (host in targets(broadcast)) {
                    try {
                        socket.send(DatagramPacket(packet, packet.size, InetAddress.getByName(host), PORT))
                        sent++
                    } catch (e: Exception) {
                        last = e
                    }
                }
            }
        } catch (e: Exception) {
            last = e
        }
        if (sent > 0) Result.success(Unit)
        else Result.failure(last ?: java.io.IOException("Nothing was sent"))
    }

    const val SENT_MESSAGE = "Wake signal sent. Give the PC a minute, then connect"
    const val CAVEAT = "Works on the same Wi-Fi when Wake-on-LAN is enabled on the PC"

    /** The line shown after tapping Wake. */
    fun resultMessage(r: Result<Unit>): String =
        if (r.isSuccess) SENT_MESSAGE
        else "Could not send the wake signal: " + (r.exceptionOrNull()?.message?.takeIf { it.isNotBlank() } ?: "unknown error")
}
