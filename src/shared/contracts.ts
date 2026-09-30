export type RuntimeId = 'python' | 'node' | 'jdk' | 'git' | 'go' | 'rust' | 'dotnet' | 'php' | 'ruby' | 'maven' | 'gradle' | 'docker' | 'bun'
export type PackageManagerId = 'npm' | 'pip' | 'maven'
export type ThemeMode = 'light' | 'dark' | 'system'
export type ProxyMode = 'system' | 'direct' | 'manual'
export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'

// 官方发布方提供的校验值算法各不相同（Go / Gradle 给 SHA-256，Apache 给 SHA-512）。
export type ChecksumAlgorithm = 'sha256' | 'sha512' | 'sha1'

export interface FileChecksum {
  algorithm: ChecksumAlgorithm
  value: string
}

export interface RuntimeMeta {
  id: RuntimeId
  name: string
  shortName: string
  glyph: string
  subtitle: string
  description: string
  color: string
  officialUrl: string
  relatedTools?: string[]
  group: 'runtime' | 'toolchain' | 'container'
}

export interface PackageManagerConfig {
  registry: string
  cacheDir?: string
  cacheDirFromFile?: boolean
  // 配置文件是否真的存在于本机：不存在时界面不展示默认值，避免把"默认约定"显示成"已配置"。
  configFileExists?: boolean
}

export interface PathBackup {
  at: string
  previousPath: string
  appliedPath: string
  previousJavaHome?: string
  appliedJavaHome?: string
  previousMachinePath?: string
  appliedMachinePath?: string
}

export interface RuntimeInstallation {
  id: string
  runtimeId: RuntimeId
  javaKind?: 'jdk' | 'jre'
  version: string
  executablePath: string
  managedDir?: string
  source: 'path' | 'manual' | 'managed'
  verified: boolean
  isDefault: boolean
  isCurrent?: boolean
  detectedAt: string
}

export interface RuntimeCatalogItem {
  runtimeId: RuntimeId
  version: string
  architecture: 'x64' | 'arm64' | 'universal'
  downloadUrl?: string
  checksum?: FileChecksum
  fileName?: string
  pageUrl: string
  installSupported: boolean
  note?: string
}

// 下载任务分两类：运行时的归档（解压后安装），以及 EnvHub 自身的更新包（交给用户手动安装）。
export type DownloadKind = 'runtime' | 'app'
export type AppRunForm = 'installer' | 'portable' | 'zip'

export interface DownloadTask {
  id: string
  kind: DownloadKind
  runtimeId: RuntimeId | null
  version: string
  url: string
  fileName: string
  filePath: string
  status: DownloadStatus
  receivedBytes: number
  totalBytes: number | null
  speedBytesPerSecond: number
  checksum?: FileChecksum
  source?: 'internal' | 'manual'
  error?: string
  warning?: string
  createdAt: string
  updatedAt: string
}

export interface ProxySettings {
  mode: ProxyMode
  server: string
}

export interface ProxyStatus {
  settings: ProxySettings
  resolution: string
  reachable?: boolean
  latencyMs?: number
  testError?: string
}

export interface AppSnapshot {
  schemaVersion: number
  theme: ThemeMode
  proxy: ProxySettings
  packageConfigs: Record<PackageManagerId, PackageManagerConfig>
  managedRoot: string
  previousManagedRoot?: string
  installations: RuntimeInstallation[]
  downloads: DownloadTask[]
  managedPaths: Partial<Record<RuntimeId, string>>
  pathBackups: PathBackup[]
  ignoredUpdateVersions: string[]
  lastScanAt: string | null
}

export interface AppUpdateAsset {
  name: string
  url: string
  size: number
  checksum?: FileChecksum
}

export interface AppUpdateInfo {
  currentVersion: string
  latestVersion: string
  releaseName: string
  releaseUrl: string
  publishedAt: string
  notes: string[]
  form: AppRunForm
  asset: AppUpdateAsset | null
  // 与当前使用形态匹配的产物存在、但缺少官方校验值时的说明；有它就说明「应用内下载」不可用。
  blockedReason?: string
  ignored: boolean
}

export interface AppUpdateState {
  state: 'idle' | 'latest' | 'available' | 'failed'
  info?: AppUpdateInfo
  error?: string
  checkedAt: string | null
}

export interface EnvHubApi {
  app: {
    getSnapshot(): Promise<AppSnapshot>
    setTheme(theme: ThemeMode): Promise<void>
    openExternal(url: string): Promise<void>
    copyText(text: string): Promise<void>
    chooseManagedRoot(): Promise<string | null>
    setManagedRoot(path: string, moveExisting: boolean): Promise<{ root: string; moved: boolean; rewritten: number; cleanedPathEntries: number; clearedDownloads: number }>
  }
  runtime: {
    scan(): Promise<RuntimeInstallation[]>
    registerManual(runtimeId: RuntimeId): Promise<RuntimeInstallation | null>
    removeManual(id: string): Promise<void>
    catalog(runtimeId: RuntimeId): Promise<RuntimeCatalogItem[]>
    copyLink(runtimeId: RuntimeId, version: string): Promise<void>
    openDownloadLink(runtimeId: RuntimeId, version: string): Promise<void>
    activate(id: string): Promise<{ directory: string; changed: boolean; javaHome?: string; shadowedBy?: string[]; cleaned?: number }>
    takeOverPriority(id: string): Promise<{ removed: string[] }>
    install(downloadId: string, activate: boolean): Promise<RuntimeInstallation>
    uninstall(id: string): Promise<void>
    refreshCurrent(runtimeId?: RuntimeId): Promise<void>
    resolveCurrent(runtimeId: RuntimeId): Promise<{ path: string | null; entries: number }>
  }
  download: {
    start(runtimeId: RuntimeId, version: string): Promise<DownloadTask>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    cancel(id: string): Promise<void>
    remove(id: string, deleteFile: boolean): Promise<void>
    importFile(runtimeId: RuntimeId, version: string): Promise<DownloadTask | null>
    getDirectory(): Promise<void>
    onUpdate(callback: (task: DownloadTask) => void): () => void
  }
  network: {
    getProxyStatus(): Promise<ProxyStatus>
    setProxy(settings: ProxySettings): Promise<ProxyStatus>
    testProxy(): Promise<ProxyStatus>
  }
  packages: {
    getConfig(manager: PackageManagerId): Promise<PackageManagerConfig>
    setRegistry(manager: PackageManagerId, registry: string): Promise<PackageManagerConfig>
    setCacheDir(manager: PackageManagerId, cacheDir: string): Promise<PackageManagerConfig>
    testRegistry(manager: PackageManagerId, registry: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>
    undoLastPathChange(): Promise<boolean>
    repairPath(): Promise<{ removed: number; remaining: number }>
  }
  privileged: {
    status(): Promise<{ enabled: boolean }>
    enable(): Promise<void>
    disable(): Promise<void>
  }
  update: {
    check(force: boolean): Promise<AppUpdateState>
    download(): Promise<DownloadTask>
    install(downloadId: string): Promise<{ mode: 'installer' | 'folder' }>
    openRelease(): Promise<void>
    ignore(version: string): Promise<void>
    restore(): Promise<void>
  }
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  onNotice(callback: (message: string) => void): () => void
  onOperationProgress(callback: (payload: { percent: number; detail: string }) => void): () => void
}
