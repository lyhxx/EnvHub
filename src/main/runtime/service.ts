import { dialog } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, lstat, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RuntimeCatalogItem, RuntimeId, RuntimeInstallation } from '../../shared/contracts'
import { runtimeMeta } from '../../shared/runtimeMeta'
import { isAllowedDownloadHost } from '../../shared/downloadHosts'
import { isInstallableRuntime } from '../../shared/installable'
import { relativeExecutables, runtimeExecutables } from '../../shared/executables'
import { loadCatalog } from './catalog'
import { store } from '../storage/store'
import { effectivePathEntries, environmentRevision } from '../services/environment'
import { notifyRenderer } from '../services/notifications'

const exec = promisify(execFile)
export const runtimes = runtimeMeta

const commands: Record<RuntimeId, { exe: string; args: string[]; pattern: RegExp }[]> = {
  python: [{ exe: 'python.exe', args: ['--version'], pattern: /Python\s+([\d.]+)/i }, { exe: 'python3.exe', args: ['--version'], pattern: /Python\s+([\d.]+)/i }],
  node: [{ exe: 'node.exe', args: ['--version'], pattern: /v?([\d.]+)/ }],
  bun: [{ exe: 'bun.exe', args: ['--version'], pattern: /^v?([\d.]+)/m }],
  jdk: [{ exe: 'java.exe', args: ['-version'], pattern: /version\s+"?([\d._+]+)"?/i }],
  git: [{ exe: 'git.exe', args: ['--version'], pattern: /git version\s+([\w.+-]+)/i }],
  go: [{ exe: 'go.exe', args: ['version'], pattern: /go version go([^\s]+)/i }],
  rust: [{ exe: 'rustc.exe', args: ['--version'], pattern: /rustc\s+([^\s]+)/i }],
  dotnet: [{ exe: 'dotnet.exe', args: ['--version'], pattern: /^([\d.]+)/m }],
  php: [{ exe: 'php.exe', args: ['--version'], pattern: /PHP\s+([^\s]+)/i }],
  ruby: [{ exe: 'ruby.exe', args: ['--version'], pattern: /ruby\s+([^\s]+)/i }],
  maven: [],
  gradle: [],
  docker: [{ exe: 'docker.exe', args: ['--version'], pattern: /Docker version\s+([^,\s]+)/i }]
}

const scriptCommands: Partial<Record<RuntimeId, string>> = { maven: 'mvn.cmd', gradle: 'gradle.bat' }

// 寻找候选可执行文件时，需要同时考虑脚本类工具（mvn.cmd / gradle.bat）。
function executableNames(runtimeId: RuntimeId): string[] {
  return [...runtimeExecutables[runtimeId], ...(scriptCommands[runtimeId] ? [scriptCommands[runtimeId]!] : [])]
}

function normalizePath(value: string): string {
  return resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

async function runVersion(executablePath: string, runtimeId: RuntimeId): Promise<string | null> {
  const name = executablePath.split(/[\\/]/).pop()?.toLowerCase()
  if (runtimeId === 'maven' || runtimeId === 'gradle') {
    const homeName = basename(dirname(dirname(executablePath)))
    const expression = runtimeId === 'maven' ? /(?:apache-)?maven[-_]?([\d]+(?:\.[\d]+){1,2})/i : /gradle[-_]?([\d]+(?:\.[\d]+){1,2})/i
    return homeName.match(expression)?.[1] ?? '版本未知'
  }
  const command = commands[runtimeId].find((item) => item.exe.toLowerCase() === name)
  if (!command) return null
  try {
    const result = await exec(executablePath, command.args, { timeout: 8000, windowsHide: true, encoding: 'utf8' })
    const output = `${result.stdout}\n${result.stderr}`
    return output.match(command.pattern)?.[1] ?? null
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string }
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(command.pattern)?.[1] ?? null
  }
}

export async function probeRuntimeVersion(runtimeId: RuntimeId, executablePath: string): Promise<string | null> {
  return runVersion(executablePath, runtimeId)
}

async function javaKind(executablePath: string): Promise<'jdk' | 'jre'> {
  try {
    await access(join(dirname(executablePath), 'javac.exe'))
    return 'jdk'
  } catch {
    return 'jre'
  }
}

