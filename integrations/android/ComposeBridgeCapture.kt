package dev.composevisualbridge.capture

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import java.io.File
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

/** Снимать только согласованную тестовую сцену; не подменять пользовательскую сессию. */
fun captureComposeScreen(
    rule: ComposeContentTestRule,
    folder: File,
    name: String,
    sourceRevision: String,
    screenState: String,
): File {
    require(name.matches(Regex("[A-Za-z0-9._-]{1,80}")))
    require(sourceRevision.isNotBlank() && screenState.isNotBlank())
    rule.waitForIdle()
    val density = rule.density
    val root = rule.onRoot().fetchSemanticsNode().boundsInRoot
    val nodes = rule.onAllNodes(SemanticsMatcher("Все узлы") { true }, useUnmergedTree = true).fetchSemanticsNodes()
    val values = JSONArray()
    for (node in nodes) {
        val bounds = node.boundsInRoot
        if (bounds.width <= 0 || bounds.height <= 0) continue
        val config = node.config
        val value = JSONObject()
            .put("semanticsId", node.id)
            .put("parentSemanticsId", node.parent?.id ?: JSONObject.NULL)
            .put("boundsDp", JSONObject().put("x", (bounds.left-root.left)/density.density).put("y", (bounds.top-root.top)/density.density).put("width", bounds.width/density.density).put("height", bounds.height/density.density))
            .put("clickable", SemanticsActions.OnClick in config)
        if (SemanticsProperties.TestTag in config) value.put("testTag", config[SemanticsProperties.TestTag])
        if (SemanticsProperties.Role in config) value.put("role", config[SemanticsProperties.Role].toString())
        if (SemanticsProperties.Selected in config) value.put("selected", config[SemanticsProperties.Selected])
        if (SemanticsProperties.ContentDescription in config) value.put("contentDescription", JSONArray(config[SemanticsProperties.ContentDescription]))
        if (SemanticsProperties.Text in config) value.put("text", config[SemanticsProperties.Text].joinToString(" ") { it.text })
        if (SemanticsProperties.EditableText in config) value.put("editableText", config[SemanticsProperties.EditableText].text)
        val layouts = mutableListOf<TextLayoutResult>()
        if (SemanticsActions.GetTextLayoutResult in config) config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        if (layouts.isNotEmpty()) {
            val layout = layouts.first()
            val style = layout.layoutInput.style
            val props = JSONObject()
            if (style.fontSize.value.isFinite()) props.put("fontSizeSp", style.fontSize.value)
            if (style.lineHeight.value.isFinite()) props.put("lineHeightSp", style.lineHeight.value)
            if (style.letterSpacing.value.isFinite()) props.put("letterSpacingSp", style.letterSpacing.value)
            style.fontWeight?.let { props.put("fontWeight", it.weight) }
            props.put("fontFamily", style.fontFamily?.toString() ?: "Default")
            props.put("fontStyle", if (style.fontStyle == FontStyle.Italic) "italic" else "normal")
            props.put("textDecoration", if (style.textDecoration?.contains(TextDecoration.Underline) == true) "underline" else "none")
            val align = when (style.textAlign) { TextAlign.Center -> "center"; TextAlign.End, TextAlign.Right -> "end"; TextAlign.Justify -> "justify"; else -> "start" }
            props.put("textAlign", align)
            if (style.color != Color.Unspecified) {
                val argb = style.color.toArgb()
                val rgb = String.format(Locale.ROOT, "#%06X", argb and 0xFFFFFF)
                props.put("color", if ((argb ushr 24) == 255) rgb else rgb + String.format(Locale.ROOT,"%02X",argb ushr 24))
            }
            props.put("maxLines", layout.layoutInput.maxLines)
            props.put("textOverflow", when(layout.layoutInput.overflow) { TextOverflow.Ellipsis -> "ellipsis"; TextOverflow.Clip -> "clip"; else -> layout.layoutInput.overflow.toString() })
            value.put("typography", props).put("lineCount", layout.lineCount)
            value.put("hasInlineStyles", layout.layoutInput.text.spanStyles.isNotEmpty() || layout.layoutInput.text.paragraphStyles.isNotEmpty())
        }
        values.put(value)
    }
    folder.mkdirs()
    require(!File(folder,"$name.png").exists() && !File(folder,"$name.json").exists()) { "Снимок уже существует: выберите новое имя, чтобы сохранить прежний эталон" }
    val image = File(folder,"$name.png")
    image.outputStream().use { stream -> check(rule.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG,100,stream)) }
    val result = JSONObject().put("captureVersion",1).put("name",name).put("sourceRevision",sourceRevision).put("state",screenState)
        .put("viewport",JSONObject().put("width",root.width/density.density).put("height",root.height/density.density).put("fontScale",density.fontScale).put("presentation","content"))
        .put("density",density.density).put("image",image.name).put("nodes",values)
    return File(folder,"$name.json").apply { writeText(result.toString(2)) }
}
