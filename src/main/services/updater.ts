import { app, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppRunForm, AppUpdateAsset, AppUpdateInfo, AppUpdateState, DownloadTask } from '../../shared/contracts'
import { APP_VERSION } from '../../shared/appInfo'
import { appUpdateRepository } from '../../shared/downloadHosts'
import { isNewerVersion, matchesUpdateAsset, summarizeReleaseNotes, updateFormLabel } from '../../shared/update'
import { sameVersion } from '../../shared/versions'
import { store } from '../storage/store'
import { startAppUpdateDownload, removeDownload } from './downloads'

// 更新检查只读本仓库的 GitHub Releases（正式版，不含预览版）：
// 1) 结果缓存几分钟，启动检查与设置页检查不会重复打接口（匿名调用有 60 次/小时的限额）；
// 2) 只有线上版本严格高于本地版本才算「有新版本」；
// 3) 下载什么由用户当前使用的形态决定（安装版 / 绿色单文件版 / 解压版）；
// 4) 下载走与运行时归档同一套队列，安装动作交给用户确认。

const checkTimeout = 15_000
const cacheTtl = 5 * 60 * 1000
const releasesPage = `https://github.com/${appUpdateRepository}/releases`

interface GitHubAsset { name: string; browser_download_url: string; size: number; digest?: string | null }
interface GitHubRelease {
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string
  draft?: boolean
  prerelease?: boolean
  assets: GitHubAsset[]
}

let cache: { at: number; value: AppUpdateState } | null = null

// 忽略 / 恢复提示后同步缓存里的标记（同一个版本才需要改），不必为了一个开关再打一次接口。
function patchCachedIgnore(version: string, ignored: boolean): void {
  const info = cache?.value.info
  if (!cache || !info || !sameVersion(info.latestVersion, version)) return
  cache = { at: cache.at, value: { ...cache.value, info: { ...info, ignored } } }
}

