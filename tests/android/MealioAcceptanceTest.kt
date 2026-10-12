package com.arttvad9r.mealio.bridge

import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.arttvad9r.mealio.R
import com.arttvad9r.mealio.domain.model.ServerAccount
import com.arttvad9r.mealio.ui.AppLanguage
import com.arttvad9r.mealio.ui.screens.SettingsScreen
import com.arttvad9r.mealio.ui.theme.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MealioAcceptanceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    @Test fun choicesAndConfirmationPreserveResourcesAndCallbacks() {
        var theme by mutableStateOf(ThemeMode.LIGHT)
        var language by mutableStateOf(AppLanguage.RUSSIAN)
        var disconnects = 0
        rule.setContent {
            MealioTheme(theme) {
                SettingsScreen(ServerAccount("https://test.invalid", "tester", "Тестовый пользователь", "Тестовая семья", "3.28.0"),
                    theme, "1.4", language, { theme = it }, { language = it }, { disconnects++ })
            }
        }
        val dark = rule.activity.getString(R.string.settings_theme_dark)
        // Filled by the acceptance harness for the structurally changed second revision.
        val removedDark = false
        if (removedDark) rule.onNodeWithText(dark).assertDoesNotExist()
        else {
            rule.onNodeWithText(dark).performClick()
            rule.runOnIdle { assertEquals(ThemeMode.DARK, theme) }
        }
        rule.onNodeWithText(rule.activity.getString(R.string.settings_theme_light)).performClick()
        rule.runOnIdle { assertEquals(ThemeMode.LIGHT, theme) }
        rule.onAllNodesWithText(rule.activity.getString(R.string.settings_theme_system)).onFirst().performClick()
        rule.runOnIdle { assertEquals(ThemeMode.SYSTEM, theme) }
        rule.onNodeWithText(rule.activity.getString(R.string.settings_language_english)).performScrollTo().performClick()
        rule.runOnIdle { assertEquals(AppLanguage.ENGLISH, language); assertEquals(0, disconnects) }
        val disconnect = rule.activity.getString(R.string.settings_disconnect)
        rule.onNodeWithText(disconnect).performScrollTo().performClick()
        rule.onNodeWithText(rule.activity.getString(R.string.settings_disconnect_confirm_title)).assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.common_cancel)).performClick()
        rule.runOnIdle { assertEquals(0, disconnects) }
        rule.onNodeWithText(disconnect).performScrollTo().performClick()
        rule.onAllNodesWithText(disconnect).onLast().performClick()
        rule.runOnIdle { assertEquals(1, disconnects) }
        rule.onNodeWithText(rule.activity.getString(R.string.settings_disconnect_confirm_title)).assertDoesNotExist()
    }
}
