package com.yashraj.glidr.screen.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Springs, not tweens; no animation at all when Reduce motion is on. */
@Composable
fun <T> motionSpec(stiffness: Float = Spring.StiffnessMedium) =
    if (LocalReduceMotion.current) snap<T>() else spring<T>(dampingRatio = 0.65f, stiffness = stiffness)

@Composable
fun Label(
    text: String, modifier: Modifier = Modifier, color: Color = Gs.colors.text, style: TextStyle = Gs.type.label,
    maxLines: Int = Int.MAX_VALUE,
) = BasicText(text, modifier, style = style.copy(color = color), maxLines = maxLines, overflow = TextOverflow.Ellipsis)

/** Minimum 48dp touch target, spring press feedback, accessible description. */
@Composable
fun PressBox(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    description: String? = null,
    shape: Shape = RoundedCornerShape(18.dp),
    background: Color = Gs.colors.s2,
    border: Boolean = true,
    content: @Composable () -> Unit,
) {
    val src = remember { MutableInteractionSource() }
    val pressed by src.collectIsPressedAsState()
    val s by animateFloatAsState(if (pressed) 0.94f else 1f, motionSpec(), label = "press")
    Box(
        modifier
            .scale(s)
            .clip(shape)
            .background(background, shape)
            .then(if (border) Modifier.border(1.dp, Gs.colors.line, shape) else Modifier)
            .clickable(interactionSource = src, indication = null, role = Role.Button, onClick = onClick)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier),
        contentAlignment = Alignment.Center,
    ) { content() }
}

enum class Ico { Back, Close, Plus, Qr, Display, Swap, Keyboard, Settings, Touch, Pad, Trash, Check, Reset, Down }

@Composable
fun Icon(kind: Ico, tint: Color, size: Dp = 22.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val sw = w * 0.085f
        val st = Stroke(sw, cap = StrokeCap.Round)
        fun p(x: Float, y: Float) = Offset(x * w / 24f, y * w / 24f)
        fun sz(a: Float, b: Float) = Size(a * w / 24f, b * w / 24f)
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(tint, p(x1, y1), p(x2, y2), sw, StrokeCap.Round)
        when (kind) {
            Ico.Back -> { line(15f, 5f, 8f, 12f); line(8f, 12f, 15f, 19f) }
            Ico.Close -> { line(6f, 6f, 18f, 18f); line(18f, 6f, 6f, 18f) }
            Ico.Plus -> { line(12f, 5f, 12f, 19f); line(5f, 12f, 19f, 12f) }
            Ico.Check -> { line(5f, 12.5f, 10f, 17f); line(10f, 17f, 19f, 7f) }
            Ico.Down -> { line(6f, 9f, 12f, 15f); line(12f, 15f, 18f, 9f) }
            Ico.Qr -> {
                drawRoundRect(tint, p(4f, 4f), sz(6f, 6f), CornerRadius(w * 0.04f), style = st)
                drawRoundRect(tint, p(14f, 4f), sz(6f, 6f), CornerRadius(w * 0.04f), style = st)
                drawRoundRect(tint, p(4f, 14f), sz(6f, 6f), CornerRadius(w * 0.04f), style = st)
                drawCircle(tint, w * 0.04f, p(16f, 16f)); drawCircle(tint, w * 0.04f, p(19f, 19f)); drawCircle(tint, w * 0.04f, p(19f, 14.5f))
            }
            Ico.Display -> {
                drawRoundRect(tint, p(3f, 5f), sz(18f, 11f), CornerRadius(w * 0.1f), style = st)
                line(9f, 20f, 15f, 20f); line(12f, 16f, 12f, 20f)
            }
            Ico.Swap -> { line(5f, 8f, 18f, 8f); line(14f, 4.5f, 18f, 8f); line(14f, 11.5f, 18f, 8f); line(19f, 16f, 6f, 16f); line(10f, 12.5f, 6f, 16f); line(10f, 19.5f, 6f, 16f) }
            Ico.Keyboard -> {
                drawRoundRect(tint, p(3f, 6f), sz(18f, 12f), CornerRadius(w * 0.12f), style = st)
                for (x in listOf(7f, 12f, 17f)) drawCircle(tint, w * 0.03f, p(x, 10f))
                line(8f, 14.5f, 16f, 14.5f)
            }
            Ico.Settings -> {
                line(4f, 7f, 20f, 7f); line(4f, 17f, 20f, 17f)
                drawCircle(Color.Transparent, w * 0.1f, p(15f, 7f)); drawCircle(tint, w * 0.11f, p(15f, 7f), style = st)
                drawCircle(tint, w * 0.11f, p(9f, 17f), style = st)
            }
            Ico.Touch -> { // pointing hand, simplified
                drawCircle(tint, w * 0.3f, p(12f, 12f), style = st); drawCircle(tint, w * 0.06f, p(12f, 12f))
            }
            Ico.Pad -> drawRoundRect(tint, p(4f, 5f), sz(16f, 14f), CornerRadius(w * 0.2f), style = st)
            Ico.Trash -> { line(5f, 7f, 19f, 7f); line(9f, 7f, 9f, 4f); line(15f, 7f, 15f, 4f); line(9f, 4f, 15f, 4f); line(7f, 7f, 8f, 20f); line(17f, 7f, 16f, 20f); line(8f, 20f, 16f, 20f) }
            Ico.Reset -> {
                drawArc(tint, 30f, 290f, false, p(5f, 5f), sz(14f, 14f), style = st)
                val tip = Path().apply { moveTo(p(16.5f, 3.5f).x, p(16.5f, 3.5f).y); lineTo(p(20f, 8f).x, p(20f, 8f).y); lineTo(p(14.5f, 8.5f).x, p(14.5f, 8.5f).y); close() }
                drawPath(tip, tint)
            }
        }
    }
}

