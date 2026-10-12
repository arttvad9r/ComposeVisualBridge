package com.arttvad9r.mealio.bridge

import android.content.res.Configuration
import androidx.compose.runtime.*
import androidx.compose.material3.Surface
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.tooling.preview.Preview
import com.arttvad9r.mealio.ui.screens.SettingsScreen
import com.arttvad9r.mealio.ui.theme.*
import com.arttvad9r.mealio.ui.AppLanguage
import com.arttvad9r.mealio.domain.model.ServerAccount
import java.util.Locale

@Composable private fun AcceptanceSettings(dark: Boolean = false, long: Boolean = false) {
    val original = LocalContext.current
    val config = Configuration(LocalConfiguration.current).apply { setLocale(Locale.forLanguageTag("ru")) }
    val context = remember(original, config) { original.createConfigurationContext(config) }
    CompositionLocalProvider(LocalContext provides context, LocalConfiguration provides config) {
        val theme = if (dark) ThemeMode.DARK else ThemeMode.LIGHT
        MealioTheme(theme) {
            Surface(color = androidx.compose.material3.MaterialTheme.colorScheme.background) {
                SettingsScreen(
                    ServerAccount(
                        if (long) "https://test.invalid/very-long-server-address-for-the-layout-check" else "https://test.invalid",
                        "tester",
                        if (long) "Очень длинное имя тестового пользователя для проверки переноса строк и ограничения числа строк" else "Тестовый пользователь",
                        if (long) "Тестовая семья с длинным названием" else "Тестовая семья",
                        "3.28.0",
                    ), theme,
                    if (long) "1.4 — длинное описание тестовой сборки приложения для проверки многострочного текста" else "1.4",
                    AppLanguage.RUSSIAN, {}, {}, {},
                )
            }
        }
    }
}
@Preview @Composable fun MealioAcceptanceLight() { AcceptanceSettings() }
@Preview @Composable fun MealioAcceptanceDark() { AcceptanceSettings(dark = true) }
@Preview @Composable fun MealioAcceptanceLong() { AcceptanceSettings(long = true) }
