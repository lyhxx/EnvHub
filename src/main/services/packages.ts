import { net } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PackageManagerConfig, PackageManagerId } from '../../shared/contracts'
import { APP_VERSION } from '../../shared/appInfo'
import { store } from '../storage/store'

const configFiles: Record<PackageManagerId, string> = {
  npm: join(homedir(), '.npmrc'),
  pip: join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'pip', 'pip.ini'),
  maven: join(homedir(), '.m2', 'settings.xml')
}

const defaultCacheDirs: Record<PackageManagerId, string> = {
  npm: join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache'),
  pip: join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'pip', 'Cache'),
  maven: join(homedir(), '.m2', 'repository')
}

function validateRegistry(value: string): string {
  const registry = value.trim()
  if (!registry || registry.length > 2048) throw new Error('镜像地址不能为空，且不能超过 2048 个字符')
  let url: URL
  try { url = new URL(registry) } catch { throw new Error('镜像地址格式无效') }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !localHttp) throw new Error('镜像地址必须使用 HTTPS（本机 localhost 服务除外）')
  if (url.username || url.password || url.search || url.hash) throw new Error('镜像地址不能包含账号、密码、查询参数或片段')
  return registry
}

function updateNpmrc(content: string, registry: string): string {
  const lines = content ? content.split(/\r?\n/) : []
  const output: string[] = []
  let replaced = false
  for (const line of lines) {
    if (/^\s*registry\s*=/i.test(line)) {
      if (!replaced) output.push(`registry=${registry}`)
      replaced = true
    } else {
      output.push(line)
    }
  }
  if (!replaced) output.push(`registry=${registry}`)
  return `${output.filter((line, index) => line || index < output.length - 1).join('\n').replace(/\n*$/, '')}\n`
}

function updatePipIni(content: string, registry: string): string {
  const lines = content ? content.split(/\r?\n/) : []
  const output: string[] = []
  let section = ''
  let sawGlobal = false
  let wroteIndex = false

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      if (section.toLowerCase() === 'global' && !wroteIndex) {
        output.push(`index-url = ${registry}`)
        wroteIndex = true
      }
      section = header[1].trim()
      if (section.toLowerCase() === 'global') sawGlobal = true
      output.push(line)
      continue
    }
    if (section.toLowerCase() === 'global' && /^\s*index-url\s*=/i.test(line)) {
      if (!wroteIndex) output.push(`index-url = ${registry}`)
      wroteIndex = true
    } else {
      output.push(line)
    }
  }

  if (section.toLowerCase() === 'global' && !wroteIndex) {
    output.push(`index-url = ${registry}`)
    wroteIndex = true
  }
  if (!sawGlobal) output.push('', '[global]', `index-url = ${registry}`)
  return `${output.join('\n').replace(/\n*$/, '')}\n`
}

function updateMavenSettings(content: string, registry: string): string {
  const mirrorBlock = [
    '    <mirror>',
    '      <id>envhub-central</id>',
    `      <url>${registry}</url>`,
    '      <mirrorOf>central</mirrorOf>',
    '    </mirror>'
  ].join('\n')

  if (/<mirrors>[\s\S]*?<\/mirrors>/i.test(content)) {
    return content.replace(/<mirrors>([\s\S]*?)<\/mirrors>/i, (block, inner: string) => {
      if (/<id>\s*envhub-central\s*<\/id>/i.test(inner)) {
        // 已有本工具的 mirror：只替换它，保持用户其它镜像原样。
        return block.replace(/<mirror>[\s\S]*?<\/mirror>/gi, (mirror) => (/<id>\s*envhub-central\s*<\/id>/i.test(mirror) ? mirrorBlock : mirror))
      }
      // 有 <mirrors> 但没有本工具的 mirror：追加一个新的，不能什么都不做。
      return block.replace(/<\/mirrors>/i, `${mirrorBlock}\n  </mirrors>`)
    })
  }

  if (!content.trim()) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">\n  <mirrors>\n${mirrorBlock}\n  </mirrors>\n</settings>\n`
  }
  if (/<settings[^>]*>/i.test(content)) {
    return content.replace(/<\/settings>/i, `  <mirrors>\n${mirrorBlock}\n  </mirrors>\n</settings>`)
  }
  throw new Error('无法识别 settings.xml 结构，请先手动检查该文件')
}

