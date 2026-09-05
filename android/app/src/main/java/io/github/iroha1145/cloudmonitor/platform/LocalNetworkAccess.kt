package io.github.iroha1145.cloudmonitor.platform

import android.Manifest
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import io.github.iroha1145.cloudmonitor.data.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.InetAddress
import java.net.UnknownHostException

/** Permission is requested only for a selected server that resolves to the local network. */
object LocalNetworkAccess {
    private val requests = PermissionRequestCoordinator()
    internal val pending = requests.pending

    suspend fun ensureAccess(context: Context, serverUrl: String) {
        if (Build.VERSION.SDK_INT < 37 || granted(context)) return
        val host = serverUrl.toHttpUrlOrNull()?.host ?: return
        if (!requiresLocalAccess(host)) return
        if (granted(context)) return
        val allowed = requests.awaitPermission(host)
        if (!allowed || !granted(context)) throw deniedException()
    }

    internal fun granted(context: Context): Boolean = Build.VERSION.SDK_INT < 37 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_LOCAL_NETWORK) ==
        PackageManager.PERMISSION_GRANTED

    internal fun respond(request: PermissionRequestCoordinator.Request, allowed: Boolean) =
        requests.respond(request, allowed)

    private fun deniedException() = ApiException(
        0,
        "未获准访问局域网，请在系统设置中允许“附近的设备”，然后重试；公网面板不受影响",
    )

    internal suspend fun requiresLocalAccess(
        host: String,
        resolve: (String) -> Array<InetAddress> = InetAddress::getAllByName,
    ): Boolean {
        val normalized = host.lowercase().removePrefix("[").removeSuffix("]").trimEnd('.')
        if (normalized == "localhost") return false
        if (normalized.endsWith(".local") || normalized.endsWith(".home.arpa") ||
            (!normalized.contains('.') && !normalized.contains(':'))
        ) return true
        return withContext(Dispatchers.IO) {
            try {
                resolve(normalized).any(::isLocalAddress)
            } catch (_: UnknownHostException) {
                // Let the HTTP client report an ordinary DNS failure for public hosts.
                false
            }
        }
    }

    internal fun isLocalAddress(address: InetAddress): Boolean {
        if (address.isLoopbackAddress) return false
        val bytes = address.address
        val first = bytes[0].toInt() and 0xff
        val second = bytes.getOrNull(1)?.toInt()?.and(0xff) ?: 0
        return address.isSiteLocalAddress || address.isLinkLocalAddress ||
            (bytes.size == 16 && first and 0xfe == 0xfc) ||
            (bytes.size == 4 && first == 100 && second in 64..127)
    }
}

/** Activity-owned launcher; a pending request survives rotation through the shared decision. */
class LocalNetworkPermissionController(private val activity: ComponentActivity) {
    private var dialog: AlertDialog? = null
    private var activeRequest: PermissionRequestCoordinator.Request? = LocalNetworkAccess.pending.value
    private val permission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        activeRequest?.let { LocalNetworkAccess.respond(it, allowed) }
        activeRequest = null
    }

    init {
        activity.lifecycleScope.launch {
            activity.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                try {
                    LocalNetworkAccess.pending.collect { request ->
                        if (request == null) {
                            dialog?.dismiss()
                            dialog = null
                        } else if (LocalNetworkAccess.granted(activity)) {
                            LocalNetworkAccess.respond(request, true)
                        } else {
                            activeRequest = request
                            if (!request.systemPromptLaunched) explain(request)
                        }
                    }
                } finally {
                    dialog?.dismiss()
                    dialog = null
                }
            }
        }
    }

    private fun explain(request: PermissionRequestCoordinator.Request) {
        if (dialog?.isShowing == true) return
        dialog = AlertDialog.Builder(activity)
            .setTitle("连接局域网面板")
            .setMessage("面板 ${request.host} 位于本地网络。请允许访问附近的设备，以读取面板的用量和设备信息。")
            .setPositiveButton("继续") { _, _ ->
                if (Build.VERSION.SDK_INT >= 37) {
                    request.systemPromptLaunched = true
                    permission.launch(Manifest.permission.ACCESS_LOCAL_NETWORK)
                } else {
                    LocalNetworkAccess.respond(request, true)
                }
            }
            .setNeutralButton("系统设置") { _, _ ->
                LocalNetworkAccess.respond(request, false)
                activity.startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", activity.packageName, null)
                })
            }
            .setNegativeButton("取消") { _, _ -> LocalNetworkAccess.respond(request, false) }
            .setOnCancelListener { LocalNetworkAccess.respond(request, false) }
            .show()
    }
}
