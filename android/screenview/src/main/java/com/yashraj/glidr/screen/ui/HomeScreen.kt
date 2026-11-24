package com.yashraj.glidr.screen.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.yashraj.glidr.screen.signal.PairedPc
import com.yashraj.glidr.screen.update.UpdateState

/** Opens Google's code scanner (no camera permission needed). */
fun scanQr(context: Context, onResult: (String) -> Unit, onError: (String) -> Unit) {
    val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build()
    GmsBarcodeScanning.getClient(context, options).startScan()
        .addOnSuccessListener { code -> code.rawValue?.let(onResult) }
        .addOnFailureListener { onError(it.message ?: "The scanner is not available. Type the code instead.") }
}

/** Update check as the home screen shows it. */
class UpdateUi(val currentVersion: String, val state: UpdateState, val onCheck: () -> Unit, val onOpen: (String) -> Unit)

@Composable
fun HomeScreen(
    pcs: List<PairedPc>,
    pairError: String?,
    onPair: (String) -> PairedPc?,
    onClearError: () -> Unit,
    onConnect: (PairedPc) -> Unit,
    onForget: (PairedPc) -> Unit,
    onRename: (PairedPc, String) -> Unit,
    onClose: (() -> Unit)?,
    update: UpdateUi? = null,
) {
    val c = Gs.colors
    val context = LocalContext.current
    var showCode by remember { mutableStateOf(false) }
    var scanError by remember { mutableStateOf<String?>(null) }
    var confirmForget by remember { mutableStateOf<PairedPc?>(null) }
    var manage by remember { mutableStateOf<PairedPc?>(null) }

    Box(Modifier.fillMaxSize().background(c.bg)) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        LazyColumn(
            Modifier.weight(1f).padding(horizontal = Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            item {
                Row(Modifier.fillMaxWidth().padding(top = Space.lg), verticalAlignment = Alignment.CenterVertically) {
                    if (onClose != null) {
                        RoundIconButton(Ico.Back, "Back", onClose)
                        Spacer(Modifier.size(12.dp))
                    }
                    Column(Modifier.weight(1f)) {
                        Label("Glidr Screen", style = Gs.type.title)
                        Label("See and control your PC from anywhere", color = c.dim, style = Gs.type.small)
                    }
                }
            }
            (update?.state as? UpdateState.Available)?.let { avail ->
                item {
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.card)).background(c.s1).border(1.dp, c.accent, RoundedCornerShape(Radius.card)).padding(Space.lg),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f).padding(end = Space.md)) {
                            Label("Version ${avail.release.version} is available", style = Gs.type.body)
                            Label("You have ${update.currentVersion}. Download and install the new APK.", color = c.dim, style = Gs.type.small)
                        }
                        Pill("Download", { update.onOpen(avail.release.downloadUrl) }, primary = true)
                    }
                }
            }
            if (pcs.isEmpty()) {
                item {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.card)).background(c.s1).border(1.dp, c.line, RoundedCornerShape(Radius.card)).padding(Space.inset), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                        Label("Connect your first PC", style = Gs.type.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold))
                        Step("1", "Run Glidr Screen on your Windows PC.")
                        Step("2", "Find the QR code in its window. If it is not shown, press \"Pair a new phone\".")
                        Step("3", "Scan it here. Your PC and phone then connect directly, from any network.")
                    }
                }
            } else {
                items(pcs, key = { it.id }) { pc ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.card)).background(c.s1).border(1.dp, c.line, RoundedCornerShape(Radius.card)).padding(Space.lg),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(48.dp).clip(RoundedCornerShape(Radius.key)).background(c.s2), contentAlignment = Alignment.Center) { Icon(Ico.Display, c.text) }
                        Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                            Label(pc.name, maxLines = 1, style = Gs.type.body)
                            Label(TimeText.lastConnected(System.currentTimeMillis(), pc.lastLive), color = c.dim, style = Gs.type.small)
                        }
                        RoundIconButton(Ico.Edit, "Rename or forget ${pc.name}", { manage = pc })
                        Spacer(Modifier.size(8.dp))
                        Pill("Connect", { onConnect(pc) }, primary = true)
                    }
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Pill("Scan QR", {
                        scanError = null
                        scanQr(context, { text -> onPair(text)?.let(onConnect) }, { scanError = it })
                    }, Modifier.weight(1f), primary = pcs.isEmpty())
                    Pill("Enter code", { onClearError(); showCode = true }, Modifier.weight(1f))
                }
            }
            val err = scanError ?: pairError.takeIf { !showCode }
            if (err != null) item { Label(err, color = c.bad, style = Gs.type.small) }
            item {
                Label(
                    "Your PC and phone talk directly over an encrypted link. No video passes through any server.",
                    color = c.dim, style = Gs.type.small, modifier = Modifier.padding(vertical = Space.sm),
                )
            }
        }
        // version and update check stay at the bottom of the screen instead of floating under the list
        if (update != null) {
            val status = when (val s = update.state) {
                UpdateState.Checking -> "Checking..."
                UpdateState.UpToDate -> "Up to date"
                UpdateState.NoReleases -> "No releases published yet"
                UpdateState.ViaStore -> "Updates come from Google Play"
                is UpdateState.Available -> "Version ${s.release.version} available"
                is UpdateState.Failed -> "Could not check for updates"
                UpdateState.Idle -> ""
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.md), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Label("Version ${update.currentVersion}", color = c.dim, style = Gs.type.small)
                    if (status.isNotEmpty()) Label(status, color = c.dim, style = Gs.type.small)
                }
                if (update.state != UpdateState.ViaStore) {
                    Pill("Check for updates", update.onCheck, enabled = update.state != UpdateState.Checking)
                }
            }
        }
        }

        if (showCode) CodeSheet(pairError, onClearError, { showCode = false }) { text ->
            val pc = onPair(text)
            if (pc != null) { showCode = false; onConnect(pc) }
        }
        manage?.let { pc ->
            ManageSheet(
                pc,
                onSave = { name -> onRename(pc, name); manage = null },
                onForget = { manage = null; confirmForget = pc },
                onDismiss = { manage = null },
            )
        }
        confirmForget?.let { pc ->
            Sheet({ confirmForget = null }) {
                Label("Forget ${pc.name}?", style = Gs.type.body)
                Label("This phone will need to be paired with the PC again.", color = c.dim, style = Gs.type.small)
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    // the safe choice is the highlighted one; the action that cannot be undone is red
                    Pill("Cancel", { confirmForget = null }, Modifier.weight(1f), primary = true)
                    Pill("Forget", { onForget(pc); confirmForget = null }, Modifier.weight(1f), danger = true)
                }
            }
        }
    }
}

