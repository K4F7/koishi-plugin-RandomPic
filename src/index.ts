import { Context, Logger, Schema, segment } from 'koishi'
import { FSWatcher, watch } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { randomInt } from 'node:crypto'

const logger = new Logger('random-pic')

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.avif',
])

export interface CommandConfig {
  paths: string[]
  limit?: number
  recursive?: boolean
  description?: string
}

export interface Config {
  root: string
  defaultCount: number
  maxCount: number
  commands: Record<string, CommandConfig>
  useQueue?: boolean
}

interface CommandState {
  files: string[]
  watchers: FSWatcher[]
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string().default('galleries').description('图库目录根路径'),
  defaultCount: Schema.natural().default(1).description('默认每次发送的图片数量'),
  maxCount: Schema.natural().default(5).description('单次发送的图片数量上限'),
  useQueue: Schema.boolean().default(false).description('发送图片时是否使用 session.sendQueued'),
  commands: Schema.dict(
    Schema.object({
      paths: Schema.array(Schema.string()).min(1).description('图库目录列表'),
      limit: Schema.natural().description('该命令单次发送的最大图片数量'),
      recursive: Schema.boolean().default(true).description('是否递归扫描目录'),
      description: Schema.string().default('').description('命令的额外说明'),
    }),
  )
    .description('命令与图库的映射')
    .default({}),
})

function resolveGalleryPath(root: string, location: string) {
  return path.isAbsolute(location) ? location : path.resolve(root, location)
}

async function ensureDirectory(dir: string) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    logger.warn(error, '无法创建目录 %s', dir)
    throw error
  }
}

async function collectImages(dir: string, recursive: boolean): Promise<string[]> {
  const files: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive) {
          files.push(...await collectImages(full, recursive))
        }
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (IMAGE_EXTENSIONS.has(ext)) {
        files.push(full)
      }
    }
  } catch (error) {
    logger.warn(error, '读取目录 %s 失败', dir)
  }
  return files
}

async function buildCommandCache(config: CommandConfig, root: string): Promise<string[]> {
  const fileSet = new Set<string>()
  for (const location of config.paths) {
    const resolved = resolveGalleryPath(root, location)
    await ensureDirectory(resolved)
    const images = await collectImages(resolved, config.recursive ?? true)
    for (const image of images) {
      fileSet.add(image)
    }
  }
  return [...fileSet]
}

function pickRandom<T>(items: readonly T[], count: number) {
  if (items.length <= count) return [...items]
  const chosen: T[] = []
  const used = new Set<number>()
  while (chosen.length < count && used.size < items.length) {
    const index = randomInt(items.length)
    if (used.has(index)) continue
    used.add(index)
    chosen.push(items[index]!)
  }
  return chosen
}

function debounce(fn: () => void, delay: number) {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, delay)
  }
}

async function registerWatchers(
  name: string,
  config: CommandConfig,
  root: string,
  onRefresh: () => Promise<void>,
): Promise<FSWatcher[]> {
  const watchers: FSWatcher[] = []
  const trigger = debounce(() => {
    onRefresh().catch((error) => logger.warn(error, '刷新命令 %s 的缓存失败', name))
  }, 200)

  for (const location of config.paths) {
    const resolved = resolveGalleryPath(root, location)
    try {
      await ensureDirectory(resolved)
      const watcher = watch(resolved, { persistent: false }, trigger)
      watcher.on('error', (error) => logger.warn(error, '监听目录 %s 失败', resolved))
      watchers.push(watcher)
    } catch (error) {
      logger.warn(error, '初始化目录 %s 的监听失败', resolved)
    }
  }

  return watchers
}

function disposeWatchers(watchers: Iterable<FSWatcher>) {
  for (const watcher of watchers) {
    try {
      watcher.close()
    } catch (error) {
      logger.warn(error, '关闭目录监听失败')
    }
  }
}

export function apply(ctx: Context, config: Config) {
  const rootDir = path.isAbsolute(config.root) ? config.root : path.resolve(ctx.baseDir, config.root)
  const commandStates = new Map<string, CommandState>()

  const refreshCommand = async (name: string, commandConfig: CommandConfig) => {
    const files = await buildCommandCache(commandConfig, rootDir)
    const state = commandStates.get(name)
    if (state) {
      state.files = files
    } else {
      commandStates.set(name, { files, watchers: [] })
    }
  }

  const refreshAll = async () => {
    await ensureDirectory(rootDir)
    await Promise.all(
      Object.entries(config.commands).map(([name, commandConfig]) => refreshCommand(name, commandConfig)),
    )
  }

  ctx.on('ready', async () => {
    await ensureDirectory(rootDir)
    await refreshAll()
  })

  ctx.on('dispose', () => {
    for (const state of commandStates.values()) {
      disposeWatchers(state.watchers)
    }
    commandStates.clear()
  })

  for (const [name, commandConfig] of Object.entries(config.commands)) {
    const limit = commandConfig.limit ?? config.maxCount
    const helpParts = [
      commandConfig.description ?? '',
      `图库来源：${commandConfig.paths.join(', ')}`,
      `一次最多发送 ${limit} 张图片`,
    ].filter(Boolean)

    const declaration = ctx.command(`${name} [count:number]`, helpParts.join('\n'))

    declaration.action(async ({ session }, countArg?: number) => {
      if (!session) {
        logger.warn('会话不可用，无法处理命令 %s', name)
        return
      }

      const count =
        typeof countArg === 'number' && Number.isFinite(countArg) && countArg > 0
          ? countArg
          : config.defaultCount
      const capped = Math.min(count, limit)

      let state = commandStates.get(name)
      if (!state || !state.files.length) {
        await refreshCommand(name, commandConfig)
        state = commandStates.get(name)
      }

      const files = state?.files ?? []
      if (!files.length) {
        await session.send('图库为空或无法读取，请稍后再试。')
        return
      }

      const selected = pickRandom(files, Math.min(capped, files.length))
      const messages = selected.map((file) => segment.image('file://' + file))

      try {
        if (config.useQueue) {
          for (const message of messages) {
            await session.sendQueued(message)
          }
        } else {
          for (const message of messages) {
            await session.send(message)
          }
        }
      } catch (error) {
        logger.warn(error, '发送图片失败')
        await session.send('发送图片时发生错误。')
      }
    })

    const state = commandStates.get(name) ?? { files: [], watchers: [] }
    commandStates.set(name, state)

    registerWatchers(name, commandConfig, rootDir, () => refreshCommand(name, commandConfig))
      .then((watchers) => {
        disposeWatchers(state.watchers)
        state.watchers = watchers
      })
      .catch((error) => {
        logger.warn(error, '注册命令 %s 的目录监听失败', name)
      })
  }
}
