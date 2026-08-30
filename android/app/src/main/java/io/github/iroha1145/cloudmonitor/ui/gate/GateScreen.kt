package io.github.iroha1145.cloudmonitor.ui.gate

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import io.github.iroha1145.cloudmonitor.ui.theme.Brand
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.LocalReducedMotion
import io.github.iroha1145.cloudmonitor.ui.theme.Motion
import io.github.iroha1145.cloudmonitor.vm.UiState
import kotlin.math.roundToInt

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
    val reduced = LocalReducedMotion.current
    val enter = remember { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!reduced) enter.animateTo(1f, tween(Motion.Gate, easing = FastOutSlowInEasing))
    }
    val shake = remember { Animatable(0f) }
    LaunchedEffect(state.gateError) {
        if (state.gateError.isNullOrBlank() || reduced) return@LaunchedEffect
        shake.snapTo(0f)
        shake.animateTo(10f, tween(80, easing = LinearEasing))
        shake.animateTo(-10f, tween(80, easing = LinearEasing))
        shake.animateTo(6f, tween(80, easing = LinearEasing))
        shake.animateTo(0f, tween(80, easing = LinearEasing))
    }
    Box(
        Modifier
            .fillMaxSize()
            .background(cm.canvas)
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
    ) {
        IconButton(onToggleDark, Modifier.align(Alignment.TopEnd)) {
            Icon(
                if (dark) AppIcons.LightMode else AppIcons.DarkMode,
                contentDescription = "夜间模式",
                tint = cm.ink2,
            )
        }
        Column(
            Modifier
                .fillMaxWidth()
                .padding(top = 72.dp)
                .graphicsLayer {
                    alpha = enter.value
                    scaleX = 0.96f + 0.04f * enter.value
                    scaleY = 0.96f + 0.04f * enter.value
                }
                .offset { IntOffset(shake.value.roundToInt(), 0) }
                .clip(RoundedCornerShape(28.dp))
                .background(cm.card)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                Modifier
                    .size(56.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(Brush.linearGradient(listOf(Brand, Color(0xFF7F7DFC)))),
                contentAlignment = Alignment.Center,
            ) {
                Text("☁", fontSize = 26.sp)
            }
            Spacer(Modifier.height(16.dp))
            Text("云端用量面板", color = cm.ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            Text(
                if (state.encryptionAvailable)
                    "原生客户端直连你的 Cloud Monitor 面板。访问密钥用系统密钥库加密后只存在本机。"
                else
                    "原生客户端直连你的 Cloud Monitor 面板。当前设备无法启用系统密钥库，登录后不会记住密钥。",
                color = cm.mute,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                lineHeight = 18.sp,
            )
            Spacer(Modifier.height(20.dp))
            val err = !state.gateError.isNullOrBlank()
            OutlinedTextField(
                value = state.hubUrl,
                onValueChange = onUrl,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("面板地址") },
                placeholder = { Text("https://panel.example.com") },
                leadingIcon = { Icon(AppIcons.Language, "面板地址") },
                singleLine = true,
                isError = err,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                colors = fieldColors(),
                shape = RoundedCornerShape(14.dp),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = state.token,
                onValueChange = onToken,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("访问密钥") },
                placeholder = { Text("ACCESS_TOKEN") },
                leadingIcon = { Icon(AppIcons.Key, "访问密钥") },
                singleLine = true,
                isError = err,
                visualTransformation = PasswordVisualTransformation(),
                colors = fieldColors(),
                shape = RoundedCornerShape(14.dp),
            )
            if (err) {
                Spacer(Modifier.height(8.dp))
                Text(state.gateError!!, color = cm.crit, fontSize = 13.sp)
            }
            if (state.hubUrl.trim().startsWith("http://", ignoreCase = true)) {
                Spacer(Modifier.height(8.dp))
                Text("当前为 HTTP，局域网内可被中间人读取密钥。公网请用 HTTPS。", color = cm.warnInk, fontSize = 12.sp)
            }
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = onLogin,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                enabled = !state.loading,
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = Color.White),
            ) {
                if (state.loading) CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                else Text("进入面板", fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(10.dp))
            OutlinedButton(
                onClick = onDemo,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(14.dp),
            ) {
                Icon(AppIcons.PlayArrow, "演示", Modifier.size(18.dp))
                Spacer(Modifier.size(6.dp))
                Text("先看演示数据")
            }
            Spacer(Modifier.height(8.dp))
            Text("演示数据在设备本地生成，不访问任何服务器。", color = cm.mute, fontSize = 11.sp, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Brand,
    unfocusedBorderColor = CmColorsCurrent.border,
    errorBorderColor = CmColorsCurrent.crit,
    focusedContainerColor = CmColorsCurrent.card,
    unfocusedContainerColor = CmColorsCurrent.card,
)
