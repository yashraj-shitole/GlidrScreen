package com.yashraj.glidr.screen.ui

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.yashraj.glidr.screen.net.MediaNote
import com.yashraj.glidr.screen.net.MediaPhase
import com.yashraj.glidr.screen.net.PhoneMediaState
import com.yashraj.glidr.screen.net.PhoneMediaText
import com.yashraj.glidr.screen.net.ScreenClient

/** Which Android permissions still have to be asked for. Pure so it is testable; nothing is asked at app start. */
object PhoneMediaPermissions {
    const val CAMERA = "android.permission.CAMERA"
    const val MICROPHONE = "android.permission.RECORD_AUDIO"

    /** The permissions [camera] / [microphone] need that [has] says are missing, in a fixed order. */
    fun missing(camera: Boolean, microphone: Boolean, has: (String) -> Boolean): List<String> = buildList {
        if (camera && !has(CAMERA)) add(CAMERA)
        if (microphone && !has(MICROPHONE)) add(MICROPHONE)
    }
}

private fun granted(context: Context, permission: String) =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

/** What the person is being asked before Android shows its own dialog. */
private data class Ask(val camera: Boolean, val microphone: Boolean)

/**
 * The "Camera and mic" chip, the persistent "Camera on" / "Mic on" tag and the sheet behind the chip (one hook in
 * Banners.kt). The tag is on screen for as long as the camera or microphone runs, whatever else is open. Everything
 * stops when the app leaves the screen (Android 14+ does not allow camera and microphone use from the background to
 * continue without a foreground service, and nobody expects a hidden camera).
 */
@Composable
fun PhoneMediaHost(client: ScreenClient, extras: ViewerExtras) {
    val state by client.phoneMedia.collectAsState()
    val context = LocalContext.current
    var open by extras::mediaOpen // opened by the "Camera and mic" tile in the viewer's tool grid
    var ask by remember { mutableStateOf<Ask?>(null) }
    var denied by remember { mutableStateOf(false) }

    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, client) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) client.stopPhoneMedia(MediaNote.Background)
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val a = ask
        ask = null
        if (a != null) {
            val cameraOk = !a.camera || result[PhoneMediaPermissions.CAMERA] == true || granted(context, PhoneMediaPermissions.CAMERA)
            val micOk = !a.microphone || result[PhoneMediaPermissions.MICROPHONE] == true || granted(context, PhoneMediaPermissions.MICROPHONE)
            denied = !cameraOk || !micOk
            if (a.camera && cameraOk) client.setPhoneCamera(true)
            if (a.microphone && micOk) client.setPhoneMicrophone(true)
        }
    }

    /** Switches one thing on: straight away when Android already allows it, otherwise after saying why and asking. */
    fun switchOn(camera: Boolean, microphone: Boolean) {
        denied = false
        val need = PhoneMediaPermissions.missing(camera, microphone) { granted(context, it) }
        if (need.isEmpty()) {
            if (camera) client.setPhoneCamera(true)
            if (microphone) client.setPhoneMicrophone(true)
        } else ask = Ask(camera, microphone)
    }

    if (open) {
        Dialog(
            onDismissRequest = { open = false; ask = null },
            properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        ) {
            // the sheet draws its own scrim
            val window = (LocalView.current.parent as? DialogWindowProvider)?.window
            SideEffect { window?.setDimAmount(0f) }
            Sheet({ open = false; ask = null }) {
                val a = ask
                if (a != null) {
                    Label("Camera and mic", style = Gs.type.body)
                    Label(PhoneMediaText.explain(a.camera, a.microphone), color = Gs.colors.dim, style = Gs.type.small)
                    Pill("Continue", {
                        launcher.launch(PhoneMediaPermissions.missing(a.camera, a.microphone) { granted(context, it) }.toTypedArray())
                    }, Modifier.fillMaxWidth(), primary = true)
                    Pill("Not now", { ask = null }, Modifier.fillMaxWidth())
                } else {
                    PhoneMediaSheetBody(
                        state, denied,
                        onCamera = { if (it) switchOn(camera = true, microphone = false) else client.setPhoneCamera(false) },
                        onMicrophone = { if (it) switchOn(camera = false, microphone = true) else client.setPhoneMicrophone(false) },
                        onFlip = { client.setPhoneCameraFront(!state.front) },
                        onSettings = { openAppSettings(context) },
                        onDismiss = { open = false },
                    )
                }
            }
        }
    }
}