@Composable
fun RoundIconButton(kind: Ico, description: String, onClick: () -> Unit, active: Boolean = false, size: Dp = 48.dp) {
    val c = Gs.colors
    PressBox(onClick, Modifier.size(size), description, CircleShape, background = if (active) c.accent else c.s2, border = !active) {
        Icon(kind, if (active) c.ink else c.text)
    }
}

/** Text button, accent when [primary]. 48dp tall. */
@Composable
fun Pill(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, primary: Boolean = false, enabled: Boolean = true) {
    val c = Gs.colors
    PressBox(
        { if (enabled) onClick() }, modifier.height(48.dp), text, RoundedCornerShape(16.dp),
        background = if (primary) c.accent else c.s2, border = !primary,
    ) { Label(text, color = if (primary) c.ink else c.text, modifier = Modifier.padding(horizontal = 18.dp)) }
}

@Composable
fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val c = Gs.colors
    Row(modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.s2).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        options.forEachIndexed { i, label ->
            val on = i == selected
            val bg by animateColorAsState(if (on) c.accent else Color.Transparent, motionSpec(), label = "seg")
            Box(
                Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(11.dp)).background(bg).clickable(role = Role.Tab) { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) { Label(label, color = if (on) c.ink else c.dim) }
        }
    }
}

@Composable
fun Toggle(on: Boolean, onChange: (Boolean) -> Unit, description: String) {
    val c = Gs.colors
    val bg by animateColorAsState(if (on) c.accent else c.s3, motionSpec(), label = "sw")
    val x by animateFloatAsState(if (on) 20f else 0f, motionSpec(), label = "swx")
    Box(
        Modifier.size(width = 52.dp, height = 48.dp).clickable(role = Role.Switch) { onChange(!on) }.semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(52.dp, 32.dp).clip(CircleShape).background(bg)) {
            Box(Modifier.padding(start = (3 + x).dp, top = 3.dp).size(26.dp).clip(CircleShape).background(if (on) c.ink else c.dim))
        }
    }
}

@Composable
fun Slider(value: Float, range: ClosedFloatingPointRange<Float>, onChange: (Float) -> Unit, description: String, step: Float = 0.1f) {
    val c = Gs.colors
    val frac = ((value - range.start) / (range.endInclusive - range.start)).coerceIn(0f, 1f)
    fun at(x: Float, w: Float): Float {
        val f = (x / w).coerceIn(0f, 1f)
        val raw = range.start + f * (range.endInclusive - range.start)
        return (Math.round(raw / step) * step).coerceIn(range.start, range.endInclusive)
    }
    Box(
        Modifier.fillMaxWidth().height(48.dp).semantics { contentDescription = "$description %.1f".format(value) }
            .pointerInput(range) { detectTapGestures { onChange(at(it.x, size.width.toFloat())) } }
            .pointerInput(range) { detectDragGestures { ch, _ -> ch.consume(); onChange(at(ch.position.x, size.width.toFloat())) } },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(Modifier.fillMaxWidth().height(8.dp).clip(CircleShape).background(c.s3))
        Box(Modifier.fillMaxWidth(frac).height(8.dp).clip(CircleShape).background(c.accent))
    }
}

/** Bottom sheet over everything: scrim, tap outside to dismiss. */
@Composable
fun Sheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val c = Gs.colors
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).pointerInput(Unit) { detectTapGestures { onDismiss() } }, contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)).background(c.s1)
                .border(1.dp, c.line, RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                .pointerInput(Unit) { detectTapGestures { } }
                .navigationBarsPadding().padding(horizontal = 18.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(Modifier.align(Alignment.CenterHorizontally).size(36.dp, 4.dp).clip(CircleShape).background(c.s3))
            content()
        }
    }
}