// 用户当前用的是哪种发行形态。electron-builder 的 portable 目标会注入 PORTABLE_EXECUTABLE_*，
// 安装版的特征是程序同目录下的卸载程序；两者都不是就是解压版。
export function currentRunForm(): AppRunForm {
  if (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
  const directory = dirname(app.getPath('exe'))
  if (existsSync(join(directory, `Uninstall ${app.getName()}.exe`)) || existsSync(join(directory, 'Uninstall EnvHub.exe'))) return 'installer'
  return 'zip'
}

function ignoredVersions(): string[] {
  return store.snapshot().ignoredUpdateVersions
}

function checksumOf(digest: string | null | undefined): AppUpdateAsset['checksum'] {
  const value = (digest ?? '').trim().toLowerCase()
  return /^sha256:[a-f0-9]{64}$/.test(value) ? { algorithm: 'sha256', value: value.slice(7) } : undefined
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const target = `https://api.github.com/repos/${appUpdateRepository}/releases/latest`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), checkTimeout)
  try {
    const response = await net.fetch(target, {
      headers: { 'User-Agent': `EnvHub/${APP_VERSION}`, Accept: 'application/vnd.github+json' },
      signal: controller.signal
    })
    const finalHost = new URL(response.url || target).hostname.toLowerCase()
    if (finalHost !== 'api.github.com') throw new Error('更新源返回了非预期地址，已停止检查')
    if (response.status === 403 || response.status === 429) throw new Error('更新源暂时限制了访问频率，请稍后再试')
    if (!response.ok) throw new Error(`更新源请求失败：HTTP ${response.status}`)
    const release = await response.json() as GitHubRelease
    if (!release?.tag_name || !Array.isArray(release.assets)) throw new Error('更新源返回的数据无法解析')
    return release
  } catch (error) {
    if (controller.signal.aborted) throw new Error('检查更新超时，请检查网络或代理后重试')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function describe(release: GitHubRelease, ignored: string[]): AppUpdateInfo {
  const latestVersion = release.tag_name.replace(/^v/, '')
  const form = currentRunForm()
  const matched = release.assets.find((asset) => matchesUpdateAsset(asset.name, form))
  const checksum = matched ? checksumOf(matched.digest) : undefined
  const asset: AppUpdateAsset | null = matched
    ? { name: matched.name, url: matched.browser_download_url, size: Number.isFinite(matched.size) ? matched.size : 0, ...(checksum ? { checksum } : {}) }
    : null
  const blockedReason = !matched
    ? `这个版本没有和当前形态（${updateFormLabel(form)}）匹配的安装包，请用浏览器下载`
    : !checksum
      ? '官方没有为这个安装包提供校验值，请用浏览器下载'
      : undefined
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    releaseName: release.name?.trim() || `EnvHub ${latestVersion}`,
    releaseUrl: /^https:\/\/github\.com\/lyhxx\/EnvHub\/releases\/tags\/[^/?#]+$/.test(release.html_url) ? release.html_url : releasesPage,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    notes: summarizeReleaseNotes(release.body ?? ''),
    form,
    asset,
    ...(blockedReason ? { blockedReason } : {}),
    ignored: ignored.includes(latestVersion)
  }
}

export async function checkForUpdate(force = false): Promise<AppUpdateState> {
  if (!force && cache && Date.now() - cache.at < cacheTtl) return cache.value
  const checkedAt = new Date().toISOString()
  let value: AppUpdateState
  try {
    const release = await fetchLatestRelease()
    const ignored = ignoredVersions()
    const info = describe(release, ignored)
    value = isNewerVersion(info.latestVersion, APP_VERSION)
      ? { state: 'available', info, checkedAt }
      : { state: 'latest', info, checkedAt }
  } catch (error) {
    value = { state: 'failed', error: error instanceof Error ? error.message : String(error), checkedAt }
  }
  cache = { at: Date.now(), value }
  return value
}

export async function downloadAppUpdate(): Promise<DownloadTask> {
  const state = await checkForUpdate(false)
  if (state.state !== 'available' || !state.info) throw new Error('当前没有可下载的新版本，请先检查更新')
  const info = state.info
  if (!info.asset) throw new Error(info.blockedReason ?? '这个版本暂不支持应用内下载')
  // 与运行时归档同一条原则：没有官方校验值就不在应用内下载。
  if (!info.asset.checksum) throw new Error(info.blockedReason ?? '这个安装包没有提供校验值，请用浏览器下载')
  const existing = store.snapshot().downloads.find((task) =>
    task.kind === 'app' && sameVersion(task.version, info.latestVersion) && ['queued', 'downloading', 'paused', 'completed'].includes(task.status)
  )
  if (existing) {
    if (existing.status !== 'completed') return existing
    // 已下载但文件被清理掉了（例如换过数据目录）：重新下载，而不是把用户卡在"安装"按钮上。
    const file = await lstat(existing.filePath).catch(() => null)
    if (file?.isFile()) return existing
    await removeDownload(existing.id, false)
  }
  return startAppUpdateDownload({
    version: info.latestVersion, url: info.asset.url, fileName: info.asset.name, checksum: info.asset.checksum
  })
}

// 先把安装程序拉起来，确认真的启动了再退出自己：顺序反了会出现「EnvHub 退了、什么都没发生」。
function launchInstaller(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(filePath, [], { detached: true, stdio: 'ignore', cwd: dirname(filePath), windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function installAppUpdate(downloadId: string): Promise<{ mode: 'installer' | 'folder' }> {
  const task = store.snapshot().downloads.find((item) => item.id === downloadId)
  if (!task || task.kind !== 'app') throw new Error('找不到该更新下载任务')
  if (task.status !== 'completed') throw new Error('请等待更新包下载完成后再安装')
  const info = await lstat(task.filePath).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('更新包已不存在，请重新下载')

  // 只看产物名：界面上的按钮文案也是按这个判断的，两处必须一致。
  // （安装版产物 → 退出并安装；绿色单文件/解压版 → 打开所在文件夹交回用户替换。）
  const isInstaller = matchesUpdateAsset(task.fileName, 'installer')
  if (!isInstaller) {
    // 绿色单文件版与解压版不能覆盖正在运行的程序：打开所在文件夹，交回用户手动替换。
    shell.showItemInFolder(task.filePath)
    return { mode: 'folder' }
  }
  await launchInstaller(task.filePath)
  // 留一点时间让界面把结果提示展示出来，然后正常退出（会清理会话锁），安装完成后 NSIS 会重新拉起 EnvHub。
  setTimeout(() => app.quit(), 1200)
  return { mode: 'installer' }
}

export async function openReleasePage(): Promise<void> {
  const url = cache?.value.info?.releaseUrl
  await shell.openExternal(url && url.startsWith(releasesPage) ? url : releasesPage)
}

export async function ignoreUpdateVersion(version: string): Promise<void> {
  if (typeof version !== 'string' || !/^\d[\w.+-]{0,39}$/.test(version)) throw new Error('无效的版本号')
  await store.ignoreUpdateVersion(version)
  patchCachedIgnore(version, true)
}

export async function restoreIgnoredUpdateVersions(): Promise<void> {
  await store.restoreUpdateVersions()
  if (cache?.value.info) cache = { at: cache.at, value: { ...cache.value, info: { ...cache.value.info, ignored: false } } }
}
