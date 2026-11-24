package com.yashraj.glidr.screen.ui

import android.content.Intent
import androidx.core.net.toUri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.yashraj.glidr.screen.ScreenViewModel
import com.yashraj.glidr.screen.signal.DEFAULT_SIGNAL_BASE
import com.yashraj.glidr.screen.signal.PairingInfo
import com.yashraj.glidr.screen.signal.PairingParser
import com.yashraj.glidr.screen.update.UpdateSource

/**
 * The whole Glidr Screen feature as one composable: list of PCs, pairing, and the live viewer with trackpad.
 * Drop it into any Compose host (the standalone app, or later a container inside the Glidr app).
 *
 * @param pendingLink a `glidr://screen?...` link received from outside (deep link); it is paired and connected
 *   automatically, then [onLinkConsumed] is called.
 * @param onClose shows a back button on the PC list when the feature is embedded in another app's navigation.
 * @param updates checks this GitHub repo for newer releases and offers the download. Leave null when embedded:
 *   the host app owns updates.
 */
@Composable
fun GlidrScreenApp(
    modifier: Modifier = Modifier,
    pendingLink: String? = null,
    onLinkConsumed: () -> Unit = {},
    onClose: (() -> Unit)? = null,
    updates: UpdateSource? = null,
    viewModel: ScreenViewModel = viewModel(),
) {
    val pcs by viewModel.pcs.collectAsState()
    val prefs by viewModel.prefs.collectAsState()
    val client by viewModel.client.collectAsState()
    val pairError by viewModel.pairError.collectAsState()
    val update by viewModel.update.collectAsState()
    val context = LocalContext.current

    LaunchedEffect(updates) { updates?.let(viewModel::configureUpdates) }

    // Any web page or app can open a glidr:// link, so a link for a PC that is not paired yet is confirmed first.
    // A link would otherwise pick the key and signaling server this phone talks to.
    var linkToConfirm by remember { mutableStateOf<Pair<String, PairingInfo>?>(null) }

    LaunchedEffect(pendingLink) {
        if (pendingLink != null) {
            val info = PairingParser.parse(pendingLink)
            when {
                info == null -> viewModel.pair(pendingLink) // sets the "does not look like a pairing code" error
                pcs.any { it.key == info.keyText } -> viewModel.pair(pendingLink)?.let { viewModel.connect(it) }
                else -> linkToConfirm = pendingLink to info
            }
            onLinkConsumed()
        }
    }

    ScreenTheme(light = prefs.light, accent = prefs.accent) {
        Box(Modifier.fillMaxSize()) {
            val active = client
            if (active != null) {
                ViewerScreen(active, prefs, viewModel::updatePrefs, onExit = viewModel::disconnect)
            } else {
                HomeScreen(
                    pcs = pcs,
                    pairError = pairError,
                    onPair = viewModel::pair,
                    onClearError = viewModel::clearPairError,
                    onConnect = viewModel::connect,
                    onForget = viewModel::forget,
                    onRename = viewModel::rename,
                    onClose = onClose,
                    update = if (updates != null) UpdateUi(updates.currentVersion, update, viewModel::checkForUpdates) { url ->
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) }
                    } else null,
                )
            }
            linkToConfirm?.let { (text, info) ->
                val c = Gs.colors
                Sheet({ linkToConfirm = null }) {
                    Label("Pair with ${info.hostName}?", maxLines = 2, style = Gs.type.body)
                    Label(
                        "This link was opened from outside the app. Only continue if it came from Glidr Screen on your own PC.",
                        color = c.dim, style = Gs.type.small,
                    )
                    if (info.signalBase != DEFAULT_SIGNAL_BASE) {
                        Label("Signaling server: ${info.signalBase}", color = c.dim, style = Gs.type.small, maxLines = 2)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Pill("Cancel", { linkToConfirm = null }, Modifier.weight(1f))
                        Pill("Pair", {
                            linkToConfirm = null
                            viewModel.pair(text)?.let { viewModel.connect(it) }
                        }, Modifier.weight(1f), primary = true)
                    }
                }
            }
        }
    }
}
