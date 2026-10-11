package com.rocky.calendar.android

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * Rocky's Android shell: the same web app as the phone site, in Capacitor's
 * WebView. Rocky's own native plugins are registered here.
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(RockyApkUpdaterPlugin::class.java)
        registerPlugin(RockyAgentBrowserPlugin::class.java)
        super.onCreate(savedInstanceState)
        // Spoken replies play without a second tap (the first tap unlocks audio).
        bridge.webView.settings.mediaPlaybackRequiresUserGesture = false
    }
}
