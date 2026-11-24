package com.yashraj.glidr.screen.lock

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * PIN hashing for the app lock. The PIN itself is never stored: only a random salt and a PBKDF2 hash of it.
 *
 * Pure (no Android classes) so it is unit tested on the JVM. [verify] fails closed: a wrong PIN, a PIN of the wrong
 * shape and any damaged stored value all return false, and it never throws.
 */
object PinLock {
    const val MIN_LENGTH = 4
    const val MAX_LENGTH = 8

    /** PBKDF2 rounds for a new PIN. About 0.1 s on a phone, so run it off the main thread. */
    const val ITERATIONS = 120_000

    /** Rounds outside this range mean the stored value is damaged (or planted), so it never verifies. */
    private const val MIN_STORED_ITERATIONS = 1_000
    private const val MAX_STORED_ITERATIONS = 2_000_000

    private const val SALT_BYTES = 16
    private const val HASH_BITS = 256
    private const val ALGORITHM = "PBKDF2WithHmacSHA256"

    /** What is kept on disk: base64 salt, base64 hash and the rounds used. */
    data class Stored(val salt: String, val hash: String, val iterations: Int = ITERATIONS)

    enum class Error { TooShort, TooLong, NotDigits, Weak }

    /** Why [pin] cannot be used as a new PIN, or null when it is fine. Digits only (ASCII 0-9), 4 to 8 of them, not trivial. */
    fun validate(pin: String): Error? = when {
        !pin.all { it in '0'..'9' } -> Error.NotDigits
        pin.length < MIN_LENGTH -> Error.TooShort
        pin.length > MAX_LENGTH -> Error.TooLong
        isWeak(pin) -> Error.Weak
        else -> null
    }

    /** All the same digit (1111) or a straight run up or down (1234, 4321, 56789). */
    private fun isWeak(pin: String): Boolean {
        if (pin.all { it == pin[0] }) return true
        val steps = pin.zipWithNext { a, b -> b - a }
        return steps.all { it == 1 } || steps.all { it == -1 }
    }

    /** Hashes a new PIN with a fresh random salt. Throws IllegalArgumentException for a PIN [validate] rejects. */
    fun create(pin: String, random: SecureRandom = SecureRandom(), iterations: Int = ITERATIONS): Stored {
        require(validate(pin) == null) { "PIN is not acceptable" }
        require(iterations in MIN_STORED_ITERATIONS..MAX_STORED_ITERATIONS) { "iterations out of range" }
        val salt = ByteArray(SALT_BYTES).also(random::nextBytes)
        val hash = derive(pin, salt, iterations)
        val b64 = Base64.getEncoder()
        return Stored(b64.encodeToString(salt), b64.encodeToString(hash), iterations)
    }

    /** True only when [pin] is the PIN [stored] was made from. Constant-time comparison. */
    fun verify(pin: String, stored: Stored): Boolean = try {
        if (!pin.all { it in '0'..'9' } || pin.length !in MIN_LENGTH..MAX_LENGTH) {
            false // cannot be a valid PIN; also keeps an absurdly long input away from the hash
        } else if (stored.iterations !in MIN_STORED_ITERATIONS..MAX_STORED_ITERATIONS) {
            false
        } else {
            val dec = Base64.getDecoder()
            val salt = dec.decode(stored.salt)
            val expected = dec.decode(stored.hash)
            if (salt.size != SALT_BYTES || expected.size != HASH_BITS / 8) {
                false
            } else {
                MessageDigest.isEqual(derive(pin, salt, stored.iterations), expected)
            }
        }
    } catch (_: Exception) {
        false
    }

    private fun derive(pin: String, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(pin.toCharArray(), salt, iterations, HASH_BITS)
        try {
            return SecretKeyFactory.getInstance(ALGORITHM).generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }
}
