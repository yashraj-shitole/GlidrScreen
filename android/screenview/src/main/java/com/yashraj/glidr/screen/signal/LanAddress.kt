package com.yashraj.glidr.screen.signal

/**
 * The PC's address for LAN signaling, the optional `l=a.b.c.d:port` of a pairing link (see docs/PROTOCOL.md, "LAN signaling").
 * Anything that is not exactly an IPv4 address on a private or link-local network plus a port is ignored, so a crafted
 * link cannot make the phone send its signaling traffic to a stranger's address or a host name.
 */
object LanAddress {
    private val FORM = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3}):(\\d{1,5})$")

    /** "192.168.1.20:50123" in canonical form (no leading zeros), or null when [text] is missing, malformed or not a private address. */
    fun clean(text: String?): String? {
        val m = FORM.matchEntire(text ?: return null) ?: return null
        val parts = m.groupValues.drop(1)
        // canonical numbers only: "01", "1.2.3.04" or "+5" are refused rather than guessed at
        if (parts.any { it.length > 1 && it.startsWith("0") }) return null
        val octets = parts.take(4).map { it.toInt() }
        val port = parts[4].toInt()
        if (octets.any { it > 255 } || port !in 1..65535) return null
        if (!isPrivate(octets[0], octets[1])) return null
        return "${octets.joinToString(".")}:$port"
    }

    /** 10/8, 172.16/12, 192.168/16 and 169.254/16: the ranges the PC itself serves (it answers everything else with 403). */
    private fun isPrivate(a: Int, b: Int): Boolean =
        a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)

    /** The ntfy-compatible base URL of the PC's LAN server for a [clean] address. */
    fun baseUrl(clean: String): String = "http://$clean"
}
