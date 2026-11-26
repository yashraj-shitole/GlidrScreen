package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/** One labelled tool: what it is drawn as, what it is called, whether it is switched on, and what a tap does. */
class ToolTileSpec(
    val label: String,
    val active: Boolean = false,
    val onClick: () -> Unit,
    val icon: @Composable (Color) -> Unit,
)

/** Fewer tiles per row when the panel is narrow (the landscape side panel), so a label never gets cut to nothing. */
object ToolGridLayout {
    const val PORTRAIT_PER_ROW = 4
    const val LANDSCAPE_PER_ROW = 3

    fun perRow(landscape: Boolean) = if (landscape) LANDSCAPE_PER_ROW else PORTRAIT_PER_ROW

    /** The tiles split into rows of [perRow]; the last row may be shorter (the grid pads it so tiles keep one width). */
    fun rows(count: Int, perRow: Int): List<Int> = if (count <= 0) emptyList() else List((count + perRow - 1) / perRow) { i -> minOf(perRow, count - i * perRow) }
}

/**
 * Every tool in one grid under the pad, each with an icon AND a text label. Nothing floats on the picture, so a button
 * can never cover the PC's screen or another button, and the person never has to guess what an icon does.
 * Tiles are 68 dp tall (above the 48 dp minimum) with 8 dp between them.
 */
@Composable
fun ToolGrid(tiles: List<ToolTileSpec>, perRow: Int, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        tiles.chunked(perRow).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                row.forEach { ToolTile(it, Modifier.weight(1f)) }
                repeat(perRow - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun ToolTile(t: ToolTileSpec, modifier: Modifier) {
    val c = Gs.colors
    val fg = if (t.active) c.ink else c.text
    PressBox(
        t.onClick, modifier.height(68.dp), if (t.active) "${t.label}, on" else t.label, RoundedCornerShape(Radius.chip),
        background = if (t.active) c.accent else c.s2, border = !t.active,
    ) {
        Column(
            Modifier.padding(horizontal = Space.xs), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.xs, Alignment.CenterVertically),
        ) {
            t.icon(fg)
            Label(t.label, color = fg, style = Gs.type.small.copy(textAlign = TextAlign.Center), maxLines = 2)
        }
    }
}
