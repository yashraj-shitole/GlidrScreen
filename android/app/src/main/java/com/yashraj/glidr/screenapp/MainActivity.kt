package com.yashraj.glidr.screenapp

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.yashraj.glidr.screen.ui.GlidrScreenApp
import com.yashraj.glidr.screen.update.UpdateSource

/** GitHub repo whose releases carry the APK (Glidr Screen-1.2.0.apk and so on), tagged v1.2.0. */
private const val RELEASES_REPO = "yashraj-shitole/GlidrScreen"

class MainActivity : ComponentActivity() {
    private var pendingLink by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Only on a fresh start: a recreated activity (locale, density, process restore) still carries the old
        // intent, and consuming it again would reconnect and drop the live session.
        if (savedInstanceState == null) pendingLink = linkFrom(intent)
        val version = packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
        val updates = UpdateSource(RELEASES_REPO, version)
        setContent {
            GlidrScreenApp(pendingLink = pendingLink, onLinkConsumed = { pendingLink = null }, updates = updates)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingLink = linkFrom(intent)
    }

    private fun linkFrom(intent: Intent?): String? =
        if (intent?.action == Intent.ACTION_VIEW) intent.dataString else null
}
