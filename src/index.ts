import { Context, Logger, Schema } from 'koishi'

export const name = 'random-pic'

export interface Config {
  /**
   * Remote endpoint that returns a random image.
   */
  endpoint: string
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string().default('https://picsum.photos/seed/koishi/800/600'),
}).description('Random picture provider options.')

const logger = new Logger(name)

export function apply(ctx: Context, config: Config) {
  logger.debug('random picture plugin initialized with endpoint %s', config.endpoint)

  ctx.command('random-pic', 'Send a random picture').action(async ({ session }) => {
    await session?.send(config.endpoint)
    return
  })
}
