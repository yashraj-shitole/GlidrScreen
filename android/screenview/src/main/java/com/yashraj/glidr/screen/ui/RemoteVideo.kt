package com.yashraj.glidr.screen.ui

import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.viewinterop.AndroidView
import com.yashraj.glidr.screen.input.VideoMapping
import com.yashraj.glidr.screen.net.MouseButton
import com.yashraj.glidr.screen.net.ScreenClient
import com.yashraj.glidr.screen.net.WebRtcRuntime
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import kotlin.math.hypot

private const val MAX_ZOOM = 5f
private const val LONG_PRESS_MS = 450L

/** Shared zoom / pan state of the picture. */
class VideoViewState {
    var zoom by mutableFloatStateOf(1f)
    var panX by mutableFloatStateOf(0f)
    var panY by mutableFloatStateOf(0f)
    fun reset() { zoom = 1f; panX = 0f; panY = 0f }
    val zoomed get() = zoom > 1.01f
}

/**
 * The PC picture. Pinch to zoom, drag to pan while zoomed. With [directTouch] a tap clicks that spot on the PC,
 * a long press right-clicks it, and dragging moves the pointer there.
 */
@Composable
fun RemoteVideo(
    track: VideoTrack?,
    client: ScreenClient,
    state: VideoViewState,
    directTouch: Boolean,
    videoSize: Pair<Int, Int>,
    haptic: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var container by remember { mutableStateOf(IntSize.Zero) }
    val vs by rememberUpdatedState(videoSize)
    val direct by rememberUpdatedState(directTouch)
    val hp by rememberUpdatedState(haptic)
    val renderer = remember {
        SurfaceViewRenderer(context).apply {
            init(WebRtcRuntime.eglBase(context).eglBaseContext, null)
            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            setEnableHardwareScaler(true)
            setMirror(false)
        }
    }
    DisposableEffect(track) {
        track?.addSink(renderer)
        onDispose { track?.removeSink(renderer) }
    }
    DisposableEffect(Unit) {
        onDispose { Handler(Looper.getMainLooper()).post { renderer.release() } }
    }

    Box(modifier.onSizeChanged { container = it }) {
        AndroidView(
            factory = { renderer },
            modifier = Modifier.fillMaxSize(),
            update = {
                it.scaleX = state.zoom
                it.scaleY = state.zoom
                it.translationX = state.panX
                it.translationY = state.panY
            },
        )
        Box(
            Modifier.fillMaxSize().pointerInput(client) {
                awaitEachGesture {
                    val first = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    val slop = viewConfiguration.touchSlop
                    var moved = false
                    var fingers = 1
                    var longFired = false
                    var lastSpan = 0f
                    var lastSend = 0L
                    var travelled = 0f
                    fun pointAt(x: Float, y: Float) = VideoMapping.toNormalised(
                        x, y, container.width.toFloat(), container.height.toFloat(), vs.first, vs.second, state.zoom, state.panX, state.panY,
                    )
                    if (direct) pointAt(first.position.x, first.position.y)?.let { client.moveAbsolute(it.first, it.second) }
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val pressed = event.changes.filter { it.pressed }
                        if (pressed.isEmpty()) break
                        fingers = maxOf(fingers, pressed.size)
                        if (pressed.size >= 2) {
                            moved = true
                            val a = pressed[0].position
                            val b = pressed[1].position
                            val span = hypot(a.x - b.x, a.y - b.y)
                            if (lastSpan > 0f && span > 0f) {
                                val nz = (state.zoom * span / lastSpan).coerceIn(1f, MAX_ZOOM)
                                state.zoom = nz
                            }
                            lastSpan = span
                            val d0 = pressed[0].positionChange(); val d1 = pressed[1].positionChange()
                            state.panX += (d0.x + d1.x) / 2f; state.panY += (d0.y + d1.y) / 2f
                            clampPan(state, container)
                            event.changes.forEach { it.consume() }
                        } else if (fingers == 1) {
                            lastSpan = 0f
                            val ch = pressed[0]
                            val d = ch.positionChange()
                            travelled += hypot(d.x, d.y)
                            if (!moved && travelled > slop) moved = true
                            if (direct) {
                                if (moved && ch.uptimeMillis - lastSend > 16) {
                                    pointAt(ch.position.x, ch.position.y)?.let { client.moveAbsolute(it.first, it.second) }
                                    lastSend = ch.uptimeMillis
                                }
                                if (!moved && !longFired && ch.uptimeMillis - first.uptimeMillis > LONG_PRESS_MS) {
                                    longFired = true
                                    pointAt(ch.position.x, ch.position.y)?.let { client.moveAbsolute(it.first, it.second); client.click(MouseButton.Right); hp(true) }
                                }
                                ch.consume()
                            } else if (state.zoomed && moved) {
                                state.panX += d.x; state.panY += d.y
                                clampPan(state, container)
                                ch.consume()
                            }
                        }
                    }
                    if (direct && !moved && !longFired && fingers == 1) {
                        pointAt(first.position.x, first.position.y)?.let { client.moveAbsolute(it.first, it.second); client.click(MouseButton.Left); hp(false) }
                    }
                }
            },
        )
    }
}

private fun clampPan(s: VideoViewState, size: IntSize) {
    val maxX = size.width * (s.zoom - 1f) / 2f
    val maxY = size.height * (s.zoom - 1f) / 2f
    s.panX = s.panX.coerceIn(-maxX, maxX)
    s.panY = s.panY.coerceIn(-maxY, maxY)
}
