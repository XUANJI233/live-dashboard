package com.monika.dashboard.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        text
            .replace("\r\n", "\n")
            .replace("\r", "\n")
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .forEach { line ->
                when {
                    line.startsWith("### ") -> Text(
                        text = inlineMarkdown(line.removePrefix("### ")),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    line.startsWith("## ") || line.startsWith("# ") -> Text(
                        text = inlineMarkdown(line.removePrefix("## ").removePrefix("# ")),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    line.startsWith("- ") || line.startsWith("* ") -> Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("•", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            text = inlineMarkdown(line.drop(2)),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    else -> Text(
                        text = inlineMarkdown(line),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
    }
}

private fun inlineMarkdown(raw: String) = buildAnnotatedString {
    val text = raw.replace(Regex("""\[([^\]]+)]\([^)]+\)"""), "$1")
    var index = 0
    while (index < text.length) {
        val start = text.indexOf("**", index)
        if (start < 0) {
            append(text.substring(index))
            break
        }
        val end = text.indexOf("**", start + 2)
        if (end < 0) {
            append(text.substring(index))
            break
        }
        append(text.substring(index, start))
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
            append(text.substring(start + 2, end))
        }
        index = end + 2
    }
}
