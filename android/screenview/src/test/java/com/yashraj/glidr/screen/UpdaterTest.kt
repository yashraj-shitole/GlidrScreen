package com.yashraj.glidr.screen

import android.content.pm.PackageInstaller
import com.yashraj.glidr.screen.ui.UpdateText
import com.yashraj.glidr.screen.update.DamagedDownload
import com.yashraj.glidr.screen.update.InstallError
import com.yashraj.glidr.screen.update.InstallStep
import com.yashraj.glidr.screen.update.Release
import com.yashraj.glidr.screen.update.UpdatePrompt
import com.yashraj.glidr.screen.update.Versions
import com.yashraj.glidr.screen.update.copyVerified
import com.yashraj.glidr.screen.update.installError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest

class UpdaterTest {
    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private val data = ByteArray(300_000) { (it * 31).toByte() }

    @Test fun copiesAndVerifiesAGoodDownload() {
        val out = ByteArrayOutputStream()
        val progress = mutableListOf<Int>()
        copyVerified(ByteArrayInputStream(data), out, data.size.toLong(), sha(data), onProgress = { progress += it })
        assertTrue(out.toByteArray().contentEquals(data))
        assertEquals(100, progress.last())
        assertEquals(progress.distinct(), progress) // each value once
        assertTrue(progress.zipWithNext().all { (a, b) -> b > a })
    }

    @Test fun aChecksumMismatchIsADamagedDownload() {
        try {
            copyVerified(ByteArrayInputStream(data), ByteArrayOutputStream(), data.size.toLong(), sha(byteArrayOf(1)))
            fail("expected DamagedDownload")
        } catch (e: DamagedDownload) { /* expected */ }
    }

    @Test fun aShortDownloadIsAFailedDownloadNotADamagedOne() {
        try {
            copyVerified(ByteArrayInputStream(data, 0, 1000), ByteArrayOutputStream(), data.size.toLong(), sha(data))
            fail("expected IOException")
        } catch (e: IOException) { /* expected: a dropped connection, retry */ }
    }

    @Test fun anEmptyDownloadFails() {
        try {
            copyVerified(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream(), -1, null)
            fail("expected IOException")
        } catch (e: IOException) { /* expected */ }
    }

    @Test fun noPromisedChecksumStillCopies() {
        val out = ByteArrayOutputStream()
        copyVerified(ByteArrayInputStream(data), out, -1, null)
        assertEquals(data.size, out.size())
    }

    @Test fun digestAndLinkParsing() {
        val hex = "a".repeat(64)
        assertEquals(hex, Versions.parseDigest("sha256:$hex"))
        assertEquals(hex, Versions.parseDigest("sha256:" + hex.uppercase()))
        assertNull(Versions.parseDigest("sha1:$hex"))
        assertNull(Versions.parseDigest("sha256:abc"))
        assertNull(Versions.parseDigest("sha256:" + "z".repeat(64)))
        assertTrue(Versions.isTrustedLink("https://github.com/x/y/releases/download/v1/a.apk"))
        assertFalse(Versions.isTrustedLink("http://github.com/x"))
        assertFalse(Versions.isTrustedLink("https://github.com.evil.example/a.apk"))
    }

    @Test fun releaseKnowsWhetherItHasAnApk() {
        assertTrue(Release("1", "https://github.com/x/a.APK", "https://github.com/x").hasApk)
        assertFalse(Release("1", "https://github.com/x/releases/latest", "https://github.com/x").hasApk)
    }

    @Test fun laterKeepsThePopupAwayForADayButNotForANewerVersion() {
        val now = 1_000_000_000_000L
        assertTrue(UpdatePrompt.shouldAsk("2.1.1", null, 0, now))
        assertFalse(UpdatePrompt.shouldAsk("2.1.1", "2.1.1", now + 1_000, now))
        assertTrue(UpdatePrompt.shouldAsk("2.1.1", "2.1.1", now - 1, now)) // the day is over
        assertTrue(UpdatePrompt.shouldAsk("2.1.2", "2.1.1", now + 1_000, now)) // a newer version asks at once
        assertTrue(UpdatePrompt.shouldAsk("2.1.1", "2.1.1", now + UpdatePrompt.SNOOZE_MS * 3, now)) // clock set back
    }

    @Test fun androidInstallStatusesMapToErrors() {
        assertNull(installError(PackageInstaller.STATUS_FAILURE_ABORTED, "INSTALL_FAILED_ABORTED: User rejected")) // said no
        assertEquals(InstallError.Refused, installError(PackageInstaller.STATUS_FAILURE_ABORTED, "INSTALL_FAILED_VERIFICATION_FAILURE"))
        assertEquals(InstallError.Storage, installError(PackageInstaller.STATUS_FAILURE_STORAGE, null))
        assertEquals(InstallError.Refused, installError(PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, null))
        assertEquals(InstallError.Refused, installError(PackageInstaller.STATUS_FAILURE_CONFLICT, null)) // e.g. a different signing key
    }

    @Test fun everyErrorHasWordingAndOnlyWorkIsBusy() {
        InstallError.values().forEach { assertTrue(UpdateText.error(it).isNotBlank()) }
        assertTrue(UpdateText.busy(InstallStep.Downloading(10)))
        assertTrue(UpdateText.busy(InstallStep.Installing))
        assertFalse(UpdateText.busy(null))
        assertFalse(UpdateText.busy(InstallStep.Failed(InstallError.Download)))
    }
}
