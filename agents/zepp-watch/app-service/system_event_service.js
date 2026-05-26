import { log } from '@zos/utils'
const logger = log.getLogger('live-dashboard.system-event')

AppService({
  onInit(options) {
    logger.log(`Live Dashboard system event: ${String(options || '')}`)
  },
})
