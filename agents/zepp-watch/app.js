import { log } from '@zos/utils'

App({
  globalData: {},
  onCreate() {
    log('Live Dashboard watch app created')
  },
  onDestroy() {
    log('Live Dashboard watch app destroyed')
  },
})
