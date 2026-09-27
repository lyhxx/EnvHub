import { dialog, net } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, lstat, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RuntimeCatalogItem, RuntimeId, RuntimeInstallation } from '../../shared/contracts'
import { runtimeMeta } from '../../shared/runtimeMeta'
import { store } from '../storage/store'
import { effectivePathEntries } from '../services/environment'
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
  const names = [...commands[runtimeId].map((command) => command.exe), ...(scriptCommands[runtimeId] ? [scriptCommands[runtimeId]!] : [])]
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
  if (runtimeId === 'ruby') roots.push(programFiles, join(local, 'Programs', 'Ruby'))
  if (runtimeId === 'maven') roots.push(join(programFiles, 'Apache', 'Maven'), join(programFiles, 'Apache Maven'), join(local, 'Programs', 'Maven'))
  if (runtimeId === 'gradle') roots.push(join(programFiles, 'Gradle'), join(local, 'Programs', 'Gradle'))
  if (runtimeId === 'docker') roots.push(join(programFiles, 'Docker', 'Docker', 'resources', 'bin'))
  if (runtimeId === 'bun') roots.push(join(local, 'bun', 'bin'), join(user, '.bun', 'bin'))
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      const paths = entries.filter((item) => item.isDirectory()).map((item) => join(root, item.name))
      if (['git', 'node', 'rust', 'dotnet', 'php', 'maven', 'gradle', 'docker', 'bun'].includes(runtimeId)) paths.unshift(root)
      if (runtimeId === 'go') paths.splice(0, paths.length, root)
      if (runtimeId === 'ruby') paths.splice(0, paths.length, ...entries.filter((item) => item.isDirectory() && /^ruby/i.test(item.name)).map((item) => join(root, item.name)))
      for (const path of paths) {
        const candidate = runtimeId === 'jdk' ? join(path, 'bin', 'java.exe')
          : runtimeId === 'git' ? join(path, 'git.exe')
            : runtimeId === 'go' ? join(path, 'bin', 'go.exe')
              : runtimeId === 'ruby' ? join(path, 'bin', 'ruby.exe')
                : runtimeId === 'maven' ? join(path, 'bin', 'mvn.cmd')
                  : runtimeId === 'gradle' ? join(path, 'bin', 'gradle.bat')
                    : runtimeId === 'docker' ? join(path, 'docker.exe')
                      : join(path, runtimeId === 'python' ? 'python.exe' : runtimeId === 'node' ? 'node.exe' : runtimeId === 'rust' ? 'rustc.exe' : runtimeId === 'dotnet' ? 'dotnet.exe' : runtimeId === 'php' ? 'php.exe' : runtimeId === 'bun' ? 'bun.exe' : 'python.exe')
        try { await access(candidate); candidates.push(candidate) } catch { /* not a matching install */ }
      }
    } catch { /* directory is optional */ }
  }
  return candidates
}

