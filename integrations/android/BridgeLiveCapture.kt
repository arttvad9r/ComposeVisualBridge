package dev.composevisualbridge.capture

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** Только в debug-копии. Навигация и состояние принадлежат исходному приложению. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun BridgeLiveHost(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val view = LocalView.current
    val layer = rememberGraphicsLayer()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    // Чтение счётчика в draw-фазе заставляет перезаписать слой перед снимком.
    var recordRequest by remember { mutableIntStateOf(0) }
    var message by remember { mutableStateOf("Редактировать экран") }
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().drawWithContent {
            recordRequest
            layer.record { this@drawWithContent.drawContent() }
            drawLayer(layer)
        }) { content() }
        Button(modifier = Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(8.dp).size(48.dp).semantics { contentDescription = message },
            contentPadding = PaddingValues(0.dp), enabled = !busy, onClick = {
            busy = true
            scope.launch {
                try {
                    val owner = (view as? ViewRootForTest)?.semanticsOwner
                        ?: error("Compose root недоступен")
                    fun node(value: SemanticsNode): JSONObject {
                        val bounds = value.boundsInRoot
                        val properties = JSONObject()
                        for ((key, data) in value.config) {
                            properties.put(key.name.replaceFirstChar { it.lowercase() }, data.toString())
                        }
                        val layouts = mutableListOf<TextLayoutResult>()
                        if (SemanticsActions.GetTextLayoutResult in value.config) {
                            value.config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
                        }
                        layouts.firstOrNull()?.let { layout ->
                            val style = layout.layoutInput.style
                            properties.put("textLineCount", layout.lineCount)
                            if (style.fontSize.value.isFinite()) properties.put("fontSize", "${style.fontSize.value}.sp")
                            if (style.lineHeight.value.isFinite()) properties.put("lineHeight", "${style.lineHeight.value}.sp")
                            style.fontWeight?.let { properties.put("fontWeight", it.weight) }
                            if (style.color != Color.Unspecified) properties.put("foregroundColor", String.format("#%06X", style.color.toArgb() and 0xFFFFFF))
                        }
                        val texts = value.config.getOrElse(SemanticsProperties.Text) { emptyList() }
                        if (texts.isNotEmpty()) properties.put("text", texts.joinToString(" ") { it.text })
                        return JSONObject().put("id", value.id.toString())
                            .put("bounds", JSONObject().put("left", bounds.left).put("top", bounds.top).put("right", bounds.right).put("bottom", bounds.bottom))
                            .put("text", if (texts.isEmpty()) JSONObject.NULL else texts.joinToString(" ") { it.text })
                            .put("mergedSemantics", properties)
                            .put("children", JSONArray(value.children.map(::node)))
                    }
                    val root = node(owner.unmergedRootSemanticsNode)
                    // Запись слоя могла устареть или быть сброшена после смены конфигурации.
                    recordRequest++
                    repeat(2) { withFrameNanos { } }
                    val image = layer.toImageBitmap().asAndroidBitmap()
                    if (image.width == 0 || image.height == 0) error("Пустой кадр экрана")
                    val bytes = ByteArrayOutputStream().apply {
                        check(image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, this))
                    }.toByteArray()
                    val frame = JSONObject().put("type", "frame").put("preview", "live:current")
                        .put("image", Base64.encodeToString(bytes, Base64.NO_WRAP))
                        .put("densityDpi", context.resources.displayMetrics.densityDpi)
                        .put("semantics", root).put("captureId", UUID.randomUUID().toString())
                        .put("capturedAt", System.currentTimeMillis())
                        .put("launchId", File(context.filesDir, "compose-visual-bridge-live-launch.txt").readText().trim())
                        .put("systemTheme", if ((context.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES) "dark" else "light")
                    val target = File(context.filesDir, "compose-visual-bridge-live.json")
                    val temp = File(context.filesDir, "compose-visual-bridge-live.tmp")
                    temp.writeText(frame.toString())
                    check(temp.renameTo(target))
                    message = "Экран сохранён для редактора"
                } catch (error: Exception) {
                    message = "Ошибка: ${error.message}"
                } finally { busy = false }
            }
        }) { Text(if (busy) "…" else "✎") }
    }
}
