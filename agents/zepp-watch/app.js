import { log } from '@zos/utils'
import { BaseApp } from '@zeppos/zml/base-app'

const logger = log.getLogger('LiveDashboard')

App(
  BaseApp({
    globalData: {},
    onCreate() {
      logger.log('Live Dashboard watch app created')
    },
    onDestroy() {
      logger.log('Live Dashboard watch app destroyed')
    },
  })
)
