package dev.composevisualbridge.capture

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import com.github.takahirom.roborazzi.captureRoboImage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import sergio.sastre.composable.preview.scanner.android.AndroidComposablePreviewScanner
import sergio.sastre.composable.preview.scanner.android.AndroidPreviewInfo
import sergio.sastre.composable.preview.scanner.core.preview.ComposablePreview
import java.io.File

/** Test-only copy: renders every @Preview on the JVM and writes a frame with semantics for the editor. */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class BridgePreviewCapture(private val preview: ComposablePreview<AndroidPreviewInfo>) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun previews() = AndroidComposablePreviewScanner()
            .scanPackageTrees(System.getProperty("bridge.package") ?: error("bridge.package"))
            .getPreviews()
    }

    @get:Rule val rule = createComposeRule()

    private fun node(value: SemanticsNode): JSONObject {
        val bounds = value.boundsInRoot
        val properties = JSONObject()
        for ((key, data) in value.config) properties.put(key.name.replaceFirstChar { it.lowercase() }, data.toString())
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

    @Test
    fun capture() {
        rule.setContent { preview() }
        rule.waitForIdle()
        val root = rule.onRoot(useUnmergedTree = true)
        val dir = File(System.getProperty("bridge.output") ?: error("bridge.output")).apply { mkdirs() }
        // toString() is unique per preview, including several @Preview on one function.
        val id = preview.toString().replace(Regex("[^\\w.-]"), "_")
        val png = File(dir, "$id.png")
        root.captureRoboImage(png)
        val frame = JSONObject().put("type", "frame").put("preview", preview.previewInfo.name.ifEmpty { preview.methodName })
            .put("function", preview.declaringClass + "." + preview.methodName)
            .put("image", java.util.Base64.getEncoder().encodeToString(png.readBytes()))
            .put("densityDpi", android.content.res.Resources.getSystem().displayMetrics.densityDpi)
            .put("semantics", node(root.fetchSemanticsNode()))
        File(dir, "$id.json").writeText(frame.toString())
    }
}