function validateCacheDir(value: string): string {
  const dir = value.trim().replace(/[\\/]+$/, '')
  if (!dir || dir.length > 1024) throw new Error('路径不能为空，且不能超过 1024 个字符')
  if (dir.includes('..')) throw new Error('路径不能包含 ..')
  if (!/^[a-zA-Z]:[\\/]/.test(dir) && !dir.startsWith('\\\\')) throw new Error('请填写绝对路径，例如 D:\\DevCache\\npm')
  return dir
}

// 路径里的 & < > 是合法的 Windows 路径字符，但直接写进 XML 会让 settings.xml 变成非法文件。
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 读回来时要还原，否则界面上会显示成 Dev&amp;Cache，再写一次还会二次转义。
function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function updateKeyLine(content: string, key: string, value: string): string {
  const lines = content ? content.split(/\r?\n/) : []
  const output: string[] = []
  let replaced = false
  for (const line of lines) {
    if (new RegExp(`^\\s*${key}\\s*=`, 'i').test(line)) {
      if (!replaced) output.push(`${key}=${value}`)
      replaced = true
    } else {
      output.push(line)
    }
  }
  if (!replaced) output.push(`${key}=${value}`)
  return `${output.filter((line, index) => line || index < output.length - 1).join('\n').replace(/\n*$/, '')}\n`
}

function updateMavenLocalRepository(content: string, dir: string): string {
  const value = escapeXml(dir)
  if (/<localRepository>[\s\S]*?<\/localRepository>/i.test(content)) {
    return content.replace(/<localRepository>[\s\S]*?<\/localRepository>/i, `<localRepository>${value}</localRepository>`)
  }
  if (/<settings[^>]*>/i.test(content)) {
    return content.replace(/(<settings[^>]*>)/i, `$1\n  <localRepository>${value}</localRepository>`)
  }
  if (!content.trim()) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">\n  <localRepository>${value}</localRepository>\n</settings>\n`
  }
  throw new Error('无法识别 settings.xml 结构，请先手动检查该文件')
}

function updateIniGlobalKey(content: string, key: string, value: string): string {
  const lines = content ? content.split(/\r?\n/) : []
  const output: string[] = []
  let section = ''
  let sawGlobal = false
  let wrote = false
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      if (section.toLowerCase() === 'global' && !wrote) { output.push(`${key} = ${value}`); wrote = true }
      section = header[1].trim()
      if (section.toLowerCase() === 'global') sawGlobal = true
      output.push(line)
      continue
    }
    if (section.toLowerCase() === 'global' && new RegExp(`^\\s*${key}\\s*=`, 'i').test(line)) {
      if (!wrote) output.push(`${key} = ${value}`)
      wrote = true
    } else {
      output.push(line)
    }
  }
  if (section.toLowerCase() === 'global' && !wrote) { output.push(`${key} = ${value}`); wrote = true }
  if (!sawGlobal) output.push('', '[global]', `${key} = ${value}`)
  return `${output.join('\n').replace(/\n*$/, '')}\n`
}

