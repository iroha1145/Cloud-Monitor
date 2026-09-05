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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
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
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.UiState

@Composable
fun GateScreen(
    state: UiState,
    dark: Boolean,
    onUrl: (String) -> Unit,
    onToken: (String) -> Unit,
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
            Modifier.widthIn(max = 560.dp).fillMaxSize()
                .verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Cloud Monitor", style = MaterialTheme.typography.titleMedium, color = cm.ink, modifier = Modifier.weight(1f))
                IconButton(onClick = onToggleDark, modifier = Modifier.size(48.dp)) {
                    Icon(
                        if (dark) AppIcons.LightMode else AppIcons.DarkMode,
                        contentDescription = if (dark) "切换为浅色外观" else "切换为深色外观",
                        tint = cm.ink2,
                    )
                }
            }
            Spacer(Modifier.height(28.dp))
            Box(Modifier.size(56.dp).clip(RoundedCornerShape(17.dp)).background(Brush.linearGradient(listOf(Color(0xFF4495A3), Color(0xFF18596E)))), contentAlignment = Alignment.Center) {
                Icon(AppIcons.Cloud, null, tint = Color.White, modifier = Modifier.size(39.dp))
                Box(Modifier.align(Alignment.BottomEnd).padding(end = 10.dp, bottom = 10.dp).size(8.5.dp)
                    .clip(RoundedCornerShape(5.dp)).background(Color(0xFFA8E4DE)))
            }
            Spacer(Modifier.height(20.dp))
            Text("连接你的用量面板", color = cm.ink, style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(8.dp))
            Text("设备、模型与配额，随时查看。", color = cm.ink2, style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(28.dp))
            Column(
                Modifier.fillMaxWidth().border(1.dp, cm.border, RoundedCornerShape(10.dp))
                    .clip(RoundedCornerShape(10.dp)).background(cm.card).padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                OutlinedTextField(
                    value = state.hubUrl, onValueChange = onUrl, modifier = Modifier.fillMaxWidth(),
                    label = { Text("面板地址") }, placeholder = { Text("https://panel.example.com") },
                    leadingIcon = { Icon(AppIcons.Language, null) },
                    singleLine = true, isError = hasError, enabled = !state.loading,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                    shape = RoundedCornerShape(12.dp),
                )
                OutlinedTextField(
                    value = state.token, onValueChange = onToken, modifier = Modifier.fillMaxWidth(),
                    label = { Text("访问密钥") },
                    leadingIcon = { Icon(AppIcons.Key, null) },
                    trailingIcon = {
                        TextButton(onClick = { revealKey = !revealKey }, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text(if (revealKey) "隐藏" else "显示")
                        }
                    },
                    singleLine = true, isError = hasError, enabled = !state.loading,
                    visualTransformation = if (revealKey) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { connect() }),
                    shape = RoundedCornerShape(12.dp),
                )
                if (hasError) {
                    Text(state.gateError.orEmpty(), color = cm.crit, style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
                if (state.hubUrl.trim().startsWith("http://", ignoreCase = true)) {
                    Text("未加密连接仅支持本机和局域网。公网地址请使用 HTTPS。", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
                }
                Button(
                    onClick = connect, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                    enabled = !state.loading, shape = RoundedCornerShape(7.dp),
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp),
                ) {
                    if (state.loading) {
                        CircularProgressIndicator(Modifier.size(20.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.dp)
                        Spacer(Modifier.width(10.dp))
                    }
                    Text(if (state.loading) "正在连接…" else "连接面板", style = MaterialTheme.typography.labelLarge)
                }
                Text(
                    if (state.encryptionAvailable) "连接成功后保存地址，密钥经系统密钥库加密后保存在此设备。"
                    else "此设备暂不支持密钥加密，连接后不会保存访问密钥。",
                    color = cm.ink2, style = MaterialTheme.typography.bodySmall,
                )
            }
            Spacer(Modifier.height(16.dp))
            OutlinedButton(
                onClick = { keyboard?.hide(); focus.clearFocus(); onDemo() },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), enabled = !state.loading,
                shape = RoundedCornerShape(7.dp), contentPadding = PaddingValues(14.dp),
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
