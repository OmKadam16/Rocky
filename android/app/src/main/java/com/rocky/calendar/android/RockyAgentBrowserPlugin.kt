package com.rocky.calendar.android

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.SystemClock
import android.text.TextUtils
import android.util.Base64
import android.view.Gravity
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * The booking agent's browser on Android: a full-screen, visible WebView over
 * Rocky with a "Rocky is driving" banner (Rocky / Stop buttons). The run loop
 * runs in Rocky's JS (shared/agentCore.mjs, the same gates as the desktop);
 * this plugin is only its eyes and hands:
 *   open, navigate, screenshot, pointer, key, insertText, evaluate (the
 *   read-only probes in shared/agentPageScripts.mjs), history, state,
 *   setBanner, show / hide, close. Events: "stop" (Stop pressed), "hidden".
 *
 * Hardening: its own WebView profile "rocky-agent" (own persistent cookie
 * jar) where the WebView supports profiles; JavaScript on; popups denied;
 * http(s) only; downloads ignored; no file/content access; no JS bridge;
 * camera / mic / location always denied; Safe Browsing on; no zoom (so CSS
 * px map exactly to the screenshot). Coordinates from JS are CSS pixels.
 */
@CapacitorPlugin(name = "RockyAgentBrowser")
class RockyAgentBrowserPlugin : Plugin() {
    private var overlay: FrameLayout? = null
    private var web: WebView? = null
    private var title: TextView? = null
    private var status: TextView? = null
    private var loading = false
    private var progress = 100
    private var downTime = 0L
    private var pendingNav: PluginCall? = null