async function readConfigFile(manager: PackageManagerId): Promise<{ content: string; encoding: 'utf8' | 'latin1'; exists: boolean }> {
  try {
    const buffer = await readFile(configFiles[manager])
    try {
      return { content: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf8', exists: true }
    } catch {
      // 文件不是合法 UTF-8（例如 GBK 编码的 settings.xml）：按字节保留，写回时不破坏原编码。
      return { content: buffer.toString('latin1'), encoding: 'latin1', exists: true }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', encoding: 'utf8', exists: false }
    throw error
  }
}

async function writeConfigFile(manager: PackageManagerId, content: string, encoding: 'utf8' | 'latin1'): Promise<void> {
  const path = configFiles[manager]
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.envhub-tmp`
  await writeFile(temporary, Buffer.from(content, encoding === 'utf8' ? 'utf8' : 'latin1'))
  await rename(temporary, path)
}

function parseRegistry(manager: PackageManagerId, content: string): string | null {
  if (manager === 'npm') return content.match(/^\s*registry\s*=\s*(.*?)\s*$/im)?.[1] ?? null
  if (manager === 'maven') {
    // 优先读本工具写入的 mirror；没有的话退回文件里第一个 mirror 的地址，避免显示与文件不一致。
    const own = content.match(/<id>\s*envhub-central\s*<\/id>\s*<url>\s*([^<]+?)\s*<\/url>/i)?.[1]
    if (own) return own
    const firstMirror = content.match(/<mirror>[\s\S]*?<\/mirror>/i)?.[0]
    return firstMirror?.match(/<url>\s*([^<]+?)\s*<\/url>/i)?.[1] ?? null
  }
  const globalSection = content.match(/^\s*\[global\]\s*$([\s\S]*?)(?=^\s*\[[^\]]+\]\s*$|\s*$)/im)?.[1]
  return globalSection?.match(/^\s*index-url\s*=\s*(.*?)\s*$/im)?.[1] ?? null
}

function parseCacheDir(manager: PackageManagerId, content: string): string | null {
  if (manager === 'npm') return content.match(/^\s*cache\s*=\s*(.*?)\s*$/im)?.[1] ?? null
  if (manager === 'maven') {
    const value = content.match(/<localRepository>\s*([^<]+?)\s*<\/localRepository>/i)?.[1]
    return value ? unescapeXml(value) : null
  }
  const globalSection = content.match(/^\s*\[global\]\s*$([\s\S]*?)(?=^\s*\[[^\]]+\]\s*$|\s*$)/im)?.[1]
  return globalSection?.match(/^\s*cache-dir\s*=\s*(.*?)\s*$/im)?.[1] ?? null
}

export async function getPackageConfig(manager: PackageManagerId): Promise<PackageManagerConfig> {
  if (!['npm', 'pip', 'maven'].includes(manager)) throw new Error('不支持的包管理器')
  const { content, exists } = await readConfigFile(manager)
  const stored = store.snapshot().packageConfigs[manager]
  const fromFile = parseCacheDir(manager, content)
  return {
    registry: parseRegistry(manager, content) || stored.registry,
    cacheDir: fromFile || stored.cacheDir || defaultCacheDirs[manager],
    cacheDirFromFile: Boolean(fromFile),
    configFileExists: exists
  }
}

export async function setPackageRegistry(manager: PackageManagerId, value: string): Promise<PackageManagerConfig> {
  if (!['npm', 'pip', 'maven'].includes(manager)) throw new Error('不支持的包管理器')
  const registry = validateRegistry(value)
  const path = configFiles[manager]
  const { content: previous, encoding } = await readConfigFile(manager)
  await mkdir(dirname(path), { recursive: true })
  try { await writeFile(`${path}.bak`, Buffer.from(previous, encoding), 'utf8') }
  catch { /* A backup is best-effort; preserve the user's original config. */ }
  const next = manager === 'npm' ? updateNpmrc(previous, registry) : manager === 'pip' ? updatePipIni(previous, registry) : updateMavenSettings(previous, registry)
  await writeConfigFile(manager, next, encoding)
  const config: PackageManagerConfig = { registry, ...(parseCacheDir(manager, next) ? { cacheDir: parseCacheDir(manager, next)! } : {}) }
  await store.setPackageConfig(manager, config)
  return { ...config, cacheDir: config.cacheDir ?? defaultCacheDirs[manager], cacheDirFromFile: Boolean(config.cacheDir), configFileExists: true }
}

export async function setPackageCacheDir(manager: PackageManagerId, value: string): Promise<PackageManagerConfig> {
  if (!['npm', 'pip', 'maven'].includes(manager)) throw new Error('不支持的包管理器')
  const cacheDir = validateCacheDir(value)
  await mkdir(cacheDir, { recursive: true }).catch(() => { throw new Error('无法创建该目录，请检查路径权限') })
  const path = configFiles[manager]
  const { content: previous, encoding } = await readConfigFile(manager)
  try { await writeFile(`${path}.bak`, Buffer.from(previous, encoding), 'utf8') }
  catch { /* best-effort backup */ }
  const next = manager === 'npm' ? updateKeyLine(previous, 'cache', cacheDir)
    : manager === 'pip' ? updateIniGlobalKey(previous, 'cache-dir', cacheDir)
      : updateMavenLocalRepository(previous, cacheDir)
  await writeConfigFile(manager, next, encoding)
  // 存/回传的是未转义的原始路径（文件里那份可能是转义过的 XML 文本）。
  const config: PackageManagerConfig = {
    registry: parseRegistry(manager, next) || store.snapshot().packageConfigs[manager].registry,
    cacheDir
  }
  await store.setPackageConfig(manager, config)
  return { ...config, cacheDir, cacheDirFromFile: true, configFileExists: true }
}

export async function testPackageRegistry(manager: PackageManagerId, value: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!['npm', 'pip', 'maven'].includes(manager)) throw new Error('不支持的包管理器')
  const registry = validateRegistry(value)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  const startedAt = Date.now()
  try {
    const response = await net.fetch(registry, { headers: { Range: 'bytes=0-0', 'User-Agent': `EnvHub/${APP_VERSION}` }, signal: controller.signal })
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`)
    await response.body?.cancel()
    return { ok: true, latencyMs: Date.now() - startedAt }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}
