import { log } from '@zos/utils'
import { BaseApp } from '@zeppos/zml/base-app'

App(
  BaseApp({
    globalData: {},
    onCreate() {
      log('Live Dashboard watch app created')
    },
    onDestroy() {
      log('Live Dashboard watch app destroyed')
    },
  })
)