@Composable
private fun PhoneMediaSheetBody(
    state: PhoneMediaState,
    denied: Boolean,
    onCamera: (Boolean) -> Unit,
    onMicrophone: (Boolean) -> Unit,
    onFlip: () -> Unit,
    onSettings: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Gs.colors
    Label("Camera and mic", style = Gs.type.body)
    Label(
        "Send this phone's camera or microphone to your PC. It opens in a Glidr Screen window there and goes straight to " +
            "your PC. Nothing is recorded or kept.",
        color = c.dim, style = Gs.type.small,
    )
    ToggleRow("Camera", "Shown in a window on the PC", state.camera, onCamera)
    ToggleRow("Microphone", "Plays on the PC", state.microphone, onMicrophone)
    Pill(if (state.front) "Use the back camera" else "Use the front camera", onFlip, Modifier.fillMaxWidth())
    val statusColor = when {
        state.note != MediaNote.None -> c.bad
        state.phase == MediaPhase.Sending -> c.accentText
        else -> c.dim
    }
    Label(PhoneMediaText.status(state), color = statusColor, style = Gs.type.small)
    if (denied) {
        Label(PhoneMediaText.DENIED_HELP, color = c.dim, style = Gs.type.small)
        Pill("Open app settings", onSettings, Modifier.fillMaxWidth())
    }
    Label("Everything stops when you leave the app or the session ends.", color = c.dim, style = Gs.type.small)
    Pill("Done", onDismiss, Modifier.fillMaxWidth())
}

@Composable
private fun ToggleRow(title: String, sub: String, on: Boolean, onChange: (Boolean) -> Unit) {
    val c = Gs.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Label(title)
            Label(sub, color = c.dim, style = Gs.type.small)
        }
        Toggle(on, onChange, title)
    }
}

/** One item of the viewer's status stack (top left of the picture): "Camera on" / "Mic on" while either runs. */
@Composable
fun MediaLiveTag(client: ScreenClient) {
    val state by client.phoneMedia.collectAsState()
    PhoneMediaText.tag(state)?.let { LiveTag(it) }
}

/** "Camera on" / "Mic on": same look as the viewer's other tags, with a red dot so it reads as live. */
@Composable
private fun LiveTag(text: String) {
    val c = Gs.colors
    val shape = RoundedCornerShape(Radius.control)
    Row(
        Modifier.height(40.dp).clip(shape).background(Scrim).border(1.dp, c.line, shape).padding(horizontal = Space.lg),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(c.bad))
        Label(text, color = Color.White, style = Gs.type.small)
    }
}

private val Scrim = Color(0xCC000000)

private fun openAppSettings(context: Context) {
    runCatching {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

/** A camera (false) or a microphone (true), drawn on the same 24-unit grid and stroke as the other icons. */
@Composable
fun MediaIcon(microphone: Boolean, tint: Color, size: Dp = 24.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val sw = w * 0.085f
        val st = Stroke(sw, cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun p(x: Float, y: Float) = Offset(x * w / 24f, y * w / 24f)
        fun sz(a: Float, b: Float) = Size(a * w / 24f, b * w / 24f)
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(tint, p(x1, y1), p(x2, y2), sw, StrokeCap.Round)
        if (microphone) {
            drawRoundRect(tint, p(9f, 3f), sz(6f, 11f), CornerRadius(w * 0.125f), style = st)
            drawArc(tint, 0f, 180f, false, p(5.5f, 7.5f), sz(13f, 11f), style = st)
            line(12f, 18.5f, 12f, 21f)
            line(8.5f, 21f, 15.5f, 21f)
        } else {
            drawRoundRect(tint, p(3f, 7f), sz(18f, 12f), CornerRadius(w * 0.1f), style = st)
            drawCircle(tint, w * 0.11f, p(12f, 13f), style = st)
            line(8f, 7f, 9.5f, 4.5f)
            line(9.5f, 4.5f, 14.5f, 4.5f)
            line(14.5f, 4.5f, 16f, 7f)
        }
    }
}