    private fun ui(block: () -> Unit) = activity.runOnUiThread(block)
    private fun density() = activity.resources.displayMetrics.density

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensure(): WebView {
        web?.let { return it }
        val ctx = activity
        val wv = WebView(ctx)
        // Own profile (cookies, storage) before the WebView is used at all.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            ProfileStore.getInstance().getOrCreateProfile(PROFILE)
            WebViewCompat.setProfile(wv, PROFILE)
        }
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            setGeolocationEnabled(false)
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = false
            mediaPlaybackRequiresUserGesture = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
        }
        wv.setDownloadListener { _, _, _, _, _ -> }
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme?.lowercase()
                // tel:, intent:, file:, market: and friends never open.
                return scheme != "http" && scheme != "https"
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                loading = true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                loading = false
                pendingNav?.resolve(JSObject().put("url", url ?: ""))
                pendingNav = null
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()

            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) =
                callback.invoke(origin, false, false)

            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress = newProgress
            }
        }

        val pad = (10 * density()).toInt()
        val banner = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#17191A"))
            setPadding(pad, pad / 2, pad, pad / 2)
        }
        val texts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        title = TextView(ctx).apply {
            text = "Rocky is driving"
            setTextColor(Color.parseColor("#7FD8B4"))
            typeface = Typeface.MONOSPACE
            textSize = 11f
        }
        status = TextView(ctx).apply {
            setTextColor(Color.parseColor("#EFEEEA"))
            textSize = 13f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        texts.addView(title)
        texts.addView(status)
        banner.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        banner.addView(Button(ctx).apply {
            text = "Rocky"
            setOnClickListener { hideOverlay() }
        })
        banner.addView(Button(ctx).apply {
            text = "Stop"
            setOnClickListener { notifyListeners("stop", JSObject()) }
        })

        val column = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        column.addView(banner, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(wv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val root = FrameLayout(ctx).apply {
            setBackgroundColor(Color.parseColor("#17191A"))
            isClickable = true // nothing under the browser gets the touches
            elevation = 100f
            addView(column, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        // Edge-to-edge: banner below the status bar, page above the nav bar / keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        activity.findViewById<ViewGroup>(android.R.id.content)
            .addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        ViewCompat.requestApplyInsets(root)
        overlay = root
        web = wv
        return wv
    }

    private fun showOverlay() {
        overlay?.visibility = View.VISIBLE
        web?.requestFocus()
    }

    /** INVISIBLE, not GONE: the page keeps its size, so screenshots still work. */
    private fun hideOverlay() {
        overlay?.visibility = View.INVISIBLE
        notifyListeners("hidden", JSObject())
    }

    private fun viewport(): JSObject {
        val wv = web
        val (w, h) = if (wv != null && wv.width > 0) AgentCoords.cssSize(wv.width, wv.height, density()) else Pair(0, 0)
        return JSObject().put("width", w).put("height", h)
    }

    @PluginMethod
    fun open(call: PluginCall) = ui {
        ensure()
        if (call.getBoolean("show", true) == true) showOverlay() else overlay?.visibility = View.INVISIBLE
        // Wait for layout so the viewport has a size.
        overlay?.post { call.resolve(viewport()) }
    }

    @PluginMethod
    fun show(call: PluginCall) = ui {
        if (web == null) {
            call.reject("not open")
        } else {
            showOverlay()
            call.resolve()
        }
    }

    @PluginMethod
    fun hide(call: PluginCall) = ui {
        hideOverlay()
        call.resolve()
    }

    @PluginMethod
    fun navigate(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        if (!(url.startsWith("https://") || url.startsWith("http://"))) return call.reject("The agent opens http(s) pages only.")
        ui {
            val wv = ensure()
            pendingNav?.resolve(JSObject().put("url", wv.url ?: ""))
            pendingNav = call
            wv.loadUrl(url)
            // Never hang: resolve after 20 s whatever happened.
            wv.postDelayed({
                if (pendingNav === call) {
                    pendingNav = null
                    call.resolve(JSObject().put("url", wv.url ?: "").put("timedOut", true))
                }
            }, 20000)
        }
    }

    @PluginMethod
    fun state(call: PluginCall) = ui {
        val wv = web
        val o = viewport()
        o.put("open", wv != null)
        o.put("shown", overlay?.visibility == View.VISIBLE)
        o.put("url", wv?.url ?: "")
        o.put("title", wv?.title ?: "")
        o.put("loading", loading || progress < 100)
        o.put("progress", progress)
        call.resolve(o)
    }

    @PluginMethod
    fun history(call: PluginCall) = ui {
        val wv = web
        if (wv == null) {
            call.reject("not open")
        } else {
            when (call.getString("dir")) {
                "back" -> if (wv.canGoBack()) wv.goBack()
                "forward" -> if (wv.canGoForward()) wv.goForward()
            }
            call.resolve()
        }
    }

    /** Runs one of Rocky's own read-only probes; the result comes back as JSON text. */
    @PluginMethod
    fun evaluate(call: PluginCall) {
        val code = call.getString("code") ?: return call.reject("code is required")
        ui {
            val wv = web
            if (wv == null) call.reject("not open")
            else wv.evaluateJavascript(code) { raw -> call.resolve(JSObject().put("json", raw ?: "null")) }
        }
    }

    /** The visible page, scaled to CSS px, as a JPEG data URL. */
    @PluginMethod
    fun screenshot(call: PluginCall) = ui {
        val wv = web
        if (wv == null || wv.width <= 0 || wv.height <= 0) {
            call.reject("the page has no size yet")
        } else {
            val full = Bitmap.createBitmap(wv.width, wv.height, Bitmap.Config.ARGB_8888)
            wv.draw(Canvas(full))
            val (w, h) = AgentCoords.cssSize(wv.width, wv.height, density())
            val scaled = Bitmap.createScaledBitmap(full, w, h, true)
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, (call.getInt("quality", 80) ?: 80).coerceIn(40, 95), out)
            if (scaled !== full) scaled.recycle()
            full.recycle()
            call.resolve(
                JSObject()
                    .put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                    .put("width", w)
                    .put("height", h),
            )
        }
    }

    /** A touch at a CSS-px point: action down | move | up. */
    @PluginMethod
    fun pointer(call: PluginCall) = ui {
        val wv = web
        if (wv == null) {
            call.reject("not open")
            return@ui
        }
        val d = density()
        val x = AgentCoords.toPhysical(call.getDouble("x") ?: 0.0, d, wv.width)
        val y = AgentCoords.toPhysical(call.getDouble("y") ?: 0.0, d, wv.height)
        val now = SystemClock.uptimeMillis()
        val action = when (call.getString("action")) {
            "down" -> {
                downTime = now
                MotionEvent.ACTION_DOWN
            }
            "up" -> MotionEvent.ACTION_UP
            else -> MotionEvent.ACTION_MOVE
        }
        if (action != MotionEvent.ACTION_DOWN && downTime == 0L) {
            call.resolve() // a hover means nothing on a touch screen
            return@ui
        }
        val ev = MotionEvent.obtain(downTime, now, action, x, y, 0)
        ev.source = InputDevice.SOURCE_TOUCHSCREEN
        wv.requestFocus()
        wv.dispatchTouchEvent(ev)
        ev.recycle()
        if (action == MotionEvent.ACTION_UP) downTime = 0L
        call.resolve()
    }

    /** A named key (Enter, Tab, Backspace, arrows...) down or up. */
    @PluginMethod
    fun key(call: PluginCall) = ui {
        val wv = web
        val code = KEYS[call.getString("key") ?: ""]
        if (wv == null || code == null) {
            call.resolve(JSObject().put("ok", false))
        } else {
            val action = if (call.getString("action") == "up") KeyEvent.ACTION_UP else KeyEvent.ACTION_DOWN
            val now = SystemClock.uptimeMillis()
            wv.requestFocus()
            wv.dispatchKeyEvent(KeyEvent(now, now, action, code, 0))
            call.resolve(JSObject().put("ok", true))
        }
    }

    /**
     * Types text into the focused field as key events: never through a page
     * script, so a verification code is never part of a script string.
     */
    @PluginMethod
    fun insertText(call: PluginCall) = ui {
        val wv = web
        if (wv == null) {
            call.reject("not open")
            return@ui
        }
        val text = call.getString("text") ?: ""
        wv.requestFocus()
        val events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray())
        if (events != null) {
            for (e in events) wv.dispatchKeyEvent(e)
            call.resolve(JSObject().put("ok", true))
        } else {
            // Characters with no key mapping (accents, emoji): the editing command.
            wv.evaluateJavascript("document.execCommand('insertText', false, " + JSONObject.quote(text) + ")") {
                call.resolve(JSObject().put("ok", true))
            }
        }
    }

    @PluginMethod
    fun setBanner(call: PluginCall) = ui {
        title?.text = call.getString("title") ?: "Rocky is driving"
        status?.text = call.getString("text") ?: ""
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) = ui {
        web?.apply {
            stopLoading()
            loadUrl("about:blank")
            destroy()
        }
        (overlay?.parent as? ViewGroup)?.removeView(overlay)
        web = null
        overlay = null
        pendingNav = null
        call.resolve()
    }

    companion object {
        const val PROFILE = "rocky-agent"
        val KEYS = mapOf(
            "Enter" to KeyEvent.KEYCODE_ENTER,
            "Tab" to KeyEvent.KEYCODE_TAB,
            "Backspace" to KeyEvent.KEYCODE_DEL,
            "Delete" to KeyEvent.KEYCODE_FORWARD_DEL,
            "Escape" to KeyEvent.KEYCODE_ESCAPE,
            "Space" to KeyEvent.KEYCODE_SPACE,
            "Up" to KeyEvent.KEYCODE_DPAD_UP,
            "Down" to KeyEvent.KEYCODE_DPAD_DOWN,
            "Left" to KeyEvent.KEYCODE_DPAD_LEFT,
            "Right" to KeyEvent.KEYCODE_DPAD_RIGHT,
            "Home" to KeyEvent.KEYCODE_MOVE_HOME,
            "End" to KeyEvent.KEYCODE_MOVE_END,
            "PageUp" to KeyEvent.KEYCODE_PAGE_UP,
            "PageDown" to KeyEvent.KEYCODE_PAGE_DOWN,
        )
    }
}