async function findCandidatesOnPath(runtimeId: RuntimeId, entries: string[]): Promise<string[]> {
  const names = executableNames(runtimeId)
  const found: string[] = []
  for (const entry of entries) {
    for (const name of names) {
      const candidate = join(entry, name)
      try {
        const info = await lstat(candidate)
        if (info.isFile()) found.push(candidate)
      } catch { /* not present in this directory */ }
    }
  }
  return found
}

async function commonCandidates(runtimeId: RuntimeId): Promise<string[]> {
  const candidates: string[] = []
  const local = process.env.LOCALAPPDATA ?? ''
  const user = process.env.USERPROFILE ?? ''
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const roots: string[] = []
  if (runtimeId === 'python') {
    roots.push(join(local, 'Programs', 'Python'), join(programFiles, 'Python'))
    try {
      const entries = await readdir(programFiles, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && /^python(?:\d|$)/i.test(entry.name)) candidates.push(join(programFiles, entry.name, 'python.exe'))
      }
    } catch { /* Program Files may be unavailable */ }
  }
  if (runtimeId === 'node') roots.push(join(programFiles, 'nodejs'), join(local, 'Programs', 'nodejs'))
  if (runtimeId === 'jdk') roots.push(join(programFiles, 'Java'), join(programFiles, 'Eclipse Adoptium'), join(programFiles, 'Microsoft'))
  if (runtimeId === 'git') roots.push(join(programFiles, 'Git', 'cmd'))
  if (runtimeId === 'go') roots.push('C:\\Go', join(programFiles, 'Go'))
  if (runtimeId === 'rust') roots.push(join(user, '.cargo', 'bin'))
  if (runtimeId === 'dotnet') roots.push(join(programFiles, 'dotnet'), join(process.env['ProgramFiles(x86)'] ?? programFiles, 'dotnet'))
  if (runtimeId === 'php') roots.push('C:\\PHP', join(programFiles, 'PHP'), join(local, 'Programs', 'PHP'))
  if (runtimeId === 'ruby') roots.push(join(local, 'Programs', 'Ruby'))
  if (runtimeId === 'maven') roots.push(join(programFiles, 'Apache', 'Maven'), join(programFiles, 'Apache Maven'), join(local, 'Programs', 'Maven'))
  if (runtimeId === 'gradle') roots.push(join(programFiles, 'Gradle'), join(local, 'Programs', 'Gradle'))
  if (runtimeId === 'docker') roots.push(join(programFiles, 'Docker', 'Docker', 'resources', 'bin'))
  if (runtimeId === 'bun') roots.push(join(local, 'bun', 'bin'), join(user, '.bun', 'bin'))

  // 有些环境把可执行文件直接放在根目录，有些放在带版本号的子目录里。
  const directInRoot = ['git', 'node', 'go', 'rust', 'dotnet', 'php', 'maven', 'gradle', 'docker', 'bun'].includes(runtimeId)
  for (const root of roots) {
    let directories: string[] = []
    try {
      const entries = await readdir(root, { withFileTypes: true })
      directories = entries.filter((item) => item.isDirectory()).map((item) => join(root, item.name))
      if (runtimeId === 'ruby') {
        directories = entries.filter((item) => item.isDirectory() && /^ruby/i.test(item.name)).map((item) => join(root, item.name))
      }
    } catch { /* directory is optional */ }
    const searchPaths = runtimeId === 'ruby' || !directInRoot ? directories : [root, ...directories]
    for (const path of searchPaths) {
      const candidate = join(path, relativeExecutables[runtimeId])
      try { await access(candidate); candidates.push(candidate) } catch { /* not a matching install */ }
    }
  }
  return candidates
}

async function findManagedExecutable(root: string, runtimeId: RuntimeId): Promise<string | null> {
  const names = executableNames(runtimeId)
  const tryPaths = async (base: string): Promise<string | null> => {
    for (const name of names) {
      const candidate = join(base, name)
      try {
        const info = await lstat(candidate)
        if (info.isFile()) return candidate
      } catch { /* not here */ }
    }
    return null
  }
  const direct = await tryPaths(root)
  if (direct) return direct
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = await tryPaths(join(root, entry.name))
    if (nested) return nested
  }
  return null
}

