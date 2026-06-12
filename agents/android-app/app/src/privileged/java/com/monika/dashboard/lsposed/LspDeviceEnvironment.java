package com.monika.dashboard.lsposed;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.telephony.TelephonyManager;

import org.json.JSONObject;

final class LspDeviceEnvironment {
    interface Host {
        Context systemContext();
        Handler uploadHandler();
        void logDebug(String message);
    }

    private static final long AMBIENT_LIGHT_CACHE_MS = 60_000L;

    private final Host host;
    private volatile float lastAmbientLux = -1f;
    private volatile long lastAmbientLightAt = 0L;
    private volatile boolean ambientLightListenerRegistered = false;

    LspDeviceEnvironment(Host host) {
        this.host = host;
    }

    void putBatteryExtras(JSONObject extra) {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return;
            Intent intent = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (intent == null) return;
            int level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) {
                int percent = Math.max(0, Math.min(100, Math.round((level * 100f) / scale)));
                extra.put("battery_percent", percent);
            }
            int status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            if (status >= 0) {
                extra.put("battery_charging",
                        status == BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == BatteryManager.BATTERY_STATUS_FULL);
            }
        } catch (Throwable t) {
            host.logDebug("battery extras skipped: " + t.getClass().getSimpleName());
        }
    }

    void putNetworkExtras(JSONObject device, boolean uploadNetwork, boolean uploadVpn) {
        if (!uploadNetwork && !uploadVpn) return;
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return;
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;

            boolean vpnActive = false;
            String activeType = "";
            String cellularGeneration = "";
            boolean connected = false;

            Network active = cm.getActiveNetwork();
            if (active != null) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(active);
                if (caps != null) {
                    connected = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                    activeType = networkType(caps);
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                        cellularGeneration = cellularGeneration();
                    }
                    vpnActive = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
                }
            }

            if (uploadVpn) {
                for (Network network : cm.getAllNetworks()) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                    if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                        vpnActive = true;
                        break;
                    }
                }
                device.put("vpn_active", vpnActive);
            }
            if (uploadNetwork) {
                device.put("network_connected", connected);
                if (activeType.length() > 0) device.put("network_type", activeType);
                if (cellularGeneration.length() > 0) device.put("cellular_generation", cellularGeneration);
            }
        } catch (Throwable t) {
            host.logDebug("network extras skipped: " + t.getClass().getSimpleName());
        }
    }

    void putAudioOutputExtras(JSONObject device) {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return;
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            AudioCandidate best = null;
            AudioDeviceInfo[] devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            if (devices != null) {
                for (AudioDeviceInfo info : devices) {
                    AudioCandidate candidate = audioCandidate(info);
                    if (candidate != null && (best == null || candidate.priority > best.priority)) {
                        best = candidate;
                    }
                }
            }
            if (best != null) {
                device.put("audio_output_connected", true);
                device.put("audio_output_type", best.type);
                if (best.name.length() > 0) device.put("audio_output_name", best.name);
            } else {
                device.put("audio_output_connected", false);
                device.put("audio_output_type", "speaker");
            }
        } catch (Throwable t) {
            host.logDebug("audio output skipped: " + t.getClass().getSimpleName());
        }
    }

    void putAmbientLightExtras(JSONObject device, long now) {
        try {
            if (lastAmbientLux >= 0f && now - lastAmbientLightAt <= AMBIENT_LIGHT_CACHE_MS) {
                device.put("ambient_lux", Math.round(lastAmbientLux * 10f) / 10.0);
            }
            requestAmbientLightSample();
        } catch (Throwable t) {
            host.logDebug("ambient light skipped: " + t.getClass().getSimpleName());
        }
    }

    boolean isNetworkConnected() {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return false;
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            Network active = cm.getActiveNetwork();
            if (active == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private AudioCandidate audioCandidate(AudioDeviceInfo info) {
        if (info == null) return null;
        String name = "";
        try {
            CharSequence productName = info.getProductName();
            if (productName != null) name = safeString(productName.toString());
        } catch (Throwable ignored) {}
        switch (info.getType()) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                return new AudioCandidate("bluetooth_headset", name, 90);
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                return new AudioCandidate("wired_headset", name, 80);
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
                return new AudioCandidate("usb_audio", name, 70);
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return new AudioCandidate("hearing_aid", name, 65);
            case AudioDeviceInfo.TYPE_HDMI:
            case AudioDeviceInfo.TYPE_HDMI_ARC:
            case AudioDeviceInfo.TYPE_HDMI_EARC:
                return new AudioCandidate("hdmi_audio", name, 50);
            default:
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    int type = info.getType();
                    if (type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                            type == AudioDeviceInfo.TYPE_BLE_SPEAKER ||
                            type == AudioDeviceInfo.TYPE_BLE_BROADCAST) {
                        return new AudioCandidate("bluetooth_headset", name, 85);
                    }
                }
                return null;
        }
    }

    private void requestAmbientLightSample() {
        if (ambientLightListenerRegistered) return;
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return;
            SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
            if (sm == null) return;
            Sensor sensor = sm.getDefaultSensor(Sensor.TYPE_LIGHT);
            if (sensor == null) return;
            Handler handler = host.uploadHandler();
            if (handler == null) return;
            final SensorEventListener[] holder = new SensorEventListener[1];
            holder[0] = new SensorEventListener() {
                @Override
                public void onSensorChanged(SensorEvent event) {
                    try {
                        if (event != null && event.values != null && event.values.length > 0) {
                            lastAmbientLux = Math.max(0f, Math.min(200000f, event.values[0]));
                            lastAmbientLightAt = System.currentTimeMillis();
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        try { sm.unregisterListener(holder[0]); } catch (Throwable ignored) {}
                        ambientLightListenerRegistered = false;
                    }
                }

                @Override
                public void onAccuracyChanged(Sensor sensor, int accuracy) {}
            };
            if (sm.registerListener(holder[0], sensor, SensorManager.SENSOR_DELAY_NORMAL, handler)) {
                ambientLightListenerRegistered = true;
                handler.postDelayed(() -> {
                    try {
                        if (ambientLightListenerRegistered) {
                            sm.unregisterListener(holder[0]);
                            ambientLightListenerRegistered = false;
                        }
                    } catch (Throwable ignored) {}
                }, 1000L);
            }
        } catch (Throwable ignored) {
            ambientLightListenerRegistered = false;
        }
    }

    private String networkType(NetworkCapabilities caps) {
        if (caps == null) return "";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "Wi-Fi";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            String gen = cellularGeneration();
            return gen.length() > 0 ? gen : "Cellular";
        }
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "Ethernet";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)) return "Bluetooth";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return "VPN";
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ? "Online" : "offline";
    }

    @SuppressLint("MissingPermission")
    private String cellularGeneration() {
        try {
            Context ctx = host.systemContext();
            if (ctx == null) return "";
            TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return "";
            if (!hasPhoneStatePermission(ctx)) return "";
            int dataNetworkType;
            try {
                dataNetworkType = tm.getDataNetworkType();
            } catch (SecurityException ignored) {
                return "";
            }
            switch (dataNetworkType) {
                case TelephonyManager.NETWORK_TYPE_NR:
                    return "5G";
                case TelephonyManager.NETWORK_TYPE_LTE:
                case TelephonyManager.NETWORK_TYPE_IWLAN:
                    return "4G";
                case TelephonyManager.NETWORK_TYPE_HSPAP:
                case TelephonyManager.NETWORK_TYPE_HSPA:
                case TelephonyManager.NETWORK_TYPE_HSDPA:
                case TelephonyManager.NETWORK_TYPE_HSUPA:
                case TelephonyManager.NETWORK_TYPE_UMTS:
                case TelephonyManager.NETWORK_TYPE_EVDO_0:
                case TelephonyManager.NETWORK_TYPE_EVDO_A:
                case TelephonyManager.NETWORK_TYPE_EVDO_B:
                case TelephonyManager.NETWORK_TYPE_EHRPD:
                    return "3G";
                case TelephonyManager.NETWORK_TYPE_EDGE:
                case TelephonyManager.NETWORK_TYPE_GPRS:
                case TelephonyManager.NETWORK_TYPE_CDMA:
                case TelephonyManager.NETWORK_TYPE_1xRTT:
                case TelephonyManager.NETWORK_TYPE_IDEN:
                    return "2G";
                default:
                    return "Cellular";
            }
        } catch (Throwable ignored) {
            return "";
        }
    }

    private boolean hasPhoneStatePermission(Context ctx) {
        try {
            if (ctx.checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE)
                    == PackageManager.PERMISSION_GRANTED) {
                return true;
            }
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && ctx.checkSelfPermission(android.Manifest.permission.READ_BASIC_PHONE_STATE)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static String safeString(String value) {
        if (value == null) return "";
        String trimmed = value.trim();
        return trimmed.length() > 64 ? trimmed.substring(0, 64) : trimmed;
    }

    private static final class AudioCandidate {
        final String type;
        final String name;
        final int priority;

        AudioCandidate(String type, String name, int priority) {
            this.type = safeString(type);
            this.name = safeString(name);
            this.priority = priority;
        }
    }
}
