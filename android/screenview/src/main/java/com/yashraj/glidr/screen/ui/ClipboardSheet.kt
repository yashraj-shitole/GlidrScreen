package com.yashraj.glidr.screen.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.yashraj.glidr.screen.net.ClipLimits
import com.yashraj.glidr.screen.net.ScreenClient
import kotlinx.coroutines.delay

/** Texts the clipboard sheet shows after an action. Pure so the wording is testable. */
object ClipboardFeedback {
    const val SENT = "Sent"
    const val COPIED = "Copied"
    const val EMPTY = "The phone clipboard has no text"
    const val NOT_SENT = "Could not send. Is the PC connected?"

    fun sentTruncated(sentChars: Int) = "Sent the first $sentChars characters. The rest was too long."
}

/**
 * Reads the Android clipboard as text, or null when it is empty or holds something else. Only call this from a tap
 * while the app is in the foreground (Android refuses background reads). The text is never logged.
 */
private fun readClipboardText(context: Context): String? {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return null
    val clip = cm.primaryClip ?: return null
    if (clip.itemCount == 0) return null
    val d = clip.description
    if (!d.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) && !d.hasMimeType(ClipDescription.MIMETYPE_TEXT_HTML)) return null
    return clip.getItemAt(0).coerceToText(context)?.toString()?.takeIf { it.isNotEmpty() }
}

/** Puts [text] on the Android clipboard, flagged sensitive so Android 13+ does not preview it on screen. */
private fun writeClipboardText(context: Context, text: String) {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText("PC clipboard", text)
    if (Build.VERSION.SDK_INT >= 33) {
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
    }
    runCatching { cm.setPrimaryClip(clip) }
}

/** While "Keep PC clipboard in sync" is on, text the PC pushes is copied to this phone's clipboard. */
@Composable
fun ClipboardAutoCopy(client: ScreenClient) {
    val context = LocalContext.current
    LaunchedEffect(client) {
        client.incomingClipboard.collect { text -> if (client.clipboardSync.value) writeClipboardText(context, text) }
    }
}

/** Clipboard bridge between the phone and the PC. Text goes straight to the PC over the peer connection. */
@Composable
fun ClipboardSheet(client: ScreenClient, onDismiss: () -> Unit) {
    val c = Gs.colors
    val context = LocalContext.current
    val sync by client.clipboardSync.collectAsState()
    val pcText by client.lastPcClipboard.collectAsState()
    var feedback by remember { mutableStateOf<String?>(null) }
    // one tick per action so the same message shown twice still restarts its timeout
    var tick by remember { mutableStateOf(0) }

    LaunchedEffect(tick) {
        if (feedback != null) { delay(3_000); feedback = null }
    }
    fun say(msg: String) { feedback = msg; tick++ }

    Sheet(onDismiss) {
        Label("Clipboard", style = Gs.type.body)
        Label("Clipboard text goes straight to your PC, never through a server.", color = c.dim, style = Gs.type.small)
        Pill("Send phone clipboard to PC", {
            val text = readClipboardText(context)
            if (text == null) {
                say(ClipboardFeedback.EMPTY)
            } else {
                val capped = ClipLimits.cap(text)
                say(
                    when {
                        !client.sendClipboard(capped.text) -> ClipboardFeedback.NOT_SENT
                        capped.truncated -> ClipboardFeedback.sentTruncated(capped.text.length)
                        else -> ClipboardFeedback.SENT
                    },
                )
            }
        }, Modifier.fillMaxWidth(), primary = true)
        Pill("Paste PC clipboard on phone", {
            pcText?.let { writeClipboardText(context, it); say(ClipboardFeedback.COPIED) }
        }, Modifier.fillMaxWidth(), enabled = pcText != null)
        if (pcText == null) {
            Label(
                if (sync) "Copy something on the PC and it shows up here." else "Turn on sync below to receive what you copy on the PC.",
                color = c.dim, style = Gs.type.small,
            )
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Label("Keep PC clipboard in sync")
                Label("Text you copy on the PC is copied to this phone too.", color = c.dim, style = Gs.type.small)
            }
            Toggle(sync, { client.setClipboardSync(it) }, "Keep PC clipboard in sync")
        }
        feedback?.let { Label(it, color = c.accentText, style = Gs.type.small) }
        Pill("Done", onDismiss, Modifier.fillMaxWidth())
    }
}
