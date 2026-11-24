package com.yashraj.glidr.screen.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
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
 * @param pendingShare files another app shared to this one (content URIs). They wait in a [ShareQueue] until a PC is
 *   connected, then the send sheet offers them; nothing is read before that. [onShareConsumed] is called once queued.
 * @param onClose shows a back button on the PC list when the feature is embedded in another app's navigation.
 * @param updates checks this GitHub repo for newer releases and offers the download. Leave null when embedded:
 *   the host app owns updates.
 */
@Composable
fun GlidrScreenApp(
    modifier: Modifier = Modifier,
    pendingLink: String? = null,
    onLinkConsumed: () -> Unit = {},
    pendingShare: List<Uri> = emptyList(),
    onShareConsumed: () -> Unit = {},
    onClose: (() -> Unit)? = null,
    updates: UpdateSource? = null,
    viewModel: ScreenViewModel = viewModel(),
) {
    val pcs by viewModel.pcs.collectAsState()
    val prefs by viewModel.prefs.collectAsState()
    val client by viewModel.client.collectAsState()
    val pairError by viewModel.pairError.collectAsState()
    val update by viewModel.update.collectAsState()
    val wakeNote by viewModel.wakeNote.collectAsState()
    val presence by viewModel.presence.collectAsState()
    val context = LocalContext.current
    val locked by viewModel.lock.locked.collectAsState()

    // The lock engages when the app has been in the background for the chosen delay. Activity stop/start is the signal
    // (ProcessLifecycleOwner is not a dependency). The first ON_START replayed on registration does nothing.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> viewModel.lock.onStop()
                Lifecycle.Event.ON_START -> viewModel.lock.onStart()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // nothing talks to the network while the lock screen is up, not even the update check
    LaunchedEffect(updates, locked) { if (!locked) updates?.let(viewModel::configureUpdates) }

    val shares = remember { ShareQueue() }
    LaunchedEffect(pendingShare) {
        if (pendingShare.isNotEmpty()) {
            shares.add(pendingShare)
            onShareConsumed()
        }
    }

    // Any web page or app can open a glidr:// link, so a link for a PC that is not paired yet is confirmed first.
    // A link would otherwise pick the key and signaling server this phone talks to.
    var linkToConfirm by remember { mutableStateOf<Pair<String, PairingInfo>?>(null) }

    // While locked the link stays pending (the caller keeps it until onLinkConsumed) and is handled right after unlock.
    LaunchedEffect(pendingLink, locked) {
        if (pendingLink != null && !locked) {
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
      CompositionLocalProvider(LocalShareQueue provides shares) {
        Box(Modifier.fillMaxSize()) {
            val active = client
            if (locked) {
                // the only thing composed while locked: no PC list, no video, no sheets, no pairing prompt behind it
                LockScreen(viewModel.lock, prefs.haptics)
            } else if (active != null) {
                ViewerScreen(active, prefs, viewModel::updatePrefs, onExit = viewModel::disconnect)
            } else {
                HomeScreen(
                    pcs = pcs,
                    pairError = pairError,
                    onPair = viewModel::pair,
                    onClearError = viewModel::clearPairError,
                    onConnect = viewModel::connect,
                    onWake = viewModel::wake,
                    presence = presence,
                    onRefreshPresence = viewModel::refreshPresence,
                    wakeNote = wakeNote,
                    onForget = viewModel::forget,
                    onRename = viewModel::rename,
                    onClose = onClose,
                    lock = viewModel.lock,
                    update = if (updates != null) UpdateUi(updates.currentVersion, update, viewModel::checkForUpdates) { url ->
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) }
                    } else null,
                )
                if (shares.uris.isNotEmpty()) ShareWaitingCard(shares, Modifier.align(Alignment.BottomCenter))
            }
            if (!locked) linkToConfirm?.let { (text, info) ->
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
}
