package com.yashraj.glidr.screen.signal

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.util.Base64
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Pairing crypto, byte-compatible with host/src/crypto.js (see docs/PROTOCOL.md).
 *
 *   encKey = HKDF-SHA256(key, salt "glidr-screen/v1", info "enc", 32)
 *   topic  = "gs-" + base32(HKDF-SHA256(key, salt, info "topic", 20))
 *   frame  = base64url(nonce12 || AES-256-GCM(gzip(json)) || tag16), AAD "glidr-screen/1"
 */
object SignalCrypto {
    private val SALT = "glidr-screen/v1".toByteArray()
    private val AAD = "glidr-screen/1".toByteArray()
    private const val B32 = "abcdefghijklmnopqrstuvwxyz234567"
    private val random = SecureRandom()

    class Slot(val topic: String, val encKey: ByteArray)

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(data) }

    /** HKDF-SHA256 (RFC 5869), single-block expand (len <= 32). */
    fun hkdf(ikm: ByteArray, info: String, len: Int): ByteArray {
        val prk = hmac(SALT, ikm)
        return hmac(prk, info.toByteArray() + byteArrayOf(1)).copyOf(len)
    }

    fun base32(data: ByteArray): String {
        val sb = StringBuilder()
        var bits = 0
        var value = 0
        for (b in data) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                sb.append(B32[(value ushr (bits - 5)) and 31])
                bits -= 5
            }
            value = value and ((1 shl bits) - 1)
        }
        if (bits > 0) sb.append(B32[(value shl (5 - bits)) and 31])
        return sb.toString()
    }

    fun unbase32(text: String): ByteArray {
        val out = ByteArrayOutputStream()
        var bits = 0
        var value = 0
        for (ch in text.lowercase()) {
            val idx = B32.indexOf(ch)
            if (idx < 0) continue
            value = (value shl 5) or idx
            bits += 5
            if (bits >= 8) {
                out.write((value ushr (bits - 8)) and 0xff)
                bits -= 8
                value = value and ((1 shl bits) - 1)
            }
        }
        return out.toByteArray()
    }

    fun deriveSlot(key: ByteArray) = Slot("gs-" + base32(hkdf(key, "topic", 20)), hkdf(key, "enc", 32))

    fun seal(encKey: ByteArray, json: String, nonce: ByteArray = ByteArray(12).also { random.nextBytes(it) }): String {
        val gz = ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(json.toByteArray()) } }.toByteArray()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(encKey, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(AAD)
        val frame = Base64.getUrlEncoder().withoutPadding().encodeToString(nonce + c.doFinal(gz))
        require(frame.length <= 3900) { "signal frame too large (${frame.length})" }
        return frame
    }

    /** Decoded JSON text, or null when the frame is not authentic. */
    fun open(encKey: ByteArray, frame: String): String? = try {
        val raw = Base64.getUrlDecoder().decode(frame.trim())
        if (raw.size < 12 + 16 + 1) null else {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(encKey, "AES"), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
            c.updateAAD(AAD)
            val gz = c.doFinal(raw, 12, raw.size - 12)
            GZIPInputStream(ByteArrayInputStream(gz)).use { it.readBytes() }.toString(Charsets.UTF_8)
        }
    } catch (_: Exception) {
        null
    }

    fun newKey(): ByteArray = ByteArray(16).also { random.nextBytes(it) }
}
