package io.github.iroha1145.cloudmonitor

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import io.github.iroha1145.cloudmonitor.platform.LocalNetworkPermissionController
import io.github.iroha1145.cloudmonitor.ui.AppRoot
import io.github.iroha1145.cloudmonitor.vm.AppViewModel

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()
    private lateinit var localNetworkPermissionController: LocalNetworkPermissionController

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        localNetworkPermissionController = LocalNetworkPermissionController(this)
        splash.setKeepOnScreenCondition { !vm.bootstrapped.value }
        setContent { AppRoot(vm) }
    }
}
