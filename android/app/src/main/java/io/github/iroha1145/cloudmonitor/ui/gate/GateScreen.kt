package io.github.iroha1145.cloudmonitor.ui.gate

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.SEG_CACHE_READ
import io.github.iroha1145.cloudmonitor.data.SEG_CACHE_WRITE
import io.github.iroha1145.cloudmonitor.data.SEG_INPUT
import io.github.iroha1145.cloudmonitor.data.SEG_OUTPUT
import io.github.iroha1145.cloudmonitor.data.SEG_UNCLS
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.errorShake
import io.github.iroha1145.cloudmonitor.vm.UiState

private val SPECTRUM = listOf(
    SEG_CACHE_READ to 58,
    SEG_INPUT to 17,
    SEG_OUTPUT to 11,
    SEG_CACHE_WRITE to 8,
    SEG_UNCLS to 6,
)

@Composable
fun GateScreen(
    state: UiState,
    dark: Boolean,
    onUrl: (String) -> Unit,
    onToken: (String) -> Unit,
    onRemember: (Boolean) -> Unit,
    onLogin: () -> Unit,
    onDemo: () -> Unit,
    onToggleDark: () -> Unit,
) {
    val cm = CmColorsCurrent
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var revealKey by rememberSaveable { mutableStateOf(false) }
    val hasError = !state.gateError.isNullOrBlank()
    val connect = {
        if (!state.loading) {
            keyboard?.hide()
            focus.clearFocus()
            revealKey = false
            onLogin()
        }
    }
    Box(
        Modifier.fillMaxSize().background(cm.canvas)
            .windowInsetsPadding(WindowInsets.safeDrawing.union(WindowInsets.ime)),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier.widthIn(max = 480.dp).fillMaxSize()
                .verticalScroll(rememberScrollState()).padding(horizontal = 22.dp, vertical = 12.dp),
        ) {
            Row(Modifier.fillMaxWidth().padding(top = 28.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Cloud Monitor", style = MaterialTheme.typography.titleMedium, color = cm.ink, modifier = Modifier.weight(1f))
                IconButton(onClick = onToggleDark, modifier = Modifier.size(48.dp)) {
                    Icon(
                        if (dark) AppIcons.LightMode else AppIcons.DarkMode,
                        contentDescription = if (dark) "切换为浅色外观" else "切换为深色外观",
                        tint = cm.ink2,
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 36.dp).height(6.dp)
                    .clip(RoundedCornerShape(7.dp)),
            ) {
                SPECTRUM.forEach { (color, weight) ->
                    Box(Modifier.weight(weight.toFloat()).fillMaxHeight().background(color))
                }
            }
            Text("查看你的用量", color = cm.ink, fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(10.dp))
            Text("输入面板地址和访问密钥，连接这台服务器上的用量记录。", color = cm.ink2, fontSize = 14.sp, lineHeight = 24.sp)
            Column(Modifier.fillMaxWidth().padding(top = 32.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = state.hubUrl, onValueChange = onUrl, modifier = Modifier.fillMaxWidth(),
                    label = { Text("面板地址") },
                    placeholder = { Text("https://panel.example.com") },
                    leadingIcon = { Icon(AppIcons.Language, null) },
                    singleLine = true, isError = hasError, enabled = !state.loading,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                    shape = RoundedCornerShape(10.dp),
                )
                OutlinedTextField(
                    label = { Text("访问密钥") },
                    value = state.token, onValueChange = onToken,
                    modifier = Modifier.fillMaxWidth().errorShake(state.shakeNonce),
                    placeholder = { Text("输入面板访问密钥") },
                    leadingIcon = { Icon(AppIcons.Key, null) },
                    trailingIcon = {
                        TextButton(onClick = { revealKey = !revealKey }, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text(if (revealKey) "隐藏" else "显示")
                        }
                    },
                    singleLine = true, isError = state.keyRejected || hasError, enabled = !state.loading,
                    visualTransformation = if (revealKey) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { connect() }),
                    shape = RoundedCornerShape(10.dp),
                )
                if (hasError) {
                    Text(state.gateError.orEmpty(), color = cm.crit, fontSize = 13.sp,
                        modifier = Modifier.testTag("gate-error").semantics { liveRegion = LiveRegionMode.Polite })
                }
                if (state.hubUrl.trim().startsWith("http://", ignoreCase = true)) {
                    Text("未加密连接仅支持本机和局域网。公网地址请使用 HTTPS。", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
                }
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = state.rememberToken && state.encryptionAvailable,
                        onCheckedChange = { if (state.encryptionAvailable) onRemember(it) },
                        enabled = state.encryptionAvailable && !state.loading,
                        modifier = Modifier.testTag("remember-token"),
                    )
                    Text(
                        "记住访问密钥",
                        color = if (state.encryptionAvailable) cm.ink else cm.mute,
                        fontSize = 14.sp,
                    )
                }
                Button(
                    onClick = connect, modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp),
                    enabled = !state.loading && state.hubUrl.isNotBlank() && state.token.isNotBlank(),
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = cm.ink,
                        contentColor = cm.card,
                        disabledContainerColor = cm.hover2,
                        disabledContentColor = cm.mute,
                    ),
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    if (state.loading) {
                        CircularProgressIndicator(Modifier.size(18.dp), color = cm.mute, strokeWidth = 2.dp)
                        Spacer(Modifier.width(10.dp))
                    }
                    Text(if (state.loading) "正在连接" else "进入工作台", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    if (!state.loading) {
                        Spacer(Modifier.width(10.dp))
                        Icon(AppIcons.ChevronRight, null, Modifier.size(18.dp))
                    }
                }
            }
            Row(Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Icon(AppIcons.Key, null, Modifier.padding(top = 3.dp).size(13.dp), tint = cm.mute)
                Text(
                    if (!state.encryptionAvailable) "此设备暂不支持密钥加密，连接后不会保存访问密钥。"
                    else if (state.rememberToken) "勾选后，访问密钥经系统密钥库加密保存在此设备。关闭选项后，只在本次打开期间保留。"
                    else "未勾选记住访问密钥。关闭应用后需要重新输入，面板地址仍会保存。",
                    color = cm.mute, fontSize = 12.sp, lineHeight = 20.sp,
                )
            }
            Spacer(Modifier.height(28.dp))
            OutlinedButton(
                onClick = { keyboard?.hide(); focus.clearFocus(); onDemo() },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !state.loading,
                shape = RoundedCornerShape(10.dp), contentPadding = PaddingValues(14.dp),
            ) {
                Icon(AppIcons.PlayArrow, null, Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("体验演示", style = MaterialTheme.typography.labelLarge)
            }
            Spacer(Modifier.height(10.dp))
            Text("演示数据仅供体验，在本机生成。", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(24.dp))
        }
    }
}
