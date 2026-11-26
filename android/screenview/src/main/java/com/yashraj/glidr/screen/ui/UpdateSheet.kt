package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import com.yashraj.glidr.screen.update.Install
import com.yashraj.glidr.screen.update.InstallError
import com.yashraj.glidr.screen.update.InstallStep
import com.yashraj.glidr.screen.update.Release

/** What the update popup says about a failed update. Pure, so it is unit-tested. */
object UpdateText {
    fun error(e: InstallError): String = when (e) {
        InstallError.Download -> "The download did not finish. Check your connection and try again."
        InstallError.Damaged -> "The downloaded file did not match the release, so it was thrown away. Try again."
        InstallError.Storage -> "There is not enough free space on this phone to install the update."
        InstallError.Refused -> "Android did not install it. If it asked to allow installs from Glidr Screen, allow that and try again, or get the update from the release page."
    }

    /** True while the popup must not be dismissed: the download runs or Android is installing. */
    fun busy(step: InstallStep?): Boolean = step is InstallStep.Downloading || step == InstallStep.Installing
}

/**
 * The update popup, the same flow as the Glidr app: ask, download inside the app with a progress bar, then hand over to
 * Android's own install prompt. [install] is null until the person says yes. A tap outside the card does nothing while
 * it is busy, so a stray touch cannot cancel a download.
 */
@Composable
fun UpdateSheet(release: Release, ui: UpdateUi, install: Install?, onClose: () -> Unit) {
    val c = Gs.colors
    val step = install?.step
    val busy = UpdateText.busy(step)
    Sheet({ if (!busy) onClose() }) {
        Label("Update available", style = Gs.type.body)
        Label("Version ${release.version} is ready. You have ${ui.currentVersion}.", style = Gs.type.body)
        val live = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
        when (step) {
            null -> Label("It downloads inside the app, then Android asks you to confirm the install. Your PCs and settings stay.", color = c.dim, style = Gs.type.small)
            is InstallStep.Downloading -> {
                Label("Downloading... ${step.percent}%", modifier = live, color = c.accentText, style = Gs.type.mono)
                UpdateProgress(step.percent / 100f)
            }
            InstallStep.Installing -> Label("Installing...", modifier = live, color = c.accentText, style = Gs.type.body)
            is InstallStep.Confirm -> Label("Android needs your OK to install the update.", modifier = live, color = c.accentText, style = Gs.type.body)
            is InstallStep.Failed -> Label(UpdateText.error(step.error), modifier = live, color = c.dim, style = Gs.type.body)
        }
        if (step != InstallStep.Installing) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                Pill(
                    if (step is InstallStep.Downloading) "Cancel" else "Later",
                    { if (step is InstallStep.Downloading) { ui.onCancel(); onClose() } else { ui.onSnooze(release.version); ui.onCancel(); onClose() } },
                    Modifier.weight(1f),
                )
                if (step !is InstallStep.Downloading) {
                    val label = when (step) {
                        is InstallStep.Confirm -> "Install"
                        is InstallStep.Failed -> "Try again"
                        else -> "Update now"
                    }
                    Pill(label, { if (step is InstallStep.Confirm) ui.onConfirmInstall() else ui.onUpdate(release) }, Modifier.weight(1f), primary = true)
                }
            }
        }
        if (step is InstallStep.Failed) Pill("Open the release page", { ui.onOpen(release.pageUrl) }, Modifier.fillMaxWidth())
    }
}

@Composable
private fun UpdateProgress(fraction: Float) {
    val c = Gs.colors
    Box(Modifier.fillMaxWidth().height(Space.sm).clip(CircleShape).background(c.s3)) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).fillMaxHeight().background(c.accent))
    }
}
