package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Drawn icons for the clipboard, follow-pointer and audio controls (same 24-unit grid and stroke as [Ico]). */
enum class ExtraIco { Clipboard, Pointer, Speaker, SpeakerOff, Send }

@Composable
fun ExtraIcon(kind: ExtraIco, tint: Color, size: Dp = 24.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val sw = w * 0.085f
        val st = Stroke(sw, cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun p(x: Float, y: Float) = Offset(x * w / 24f, y * w / 24f)
        fun sz(a: Float, b: Float) = Size(a * w / 24f, b * w / 24f)
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(tint, p(x1, y1), p(x2, y2), sw, StrokeCap.Round)
        fun poly(vararg pts: Pair<Float, Float>) {
            val path = Path()
            pts.forEachIndexed { i, (x, y) -> if (i == 0) path.moveTo(p(x, y).x, p(x, y).y) else path.lineTo(p(x, y).x, p(x, y).y) }
            path.close()
            drawPath(path, tint, style = st)
        }
        when (kind) {
            ExtraIco.Clipboard -> {
                drawRoundRect(tint, p(6f, 5f), sz(12f, 16f), CornerRadius(w * 0.07f), style = st)
                drawRoundRect(tint, p(9f, 3f), sz(6f, 4f), CornerRadius(w * 0.04f), style = st)
                line(9f, 12f, 15f, 12f); line(9f, 16f, 13f, 16f)
            }
            ExtraIco.Send -> { // an arrow up out of a tray
                line(12f, 15f, 12f, 4.5f); line(7.5f, 9f, 12f, 4.5f); line(16.5f, 9f, 12f, 4.5f)
                line(5f, 14f, 5f, 19f); line(5f, 19f, 19f, 19f); line(19f, 19f, 19f, 14f)
            }
            ExtraIco.Pointer -> poly(6f to 4f, 6f to 18f, 10f to 14f, 13f to 20f, 15.5f to 19f, 12.5f to 13f, 18f to 13f)
            ExtraIco.Speaker, ExtraIco.SpeakerOff -> {
                poly(4f to 9f, 8f to 9f, 13f to 5f, 13f to 19f, 8f to 15f, 4f to 15f)
                if (kind == ExtraIco.Speaker) {
                    drawArc(tint, -45f, 90f, false, p(10f, 8f), sz(8f, 8f), style = st)
                    drawArc(tint, -45f, 90f, false, p(8f, 4f), sz(14f, 16f), style = st)
                } else {
                    line(16.5f, 9.5f, 21f, 14.5f); line(21f, 9.5f, 16.5f, 14.5f)
                }
            }
        }
    }
}
