// Notifications of {{kit.name}}: `await appNotifier(config).notify({ topic, title, message })`.
// Off until NOTIFIER_URL is set. notify() never throws — check the result if the outcome matters.
import type { Config } from './config.js'
import type { Logger } from './kit/api/log.js'
import { createNotifier, type Notifier } from './kit/notify/client.js'

export function appNotifier(config: Pick<Config, 'NOTIFIER_URL' | 'NOTIFIER_TOKEN'>, logger?: Logger): Notifier {
  return createNotifier({
    url: config.NOTIFIER_URL,
    token: config.NOTIFIER_TOKEN,
    onError: (error, message) => logger?.warn('notification not sent', { topic: message.topic, title: message.title, error }),
  })
}