@Composable
private fun ManageSheet(pc: PairedPc, onSave: (String) -> Unit, onForget: () -> Unit, onDismiss: () -> Unit) {
    val c = Gs.colors
    var name by remember { mutableStateOf(pc.name) }
    Sheet(onDismiss) {
        Label("Name this PC", style = Gs.type.body)
        BasicTextField(
            value = name,
            onValueChange = { name = it.take(40) },
            textStyle = Gs.type.body.copy(color = c.text),
            cursorBrush = SolidColor(c.accent),
            singleLine = true,
            modifier = Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(Radius.chip)).background(c.s2).padding(Space.md),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            Pill("Forget PC", onForget, Modifier.weight(1f))
            Pill("Save", { onSave(name) }, Modifier.weight(1f), primary = true, enabled = name.isNotBlank())
        }
    }
}

@Composable
private fun Step(n: String, text: String) {
    val c = Gs.colors
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        Box(Modifier.size(24.dp).clip(RoundedCornerShape(Radius.key)).background(c.accent), contentAlignment = Alignment.Center) { Label(n, color = c.ink, style = Gs.type.small) }
        Label(text, color = c.dim, style = Gs.type.body)
    }
}

@Composable
private fun CodeSheet(error: String?, onClearError: () -> Unit, onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    val c = Gs.colors
    var text by remember { mutableStateOf("") }
    Sheet(onDismiss) {
        Label("Enter the pairing code", style = Gs.type.body)
        Label("Type the code shown on the PC, or paste the pairing link.", color = c.dim, style = Gs.type.small)
        BasicTextField(
            value = text,
            onValueChange = { text = it; onClearError() },
            textStyle = Gs.type.mono.copy(color = c.text),
            cursorBrush = SolidColor(c.accent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
            modifier = Modifier.fillMaxWidth().height(64.dp).clip(RoundedCornerShape(Radius.chip)).background(c.s2).padding(Space.md),
        )
        if (error != null) Label(error, color = c.bad, style = Gs.type.small)
        Pill("Pair", { onSubmit(text) }, Modifier.fillMaxWidth(), primary = true, enabled = text.isNotBlank())
    }
}
