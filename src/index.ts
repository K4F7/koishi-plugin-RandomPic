import { Context, Schema, Logger, segment } from 'koishi'
import { promises as fsp } from 'fs'
import fs from 'fs'
import path from 'path'
import { randomInt } from 'crypto'

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

interface CommandConfig {
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
  watchers: fs.FSWatcher[]
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
  ).description('命令与图库的映射').default({}),
})

async function ensureDirectory(dir: string) {
  try {
    await fsp.mkdir(dir, { recursive: true })
  } catch (error) {
    logger.warn(error, '无法创建目录 %s', dir)
    throw error
  }
}

async function collectImages(dir: string, recursive: boolean, seen = new Set<string>()): Promise<string[]> {
  const items: string[] = []
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && !seen.has(full)) {
          seen.add(full)
          items.push(...await collectImages(full, recursive, seen))
        }
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (IMAGE_EXTENSIONS.has(ext)) {
        items.push(full)
      }
    }
  } catch (error) {
    logger.warn(error, '读取目录 %s 失败', dir)
  }
  return items
}

async function buildCommandCache(config: CommandConfig, root: string): Promise<string[]> {
  const fileSet = new Set<string>()
  for (const relative of config.paths) {
    const resolved = path.isAbsolute(relative) ? relative : path.resolve(root, relative)
    await ensureDirectory(resolved)
    const files = await collectImages(resolved, config.recursive ?? true)
    for (const file of files) {
      fileSet.add(file)
    }
  }
  return [...fileSet]
}

function pickRandom<T>(source: T[], count: number): T[] {
  if (count >= source.length) return [...source]
  const picked: T[] = []
  const used = new Set<number>()
  while (picked.length < count && used.size < source.length) {
    const index = randomInt(source.length)
    if (used.has(index)) continue
    used.add(index)
    picked.push(source[index])
  }
  return picked
}

async function registerWatchers(config: CommandConfig, root: string, refresh: () => void) {
  const watchers: fs.FSWatcher[] = []
  const watchDirs = config.paths.map((relative) => path.isAbsolute(relative) ? relative : path.resolve(root, relative))
  for (const dir of watchDirs) {
    try {
      await ensureDirectory(dir)
      const watcher = fs.watch(dir, { persistent: false }, debounce(refresh, 200))
      watcher.on('error', (error) => logger.warn(error, '监听目录 %s 失败', dir))
      watchers.push(watcher)
    } catch (error) {
      logger.warn(error, '无法监听目录 %s', dir)
    }
  }
  return watchers
}

function debounce(fn: () => void, delay: number) {
  let timer: NodeJS.Timeout
  return () => {
    clearTimeout(timer)
    timer = setTimeout(fn, delay)
  }
}

export function apply(ctx: Context, config: Config) {
  const rootDir = path.isAbsolute(config.root) ? config.root : path.resolve(ctx.baseDir, config.root)
  const commandStates = new Map<string, CommandState>()

  ensureDirectory(rootDir).catch((error) => logger.warn(error, '初始化图库目录失败'))

  ctx.on('ready', async () => {
    await ensureDirectory(rootDir)
    await refreshAll()
  })

  ctx.on('dispose', () => {
    for (const state of commandStates.values()) {
      for (const watcher of state.watchers) {
        watcher.close()
      }
    }
    commandStates.clear()
  })

  async function refreshCommand(name: string, commandConfig: CommandConfig) {
    const files = await buildCommandCache(commandConfig, rootDir)
    const state = commandStates.get(name)
    if (state) {
      state.files = files
    } else {
      commandStates.set(name, { files, watchers: [] })
    }
  }

  async function refreshAll() {
    await ensureDirectory(rootDir)
    for (const [name, commandConfig] of Object.entries(config.commands)) {
      await refreshCommand(name, commandConfig)
    }
  }

  for (const [name, commandConfig] of Object.entries(config.commands)) {
    const helpParts: string[] = []
    if (commandConfig.description) {
      helpParts.push(commandConfig.description)
    }
    helpParts.push(`图库来源：${commandConfig.paths.join(', ')}`)
    const limit = commandConfig.limit ?? config.maxCount
    helpParts.push(`一次最多发送 ${limit} 张图片`)
    const decl = ctx.command(`${name} [count:number]`, helpParts.join('\n'))
    decl.action(async ({ session }, countArg) => {
      const requestCount = Number.parseInt(countArg, 10)
      const defaultCount = config.defaultCount
      const maxCount = commandConfig.limit ?? config.maxCount
      const count = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : defaultCount
      const capped = Math.min(count, maxCount)

      const state = commandStates.get(name)
      if (!state || !state.files.length) {
        await refreshCommand(name, commandConfig)
      }
      const files = commandStates.get(name)?.files ?? []
      if (!files.length) {
        await session.send(`图库为空或无法读取，请稍后再试。`)
        return
      }

      const picked = pickRandom(files, Math.min(capped, files.length))
      const messages = picked.map((file) => segment.image('file://' + file))
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
    const refresh = async () => {
      logger.debug('刷新命令 %s 的缓存', name)
      await refreshCommand(name, commandConfig)
    }
    commandStates.set(name, state)
    registerWatchers(commandConfig, rootDir, () => {
      refresh().catch((error) => logger.warn(error, '刷新缓存失败'))
    }).then((watchers) => {
      state.watchers = watchers
    }).catch((error) => {
      logger.warn(error, '初始化命令 %s 的目录监听失败', name)
    })
  }
}

