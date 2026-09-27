import { BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PackageManagerId, RuntimeId, ThemeMode } from '../shared/contracts'
import { store } from './storage/store'
import { adoptDetectedDirectories, assertCurrentCatalogItem, getCatalog, refreshAllCurrentFlags, refreshCurrentFlag, registerManual, resolveCurrentFor, runtimes, scanRuntime } from './runtime/service'
import { cancelDownload, importDownloadedFile, openDownloadDirectory, pauseDownload, removeDownload, resumeDownload, startDownload } from './services/downloads'
import { applyProxy, getProxyStatus, testProxyConnection } from './services/network'
import { getPackageConfig, setPackageCacheDir, setPackageRegistry, testPackageRegistry } from './services/packages'
import { applyDefaultVersion, disablePrivilegedHelper, enablePrivilegedHelper, privilegedHelperStatus, repairUserPath, takeOverMachinePriority, undoLastPathChange } from './services/environment'
import { changeManagedRoot } from './services/storage'
import { installDownloadedRuntime, uninstallManagedRuntime } from './services/install'

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('仅允许主窗口页面发起调用')
  const frameUrl = event.senderFrame?.url ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try { if (new URL(frameUrl).origin === new URL(devUrl).origin) return } catch { /* invalid sender URL */ }
  }
  if (!devUrl && frameUrl.split(/[?#]/)[0] === pathToFileURL(join(__dirname, '../renderer/index.html')).href) return
  throw new Error('拒绝来自非 EnvHub 页面发起的调用')
}

function register(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event)
    return handler(event, ...args)
  })
}

function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === 'string' && runtimes.some((item) => item.id === value)
}

async function resolveCatalogItem(runtimeId: unknown, version: unknown) {
  if (!isRuntimeId(runtimeId)) throw new Error('无效的运行时')
  if (typeof version !== 'string' || version.length === 0 || version.length > 100) throw new Error('无效的版本号')
  const catalog = await getCatalog(runtimeId)
  const item = catalog.find((entry) => entry.version === version)
  if (!item) throw new Error('版本信息已变化，请刷新版本列表后重试')
  return item
}

function broadcastSnapshot(): void {
  const snapshot = store.snapshot()
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('app:snapshot', snapshot)
}

