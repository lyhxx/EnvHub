import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSnapshot, DownloadTask, FileChecksum, PackageManagerConfig, PackageManagerId, PathBackup, ProxySettings, RuntimeInstallation, ThemeMode } from '../../shared/contracts'
import { runtimeMeta } from '../../shared/runtimeMeta'

const initial: AppSnapshot = {
  schemaVersion: 1,
  theme: 'system',
  proxy: { mode: 'system', server: '' },
  packageConfigs: {
    npm: { registry: 'https://registry.npmjs.org/' },
    pip: { registry: 'https://pypi.org/simple' },
    maven: { registry: 'https://repo.maven.apache.org/maven2' }
  },
  managedRoot: join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'EnvHub'),
  installations: [],
  downloads: [],
  managedPaths: {},
  pathBackups: [],
  ignoredUpdateVersions: [],
  lastScanAt: null
}

const runtimeIds = new Set(runtimeMeta.map((item) => item.id))
const downloadStatuses = new Set(['queued', 'downloading', 'paused', 'completed', 'failed', 'cancelled'])
const checksumAlgorithms = new Set(['sha256', 'sha512', 'sha1'])

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据格式无效')
  return value as Record<string, unknown>
}

function safeFileName(value: unknown): string {
  if (typeof value !== 'string') return 'runtime-download.zip'
  const result = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120)
  return result || 'runtime-download.zip'
}