// 从磁盘上的托管目录恢复记录（例如数据目录切换、db 损坏后），依据 .envhub.json 标记。
// 只有 EnvHub 自己标记为"安装中"的目录才会被清理；没有标记的目录一律不动，避免误删用户数据。
async function recoverManagedFromRoot(root: string): Promise<{ recovered: RuntimeInstallation[]; cleaned: number; unmarked: number }> {
  const recovered: RuntimeInstallation[] = []
  let cleaned = 0
  let unmarked = 0
  for (const meta of runtimes) {
    const runtimeDir = join(root, 'runtimes', meta.id)
    const versions = await readdir(runtimeDir, { withFileTypes: true }).catch(() => [])
    for (const entry of versions) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const versionDir = join(runtimeDir, entry.name)
      const marker = await readInstallMarker(versionDir)
      if (marker === null) {
        // 没有标记：可能是 EnvHub 之外的内容，也不排除标记文件被同步工具跳过。
        // 只在目录为空时清理，其余保持原样并提示用户。
        const contents = await readdir(versionDir).catch(() => [])
        if (!contents.length) {
          await rm(versionDir, { recursive: true, force: true }).catch(() => undefined)
          cleaned += 1
        } else {
          unmarked += 1
        }
        continue
      }
      if (marker.state === 'installing') {
        await rm(versionDir, { recursive: true, force: true }).catch(() => undefined)
        cleaned += 1
        continue
      }
      const executablePath = await findManagedExecutable(versionDir, meta.id)
      if (!executablePath) continue
      if (recovered.some((item) => normalizePath(item.executablePath) === normalizePath(executablePath))) continue
      const version = await runVersion(executablePath, meta.id)
      recovered.push({
        id: randomUUID(), runtimeId: meta.id,
        ...(meta.id === 'jdk' ? { javaKind: await javaKind(executablePath) } : {}),
        version: version ?? entry.name, executablePath, managedDir: versionDir, source: 'managed',
        verified: Boolean(version) && version !== '版本未知', isDefault: false, isCurrent: false,
        detectedAt: new Date().toISOString()
      })
    }
  }
  return { recovered, cleaned, unmarked }
}

// 读取版本目录里的标记。旧版本写入的标记没有 state 字段，一律按"已完成"处理。
async function readInstallMarker(versionDir: string): Promise<{ state: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(join(versionDir, '.envhub.json'), 'utf8')) as { state?: unknown }
    return { state: typeof parsed.state === 'string' ? parsed.state : 'ready' }
  } catch {
    return null
  }
}

