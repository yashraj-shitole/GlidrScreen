package com.yashraj.glidr.screen.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yashraj.glidr.screen.R

/** Same Midnight / Paper palette and accents as the Glidr app so the screen viewer can live inside it. */
@Immutable
class ScreenColors(
    val bg: Color, val s1: Color, val s2: Color, val s3: Color,
    val line: Color, val text: Color, val dim: Color, val dot: Color,
    val accent: Color, val accentText: Color, val ink: Color, val bad: Color, val light: Boolean,
)

private val ACCENTS = listOf(
    Color(0xFFD4FF3F) to Color(0xFF4A6000), // Volt
    Color(0xFFFF8A5B) to Color(0xFFA23A0C), // Ember
    Color(0xFF7DB2FF) to Color(0xFF1D4FB0), // Sky
    Color(0xFFFF7FB0) to Color(0xFFA8265B), // Rose
)

/**
 * Layout system, the same one the Glidr app uses. Sources: Material Design layout metrics (components on an 8dp
 * grid, type and icons on a 4dp sub-grid, 16dp side margins, 48dp touch targets with at least 8dp between
 * neighbours) and Apple's HIG (44pt minimum hit area).
 *
 * Rules the screens follow:
 *  - Screen gutter 16 ([Space.lg]).
 *  - Related items inside a group 8 ([Space.sm]); a label above its control 12 ([Space.md]).
 *  - Separate components stacked on a screen (trackpad, mouse buttons, tool row) 12 ([Space.md]); sections 24 ([Space.xl]).
 *  - Card inner padding 16 in lists, 20 ([Space.inset]) in dialogs and sheets. Pill button text padding 20.
 *  - Touch targets are 48dp. Key chips and segmented options are 44dp, the HIG minimum, so a row of them fits a phone.
 *  - Nothing off the 4dp grid except hairlines (1, 2) and drawn graphics (dot grid, ticks).
 */
object Space {
    val hair = 2.dp
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val inset = 20.dp
    val xl = 24.dp
}

/** Widest a bottom sheet gets, so wide screens and landscape keep a readable column (Material: ~560-600dp). */
val MAX_SHEET_WIDTH = 560.dp

/**
 * Corner radii on one scale. Nested shapes follow `inner = outer - inset`, so curves stay concentric:
 * segmented control 16 - 4 = 12 ([key]).
 */
object Radius {
    val key = 12.dp
    val chip = 16.dp
    val control = 20.dp
    val card = 24.dp
    val sheet = 28.dp
    val pad = 32.dp
}

/** The accent colours on offer, in the order [screenColors] takes them. */
val AccentSwatches: List<Color> get() = ACCENTS.map { it.first }

fun screenColors(light: Boolean, accentIndex: Int): ScreenColors {
    val (ac, deep) = ACCENTS[accentIndex.coerceIn(0, ACCENTS.lastIndex)]
    val ink = Color(0xFF0B0C0A)
    return if (light) {
        ScreenColors(
            Color(0xFFF1F2F4), Color(0xFFFFFFFF), Color(0xFFE7E8EB), Color(0xFFD8DADF), Color(0x17000000),
            Color(0xFF141517), Color(0xFF565963), Color(0x1A000000), ac, deep, ink, Color(0xFFB3261E), true,
        )
    } else {
        ScreenColors(
            Color(0xFF000000), Color(0xFF0C0D0F), Color(0xFF16171A), Color(0xFF222328), Color(0x14FFFFFF),
            Color(0xFFF3F2EE), Color(0xFF9A9CA6), Color(0x13FFFFFF), ac, ac, ink, Color(0xFFFF7F7F), false,
        )
    }
}

@Immutable
class ScreenType(val body: TextStyle, val label: TextStyle, val title: TextStyle, val mono: TextStyle, val small: TextStyle)

@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun geist(w: Int) = Font(R.font.gs_geist, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))

@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun mono(w: Int) = Font(R.font.gs_geist_mono, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))

private val Geist = FontFamily(geist(400), geist(500), geist(600), geist(700))
private val GeistMono = FontFamily(mono(400), mono(500), mono(600))

private val Type = ScreenType(
    body = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Medium, fontSize = 15.sp),
    label = TextStyle(fontFamily = Geist, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, letterSpacing = 0.05.sp),
    title = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Bold, fontSize = 28.sp, letterSpacing = (-0.8).sp),
    mono = TextStyle(fontFamily = GeistMono, fontWeight = FontWeight.Medium, fontSize = 11.sp),
    small = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Medium, fontSize = 12.sp),
)

private val LocalColors = compositionLocalOf { screenColors(false, 0) }
private val LocalType = compositionLocalOf { Type }
val LocalReduceMotion = compositionLocalOf { false }

object Gs {
    val colors: ScreenColors @Composable @ReadOnlyComposable get() = LocalColors.current
    val type: ScreenType @Composable @ReadOnlyComposable get() = LocalType.current
}

@Composable
fun ScreenTheme(light: Boolean = false, accent: Int = 0, reduceMotion: Boolean = false, content: @Composable () -> Unit) {
    CompositionLocalProvider(
        LocalColors provides screenColors(light, accent),
        LocalType provides Type,
        LocalReduceMotion provides reduceMotion,
        content = content,
    )
}
