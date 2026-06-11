package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

@RunWith(AndroidJUnit4.class)
public class LspBrowserTitleTest {
    @Test
    public void recognizesScopedBrowserPackages() {
        assertTrue(LspBrowserTitle.isBrowserPackage("com.android.chrome"));
        assertTrue(LspBrowserTitle.isBrowserPackage("com.mi.browser"));
    }

    @Test
    public void removesUrlPrefixAndBrowserSuffix() {
        assertEquals(
                "DeepSeek 文档",
                LspBrowserTitle.cleanBrowserTitle(
                        "Chrome",
                        "https://api-docs.deepseek.com - DeepSeek 文档 - Chrome"));
    }

    @Test
    public void rejectsUrlLikeAndGenericTitles() {
        assertNull(LspBrowserTitle.cleanBrowserTitle(
                "Chrome",
                "https://example.com/path"));
        assertNull(LspBrowserTitle.cleanBrowserTitle(
                "Chrome",
                "Chrome"));
    }

    @Test
    public void ranksWebSourcesAboveDecorativeSources() {
        assertTrue(LspBrowserTitle.sourceRank("web_chrome") > LspBrowserTitle.sourceRank("task"));
        assertTrue(LspBrowserTitle.sourceRank("task") > LspBrowserTitle.sourceRank("window"));
    }
}