function normalizeSnapshot(value: unknown): AppSnapshot {
  const parsed = asObject(value)
  if (parsed.schemaVersion !== 1) throw new Error('不支持的数据版本')
  const theme: ThemeMode = ['light', 'dark', 'system'].includes(String(parsed.theme)) ? parsed.theme as ThemeMode : initial.theme
  const proxyRaw = parsed.proxy && typeof parsed.proxy === 'object' ? parsed.proxy as Record<string, unknown> : {}
  const proxy: ProxySettings = ['system', 'direct', 'manual'].includes(String(proxyRaw.mode)) && typeof proxyRaw.server === 'string' && proxyRaw.server.length <= 300
    ? { mode: proxyRaw.mode as ProxySettings['mode'], server: proxyRaw.server }
    : structuredClone(initial.proxy)
  const packageConfigRaw = parsed.packageConfigs && typeof parsed.packageConfigs === 'object' ? parsed.packageConfigs as Record<string, unknown> : {}
  const packageConfigs = { ...structuredClone(initial.packageConfigs) }
  for (const manager of ['npm', 'pip', 'maven'] as PackageManagerId[]) {
    const config = packageConfigRaw[manager]
    if (config && typeof config === 'object' && typeof (config as Record<string, unknown>).registry === 'string') {
      packageConfigs[manager] = { registry: ((config as Record<string, unknown>).registry as string).slice(0, 2048) }
    }
  }

  const installations = Array.isArray(parsed.installations) ? parsed.installations.flatMap((value) => {
    try {
      const item = asObject(value)
      if (typeof item.id !== 'string' || typeof item.runtimeId !== 'string' || !runtimeIds.has(item.runtimeId as never) ||
          typeof item.version !== 'string' || typeof item.executablePath !== 'string' ||
          !['path', 'manual', 'managed'].includes(String(item.source))) return []
      return [{
        id: item.id.slice(0, 100), runtimeId: item.runtimeId as RuntimeInstallation['runtimeId'],
        ...(item.javaKind === 'jdk' || item.javaKind === 'jre' ? { javaKind: item.javaKind as RuntimeInstallation['javaKind'] } : {}),
        ...(typeof item.managedDir === 'string' ? { managedDir: item.managedDir.slice(0, 2048) } : {}),
        version: item.version.slice(0, 100), executablePath: item.executablePath.slice(0, 2048),
        source: item.source as RuntimeInstallation['source'], verified: item.verified === true,
        isDefault: item.isDefault === true, isCurrent: item.isCurrent === true, detectedAt: typeof item.detectedAt === 'string' ? item.detectedAt.slice(0, 40) : new Date(0).toISOString()
      }]
    } catch { return [] }
  }) : []

  const managedRootRaw = parsed.managedRoot
  const managedRoot = typeof managedRootRaw === 'string' && /^[a-zA-Z]:[\\/]/.test(managedRootRaw) && !managedRootRaw.includes('..') && managedRootRaw.length <= 2048
    ? managedRootRaw.replace(/[\\/]+$/, '')
    : initial.managedRoot

  const downloads: DownloadTask[] = Array.isArray(parsed.downloads) ? parsed.downloads.flatMap((value) => {
    try {
      const item = asObject(value)
      const kind: DownloadTask['kind'] = item.kind === 'app' ? 'app' : 'runtime'
      if (typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id) ||
          typeof item.version !== 'string' || typeof item.url !== 'string' || !downloadStatuses.has(String(item.status))) return []
      if (kind === 'runtime' && (typeof item.runtimeId !== 'string' || !runtimeIds.has(item.runtimeId as never))) return []
      // 版本号会参与托管目录拼接（runtimes/<环境>/<版本>），先把带路径分隔符之类的奇怪值挡在门外。
      if (!/^[A-Za-z0-9][A-Za-z0-9.+_@-]{0,99}$/.test(item.version)) return []
      const fileName = safeFileName(item.fileName)
      const source = item.source === 'manual' ? 'manual' : 'internal'
      const receivedBytes = typeof item.receivedBytes === 'number' && Number.isFinite(item.receivedBytes) ? Math.max(0, item.receivedBytes) : 0
      const totalBytes = typeof item.totalBytes === 'number' && Number.isFinite(item.totalBytes) ? Math.max(0, item.totalBytes) : null
      const rawChecksum = item.checksum && typeof item.checksum === 'object' ? item.checksum as Record<string, unknown> : null
      const checksum: FileChecksum | undefined = rawChecksum && checksumAlgorithms.has(String(rawChecksum.algorithm)) && typeof rawChecksum.value === 'string' && /^[a-f0-9]{40,128}$/i.test(rawChecksum.value)
        ? { algorithm: String(rawChecksum.algorithm) as FileChecksum['algorithm'], value: rawChecksum.value.toLowerCase() }
        : undefined
      return [{
        id: item.id, kind, runtimeId: kind === 'runtime' ? item.runtimeId as DownloadTask['runtimeId'] : null,
        version: item.version.slice(0, 100),
        url: item.url.slice(0, 2048), fileName,
        // Never trust a persisted path; all task I/O is confined to EnvHub's managed download directory.
        filePath: join(managedRoot, 'downloads', `${item.id}-${fileName}`),
        status: item.status as DownloadTask['status'], receivedBytes, totalBytes,
        speedBytesPerSecond: 0, checksum,
        source, error: typeof item.error === 'string' ? item.error.slice(0, 500) : undefined,
        warning: typeof item.warning === 'string' ? item.warning.slice(0, 300) : undefined,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt.slice(0, 40) : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt.slice(0, 40) : new Date(0).toISOString()
      }]
    } catch { return [] }
  }) : []

  const managedPathsRaw = parsed.managedPaths && typeof parsed.managedPaths === 'object' ? parsed.managedPaths as Record<string, unknown> : {}
  const managedPaths: Partial<Record<RuntimeInstallation['runtimeId'], string>> = {}
  for (const [runtimeId, directory] of Object.entries(managedPathsRaw)) {
    if (runtimeIds.has(runtimeId as never) && typeof directory === 'string' && directory.length <= 2048) {
      managedPaths[runtimeId as RuntimeInstallation['runtimeId']] = directory
    }
  }
  const ignoredUpdateVersions = Array.isArray(parsed.ignoredUpdateVersions)
    ? parsed.ignoredUpdateVersions.flatMap((value) => (typeof value === 'string' && /^\d[\w.+-]{0,39}$/.test(value) ? [value] : [])).slice(-20)
    : []
  const pathBackups = Array.isArray(parsed.pathBackups) ? parsed.pathBackups.flatMap((value) => {
    try {
      const item = asObject(value)
      if (typeof item.previousPath !== 'string' || typeof item.appliedPath !== 'string') return []
      return [{
        at: typeof item.at === 'string' ? item.at.slice(0, 40) : new Date(0).toISOString(),
        previousPath: item.previousPath.slice(0, 32767), appliedPath: item.appliedPath.slice(0, 32767),
        previousJavaHome: typeof item.previousJavaHome === 'string' ? item.previousJavaHome.slice(0, 2048) : undefined,
        appliedJavaHome: typeof item.appliedJavaHome === 'string' ? item.appliedJavaHome.slice(0, 2048) : undefined,
        previousMachinePath: typeof item.previousMachinePath === 'string' ? item.previousMachinePath.slice(0, 32767) : undefined,
        appliedMachinePath: typeof item.appliedMachinePath === 'string' ? item.appliedMachinePath.slice(0, 32767) : undefined
      }]
    } catch { return [] }
  }).slice(-10) : []

  return {
    ...structuredClone(initial), theme, proxy, packageConfigs, installations, downloads,
    managedPaths, pathBackups, managedRoot, ignoredUpdateVersions,
    ...(typeof parsed.previousManagedRoot === 'string' && /^[a-zA-Z]:[\\/]/.test(parsed.previousManagedRoot) && !parsed.previousManagedRoot.includes('..')
      ? { previousManagedRoot: parsed.previousManagedRoot.replace(/[\\/]+$/, '').slice(0, 2048) }
      : {}),
    lastScanAt: typeof parsed.lastScanAt === 'string' ? parsed.lastScanAt.slice(0, 40) : null
  }
}