export function registerIpc(): void {
  register('app:get-snapshot', () => store.snapshot())
  register('app:set-theme', async (_event, theme: ThemeMode) => {
    if (!['light', 'dark', 'system'].includes(theme)) throw new Error('无效的主题设置')
    nativeTheme.themeSource = theme
    const dark = nativeTheme.shouldUseDarkColors
    const color = dark ? '#171c19' : '#f4f5f2'
    for (const window of BrowserWindow.getAllWindows()) {
      window.setBackgroundColor(color)
      window.setTitleBarOverlay({ color, symbolColor: dark ? '#dce5de' : '#344139', height: 40 })
    }
    await store.setTheme(theme)
  })
  register('app:open-external', async (_event, url: string) => {
    const parsed = new URL(url)
    const allowed = new Set(runtimes.map((runtime) => new URL(runtime.officialUrl).hostname.toLowerCase()))
    if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname.toLowerCase())) throw new Error('链接不在官方站点允许列表中')
    await shell.openExternal(parsed.toString())
  })
  register('app:copy-text', (_event, text: string) => {
    if (typeof text !== 'string' || text.length > 4096) throw new Error('无效的复制内容')
    clipboard.writeText(text)
  })
  register('app:copy-link', async (_event, runtimeId: RuntimeId, version: string) => {
    const candidate = await resolveCatalogItem(runtimeId, version)
    const link = candidate.downloadUrl ?? candidate.pageUrl
    if (!link) throw new Error('没有可复制的官方链接')
    if (candidate.downloadUrl) await assertCurrentCatalogItem(candidate)
    clipboard.writeText(link)
  })
  register('runtime:open-download-link', async (_event, runtimeId: RuntimeId, version: string) => {
    const candidate = await resolveCatalogItem(runtimeId, version)
    if (candidate.downloadUrl) await assertCurrentCatalogItem(candidate)
    const link = candidate.downloadUrl ?? candidate.pageUrl
    if (new URL(link).protocol !== 'https:') throw new Error('仅允许 HTTPS 官方下载链接')
    await shell.openExternal(link)
  })

  register('runtime:scan', async () => {
    const items = await scanRuntime()
    return items
  })
  register('runtime:register-manual', async (_event, runtimeId: RuntimeId) => {
    if (!isRuntimeId(runtimeId)) throw new Error('无效的运行时')
    const item = await registerManual(runtimeId)
    return item
  })
  register('runtime:remove-manual', async (_event, id: string) => {
    if (typeof id !== 'string' || id.length > 80) throw new Error('无效的安装记录')
    await store.removeManual(id)
  })
  register('runtime:catalog', async (_event, runtimeId: RuntimeId) => {
    if (!isRuntimeId(runtimeId)) throw new Error('无效的运行时')
    return getCatalog(runtimeId)
  })
  register('runtime:activate', async (_event, id: string) => {
    if (typeof id !== 'string' || id.length > 80) throw new Error('无效的安装记录')
    const installation = store.snapshot().installations.find((item) => item.id === id)
    if (!installation) throw new Error('找不到该环境记录')
    const result = await applyDefaultVersion(installation)
    await store.activate(id)
    // 写入 PATH 可能顺带移除了其他运行时的托管目录，必须整体重算"当前使用"，否则别的运行时标记会一直停在旧值。
    await refreshAllCurrentFlags()
    return result
  })
  register('runtime:takeover-priority', async (_event, id: string) => {
    if (typeof id !== 'string' || id.length > 80) throw new Error('无效的安装记录')
    const installation = store.snapshot().installations.find((item) => item.id === id)
    if (!installation) throw new Error('找不到该环境记录')
    const result = await takeOverMachinePriority(installation)
    await adoptDetectedDirectories(installation.runtimeId, result.removed)
    // 系统 PATH 变了，所有运行时的解析结果都可能变。
    await refreshAllCurrentFlags()
    void scanRuntime().catch(() => undefined)
    return result
  })
  register('runtime:refresh-current', async (_event, runtimeId?: RuntimeId) => {
    if (runtimeId !== undefined) {
      if (!isRuntimeId(runtimeId)) throw new Error('无效的运行时')
      await refreshCurrentFlag(runtimeId)
    } else {
      await refreshAllCurrentFlags()
    }
  })
  register('runtime:resolve-current', async (_event, runtimeId: RuntimeId) => {
    if (!isRuntimeId(runtimeId)) throw new Error('无效的运行时')
    return resolveCurrentFor(runtimeId)
  })
  register('runtime:install', async (_event, downloadId: string, activate: boolean) => {
    if (typeof downloadId !== 'string' || downloadId.length > 80) throw new Error('无效的下载任务')
    const installation = await installDownloadedRuntime(downloadId, activate === true)
    return installation
  })
  register('runtime:uninstall', async (_event, id: string) => {
    if (typeof id !== 'string' || id.length > 80) throw new Error('无效的安装记录')
    await uninstallManagedRuntime(id)
  })

  register('download:start', async (_event, runtimeId: RuntimeId, version: string) => {
    const item = await resolveCatalogItem(runtimeId, version)
    const current = await assertCurrentCatalogItem(item)
    return startDownload(current)
  })
  register('download:pause', (_event, id: string) => pauseDownload(id))
  register('download:resume', (_event, id: string) => resumeDownload(id))
  register('download:cancel', (_event, id: string) => cancelDownload(id))
  register('download:remove', async (_event, id: string, deleteFile: boolean) => {
    if (typeof id !== 'string' || id.length > 80) throw new Error('无效的下载任务')
    await removeDownload(id, deleteFile === true)
  })
  register('download:import', async (_event, runtimeId: RuntimeId, version: string) => {
    const item = await resolveCatalogItem(runtimeId, version)
    const current = await assertCurrentCatalogItem(item)
    return importDownloadedFile(current)
  })
  register('download:directory', () => openDownloadDirectory())

  register('network:get-proxy', () => getProxyStatus())
  register('network:test-proxy', () => testProxyConnection())
  register('packages:get', (_event, manager: PackageManagerId) => getPackageConfig(manager))
  register('packages:set', (_event, manager: PackageManagerId, registry: string) => setPackageRegistry(manager, registry))
  register('packages:set-cache', (_event, manager: PackageManagerId, cacheDir: string) => setPackageCacheDir(manager, cacheDir))
  register('packages:test', (_event, manager: PackageManagerId, registry: string) => testPackageRegistry(manager, registry))
  register('packages:undo-path', async () => {
    const restored = await undoLastPathChange()
    // 恢复 PATH 后，所有运行时的实际解析结果都需要重算。
    await refreshAllCurrentFlags()
    return restored
  })
  register('environment:repair-path', async () => {
    const result = await repairUserPath()
    await refreshAllCurrentFlags()
    return result
  })
  register('app:choose-managed-root', async () => {
    const result = await dialog.showOpenDialog({ title: '选择 EnvHub 数据目录', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  register('app:set-managed-root', async (_event, path: string, moveExisting: boolean) => {
    if (typeof path !== 'string' || path.length > 300) throw new Error('无效的目录')
    const result = await changeManagedRoot(path, moveExisting === true)
    await refreshAllCurrentFlags()
    return result
  })
  register('privileged:status', () => privilegedHelperStatus())
  register('privileged:enable', () => enablePrivilegedHelper())
  register('privileged:disable', () => disablePrivilegedHelper())
  register('network:set-proxy', async (_event, settings) => {
    if (!settings || !['system', 'direct', 'manual'].includes(settings.mode) || typeof settings.server !== 'string' || settings.server.length > 300) {
      throw new Error('代理设置无效')
    }
    const status = await applyProxy(settings)
    return status
  })
}
