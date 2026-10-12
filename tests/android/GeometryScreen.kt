package dev.composevisualbridge.acceptance

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable fun GeometryScreen() {
    Column(Modifier.fillMaxSize().background(Color.White).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.width(100.dp).height(64.dp).padding(16.dp).background(Color(0xFFE0EFFF))) {
            Text("A", modifier = Modifier.fillMaxSize(), fontSize = 14.sp)
        }
        Box(Modifier.padding(16.dp).width(100.dp).height(32.dp).background(Color(0xFFFFE0EF))) {
            Text("B", modifier = Modifier.fillMaxSize(), fontSize = 14.sp)
        }
        Box(Modifier.width(100.dp).height(64.dp).padding(16.dp).background(Color(0xFFE0FFEF))) {
            Text("C", modifier = Modifier.fillMaxSize(), fontSize = 14.sp)
        }
        Box(Modifier.width(100.dp).height(64.dp).padding(horizontal = 8.dp, vertical = 16.dp).background(Color(0xFFFFFFE0))) {
            Text("D", modifier = Modifier.fillMaxSize(), fontSize = 14.sp)
        }
    }
}

@Preview @Composable fun GeometryPreview() {
    MaterialTheme(colorScheme = lightColorScheme()) { GeometryScreen() }
}
