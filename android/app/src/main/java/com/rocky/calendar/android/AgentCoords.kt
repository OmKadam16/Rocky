package com.rocky.calendar.android

import kotlin.math.roundToInt

/**
 * Coordinates for the agent browser. The booking core works in CSS pixels
 * (the page's own viewport, exactly what the screenshots show); Android's
 * touch events want physical pixels inside the WebView. Pure, unit-tested
 * (app/src/test/.../AgentCoordsTest.kt).
 */
object AgentCoords {
    /** CSS px -> physical px within the WebView, clamped to its size. */
    fun toPhysical(css: Double, density: Float, sizePx: Int): Float {
        val px = (css * density).toFloat()
        return px.coerceIn(0f, (sizePx - 1).coerceAtLeast(0).toFloat())
    }

    /** The WebView's size in CSS px (what screenshots are scaled to). */
    fun cssSize(widthPx: Int, heightPx: Int, density: Float): Pair<Int, Int> {
        val d = if (density > 0f) density else 1f
        return Pair((widthPx / d).roundToInt().coerceAtLeast(1), (heightPx / d).roundToInt().coerceAtLeast(1))
    }
}