async function findManagedExecutable(root: string, runtimeId: RuntimeId): Promise<string | null> {
  const names = [...commands[runtimeId].map((command) => command.exe), ...(scriptCommands[runtimeId] ? [scriptCommands[runtimeId]!] : [])]
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
// 没有标记的版本目录视为"上次安装中断的残留"，直接清理，避免留下半成品。
async function recoverManagedFromRoot(root: string): Promise<{ recovered: RuntimeInstallation[]; cleaned: number }> {
  const recovered: RuntimeInstallation[] = []
  let cleaned = 0
  for (const meta of runtimes) {
    const runtimeDir = join(root, 'runtimes', meta.id)
    const versions = await readdir(runtimeDir, { withFileTypes: true }).catch(() => [])
    for (const entry of versions) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const versionDir = join(runtimeDir, entry.name)
      let hasMarker = false
      try { await access(join(versionDir, '.envhub.json')); hasMarker = true } catch { /* 无标记 */ }
      if (!hasMarker) {
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
  return { recovered, cleaned }
}

export async function scanRuntime(): Promise<RuntimeInstallation[]> {
  // 生效 PATH = 系统 PATH + 用户 PATH。全部基于它计算，进程内的旧 PATH 不参与。
  const effective = await effectivePathEntries()
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
  for (const root of [snapshot.managedRoot, snapshot.previousManagedRoot]) {
    if (!root) continue
    const result = await recoverManagedFromRoot(root)
    recovered.push(...result.recovered)
    cleanedLeftovers += result.cleaned
  }
  if (cleanedLeftovers) notifyRenderer(`已清理 ${cleanedLeftovers} 个上次中断留下的未完成目录`)
  const existing = [...snapshot.installations.filter((item) => item.source === 'manual' || item.source === 'managed'), ...recovered]
  const merged = [...existing, ...found]
  const deduped = merged.filter((item, index) => merged.findIndex((other) => normalizePath(other.executablePath) === normalizePath(item.executablePath)) === index)
  const defaults = new Set(deduped.filter((item) => item.isDefault).map((item) => item.runtimeId))
  for (const item of deduped) {
    if (!defaults.has(item.runtimeId)) item.isDefault = item.source === 'managed' && ![...deduped].some((other) => other.runtimeId === item.runtimeId && other.isDefault)
  }
  const currentByRuntime = new Map<RuntimeId, string>()
  for (const meta of runtimes) {
    const current = await resolveCurrentExecutable(meta.id, effective)
    if (current) currentByRuntime.set(meta.id, normalizePath(current))
  }
  for (const item of deduped) {
    const currentPath = currentByRuntime.get(item.runtimeId)
    item.isCurrent = currentPath !== undefined && currentPath !== null && normalizePath(item.executablePath) === currentPath
  }
  await store.setInstallations(deduped)
  return deduped
}

async function resolveCurrentExecutable(runtimeId: RuntimeId, entries: string[]): Promise<string | null> {
  const names = [...commands[runtimeId].map((command) => command.exe), ...(scriptCommands[runtimeId] ? [scriptCommands[runtimeId]!] : [])]
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
  const names = [...commands[runtimeId].map((command) => command.exe), ...(scriptCommands[runtimeId] ? [scriptCommands[runtimeId]!] : [])]
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
  if (added) await store.setInstallations(installations, false)
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
  const accepted = commands[runtimeId].some((item) => item.exe.toLowerCase() === selectedName) || scriptCommands[runtimeId]?.toLowerCase() === selectedName
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

async function fetchJson(url: string, allowedHost: string): Promise<unknown> {
  const response = await net.fetch(url, { headers: { 'User-Agent': 'EnvHub/0.1' } })
  if (response.url && new URL(response.url).hostname.toLowerCase() !== allowedHost) throw new Error('版本源重定向到了非预期域名')
  if (!response.ok) throw new Error(`版本源请求失败：HTTP ${response.status}`)
  return response.json()
}

function windowsArch(): 'x64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

export async function getCatalog(runtimeId: RuntimeId): Promise<RuntimeCatalogItem[]> {
  const meta = runtimes.find((item) => item.id === runtimeId)
  if (!meta) throw new Error('未知运行时')
  const architecture = windowsArch()
  if (runtimeId === 'node') {
    const releases = await fetchJson('https://nodejs.org/dist/index.json', 'nodejs.org') as { version: string; lts: string | false }[]
    const release = releases.find((item) => Boolean(item.lts))
    if (!release) throw new Error('暂时无法获取 Node.js LTS 版本')
    const version = release.version.replace(/^v/, '')
    const fileName = `node-v${version}-win-${architecture}.zip`
    const base = `https://nodejs.org/dist/v${version}`
    const checksumResponse = await net.fetch(`${base}/SHASUMS256.txt`)
    if (!checksumResponse.ok) throw new Error('Node.js 校验清单暂不可用')
    if (checksumResponse.url && new URL(checksumResponse.url).hostname.toLowerCase() !== 'nodejs.org') throw new Error('Node.js 校验清单重定向到了非预期域名')
    const checksums = await checksumResponse.text()
    const checksum = checksums.split(/\r?\n/).find((line) => line.endsWith(`  ${fileName}`))?.split(/\s+/)[0]
    return [{ runtimeId, version, architecture, downloadUrl: `${base}/${fileName}`, checksumUrl: `${base}/SHASUMS256.txt`, sha256: checksum, fileName, pageUrl: meta.officialUrl, installSupported: Boolean(checksum), note: checksum ? '官方 LTS ZIP；下载后会校验 SHA-256。当前版本仅提供归档下载。' : '官方校验值未找到，暂不允许应用内下载。' }]
  }
  if (runtimeId === 'jdk') {
    const majors = [25, 21, 17]
    const assets: (RuntimeCatalogItem | null)[] = await Promise.all(majors.map(async (major) => {
      try {
        const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${architecture}&image_type=jdk&os=windows&vendor=eclipse`
        const data = await fetchJson(url, 'api.adoptium.net') as { binary?: { package?: { link?: string; checksum?: string; name?: string } }; version_data?: { semver?: string } }[]
        const release = data[0]
        const pkg = release?.binary?.package
        if (!pkg?.link || !pkg.checksum) return null
        const fileName = pkg.name ?? new URL(pkg.link).pathname.split('/').pop() ?? `jdk-${major}.zip`
        return { runtimeId, version: release.version_data?.semver ?? String(major), architecture, downloadUrl: pkg.link, sha256: pkg.checksum, fileName, pageUrl: meta.officialUrl, installSupported: true, note: 'Eclipse Temurin JDK ZIP；下载后会校验 SHA-256。安装流程尚未启用。' } satisfies RuntimeCatalogItem
      } catch {
        return null
      }
    }))
    return assets.filter((item): item is RuntimeCatalogItem => item !== null)
  }
  return [{ runtimeId, version: '官网版本', architecture, pageUrl: meta.officialUrl, installSupported: false, note: '请前往官方页面获取版本；自动下载与安装流程尚未接入。' }]
}

export function validateProviderAsset(item: RuntimeCatalogItem): void {
  if (!item.downloadUrl) throw new Error('此版本需要前往官网手动下载')
  const url = new URL(item.downloadUrl)
  if (url.protocol !== 'https:') throw new Error('仅允许 HTTPS 下载')
  const hosts: Record<RuntimeId, string[]> = {
    node: ['nodejs.org'], jdk: ['api.adoptium.net', 'github.com', 'objects.githubusercontent.com'],
    python: ['python.org', 'www.python.org'], git: ['git-scm.com', 'github.com', 'objects.githubusercontent.com'],
    go: ['go.dev', 'golang.org'], rust: ['rust-lang.org', 'static.rust-lang.org', 'github.com'],
    dotnet: ['dotnet.microsoft.com', 'download.visualstudio.microsoft.com'], php: ['windows.php.net', 'php.net'],
    ruby: ['rubyinstaller.org', 'ruby-lang.org'], maven: ['maven.apache.org', 'downloads.apache.org', 'dlcdn.apache.org'],
    gradle: ['gradle.org', 'services.gradle.org'], docker: ['docker.com', 'docs.docker.com'],
    bun: ['bun.sh', 'github.com', 'objects.githubusercontent.com']
  }
  if (!hosts[item.runtimeId].includes(url.hostname.toLowerCase())) throw new Error('下载域名不在该 Provider 的允许列表中')
  if (item.runtimeId === 'jdk' && !item.sha256) throw new Error('JDK 下载必须具有 SHA-256 校验值')
  if (item.runtimeId === 'node' && !item.sha256) throw new Error('Node.js 下载必须具有 SHA-256 校验值')
}

export async function assertCurrentCatalogItem(item: RuntimeCatalogItem): Promise<RuntimeCatalogItem> {
  const current = await getCatalog(item.runtimeId)
  const match = current.find((candidate) => candidate.version === item.version && candidate.downloadUrl === item.downloadUrl && candidate.sha256 === item.sha256)
  if (!match) throw new Error('下载信息已变化，请刷新版本列表后重试')
  validateProviderAsset(match)
  return match
}
