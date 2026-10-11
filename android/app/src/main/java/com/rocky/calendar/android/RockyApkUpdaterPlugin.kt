package com.rocky.calendar.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Native APK updates (never silent):
 *   download({ url, sha256, version }) -> https only, streamed to
 *     cache/updates/, SHA-256 checked; a mismatch deletes the file and fails.
 *   install({ path }) -> hands the verified APK to Android's package
 *     installer through the FileProvider. Android asks the user to tap
 *     Install (and, once, to allow installs from Rocky).
 */
@CapacitorPlugin(name = "RockyApkUpdater")
class RockyApkUpdaterPlugin : Plugin() {
    private val io = Executors.newSingleThreadExecutor()

    @PluginMethod
    fun download(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url is required")
        val expected = (call.getString("sha256") ?: return call.reject("sha256 is required")).lowercase()
        val version = (call.getString("version") ?: "update").replace(Regex("[^0-9A-Za-z._-]"), "_")
        if (!url.startsWith("https://")) return call.reject("https only", "not_https")
        if (!Regex("^[0-9a-f]{64}$").matches(expected)) return call.reject("bad sha256", "bad_hash")
        io.execute {
            val dir = File(context.cacheDir, "updates").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() } // only ever one pending APK
            val out = File(dir, "rocky-$version.apk")
            try {
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = true
                    connectTimeout = 20000
                    readTimeout = 60000
                }
                if (conn.responseCode !in 200..299) throw IllegalStateException("HTTP ${conn.responseCode}")
                val total = conn.contentLengthLong
                val digest = MessageDigest.getInstance("SHA-256")
                var done = 0L
                var lastPct = -1
                conn.inputStream.use { input ->
                    out.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            output.write(buf, 0, n)
                            digest.update(buf, 0, n)
                            done += n
                            if (total > 0) {
                                val pct = ((done * 100) / total).toInt()
                                if (pct != lastPct) {
                                    lastPct = pct
                                    notifyListeners("progress", JSObject().put("percent", pct))
                                }
                            }
                        }
                    }
                }
                val actual = digest.digest().joinToString("") { "%02x".format(it) }
                if (actual != expected) {
                    out.delete()
                    call.reject("The download didn't match its checksum; nothing was installed.", "hash_mismatch")
                    return@execute
                }
                call.resolve(JSObject().put("path", out.absolutePath).put("size", out.length()))
            } catch (e: Exception) {
                out.delete()
                call.reject("Download failed: ${e.message}", "download_failed")
            }
        }
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("path is required")
        val file = File(path)
        val updates = File(context.cacheDir, "updates").canonicalPath
        if (!file.exists() || !file.canonicalPath.startsWith(updates)) return call.reject("No verified update file", "missing")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            // Once: Android's "Install unknown apps" switch for Rocky.
            val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(settings)
            call.resolve(JSObject().put("needsPermission", true))
            return
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve(JSObject().put("needsPermission", false))
    }
}
