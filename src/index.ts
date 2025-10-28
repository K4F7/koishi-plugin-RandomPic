import { Context, Schema, Logger, segment } from 'koishi'
import { promises as fsp } from 'fs'
import fs from 'fs'
import path from 'path'
import { randomInt } from 'crypto'

const logger = new Logger('random-pic')

export const name = 'random-pic'

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
  watchers: fs.FSWatcher[]
  refresh?: () => Promise<void>
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

interface ScanResult {
  files: Set<string>
  directories: Set<string>
}

async function collectImages(dir: string, recursive: boolean, seen = new Set<string>()): Promise<ScanResult> {
  const files = new Set<string>()
  const directories = new Set<string>()
  directories.add(dir)
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && !seen.has(full)) {
          seen.add(full)
          const nested = await collectImages(full, recursive, seen)
          nested.files.forEach((file) => files.add(file))
          nested.directories.forEach((directory) => directories.add(directory))
        }
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (IMAGE_EXTENSIONS.has(ext)) {
        files.add(full)
      }
    }
  } catch (error) {
    logger.warn(error, '读取目录 %s 失败', dir)
  }
  return { files, directories }
}

async function buildCommandCache(config: CommandConfig, root: string): Promise<ScanResult> {
  const fileSet = new Set<string>()
  const dirSet = new Set<string>()
  for (const relative of config.paths) {
    const resolved = path.isAbsolute(relative) ? relative : path.resolve(root, relative)
    await ensureDirectory(resolved)
    const result = await collectImages(resolved, config.recursive ?? true)
    result.files.forEach((file) => fileSet.add(file))
    result.directories.forEach((directory) => dirSet.add(directory))
  }
  return { files: fileSet, directories: dirSet }
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

function registerWatchers(directories: Iterable<string>, refresh: () => void) {
  const watchers: fs.FSWatcher[] = []
  const handleChange = debounce(() => refresh(), 200)
  for (const dir of directories) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, () => handleChange())
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
    const { files, directories } = await buildCommandCache(commandConfig, rootDir)
    let state = commandStates.get(name)
    if (!state) {
      state = { files: [], watchers: [] }
      commandStates.set(name, state)
    }
    state.files = [...files]
    for (const watcher of state.watchers) {
      watcher.close()
    }
    const triggerRefresh = () => {
      if (state?.refresh) {
        state.refresh().catch((error) => logger.warn(error, '刷新命令 %s 缓存失败', name))
      } else {
        refreshCommand(name, commandConfig).catch((error) => logger.warn(error, '刷新命令 %s 缓存失败', name))
      }
    }
    state.watchers = registerWatchers(directories, triggerRefresh)
  }

  async function refreshAll() {
    await ensureDirectory(rootDir)
    for (const [name, commandConfig] of Object.entries(config.commands)) {
      const state = commandStates.get(name)
      try {
        if (state?.refresh) {
          await state.refresh()
        } else {
          await refreshCommand(name, commandConfig)
        }
      } catch (error) {
        logger.warn(error, '初始化命令 %s 缓存失败', name)
      }
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
    let state = commandStates.get(name)
    if (!state) {
      state = { files: [], watchers: [] }
      commandStates.set(name, state)
    }

    const refresh = async () => {
      logger.debug('刷新命令 %s 的缓存', name)
      await refreshCommand(name, commandConfig)
    }

    state.refresh = refresh

    decl.action(async ({ session }, countArg) => {
      const requestCount = Number.parseInt(countArg, 10)
      const defaultCount = config.defaultCount
      const maxCount = commandConfig.limit ?? config.maxCount
      const count = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : defaultCount
      const capped = Math.min(count, maxCount)

      const currentState = commandStates.get(name)
      if (!currentState || !currentState.files.length) {
        await refresh()
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

    refresh().catch((error) => logger.warn(error, '初始化命令 %s 缓存失败', name))
  }
}