export async function scanRuntime(): Promise<RuntimeInstallation[]> {
  // 生效 PATH = 系统 PATH + 用户 PATH。全部基于它计算，进程内的旧 PATH 不参与。
  let effective = await effectivePathEntries()
  const revisionAtStart = environmentRevision()
  const found: RuntimeInstallation[] = []
  for (const meta of runtimes) {
    const pathCandidates = await findCandidatesOnPath(meta.id, effective)
    const allCandidates = [...pathCandidates, ...(await commonCandidates(meta.id))]
    const seen = new Set<string>()
    for (const executablePath of allCandidates) {
      const normalized = normalizePath(executablePath)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      const version = await runVersion(executablePath, meta.id)
      if (!version) continue
      found.push({
        id: `path-${Buffer.from(normalized).toString('base64url').slice(0, 16)}`,
        runtimeId: meta.id,
        ...(meta.id === 'jdk' ? { javaKind: await javaKind(executablePath) } : {}),
        version,
        executablePath,
        source: 'path',
        verified: version !== '版本未知',
        isDefault: false,
        detectedAt: new Date().toISOString()
      })
    }
  }

  const snapshot = store.snapshot()
  const recovered: RuntimeInstallation[] = []
  let cleanedLeftovers = 0
  let unmarkedLeftovers = 0
  const result = await recoverManagedFromRoot(snapshot.managedRoot)
  recovered.push(...result.recovered)
  cleanedLeftovers += result.cleaned
  unmarkedLeftovers += result.unmarked
  if (cleanedLeftovers) notifyRenderer(`已清理 ${cleanedLeftovers} 个中断的安装目录`)
  if (unmarkedLeftovers) notifyRenderer(`有 ${unmarkedLeftovers} 个版本目录缺少 EnvHub 标记，未做任何改动；如需清理请手动处理`)
  const existing = [...snapshot.installations.filter((item) => item.source === 'manual' || item.source === 'managed'), ...recovered]
  const merged = [...existing, ...found]
  const deduped = merged.filter((item, index) => merged.findIndex((other) => normalizePath(other.executablePath) === normalizePath(item.executablePath)) === index)
  const defaults = new Set(deduped.filter((item) => item.isDefault).map((item) => item.runtimeId))
  for (const item of deduped) {
    if (!defaults.has(item.runtimeId)) item.isDefault = item.source === 'managed' && ![...deduped].some((other) => other.runtimeId === item.runtimeId && other.isDefault)
  }
  const currentByRuntime = new Map<RuntimeId, string>()
  // 扫描期间如果用户改过环境变量（切换版本、清理遮蔽目录），必须重新取一次 PATH，
  // 否则这里写回的“当前使用”会覆盖掉刚生效的结果。
  if (environmentRevision() !== revisionAtStart) effective = await effectivePathEntries({ fresh: true })
  for (const meta of runtimes) {
    const current = await resolveCurrentExecutable(meta.id, effective)
    if (current) currentByRuntime.set(meta.id, normalizePath(current))
  }
  for (const item of deduped) {
    const currentPath = currentByRuntime.get(item.runtimeId)
    item.isCurrent = currentPath !== undefined && currentPath !== null && normalizePath(item.executablePath) === currentPath
  }
  // 扫描期间用户可能登记、安装或切换了版本：以扫描结果为底，把期间新增的记录并回来，
  // 并把「默认版本」以最新状态为准（否则整表写回会把用户刚做的操作抹掉）。
  const latest = store.snapshot().installations
  const scannedIds = new Set(deduped.map((item) => item.id))
  const addedDuringScan = latest.filter((item) => !scannedIds.has(item.id))
  const latestById = new Map(latest.map((item) => [item.id, item]))
  const merged2 = [...deduped, ...addedDuringScan].map((item) => {
    const latestItem = latestById.get(item.id)
    return latestItem ? { ...item, isDefault: latestItem.isDefault } : item
  })
  await store.setInstallations(merged2)
  return merged2
}

async function resolveCurrentExecutable(runtimeId: RuntimeId, entries: string[]): Promise<string | null> {
  const names = executableNames(runtimeId)
  if (!names.length) return null
  for (const entry of entries) {
    for (const name of names) {
      const candidate = join(entry, name)
      try {
        const info = await lstat(candidate)
        if (info.isFile()) return candidate
      } catch { /* keep scanning the effective PATH */ }
    }
  }
  return null
}

export async function refreshCurrentFlag(runtimeId: RuntimeId): Promise<void> {
  const current = await resolveCurrentExecutable(runtimeId, await effectivePathEntries())
  const currentPath = current ? normalizePath(current) : null
  const installations = store.snapshot().installations.map((item) =>
    item.runtimeId === runtimeId
      ? { ...item, isCurrent: currentPath !== null && normalizePath(item.executablePath) === currentPath }
      : item
  )
  await store.setInstallations(installations, false)
}

export async function adoptDetectedDirectories(runtimeId: RuntimeId, directories: string[]): Promise<number> {
  const names = executableNames(runtimeId)
  if (!names.length) return 0
  const installations = [...store.snapshot().installations]
  let added = 0
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      try {
        const info = await lstat(candidate)
        if (!info.isFile()) continue
      } catch { continue }
      if (installations.some((item) => normalizePath(item.executablePath) === normalizePath(candidate))) break
      const version = await runVersion(candidate, runtimeId)
      installations.push({
        id: randomUUID(), runtimeId,
        ...(runtimeId === 'jdk' ? { javaKind: await javaKind(candidate) } : {}),
        version: version ?? '版本未知', executablePath: candidate, source: 'manual',
        verified: Boolean(version) && version !== '版本未知', isDefault: false, isCurrent: false,
        detectedAt: new Date().toISOString()
      })
      added += 1
      break
    }
  }
  if (added) {
    // 逐个探测版本可能耗时较久，写回前把期间新增的记录并回来，避免覆盖用户的操作。
    const latest = store.snapshot().installations
    const known = new Set(installations.map((item) => item.id))
    await store.setInstallations([...installations, ...latest.filter((item) => !known.has(item.id))], false)
  }
  return added
}

