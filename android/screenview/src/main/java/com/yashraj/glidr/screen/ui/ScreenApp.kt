package com.yashraj.glidr.screen.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.yashraj.glidr.screen.ScreenViewModel

/**
 * The whole Glidr Screen feature as one composable: list of PCs, pairing, and the live viewer with trackpad.
 * Drop it into any Compose host (the standalone app, or later a container inside the Glidr app).
 *
 * @param pendingLink a `glidr://screen?...` link received from outside (deep link); it is paired and connected
 *   automatically, then [onLinkConsumed] is called.
 * @param onClose shows a back button on the PC list when the feature is embedded in another app's navigation.
 */
@Composable
fun GlidrScreenApp(
    modifier: Modifier = Modifier,
    pendingLink: String? = null,
    onLinkConsumed: () -> Unit = {},
    onClose: (() -> Unit)? = null,
    viewModel: ScreenViewModel = viewModel(),
) {
    val pcs by viewModel.pcs.collectAsState()
    val prefs by viewModel.prefs.collectAsState()
    val client by viewModel.client.collectAsState()
    val pairError by viewModel.pairError.collectAsState()

    LaunchedEffect(pendingLink) {
        if (pendingLink != null) {
            viewModel.pair(pendingLink)?.let { viewModel.connect(it) }
            onLinkConsumed()
        }
    }

    ScreenTheme(light = prefs.light, accent = prefs.accent) {
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
                onClose = onClose,
            )
        }
    }
}
