package com.monika.dashboard.lsposed;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.graphics.Bitmap;
import android.graphics.Color;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;

import java.io.ByteArrayOutputStream;

@RunWith(AndroidJUnit4.class)
@Config(sdk = 35)
public class LspScreenshotControllerTest {
    @Test
    public void downscalesAndBoundsJpegForUpload() {
        byte[] png = testPng(1440, 3200);
        LspScreenshotController controller = new LspScreenshotController(() -> png, message -> {});

        LspCapturedScreenshot screenshot = controller.capture(720, 65);

        assertNotNull(screenshot);
        assertEquals("image/jpeg", screenshot.mimeType);
        assertEquals(720, screenshot.width);
        assertEquals(1600, screenshot.height);
        assertTrue(screenshot.bytes.length <= 700 * 1024);
        assertEquals(0xff, screenshot.bytes[0] & 0xff);
        assertEquals(0xd8, screenshot.bytes[1] & 0xff);
    }

    private byte[] testPng(int width, int height) {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.rgb(40, 80, 120));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        bitmap.recycle();
        return out.toByteArray();
    }
}
