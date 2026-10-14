package pl.jakubokruszek.flipcollector.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A card on the elevated surface with a hairline border, as on the web dashboard. */
@Composable
fun FlipCard(modifier: Modifier = Modifier, highlighted: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = FlipColors.SurfaceElevated, contentColor = FlipColors.Foreground),
        border = BorderStroke(1.dp, if (highlighted) FlipColors.GoldMuted else FlipColors.Border),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), modifier = modifier, color = FlipColors.MutedForeground, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.2.sp)
}

enum class Tone(val color: Color) {
    GOLD(FlipColors.Gold),
    SUCCESS(FlipColors.Success),
    WARNING(FlipColors.Warning),
    DANGER(FlipColors.Danger),
    NEUTRAL(FlipColors.MutedForeground),
}

/** Small rounded label with a coloured dot, e.g. "Wi-Fi · połączono". */
@Composable
fun StatusPill(text: String, tone: Tone, modifier: Modifier = Modifier) {
    Row(
        modifier
            .border(1.dp, tone.color.copy(alpha = 0.45f), RoundedCornerShape(50))
            .background(tone.color.copy(alpha = 0.10f), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(tone.color, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(text, color = FlipColors.Foreground, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Prominent banner that the app runs on test data. */
@Composable
fun DemoBanner(text: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .border(1.dp, FlipColors.Gold, MaterialTheme.shapes.small)
            .background(FlipColors.Gold.copy(alpha = 0.12f), MaterialTheme.shapes.small)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("TRYB DEMO", color = FlipColors.OnGold, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.background(FlipColors.Gold, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
        Spacer(Modifier.width(10.dp))
        Text(text, color = FlipColors.Foreground, fontSize = 13.sp)
    }
}

/** A KPI tile: big number, small label. */
@Composable
fun RowScope.MetricTile(value: String, label: String, tone: Tone = Tone.NEUTRAL) {
    Column(
        Modifier
            .weight(1f)
            .background(FlipColors.SurfaceMuted, MaterialTheme.shapes.small)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(value, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = if (tone == Tone.NEUTRAL) FlipColors.Foreground else tone.color)
        Text(label, fontSize = 12.sp, color = FlipColors.MutedForeground)
    }
}

/** Labelled progress bar, e.g. "Grupy 4/13". */
@Composable
fun LabeledProgress(label: String, done: Int, total: Int?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Text(label, fontSize = 13.sp, color = FlipColors.MutedForeground, modifier = Modifier.weight(1f))
            Text(if (total != null) "$done/$total" else "$done", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
        if (total != null && total > 0) {
            LinearProgressIndicator(
                progress = { (done.toFloat() / total).coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().height(8.dp),
                color = FlipColors.Gold,
                trackColor = FlipColors.SurfaceHover,
                strokeCap = StrokeCap.Round,
                gapSize = 0.dp,
                drawStopIndicator = {},
            )
        } else {
            LinearProgressIndicator(Modifier.fillMaxWidth().height(8.dp), color = FlipColors.Gold, trackColor = FlipColors.SurfaceHover, strokeCap = StrokeCap.Round)
        }
    }
}

/** Two-column "label — value" line used in detail cards. */
@Composable
fun InfoRow(label: String, value: String, valueColor: Color = FlipColors.Foreground) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(label, fontSize = 13.sp, color = FlipColors.MutedForeground, modifier = Modifier.weight(0.45f))
        Text(value, fontSize = 13.sp, color = valueColor, modifier = Modifier.weight(0.55f))
    }
}