export class JsonStore {
  private data: AppSnapshot = structuredClone(initial)
  private readonly filePath = join(app.getPath('userData'), 'db.json')
  private writeQueue: Promise<void> = Promise.resolve()
  private preserveBackupOnNextWrite = false
  // 上一次成功写出的完整内容（含加载时的规范化结果），备份只从这里取。
  private backupSource: string | null = null
  private listeners = new Set<(snapshot: AppSnapshot) => void>()

  // 唯一的变更出口：任何写入完成后通知订阅者（主进程据此向界面广播）。
  onChange(listener: (snapshot: AppSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChange(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch { /* 订阅者异常不影响存储 */ }
    }
  }

  async load(): Promise<AppSnapshot> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const readJson = async (path: string): Promise<unknown> => {
      const text = await readFile(path, 'utf8')
      return JSON.parse(text.replace(/^\uFEFF/, ''))
    }
    try {
      this.data = normalizeSnapshot(await readJson(this.filePath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.preserveBackupOnNextWrite = true
        // 先把损坏的文件改名留档，再回退到备份：否则接下来的写盘会把它覆盖掉，事后无从诊断。
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await rename(this.filePath, `${this.filePath}.corrupt-${stamp}`).catch(() => undefined)
        try {
          this.data = normalizeSnapshot(await readJson(`${this.filePath}.bak`))
        } catch {
          // 备份也不可用时从默认值开始；损坏文件与备份都保留在磁盘上。
        }
      }
    }
    await this.persist()
    return this.snapshot()
  }

  snapshot(): AppSnapshot {
    return structuredClone(this.data)
  }

  async setTheme(theme: ThemeMode): Promise<void> {
    this.data.theme = theme
    await this.persist()
  }

  async setProxy(proxy: ProxySettings): Promise<void> {
    this.data.proxy = proxy
    await this.persist()
  }

  async setPackageConfig(manager: PackageManagerId, config: PackageManagerConfig): Promise<void> {
    this.data.packageConfigs[manager] = config
    await this.persist()
  }

  async setManagedRoot(root: string, previousRoot?: string): Promise<void> {
    if (previousRoot) this.data.previousManagedRoot = previousRoot
    this.data.managedRoot = root
    await this.persist()
  }

  async setInstallations(installations: RuntimeInstallation[], touchScanTime = true): Promise<void> {
    this.data.installations = installations
    if (touchScanTime) this.data.lastScanAt = new Date().toISOString()
    await this.persist()
  }

  async upsertDownload(task: DownloadTask): Promise<void> {
    const index = this.data.downloads.findIndex((item) => item.id === task.id)
    if (index < 0) this.data.downloads.unshift(task)
    else this.data.downloads[index] = task
    const active = this.data.downloads.filter((item) => ['queued', 'downloading', 'paused'].includes(item.status))
    const finished = this.data.downloads.filter((item) => !['queued', 'downloading', 'paused'].includes(item.status))
    this.data.downloads = [...active, ...finished.slice(0, Math.max(0, 30 - active.length))]
    await this.persist()
  }

  async removeManual(id: string): Promise<void> {
    this.data.installations = this.data.installations.filter((item) => item.id !== id || item.source !== 'manual')
    await this.persist()
  }

  async removeInstallation(id: string): Promise<void> {
    this.data.installations = this.data.installations.filter((item) => item.id !== id)
    await this.persist()
  }

  // 用户点过「忽略此版本」的版本号；用数组而不是单个字段，避免某个版本被撤回后 latest 回退又提示一遍。
  async ignoreUpdateVersion(version: string): Promise<void> {
    if (!this.data.ignoredUpdateVersions.includes(version)) this.data.ignoredUpdateVersions.push(version)
    this.data.ignoredUpdateVersions = this.data.ignoredUpdateVersions.slice(-20)
    await this.persist()
  }

  async restoreUpdateVersions(): Promise<void> {
    this.data.ignoredUpdateVersions = []
    await this.persist()
  }

  // 数据目录迁移后一次性改写任务路径（保留 active/finished 的收纳规则）。
  async setDownloads(downloads: DownloadTask[]): Promise<void> {
    const active = downloads.filter((item) => ['queued', 'downloading', 'paused'].includes(item.status))
    const finished = downloads.filter((item) => !['queued', 'downloading', 'paused'].includes(item.status))
    this.data.downloads = [...active, ...finished.slice(0, Math.max(0, 30 - active.length))]
    await this.persist()
  }

  // 数据目录迁移后改写备份里的路径，避免撤销时把已搬走的旧目录写回 PATH。
  async setPathBackups(backups: PathBackup[]): Promise<void> {
    this.data.pathBackups = backups.slice(-10)
    await this.persist()
  }

  async activate(id: string): Promise<void> {
    const selected = this.data.installations.find((item) => item.id === id)
    if (!selected) throw new Error('找不到该环境记录')
    if (selected.runtimeId === 'jdk' && selected.javaKind === 'jre') throw new Error('JRE 不包含编译器，不能设为默认 JDK')
    this.data.installations = this.data.installations.map((item) =>
      item.runtimeId === selected.runtimeId ? { ...item, isDefault: item.id === id, isCurrent: item.id === id } : item
    )
    await this.persist()
  }

  async removeDownload(id: string): Promise<DownloadTask | null> {
    const task = this.data.downloads.find((item) => item.id === id) ?? null
    this.data.downloads = this.data.downloads.filter((item) => item.id !== id)
    await this.persist()
    return task
  }

  async setManagedPath(runtimeId: RuntimeInstallation['runtimeId'], directory: string, backup: PathBackup): Promise<void> {
    this.data.managedPaths[runtimeId] = directory
    this.data.pathBackups = [...this.data.pathBackups, backup].slice(-10)
    await this.persist()
  }

  async clearManagedPath(runtimeId: RuntimeInstallation['runtimeId']): Promise<void> {
    delete this.data.managedPaths[runtimeId]
    await this.persist()
  }

  async pushPathBackup(backup: PathBackup): Promise<void> {
    this.data.pathBackups = [...this.data.pathBackups, backup].slice(-10)
    await this.persist()
  }

  async popPathBackup(): Promise<PathBackup | null> {
    const backup = this.data.pathBackups.at(-1) ?? null
    if (!backup) return null
    this.data.pathBackups = this.data.pathBackups.slice(0, -1)
    await this.persist()
    return backup
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.tmp`
    const backup = `${this.filePath}.bak`
    const content = `${JSON.stringify(this.data, null, 2)}\n`
    const write = async (): Promise<void> => {
      // 备份只写"上一次由本进程成功写出的内容"，不再复制磁盘上的 db.json：
      // 否则运行期被外部写坏的文件会被当成健康内容覆盖掉真正的备份。
      if (!this.preserveBackupOnNextWrite && this.backupSource !== null) {
        try { await writeFile(backup, this.backupSource) } catch { /* 备份失败不影响主写入 */ }
      }
      this.preserveBackupOnNextWrite = false
      await writeFile(temporary, content, 'utf8')
      await rename(temporary, this.filePath)
      this.backupSource = content
    }
    this.writeQueue = this.writeQueue.then(write, write)
    await this.writeQueue
    this.emitChange()
  }
}

export const store = new JsonStore()