export async function resolveCurrentFor(runtimeId: RuntimeId): Promise<{ path: string | null; entries: number }> {
  const entries = await effectivePathEntries()
  const current = await resolveCurrentExecutable(runtimeId, entries)
  return { path: current, entries: entries.length }
}

export async function refreshAllCurrentFlags(): Promise<void> {
  const entries = await effectivePathEntries()
  const installations = [...store.snapshot().installations]
  const cache = new Map<RuntimeId, string | null>()
  let changed = false
  for (const item of installations) {
    if (!cache.has(item.runtimeId)) {
      const current = await resolveCurrentExecutable(item.runtimeId, entries)
      cache.set(item.runtimeId, current ? normalizePath(current) : null)
    }
    const currentPath = cache.get(item.runtimeId) ?? null
    const next = currentPath !== null && normalizePath(item.executablePath) === currentPath
    if (item.isCurrent !== next) { item.isCurrent = next; changed = true }
  }
  if (changed) await store.setInstallations(installations, false)
}

export async function registerManual(runtimeId: RuntimeId): Promise<RuntimeInstallation | null> {
  const meta = runtimes.find((item) => item.id === runtimeId)!
  const result = await dialog.showOpenDialog({
    title: `选择 ${meta.name} 可执行文件`,
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: scriptCommands[runtimeId] ? ['exe', 'cmd', 'bat'] : ['exe'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const executablePath = result.filePaths[0]
  const selectedName = executablePath.split(/[\\/]/).pop()?.toLowerCase()
  const accepted = executableNames(runtimeId).some((name) => name.toLowerCase() === selectedName)
  if (!accepted) throw new Error(`选择的文件不是受支持的 ${meta.name} 可执行文件`)
  const version = await runVersion(executablePath, runtimeId)
  if (!version) throw new Error(`无法从该文件读取 ${meta.name} 版本`)
  const item: RuntimeInstallation = {
    id: randomUUID(), runtimeId, ...(runtimeId === 'jdk' ? { javaKind: await javaKind(executablePath) } : {}), version, executablePath, source: 'manual', verified: version !== '版本未知',
    isDefault: false, detectedAt: new Date().toISOString()
  }
  const installations = store.snapshot().installations.filter((other) => normalizePath(other.executablePath) !== normalizePath(executablePath))
  await store.setInstallations([...installations, item])
  return item
}

function windowsArch(): 'x64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

// 版本清单按环境分发到 runtime/catalog.ts，每个环境一个官方源实现。
export async function getCatalog(runtimeId: RuntimeId): Promise<RuntimeCatalogItem[]> {
  if (!runtimes.some((item) => item.id === runtimeId)) throw new Error('未知运行时')
  return loadCatalog(runtimeId, windowsArch())
}

export function validateProviderAsset(item: RuntimeCatalogItem): void {
  if (!item.downloadUrl) throw new Error('此版本需要前往官网手动下载')
  const url = new URL(item.downloadUrl)
  if (url.protocol !== 'https:') throw new Error('仅允许 HTTPS 下载')
  if (!isAllowedDownloadHost(item.runtimeId, item.downloadUrl)) throw new Error('下载域名不在该环境的允许列表中')
  if (item.installSupported && !item.checksum) throw new Error('应用内下载必须提供官方校验值')
  if (item.installSupported && !isInstallableRuntime(item.runtimeId)) throw new Error('该环境暂不支持应用内安装')
}

export async function assertCurrentCatalogItem(item: RuntimeCatalogItem): Promise<RuntimeCatalogItem> {
  const current = await getCatalog(item.runtimeId)
  const match = current.find((candidate) =>
    candidate.version === item.version &&
    candidate.downloadUrl === item.downloadUrl &&
    candidate.checksum?.value === item.checksum?.value &&
    candidate.checksum?.algorithm === item.checksum?.algorithm
  )
  if (!match) throw new Error('下载信息已变化，请刷新版本列表后重试')
  validateProviderAsset(match)
  return match
}
