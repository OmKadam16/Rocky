package com.rocky.calendar.android

import org.junit.Assert.assertEquals
import org.junit.Test

class AgentCoordsTest {
    @Test
    fun cssToPhysicalUsesDensity() {
        assertEquals(300f, AgentCoords.toPhysical(100.0, 3f, 1080), 0.001f)
        assertEquals(262.5f, AgentCoords.toPhysical(105.0, 2.5f, 1000), 0.001f)
    }

    @Test
    fun clampsToTheWebView() {
        assertEquals(1079f, AgentCoords.toPhysical(5000.0, 3f, 1080), 0.001f)
        assertEquals(0f, AgentCoords.toPhysical(-20.0, 3f, 1080), 0.001f)
    }

    @Test
    fun cssSizeMatchesScreenshots() {
        assertEquals(Pair(360, 680), AgentCoords.cssSize(1080, 2040, 3f))
        assertEquals(Pair(412, 800), AgentCoords.cssSize(1236, 2400, 3f))
        assertEquals(Pair(1, 1), AgentCoords.cssSize(0, 0, 0f))
    }
}
