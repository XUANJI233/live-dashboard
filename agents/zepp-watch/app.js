import { BaseApp } from '@zeppos/zml/base-app'

App(
  BaseApp({
    globalData: {
      serverUrl: '',
      token: '',
      syncIntervalSec: 30,
    },

    onCreate() {
      console.log('[LiveWatch] App started')
      // Settings are loaded from app-side storage via SettingsPlugin
    },

    onDestroy() {
      console.log('[LiveWatch] App destroyed')
    },
  }),
)