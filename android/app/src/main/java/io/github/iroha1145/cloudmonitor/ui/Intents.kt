package io.github.iroha1145.cloudmonitor.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import io.github.iroha1145.cloudmonitor.data.Format

fun Context.openHttpUrl(url: String?) {
    val safe = Format.safeHttpUrl(url) ?: return
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(safe))
    if (this !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(this, "没有可打开链接的应用", Toast.LENGTH_SHORT).show()
    } catch (_: Exception) {
        Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show()
    }
}
