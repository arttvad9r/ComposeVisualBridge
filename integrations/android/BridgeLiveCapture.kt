package dev.composevisualbridge.capture

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
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
import android.app.Activity
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import android.view.View
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject

private fun blankBitmap(bitmap: Bitmap): Boolean {
    val soft = if (Build.VERSION.SDK_INT >= 26 && bitmap.config == Bitmap.Config.HARDWARE) bitmap.copy(Bitmap.Config.ARGB_8888, false) else bitmap
    val sample = Bitmap.createScaledBitmap(soft, 32, 32, false)
    val pixels = IntArray(32 * 32).also { sample.getPixels(it, 0, 32, 0, 0, 32, 32) }
    return pixels.all { it ushr 24 == 0 }
}

/** Копия уже показанного окна: запасной путь, когда offscreen-рендер слоя вернул пустой кадр. */
private suspend fun windowPixels(view: View, content: LayoutCoordinates): Bitmap {
    if (Build.VERSION.SDK_INT < 26) error("Пустой кадр экрана")
    var current = view.context
    while (current is ContextWrapper && current !is Activity) current = current.baseContext
    val window = (current as? Activity)?.window ?: error("Окно приложения недоступно")
    val origin = IntArray(2).also(view::getLocationInWindow)
    val bounds = content.boundsInRoot()
    val rect = android.graphics.Rect(origin[0] + bounds.left.roundToInt(), origin[1] + bounds.top.roundToInt(),
        origin[0] + bounds.right.roundToInt(), origin[1] + bounds.bottom.roundToInt())
    val bitmap = Bitmap.createBitmap(rect.width(), rect.height(), Bitmap.Config.ARGB_8888)
    return suspendCancellableCoroutine { continuation ->
        PixelCopy.request(window, rect, bitmap, { result ->
            if (result == PixelCopy.SUCCESS) continuation.resume(bitmap)
            else continuation.resumeWithException(IllegalStateException("PixelCopy: $result"))
        }, Handler(Looper.getMainLooper()))
    }
}

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
    var hidden by remember { mutableStateOf(false) }
    val content = remember { arrayOfNulls<LayoutCoordinates>(1) }
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().onGloballyPositioned { content[0] = it }.drawWithContent {
            recordRequest
            layer.record { this@drawWithContent.drawContent() }
            // Экран рисуется напрямую: слой только для снимка. После пересоздания Activity
            // вывод через drawLayer оставлял окно чёрным.
            drawContent()
        }) { content() }
        Button(modifier = Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(8.dp).size(48.dp).alpha(if (hidden) 0f else 1f).semantics { contentDescription = message },
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
                    var image = layer.toImageBitmap().asAndroidBitmap()
                    if (image.width == 0 || image.height == 0 || blankBitmap(image)) {
                        // На эмуляторе с gfxstream offscreen-рендер после смены темы возвращал прозрачный кадр.
                        hidden = true
                        try {
                            repeat(2) { withFrameNanos { } }
                            image = windowPixels(view, content[0] ?: error("Экран ещё не размещён"))
                        } finally { hidden = false }
                        if (blankBitmap(image)) error("Пустой кадр экрана")
                    }
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
