package com.yashraj.glidr.screen.update

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/** The download did not match what the release promised. */
class DamagedDownload(message: String) : Exception(message)

/** Far above any real Glidr Screen APK; stops a runaway response from filling the phone. */
private const val MAX_APK_BYTES = 200L * 1024 * 1024

/**
 * Copies a download into [output] and checks it on the way. [length] is the promised size (-1 if unknown) and
 * [sha256] the promised checksum (null if the release gave none). [onProgress] gets 0 to 100, each value once;
 * [checkActive] throws to stop the copy.
 */
fun copyVerified(
    input: InputStream, output: OutputStream, length: Long, sha256: String?,
    checkActive: () -> Unit = {}, onProgress: (Int) -> Unit = {},
) {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    var percent = -1
    while (true) {
        checkActive()
        val n = input.read(buffer)
        if (n < 0) break
        total += n
        if (total > MAX_APK_BYTES) throw DamagedDownload("larger than $MAX_APK_BYTES bytes")
        output.write(buffer, 0, n)
        digest.update(buffer, 0, n)
        if (length > 0) {
            val now = (total * 100 / length).toInt().coerceAtMost(100)
            if (now != percent) {
                percent = now
                onProgress(now)
            }
        }
    }
    // A dropped connection is a failed download, not a bad file.
    if (length >= 0 && total != length) throw IOException("got $total of $length bytes")
    if (total == 0L) throw IOException("empty download")
    if (sha256 != null) {
        val got = digest.digest().joinToString("") { "%02x".format(it) }
        if (got != sha256) throw DamagedDownload("checksum mismatch")
    }
}
