package com.yashraj.glidr.screenapp

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.IntentCompat
import com.yashraj.glidr.screen.ui.GlidrScreenApp
import com.yashraj.glidr.screen.update.UpdateSource

/** GitHub repo whose releases carry the APK (Glidr Screen-1.2.0.apk and so on), tagged v1.2.0. */
private const val RELEASES_REPO = "yashraj-shitole/GlidrScreen"

/** Most files taken from one share. */
private const val MAX_SHARED = 25

class MainActivity : ComponentActivity() {
    private var pendingLink by mutableStateOf<String?>(null)
    private var pendingShare by mutableStateOf<List<Uri>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Only on a fresh start: a recreated activity (locale, density, process restore) still carries the old
        // intent, and consuming it again would reconnect and drop the live session.
        if (savedInstanceState == null) {
            pendingLink = linkFrom(intent)
            pendingShare = sharedFrom(intent)
        }
        val version = packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
        val updates = UpdateSource(RELEASES_REPO, version)
        setContent {
            GlidrScreenApp(
                pendingLink = pendingLink, onLinkConsumed = { pendingLink = null },
                pendingShare = pendingShare, onShareConsumed = { pendingShare = emptyList() },
                updates = updates,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingLink = linkFrom(intent)
        pendingShare = sharedFrom(intent)
    }

    private fun linkFrom(intent: Intent?): String? =
        if (intent?.action == Intent.ACTION_VIEW) intent.dataString else null

    /**
     * Files another app shared with "Share > Glidr Screen" (ACTION_SEND / ACTION_SEND_MULTIPLE). Only the URIs are
     * taken here; they are not opened until the user is connected to a PC and confirms. Anything but a `content://`
     * URI is dropped: a `file://` URI could point at this app's own private files.
     */
    private fun sharedFrom(intent: Intent?): List<Uri> {
        val uris = when (intent?.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList() // plain text shares carry no file
        }
        return uris.filter { it.scheme == "content" }.take(MAX_SHARED)
    }
}
