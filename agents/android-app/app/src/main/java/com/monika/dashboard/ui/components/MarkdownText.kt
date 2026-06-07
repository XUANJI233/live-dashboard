package com.monika.dashboard.ui.components

import android.util.TypedValue
import android.view.ViewGroup
import android.widget.TextView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.Markwon
import io.noties.markwon.ext.tables.TablePlugin

@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val color = MaterialTheme.colorScheme.onSurface.toArgb()
    val typography = MaterialTheme.typography
    val bodyStyle = typography.bodyMedium
    val markwon = remember(context) {
        Markwon.builder(context.applicationContext)
            .usePlugin(TablePlugin.create(context.applicationContext))
            .build()
    }

    AndroidView(
        modifier = modifier.fillMaxWidth(),
        factory = { viewContext ->
            TextView(viewContext).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )
                includeFontPadding = false
                linksClickable = false
                movementMethod = null
                setTextIsSelectable(false)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, bodyStyle.fontSize.spValueOr(14f))
                setLineSpacing(0f, 1.12f)
            }
        },
        update = { view ->
            view.setTextColor(color)
            view.setTextSize(TypedValue.COMPLEX_UNIT_SP, bodyStyle.fontSize.spValueOr(14f))
            markwon.setMarkdown(view, text.normalizeMarkdown())
            view.linksClickable = false
            view.movementMethod = null
        },
    )
}

private fun String.normalizeMarkdown(): String = replace("\r\n", "\n")
    .replace("\r", "\n")
    .trim()

private fun TextUnit.spValueOr(fallback: Float): Float =
    takeIf { isSp }?.value ?: fallback
