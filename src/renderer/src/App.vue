<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Directive } from 'vue'
import type { AppSnapshot, AppUpdateInfo, AppUpdateState, DownloadTask, ProxyStatus, RuntimeCatalogItem, RuntimeId, RuntimeInstallation, ThemeMode } from '../../shared/contracts'
import { runtimeMeta, runtimeGroups } from '../../shared/runtimeMeta'
import { isInstallableRuntime } from '../../shared/installable'
import { sameVersion } from '../../shared/versions'
import { updateFormLabel, matchesUpdateAsset } from '../../shared/update'
import { APP_STAGE, APP_VERSION } from '../../shared/appInfo'
import brandMark from './assets/brand/envhub-mark.png'

type Page = 'overview' | 'runtimes' | 'downloads' | 'settings'
const page = ref<Page>('overview')
const selectedRuntime = ref<RuntimeId>('python')
const runtimeSearch = ref('')
const sidebarCollapsed = ref(window.localStorage.getItem('envhub.sidebar') === 'collapsed')

function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value
  window.localStorage.setItem('envhub.sidebar', sidebarCollapsed.value ? 'collapsed' : 'expanded')
}
const runtimeFilter = ref<'all' | 'installed'>('all')
const detailTab = ref<'versions' | 'sources' | 'releases'>('versions')
const snapshot = ref<AppSnapshot | null>(null)
const proxyStatus = ref<ProxyStatus | null>(null)
const catalog = ref<RuntimeCatalogItem[]>([])
const packageRegistry = ref('')
const packageCacheDir = ref('')
const packageCacheDirFromFile = ref(false)
const packageConfigFileExists = ref(false)
const installingTaskId = ref('')
const helperEnabled = ref(false)
const packageBusy = ref(false)
const catalogLoading = ref(false)
const scanning = ref(false)
const busy = ref(false)
const testingProxy = ref(false)
const manualProxyServer = ref('')
// “自定义代理”只是先把输入框露出来，不要直接改本地快照——任何状态广播都会把它冲掉。
const proxyModeDraft = ref<'manual' | null>(null)
const shownProxyMode = computed(() => proxyModeDraft.value ?? snapshot.value?.proxy.mode ?? 'system')
const notice = ref('')
// 更新提示：「取消」只收起本次运行，「忽略此版本」写进本地数据（设置页可恢复）。
const updateState = ref<AppUpdateState | null>(null)
const updateChecking = ref(false)
const updateBusy = ref(false)
const updateBannerHidden = ref(false)
const installingUpdateId = ref('')
const tooltip = ref<{ text: string; x: number; y: number; below: boolean } | null>(null)
const operation = ref<{ title: string; detail?: string; percent?: number } | null>(null)
let operationDepth = 0
interface ConfirmOptions { title: string; lines: string[]; confirmText?: string; cancelText?: string; danger?: boolean }
const confirmDialog = ref<ConfirmOptions | null>(null)
let confirmResolver: ((ok: boolean) => void) | null = null

function askConfirm(options: ConfirmOptions): Promise<boolean> {
  if (confirmResolver) { confirmResolver(false); confirmResolver = null }
  confirmDialog.value = options
  return new Promise((resolve) => { confirmResolver = resolve })
}

function closeConfirm(ok: boolean): void {
  confirmDialog.value = null
  const resolver = confirmResolver
  confirmResolver = null
  resolver?.(ok)
}

// 对话框：打开时把焦点移进去（否则键盘 Tab 会跑到被遮住的背景控件上），并支持 Esc 关闭。
const confirmCard = ref<HTMLElement | null>(null)
watch(confirmDialog, async (value) => {
  if (!value) return
  await nextTick()
  confirmCard.value?.focus()
})
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeDownloads: (() => void) | undefined
let unsubscribeSnapshot: (() => void) | undefined
let unsubscribeProgress: (() => void) | undefined
let unsubscribeNotice: (() => void) | undefined
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')

const installations = computed(() => snapshot.value?.installations ?? [])
const downloads = computed(() => snapshot.value?.downloads ?? [])
const installedCount = computed(() => installations.value.length)
const activeDownloads = computed(() => downloads.value.filter((item) => ['queued', 'downloading', 'paused'].includes(item.status)).length)
const activeDownloadTasks = computed(() => downloads.value.filter((item) => ['queued', 'downloading', 'paused'].includes(item.status)).slice(0, 2))
const selectedMeta = computed(() => runtimeMeta.find((item) => item.id === selectedRuntime.value)!)
const matchesFilter = (runtime: (typeof runtimeMeta)[number]): boolean => {
  const query = runtimeSearch.value.trim().toLowerCase()
  const hitSearch = !query ||
    runtime.name.toLowerCase().includes(query) ||
    runtime.shortName.toLowerCase().includes(query) ||
    (runtime.relatedTools ?? []).some((tool) => tool.toLowerCase().includes(query))
  const hitFilter = runtimeFilter.value === 'all' || installations.value.some((item) => item.runtimeId === runtime.id)
  return hitSearch && hitFilter
}
const filteredRuntimes = computed(() => runtimeMeta.filter(matchesFilter))
const groupedRuntimes = computed(() => runtimeGroups
  .map((group) => ({ ...group, items: filteredRuntimes.value.filter((runtime) => runtime.group === group.id) }))
  .filter((group) => group.items.length > 0))
const selectedInstallations = computed(() => installations.value.filter((item) => item.runtimeId === selectedRuntime.value))
const currentInstallation = computed(() => selectedInstallations.value.find((item) => item.isCurrent))
const resolvedCurrentPath = ref<string | null>(null)
// 异步请求的归属校验：快速切换运行时/页面时，先发后回的旧结果不能覆盖当前选中的内容。
let catalogRequestId = 0
let resolvedPathRequestId = 0
let packageConfigRequestId = 0

async function refreshResolvedPath(): Promise<void> {
  const requestId = ++resolvedPathRequestId
  const runtimeId = selectedRuntime.value
  try {
    const path = (await window.envhub.runtime.resolveCurrent(runtimeId)).path
    if (requestId !== resolvedPathRequestId || runtimeId !== selectedRuntime.value) return
    resolvedCurrentPath.value = path
  } catch {
    if (requestId === resolvedPathRequestId) resolvedCurrentPath.value = null
  }
}
const formattedScan = computed(() => snapshot.value?.lastScanAt ? new Date(snapshot.value.lastScanAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '尚未扫描')
const downloadDirectory = computed(() => snapshot.value?.managedRoot ? `${snapshot.value.managedRoot}\\downloads` : '')
const updateInfo = computed<AppUpdateInfo | null>(() => updateState.value?.state === 'available' ? updateState.value.info ?? null : null)
const showUpdateBanner = computed(() => Boolean(updateInfo.value && !updateInfo.value.ignored && !updateBannerHidden.value))
const updateTask = computed<DownloadTask | null>(() => {
  const info = updateInfo.value
  if (!info) return null
  return downloads.value.find((task) => task.kind === 'app' && sameVersion(task.version, info.latestVersion)) ?? null
})
const ignoredUpdateVersions = computed(() => snapshot.value?.ignoredUpdateVersions ?? [])
const updateCheckText = computed(() => {
  const state = updateState.value
  if (!state) return '尚未检查'
  if (state.state === 'failed') return state.error ?? '检查失败'
  if (state.state === 'latest') return `已是最新版本（${state.info?.latestVersion ?? APP_VERSION}）`
  const info = state.info
  if (!info) return '发现新版本'
  return info.ignored ? `已忽略 ${info.latestVersion}` : `可更新到 ${info.latestVersion}`
})
const updateCheckedText = computed(() => {
  const checkedAt = updateState.value?.checkedAt
  if (!checkedAt) return '尚未检查'
  return new Date(checkedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
})
const updateAssetText = computed(() => {
  const info = updateInfo.value
  if (!info) return ''
  if (!info.asset) return info.blockedReason ?? '这个版本暂不支持应用内下载'
  return `${info.asset.name}（${updateFormLabel(info.form)}，${formatBytes(info.asset.size)}）`
})
// 按钮文案按"任务自己的产物名"判断，不能依赖 updateInfo（启动后 6 秒内它还是空的，
// 那时下载页里的按钮会显示成"打开所在文件夹"，实际点下去却是"退出并安装"）。
function updateActionLabel(task: DownloadTask): string {
  if (installingUpdateId.value === task.id) return '正在启动…'
  return matchesUpdateAsset(task.fileName, 'installer') ? '退出并安装' : '打开所在文件夹'
}
const updateFormText = computed(() => updateState.value?.info ? updateFormLabel(updateState.value.info.form) : '—')

function taskTitle(task: DownloadTask): string {
  if (task.kind === 'app') return 'EnvHub'
  return runtimeMeta.find((item) => item.id === task.runtimeId)?.name ?? '运行时'
}

const updateTaskStatusText = computed(() => {
  const task = updateTask.value
  if (!task) return ''
  if (task.status === 'completed') return '更新包已下载完成'
  if (task.status === 'failed') return task.error ?? '下载失败'
  if (task.status === 'paused') return '下载已暂停'
  if (task.status === 'cancelled') return '下载已取消'
  return `正在下载更新包 ${formatBytes(task.receivedBytes)}${task.totalBytes ? ` / ${formatBytes(task.totalBytes)}` : ''}`
})

function versionsFor(runtimeId: RuntimeId): RuntimeInstallation[] {
  return installations.value.filter((item) => item.runtimeId === runtimeId)
}

function highlightedVersion(runtimeId: RuntimeId): RuntimeInstallation | undefined {
  const versions = versionsFor(runtimeId)
  return versions.find((item) => item.isDefault) ?? versions.find((item) => item.source === 'managed') ?? versions[0]
}

function cloudFontSize(runtimeId: RuntimeId): number {
  const count = versionsFor(runtimeId).length
  return count ? Math.min(48, 28 + count * 5) : 19
}

function openRuntime(runtimeId: RuntimeId): void {
  selectedRuntime.value = runtimeId
  detailTab.value = 'versions'
  page.value = 'runtimes'
  void syncCurrentFlags()
  void refreshResolvedPath()
  void loadCatalog()
}

function currentVersionFor(runtimeId: RuntimeId): string | null {
  const versions = versionsFor(runtimeId)
  return (versions.find((item) => item.isCurrent) ?? versions[0])?.version ?? null
}

async function copyPath(text: string): Promise<void> {
  try { await window.envhub.app.copyText(text); say('已复制到剪贴板') }
  catch { say('复制失败，请稍后重试') }
}

const packagePresets: Record<string, { label: string; url: string }[]> = {
  npm: [
    { label: '官方源', url: 'https://registry.npmjs.org/' },
    { label: '淘宝镜像', url: 'https://registry.npmmirror.com/' },
    { label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/npm/' }
  ],
  pip: [
    { label: '官方源', url: 'https://pypi.org/simple' },
    { label: '清华镜像', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
    { label: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/' }
  ],
  maven: [
    { label: '官方源', url: 'https://repo.maven.apache.org/maven2' },
    { label: '阿里云', url: 'https://maven.aliyun.com/repository/public' },
    { label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/' }
  ]
}

const activePackageManager = computed<'npm' | 'pip' | 'maven' | null>(() => selectedRuntime.value === 'python' ? 'pip' : selectedRuntime.value === 'node' ? 'npm' : selectedRuntime.value === 'maven' ? 'maven' : null)
// 没有包管理器的环境（Docker、Go、Rust…）返回空串，交给模板显示中性的「软件源」标题，
// 不能像以前那样落到最后一个分支显示成 Maven。
const packageManagerLabel = computed(() => {
  const manager = activePackageManager.value
  if (manager === 'npm') return 'npm registry · .npmrc'
  if (manager === 'pip') return 'pip 镜像 · pip.ini'
  if (manager === 'maven') return 'Maven 镜像 · settings.xml'
  return ''
})
// 没装这个工具、本机也没有它的配置文件时，不显示默认镜像与缓存地址：
// 那是"约定"而不是"配置"，摆出来只会让人以为已经配好了。
const packageConfigReady = computed(() => Boolean(activePackageManager.value) &&
  (selectedInstallations.value.length > 0 || packageConfigFileExists.value))
const packageConfigTarget = computed(() => {
  const manager = activePackageManager.value
  if (manager === 'npm') return 'npm registry 与缓存目录'
  if (manager === 'pip') return 'pip 镜像与缓存目录'
  if (manager === 'maven') return 'Maven 镜像与本地仓库'
  return ''
})
const packagePresetList = computed(() => {
  const manager = activePackageManager.value
  return manager ? packagePresets[manager] : []
})


async function loadPackageConfig(): Promise<void> {
  const manager = activePackageManager.value
  const requestId = ++packageConfigRequestId
  if (!manager) { packageRegistry.value = ''; packageCacheDir.value = ''; packageCacheDirFromFile.value = false; packageConfigFileExists.value = false; return }
  try {
    const config = await window.envhub.packages.getConfig(manager)
    if (requestId !== packageConfigRequestId || manager !== activePackageManager.value) return
    packageRegistry.value = config.registry
    packageCacheDir.value = config.cacheDir ?? ''
    packageCacheDirFromFile.value = config.cacheDirFromFile === true
    packageConfigFileExists.value = config.configFileExists === true
  } catch (error) {
    if (requestId === packageConfigRequestId) say(error instanceof Error ? error.message : '读取镜像配置失败')
  }
}

async function applyPackageCacheDir(): Promise<void> {
  const manager = activePackageManager.value
  if (!manager) return
  packageBusy.value = true
  try {
    const config = await window.envhub.packages.setCacheDir(manager, packageCacheDir.value.trim())
    packageCacheDir.value = config.cacheDir ?? packageCacheDir.value
    packageCacheDirFromFile.value = config.cacheDirFromFile === true
    say('本地路径已写入用户配置，并已保留原始备份')
  } catch (error) { say(error instanceof Error ? error.message : '写入本地路径失败') }
  finally { packageBusy.value = false }
}

async function applyPackageRegistry(value?: string): Promise<void> {
  const manager = activePackageManager.value
  if (!manager) return
  const registry = (value ?? packageRegistry.value).trim()
  packageBusy.value = true
  try {
    const config = await window.envhub.packages.setRegistry(manager, registry)
    packageRegistry.value = config.registry
    say('镜像已写入用户级配置文件，并已保留原始备份')
  } catch (error) { say(error instanceof Error ? error.message : '写入镜像配置失败') }
  finally { packageBusy.value = false }
}

async function testPackageRegistry(): Promise<void> {
  const manager = activePackageManager.value
  if (!manager) return
  packageBusy.value = true
  try {
    const result = await withOperation('正在测试软件源连接', packageRegistry.value.trim(), () => window.envhub.packages.testRegistry(manager, packageRegistry.value.trim()))
    say(result.ok ? `软件源连接正常 · ${result.latencyMs} ms` : `软件源连接失败 · ${result.error ?? '请检查地址'}`)
  } catch (error) { say(error instanceof Error ? error.message : '测试连接失败') }
  finally { packageBusy.value = false }
}

async function loadHelperStatus(): Promise<void> {
  try { helperEnabled.value = (await window.envhub.privileged.status()).enabled }
  catch { helperEnabled.value = false }
}

async function enableHelper(): Promise<void> {
  const confirmed = await askConfirm({
    title: '启用一次性管理授权？',
    lines: [
      '会创建一个仅用于修改系统 PATH 的计划任务，之后切换版本不再弹出管理员确认。',
      '该任务只接受“设置系统 PATH”这一种操作，不会执行其他命令；随时可以在设置中撤销。'
    ],
    confirmText: '启用（需一次管理员授权）'
  })
  if (!confirmed) return
  beginOperation('正在创建特权助手', '请在 Windows 弹出的一次性授权窗口中选择“是”')
  try {
    await window.envhub.privileged.enable()
    await loadHelperStatus()
    say('已启用；之后切换版本不会再弹出管理员确认')
  } catch (error) { say(error instanceof Error ? error.message : '启用失败') }
  finally { endOperation() }
}

async function disableHelper(): Promise<void> {
  beginOperation('正在移除特权助手', '需要一次管理员授权')
  try {
    await window.envhub.privileged.disable()
    await loadHelperStatus()
    say('已撤销授权，之后切换版本会重新弹出管理员确认')
  } catch (error) { say(error instanceof Error ? error.message : '撤销失败') }
  finally { endOperation() }
}

async function repairPath(): Promise<void> {
  const confirmed = await askConfirm({
    title: '修复用户 PATH？',
    lines: [
      '将删除重复条目，以及指向不存在目录的失效条目。',
      '不认识的条目、顺序和系统 PATH 都不会改动；原始值会保存，可撤销。'
    ],
    confirmText: '开始修复'
  })
  if (!confirmed) return
  beginOperation('正在修复用户 PATH', '删除重复项与失效目录')
  try {
    const result = await window.envhub.packages.repairPath()
    snapshot.value = await window.envhub.app.getSnapshot()
    await syncCurrentFlags()
    say(result.removed ? `已清理 ${result.removed} 条重复或失效条目，剩余 ${result.remaining} 条` : '没有发现需要清理的条目')
  } catch (error) { say(error instanceof Error ? error.message : '修复 PATH 失败') }
  finally { endOperation() }
}

async function changeStorageRoot(): Promise<void> {
  try {
    const picked = await window.envhub.app.chooseManagedRoot()
    if (!picked) return
    const moveExisting = await askConfirm({
      title: '是否搬移现有内容？',
      lines: [
        `新位置：${picked}`,
        '选择“搬移并切换”会把现有的运行时、下载文件和特权助手目录一起移动过去；跨磁盘时会复制文件，过程会显示进度。',
        '选择“仅切换”则保留旧目录中的文件不动；旧目录里的托管版本仍会留在清单中，可逐个卸载（旧目录下的下载记录会被清理）。'
      ],
      confirmText: '搬移并切换', cancelText: '仅切换'
    })
    beginOperation('正在切换数据目录', moveExisting ? '移动现有文件，可能需要一些时间' : '更新配置')
    try {
      const result = await window.envhub.app.setManagedRoot(picked, moveExisting)
      snapshot.value = await window.envhub.app.getSnapshot()
      await syncCurrentFlags()
      const extras: string[] = []
      if (result.rewritten) extras.push(`同步 ${result.rewritten} 条记录路径`)
      if (result.cleanedPathEntries) extras.push(`同步 ${result.cleanedPathEntries} 条 PATH 条目`)
      if (result.clearedDownloads) extras.push(`清理 ${result.clearedDownloads} 条旧目录下的下载记录（文件仍在旧目录）`)
      say(`数据目录已切换到 ${result.root}${extras.length ? `；${extras.join('，')}` : ''}`)
    } catch (error) { say(error instanceof Error ? error.message : '切换数据目录失败') }
    finally { endOperation() }
  } catch (error) { say(error instanceof Error ? error.message : '选择目录失败') }
}

async function undoLastPathChange(): Promise<void> {
  const backup = snapshot.value?.pathBackups?.at(-1)
  const targets = ['用户 PATH']
  if (backup?.appliedJavaHome) targets.push('Java 工具链的 JDK 位置')
  if (backup?.appliedMachinePath !== undefined) targets.push('系统 PATH')
  const confirmed = await askConfirm({
    title: '撤销上一次环境变量修改？',
    lines: [
      `将恢复：${targets.join('、')}`,
      backup?.appliedMachinePath !== undefined
        ? '其中包含系统 PATH，会弹出一次管理员授权。'
        : '已打开的终端不受影响，新开终端才会使用恢复后的值。'
    ],
    confirmText: '撤销'
  })
  if (!confirmed) return
  beginOperation(`正在恢复 ${targets.join(' 与 ')}`, backup?.appliedMachinePath !== undefined ? '请在管理员授权窗口中选择“是”' : '写入当前用户环境变量')
  try {
    const restored = await window.envhub.packages.undoLastPathChange()
    snapshot.value = await window.envhub.app.getSnapshot()
    await syncCurrentFlags()
    say(restored ? `已恢复：${targets.join('、')}` : '没有可恢复的修改记录')
  } catch (error) { say(error instanceof Error ? error.message : '恢复失败') }
  finally { endOperation() }
}

function say(message: string, duration = 2400): void {
  notice.value = message
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = '' }, duration)
}

function clearNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = undefined
  notice.value = ''
}

// 自定义提示气泡：替代原生 title，支持多行与深浅色主题。
// 静态文案用 v-tip data-tip="..."，动态文案用 v-tip="表达式"。
const tipStore = new WeakMap<HTMLElement, { show: () => void; hide: () => void; value: string }>()
const vTip: Directive<HTMLElement, string> = {
  mounted(el, binding) {
    const entry: { show: () => void; hide: () => void; value: string } = { show: () => undefined, hide: () => { tooltip.value = null }, value: binding.value ?? '' }
    entry.show = (): void => {
      const text = el.dataset.tip || entry.value
      if (!text) return
      const rect = el.getBoundingClientRect()
      const below = rect.top < 56
      // 提示框宽 380px，这里把中心点钳进视口，避免贴边时被裁掉一半。
      const half = 190
      const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8)
      tooltip.value = { text, x, y: below ? rect.bottom : rect.top, below }
    }
    if (binding.value) el.dataset.tip = ''
    // 图标按钮（···、×、↗）只有符号，键盘与读屏需要名字：没显式写 aria-label 就用提示文案兜底。
    const label = el.getAttribute('aria-label') || el.dataset.tip || binding.value
    if (label && !el.getAttribute('aria-label')) el.setAttribute('aria-label', label)
    el.addEventListener('mouseenter', entry.show)
    el.addEventListener('mouseleave', entry.hide)
    // 键盘聚焦时也要能看到提示：disabled 的按钮不会触发鼠标事件，所以提示文案同时进了 aria-label。
    el.addEventListener('focusin', entry.show)
    el.addEventListener('focusout', entry.hide)
    el.addEventListener('mousedown', entry.hide)
    tipStore.set(el, entry)
  },
  updated(el, binding) {
    const entry = tipStore.get(el)
    if (entry) entry.value = binding.value ?? ''
  },
  unmounted(el) {
    const entry = tipStore.get(el)
    if (!entry) return
    el.removeEventListener('mouseenter', entry.show)
    el.removeEventListener('mouseleave', entry.hide)
    el.removeEventListener('focusin', entry.show)
    el.removeEventListener('focusout', entry.hide)
    el.removeEventListener('mousedown', entry.hide)
    tipStore.delete(el)
  }
}

function beginOperation(title: string, detail?: string): void {
  clearNotice()
  operationDepth += 1
  operation.value = { title, detail }
}

function endOperation(): void {
  operationDepth = Math.max(0, operationDepth - 1)
  if (operationDepth === 0) operation.value = null
}

function onOperationProgress(payload: { percent: number; detail: string }): void {
  if (!operation.value) return
  operation.value.percent = Math.max(0, Math.min(100, payload.percent))
  if (!operation.value.detail || !payload.detail.startsWith('正在复制')) operation.value.detail = payload.detail
}

async function withOperation<T>(title: string, detail: string | undefined, task: () => Promise<T>, delayMs = 320, onTimeout?: () => void): Promise<T> {
  // operationDepth 只有在真正 beginOperation 之后才成对释放，否则会把别的操作的提示条提前收掉。
  let began = false
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearInterval(watchdog)
    if (began) { began = false; endOperation() }
  }
  const timer = setTimeout(() => { began = true; beginOperation(title, detail) }, delayMs)
  let start = 0
  const watchdog = setInterval(() => {
    if (!operation.value) { clearInterval(watchdog); return }
    if (!start) start = Date.now()
    // 底层调用异常缓慢时不要一直转圈：超过 60 秒就收起操作条并说明情况。
    if (Date.now() - start > 60_000) {
      clearInterval(watchdog)
      if (began) { began = false; endOperation() }
      // 调用方要把自己的 loading 标志一起复位，否则按钮会永远停在"进行中"。
      onTimeout?.()
      say('操作耗时超出预期，已停止等待；结果可能稍后自动生效', 4000)
    }
  }, 2000)
  try {
    return await task()
  } finally {
    finish()
  }
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

function progress(task: DownloadTask): number {
  return task.totalBytes ? Math.min(100, Math.round(task.receivedBytes / task.totalBytes * 100)) : 0
}

function setTheme(theme: ThemeMode): void {
  if (!snapshot.value) return
  snapshot.value.theme = theme
  void window.envhub.app.setTheme(theme).catch((error) => say(error.message))
}

function applyTheme(theme: ThemeMode | undefined): void {
  if (!theme) return
  const dark = theme === 'dark' || (theme === 'system' && systemThemeQuery.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  // 记下实际明暗，下次启动由 main.ts 先铺底，避免深色用户看到一闪的浅色。
  window.localStorage.setItem('envhub.theme', dark ? 'dark' : 'light')
}

watch(() => snapshot.value?.theme, applyTheme, { immediate: true })
watch([page, selectedRuntime], () => {
  clearNotice()
  // 离开设置页就丢弃"自定义代理"的草稿态，避免回来时卡片高亮与真实模式不一致。
  proxyModeDraft.value = null
  if (page.value === 'runtimes') {
    void loadPackageConfig()
    void syncCurrentFlags()
    void refreshResolvedPath()
  }
  if (page.value === 'overview') void syncCurrentFlags()
})
watch(detailTab, () => { clearNotice() })
function onSystemThemeChange(): void { if (snapshot.value?.theme === 'system') applyTheme('system') }

async function loadCatalog(): Promise<void> {
  const requestId = ++catalogRequestId
  const runtimeId = selectedRuntime.value
  catalogLoading.value = true
  catalog.value = []
  void loadPackageConfig()
  try {
    const items = await withOperation('正在读取官方版本列表', '从官方源获取版本与校验信息', () => window.envhub.runtime.catalog(runtimeId), 600,
      () => { if (requestId === catalogRequestId) catalogLoading.value = false })
    if (requestId !== catalogRequestId || runtimeId !== selectedRuntime.value) return
    catalog.value = items
  } catch (error) {
    if (requestId === catalogRequestId && runtimeId === selectedRuntime.value) say(error instanceof Error ? error.message : '暂时无法读取版本信息')
  }
  finally { if (requestId === catalogRequestId) catalogLoading.value = false }
}

async function scan(): Promise<void> {
  scanning.value = true
  try {
    await withOperation('正在扫描本机环境', '读取 PATH 与常见安装目录中的版本信息', async () => {
      await window.envhub.runtime.scan()
      snapshot.value = await window.envhub.app.getSnapshot()
    }, 320, () => { scanning.value = false })
    await refreshResolvedPath()
    say('扫描完成，已更新本机环境清单')
  } catch (error) { say(error instanceof Error ? error.message : '扫描失败') }
  finally { scanning.value = false }
}

async function registerManual(runtimeId: RuntimeId): Promise<void> {
  try {
    const result = await withOperation('正在登记环境', '读取所选可执行文件的版本信息', () => window.envhub.runtime.registerManual(runtimeId))
    if (result) {
      snapshot.value = await window.envhub.app.getSnapshot()
      say(`${runtimeMeta.find((item) => item.id === runtimeId)?.name} 已登记`)
    }
  } catch (error) { say(error instanceof Error ? error.message : '无法登记该环境') }
}

async function activate(item: RuntimeInstallation): Promise<void> {
  const runtimeName = runtimeMeta.find((runtime) => runtime.id === item.runtimeId)?.name ?? item.runtimeId
  const lines = [`将把该版本目录写入当前用户 PATH 的最前面。`]
  if (item.runtimeId === 'jdk') lines.push('同时更新 Java 工具链（Maven、Gradle、IDE）定位 JDK 的位置。')
  lines.push('原值会被保存，可在设置中撤销。', '需要新开终端才会生效。')
  const confirmed = await askConfirm({ title: `使用 ${runtimeName} ${item.version}？`, lines, confirmText: '使用此版本' })
  if (!confirmed) return
  try {
    const result = await withOperation('正在写入用户 PATH', '把所选版本目录排到用户 PATH 最前', () => window.envhub.runtime.activate(item.id))
    snapshot.value = await window.envhub.app.getSnapshot()
    await refreshResolvedPath()
    if (result.cleaned) say(`已顺带清理 ${result.cleaned} 条 EnvHub 旧条目 / 重复项`)
    const effective = snapshot.value?.installations.find((entry) => entry.runtimeId === item.runtimeId && entry.isCurrent)
    if (effective && effective.id !== item.id) {
      say(`切换已写入，但系统当前解析到的仍是 ${effective.version}；可点击“使用此版本”并按提示移除遮蔽目录`)
    }
    if (result.shadowedBy?.length) {
      const takeOver = await askConfirm({
        title: '所选版本被系统 PATH 中的目录遮蔽',
        lines: [
          `系统 PATH 中的 ${result.shadowedBy.join('、')} 排在更前面，新终端仍会使用旧版本。`,
          '确认后会弹出 Windows 管理员授权窗口，移除这些目录；原始值会保留，可随时撤销。'
        ],
        confirmText: '移除并生效', cancelText: '暂不处理'
      })
      if (takeOver) {
        beginOperation('正在等待管理员授权', '请在 Windows 弹出的授权窗口中选择“是”，完成后会自动继续')
        try {
          const takeover = await window.envhub.runtime.takeOverPriority(item.id)
          snapshot.value = await window.envhub.app.getSnapshot()
          say(takeover.removed.length ? `已移除系统 PATH 中的 ${takeover.removed.join('、')}；新终端将使用所选版本` : '没有需要移除的目录')
        } catch (error) { say(error instanceof Error ? error.message : '清理系统 PATH 失败') }
        finally { endOperation() }
      }
    } else {
      say(result.changed ? '已写入用户 PATH；新开的终端会使用该版本' : '该版本已经是 PATH 中的首选', 2000)
    }
  } catch (error) { say(error instanceof Error ? error.message : '切换版本失败') }
}

async function installTask(task: DownloadTask): Promise<void> {
  if (installingTaskId.value) return
  if (task.kind !== 'runtime' || !task.runtimeId) return
  installingTaskId.value = task.id
  const runtimeName = runtimeMeta.find((runtime) => runtime.id === task.runtimeId)?.name ?? '运行时'
  beginOperation(`正在安装 ${runtimeName} ${task.version}`, '解压到托管目录并校验可执行文件，请稍候')
  try {
    const installation = await window.envhub.runtime.install(task.id, false)
    snapshot.value = await window.envhub.app.getSnapshot()
    say(`${runtimeName} ${installation.version} 已安装到托管目录`)
    openRuntime(task.runtimeId)
  } catch (error) { say(error instanceof Error ? error.message : '安装失败') }
  finally { installingTaskId.value = ''; endOperation() }
}

async function uninstallRuntime(item: RuntimeInstallation): Promise<void> {
  const runtimeName = runtimeMeta.find((runtime) => runtime.id === item.runtimeId)?.name ?? item.runtimeId
  const confirmed = await askConfirm({
    title: `卸载 ${runtimeName} ${item.version}？`,
    lines: [`将删除托管目录：${item.managedDir ?? item.executablePath}`, '不会删除用户项目、其他安装版本和包管理器缓存。'],
    confirmText: '卸载', danger: true
  })
  if (!confirmed) return
  try {
    await withOperation(`正在卸载 ${runtimeName} ${item.version}`, '删除托管目录并清理记录', () => window.envhub.runtime.uninstall(item.id))
    snapshot.value = await window.envhub.app.getSnapshot()
    say('已卸载托管版本')
  } catch (error) { say(error instanceof Error ? error.message : '卸载失败') }
}

async function removeManual(item: RuntimeInstallation): Promise<void> {
  const confirmed = await askConfirm({ title: `从清单移除 ${item.version}？`, lines: ['只会移除 EnvHub 中的登记记录，不会卸载或删除该软件。'], confirmText: '移除' })
  if (!confirmed) return
  try {
    await window.envhub.runtime.removeManual(item.id)
    snapshot.value = await window.envhub.app.getSnapshot()
    say('已从清单移除；软件本身未改动')
  } catch (error) { say(error instanceof Error ? error.message : '移除失败') }
}

async function startDownload(item: RuntimeCatalogItem): Promise<void> {
  try {
    await window.envhub.download.start(item.runtimeId, item.version)
    page.value = 'downloads'
    say('下载任务已加入队列')
  } catch (error) { say(error instanceof Error ? error.message : '无法开始下载') }
}

async function copyLink(item: RuntimeCatalogItem): Promise<void> {
  try { await window.envhub.runtime.copyLink(item.runtimeId, item.version); say(item.downloadUrl ? '官方直链已复制' : '官方下载页面链接已复制') }
  catch (error) { say(error instanceof Error ? error.message : '复制链接失败') }
}

async function openDownloadLink(item: RuntimeCatalogItem): Promise<void> {
  try { await window.envhub.runtime.openDownloadLink(item.runtimeId, item.version) }
  catch (error) { say(error instanceof Error ? error.message : '无法打开官方链接') }
}

async function openOfficial(runtimeId: RuntimeId): Promise<void> {
  const url = runtimeMeta.find((item) => item.id === runtimeId)?.officialUrl
  if (!url) return
  try { await window.envhub.app.openExternal(url) }
  catch (error) { say(error instanceof Error ? error.message : '无法打开官方网站') }
}

async function handleManualFile(item: RuntimeCatalogItem): Promise<void> {
  try {
    const task = await window.envhub.download.importFile(item.runtimeId, item.version)
    if (task) {
      snapshot.value = await window.envhub.app.getSnapshot()
      page.value = 'downloads'
      say('文件已导入并通过官方 SHA-256 校验；暂存完成，尚未安装。')
    }
  } catch (error) { say(error instanceof Error ? error.message : '选择文件失败') }
}

async function copyTaskLink(task: DownloadTask): Promise<void> {
  try {
    await window.envhub.app.copyText(task.url)
    say('下载链接已复制')
  } catch { say('复制失败，请稍后重试') }
}

async function checkUpdate(force: boolean, announce = false): Promise<void> {
  if (updateChecking.value) return
  updateChecking.value = true
  try {
    updateState.value = await window.envhub.update.check(force)
    if (announce) {
      const state = updateState.value
      if (state.state === 'available' && state.info) say(`发现新版本 ${state.info.latestVersion}`)
      else if (state.state === 'latest') say('已是最新版本')
      else say(state.error ?? '检查更新失败')
    }
  } catch (error) {
    if (announce) say(error instanceof Error ? error.message : '检查更新失败')
  } finally { updateChecking.value = false }
}

async function downloadUpdate(): Promise<void> {
  updateBusy.value = true
  try {
    await window.envhub.update.download()
    snapshot.value = await window.envhub.app.getSnapshot()
    say('更新包已加入下载队列，可在下载页查看进度')
  } catch (error) { say(error instanceof Error ? error.message : '无法下载更新包') }
  finally { updateBusy.value = false }
}

async function installUpdate(task: DownloadTask): Promise<void> {
  if (installingUpdateId.value) return
  if (matchesUpdateAsset(task.fileName, 'installer')) {
    const confirmed = await askConfirm({
      title: '安装 EnvHub 更新？',
      lines: [
        'EnvHub 会先退出，然后启动安装程序；安装完成后会自动重新打开。',
        '已安装的运行环境与清单都在本机数据目录里，更新不会改动它们。',
        'Windows 可能会要求你确认安装程序的来源。'
      ],
      confirmText: '退出并安装'
    })
    if (!confirmed) return
  }
  installingUpdateId.value = task.id
  try {
    const result = await window.envhub.update.install(task.id)
    if (result.mode === 'installer') say('安装程序已启动，EnvHub 即将退出…', 4000)
    else say('已打开更新包所在文件夹，替换（或直接使用）新文件即可')
  } catch (error) { say(error instanceof Error ? error.message : '无法启动安装程序') }
  finally { installingUpdateId.value = '' }
}

async function ignoreUpdate(version: string): Promise<void> {
  try {
    await window.envhub.update.ignore(version)
    updateBannerHidden.value = true
    await checkUpdate(false)
    say(`已忽略 ${version}；更高的版本发布后仍会提示`, 3200)
  } catch (error) { say(error instanceof Error ? error.message : '忽略失败') }
}

async function restoreIgnoredUpdates(): Promise<void> {
  try {
    await window.envhub.update.restore()
    updateBannerHidden.value = false
    await checkUpdate(true)
    say('已恢复更新提示')
  } catch (error) { say(error instanceof Error ? error.message : '恢复失败') }
}

async function openReleasePage(): Promise<void> {
  try { await window.envhub.update.openRelease() }
  catch (error) { say(error instanceof Error ? error.message : '无法打开发布页面') }
}

function isInstalled(task: DownloadTask): boolean {
  if (task.kind !== 'runtime' || !task.runtimeId) return false
  return installations.value.some((item) => item.source === 'managed' && item.runtimeId === task.runtimeId && sameVersion(item.version, task.version))
}

async function loadProxy(): Promise<void> {
  try {
    proxyStatus.value = await window.envhub.network.getProxyStatus()
    manualProxyServer.value = proxyStatus.value.settings.server
  } catch (error) { say(error instanceof Error ? error.message : '读取系统代理状态失败') }
}

async function testProxy(): Promise<void> {
  testingProxy.value = true
  try {
    proxyStatus.value = await withOperation('正在测试网络连接', '通过当前代理设置请求官方版本源', () => window.envhub.network.testProxy())
    say(proxyStatus.value.reachable ? `连接正常 · ${proxyStatus.value.latencyMs} ms` : `连接失败 · ${proxyStatus.value.testError ?? '请检查代理设置'}`)
  } catch (error) { say(error instanceof Error ? error.message : '代理连接测试失败') }
  finally { testingProxy.value = false }
}

async function saveProxy(mode: 'system' | 'direct' | 'manual'): Promise<void> {
  busy.value = true
  try {
    proxyStatus.value = await window.envhub.network.setProxy({ mode, server: mode === 'manual' ? manualProxyServer.value.trim() : '' })
    snapshot.value = await window.envhub.app.getSnapshot()
    proxyModeDraft.value = null
    say('代理设置已应用；下载和版本查询将使用此连接')
  } catch (error) { say(error instanceof Error ? error.message : '代理设置失败') }
  finally { busy.value = false }
}

function statusLabel(status: DownloadTask['status']): string {
  return ({ queued: '等待中', downloading: '下载中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' })[status]
}

let lastSyncAt = 0
let syncInFlight: Promise<void> | null = null
async function syncCurrentFlags(): Promise<void> {
  if (operationDepth > 0) return
  if (Date.now() - lastSyncAt < 1000) return
  if (syncInFlight) return
  lastSyncAt = Date.now()
  syncInFlight = (async () => {
    try {
      await window.envhub.runtime.refreshCurrent()
      snapshot.value = await window.envhub.app.getSnapshot()
    } catch { /* 同步失败不打扰用户，下次聚焦再试 */ }
    finally { syncInFlight = null }
  })()
  await syncInFlight
}

function onWindowFocus(): void { void syncCurrentFlags() }
function onVisibilityChange(): void { if (document.visibilityState === 'visible') void syncCurrentFlags() }

function openDownloadDirectory(): void { void window.envhub.download.getDirectory() }function pauseTask(id: string): void { void window.envhub.download.pause(id) }
function resumeTask(id: string): void { void window.envhub.download.resume(id) }
function cancelTask(id: string): void { void window.envhub.download.cancel(id) }

async function removeTask(task: DownloadTask): Promise<void> {
  const deleteFile = task.source !== 'internal' || ['completed', 'failed', 'cancelled'].includes(task.status)
  const confirmed = await askConfirm({
    title: deleteFile ? '删除任务并删除文件？' : '删除任务记录？',
    lines: deleteFile ? [`文件：${task.fileName}`] : [`文件：${task.fileName}`, '已下载的文件会保留在下载目录。'],
    confirmText: '删除', danger: deleteFile
  })
  if (!confirmed) return
  try {
    await window.envhub.download.remove(task.id, deleteFile)
    snapshot.value = await window.envhub.app.getSnapshot()
    say('任务已删除')
  } catch (error) { say(error instanceof Error ? error.message : '删除任务失败') }
}

function statusClass(status: DownloadTask['status']): string {
  return status === 'completed' ? 'success' : status === 'failed' ? 'danger' : status === 'downloading' ? 'active' : 'quiet'
}

onMounted(async () => {
  systemThemeQuery.addEventListener('change', onSystemThemeChange)
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibilityChange)
  try {
    snapshot.value = await window.envhub.app.getSnapshot()
    void loadProxy()
    void loadHelperStatus()
    void syncCurrentFlags()
    // 启动后等首屏扫描安静下来再检查更新；失败不打扰用户，只有手动检查才回报结果。
    window.setTimeout(() => { void checkUpdate(false) }, 6000)
  } catch (error) { say(error instanceof Error ? error.message : 'EnvHub 初始化失败') }
  unsubscribeDownloads = window.envhub.download.onUpdate((task) => {
    if (!snapshot.value) return
    const index = snapshot.value.downloads.findIndex((item) => item.id === task.id)
    if (index < 0) snapshot.value.downloads.unshift(task)
    else snapshot.value.downloads[index] = task
  })
  unsubscribeSnapshot = window.envhub.onSnapshot((value) => { snapshot.value = value })
  unsubscribeProgress = window.envhub.onOperationProgress(onOperationProgress)
  unsubscribeNotice = window.envhub.onNotice((message) => say(message, 6000))
})

onUnmounted(() => {
  systemThemeQuery.removeEventListener('change', onSystemThemeChange)
  window.removeEventListener('focus', onWindowFocus)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  unsubscribeDownloads?.()
  unsubscribeSnapshot?.()
  unsubscribeProgress?.()
  unsubscribeNotice?.()
  if (noticeTimer) clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="app-frame">
    <aside :class="['sidebar', { collapsed: sidebarCollapsed }]">
      <div class="brand-row">
        <img class="brand-mark" :src="brandMark" alt="EnvHub" />
        <div class="brand-name">Env<span>Hub</span></div>
        <button class="sidebar-toggle" v-tip="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'" @click="toggleSidebar">{{ sidebarCollapsed ? '»' : '«' }}</button>
      </div>

      <div class="side-caption">工作区</div>
      <nav class="nav-list">
        <button :class="['nav-item', { selected: page === 'overview' }]" v-tip data-tip="概览" @click="page = 'overview'"><span class="nav-glyph"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/></svg></span><span>概览</span><span v-if="page === 'overview'" class="nav-dot"></span></button>
        <button :class="['nav-item', { selected: page === 'runtimes' }]" v-tip data-tip="环境与工具" @click="page = 'runtimes'"><span class="nav-glyph"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.4"/><path d="M7.5 9.5l3 3-3 3"/><path d="M13 15.5h4"/></svg></span><span>环境与工具</span><span class="nav-count">{{ installedCount }}</span></button>
        <button :class="['nav-item', { selected: page === 'downloads' }]" v-tip data-tip="下载" @click="page = 'downloads'"><span class="nav-glyph"><svg viewBox="0 0 24 24"><path d="M12 4v10"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/></svg></span><span>下载</span><span v-if="activeDownloads" class="nav-count accent-count">{{ activeDownloads }}</span></button>
      </nav>

      <div class="side-caption settings-caption">偏好设置</div>
      <nav class="nav-list">
        <button :class="['nav-item', { selected: page === 'settings' }]" v-tip data-tip="设置" @click="page = 'settings'"><span class="nav-glyph"><svg viewBox="0 0 24 24"><path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2.2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2.2"/></svg></span><span>设置</span></button>
      </nav>

      <div class="sidebar-bottom">
        <div class="build-label">EnvHub <span>{{ APP_VERSION }} · {{ APP_STAGE }}</span></div>
      </div>
    </aside>

    <main class="main-area">
      <header class="topbar">
        <div class="window-drag"></div>
        <div class="breadcrumb"><span>EnvHub</span><i>/</i><b>{{ page === 'overview' ? '概览' : page === 'runtimes' ? '环境与工具' : page === 'downloads' ? '下载' : '设置' }}</b></div>
      </header>

      <div class="content-scroll">
        <transition name="page" mode="out-in">
        <div :key="page" :class="{ 'page-transition-fill': page === 'runtimes' }">
        <section v-if="page === 'overview'" class="page-content">
          <section v-if="showUpdateBanner && updateInfo" class="update-banner surface-card">
            <div class="update-banner-icon">↑</div>
            <div class="update-banner-body">
              <div class="update-banner-title"><b>EnvHub {{ updateInfo.latestVersion }} 可用</b><span>当前 {{ updateInfo.currentVersion }} · {{ updateInfo.publishedAt ? new Date(updateInfo.publishedAt).toLocaleDateString('zh-CN') : '' }}</span></div>
              <ul v-if="updateInfo.notes.length" class="update-banner-notes"><li v-for="line in updateInfo.notes" :key="line">{{ line }}</li></ul>
              <div v-if="updateTask" class="update-banner-progress">
                <div class="progress-track"><i :class="{ indeterminate: !updateTask.totalBytes && updateTask.status === 'downloading' }" :style="{ width: `${updateTask.totalBytes ? progress(updateTask) : 30}%` }"></i></div>
                <span>{{ updateTaskStatusText }}</span>
              </div>
              <div v-else-if="updateAssetText" class="update-banner-asset">{{ updateAssetText }}</div>
            </div>
            <div class="update-banner-actions">
              <template v-if="updateTask && updateTask.status === 'completed'">
                <button class="button button-dark small-button" :disabled="installingUpdateId === updateTask.id" @click="installUpdate(updateTask)">{{ updateActionLabel(updateTask) }}</button>
              </template>
              <template v-else-if="updateTask && ['paused', 'failed', 'cancelled'].includes(updateTask.status)">
                <button class="button button-dark small-button" @click="resumeTask(updateTask.id)">继续下载</button>
              </template>
              <template v-else-if="updateTask">
                <button class="button button-outline small-button" @click="page = 'downloads'">查看下载</button>
              </template>
              <template v-else>
                <button class="button button-dark small-button" :disabled="updateBusy || !updateInfo.asset?.checksum" v-tip="updateInfo.blockedReason ?? ''" @click="downloadUpdate">应用内下载</button>
              </template>
              <button class="button button-outline small-button" @click="openReleasePage">浏览器下载 ↗</button>
              <button class="quiet-link" @click="updateBannerHidden = true">取消</button>
            </div>
            <button class="more-action update-banner-more" v-tip data-tip="忽略此版本（设置里可恢复）" @click="ignoreUpdate(updateInfo.latestVersion)">···</button>
          </section>
          <div class="cloud-page-heading">
            <div><div class="eyebrow"><span class="eyebrow-line"></span> TOOLCHAIN CLOUD</div><h1>开发环境</h1></div>
            <button class="button button-outline" :disabled="scanning" @click="scan">{{ scanning ? '扫描中…' : '扫描本机环境' }} <span>↻</span></button>
          </div>
          <section class="word-cloud-panel surface-card">
            <div class="word-cloud" aria-label="开发环境目录；彩色代表本机已发现，灰色代表尚未检测到">
              <button v-for="runtime in runtimeMeta" :key="runtime.id" :class="['cloud-word', { installed: versionsFor(runtime.id).length > 0 }]" :style="{ '--runtime-color': runtime.color, '--cloud-size': `${cloudFontSize(runtime.id)}px` }" v-tip="versionsFor(runtime.id).length ? `${runtime.name} ${highlightedVersion(runtime.id)?.version ?? ''}，点击管理` : `${runtime.name} 尚未检测到；点击查看官方信息`" @click="openRuntime(runtime.id)">
                <span class="cloud-word-name">{{ runtime.name }}</span>
                <span class="cloud-word-meta"><span :class="['status-led', { 'led-on': versionsFor(runtime.id).length > 0 }]" ></span><template v-if="versionsFor(runtime.id).length">{{ highlightedVersion(runtime.id)?.version }}<i>{{ versionsFor(runtime.id).length }}</i></template><template v-else>{{ snapshot?.lastScanAt ? '未发现' : '未扫描' }}</template></span>
              </button>
            </div>
            <footer class="word-cloud-footer"><span><span class="status-led" :class="snapshot?.lastScanAt ? 'led-on' : ''"></span>{{ snapshot?.lastScanAt ? `最近扫描 · ${formattedScan}` : '尚未扫描' }}</span><span>{{ installedCount }} 个版本</span><button class="text-link" @click="page = 'runtimes'">打开环境库 <span>→</span></button></footer>
          </section>
          <button v-if="activeDownloads" class="download-summary surface-card word-cloud-download" @click="page = 'downloads'"><span class="download-summary-icon">↓</span><span class="download-summary-copy"><b>{{ activeDownloads }} 个下载任务进行中</b><small>{{ activeDownloadTasks.map(task => `${taskTitle(task)} ${task.version}`).join(' · ') }}</small></span><span class="download-summary-link">查看队列 →</span></button>
        </section>

        <section v-else-if="page === 'runtimes'" class="page-content runtimes-page">
          <div class="page-title-row"><div><div class="eyebrow"><span class="eyebrow-line"></span> ENVIRONMENT LIBRARY</div><h1>环境与工具</h1><p class="lead">自动发现、手动登记，或浏览官方信息。</p></div><button class="button button-outline" :disabled="scanning" @click="scan">{{ scanning ? '扫描中…' : '↻ 重新扫描' }}</button></div>
          <div class="runtime-layout">
            <aside class="runtime-selector surface-card">
              <div class="runtime-search"><input v-model="runtimeSearch" type="search" placeholder="搜索环境或工具…" aria-label="搜索环境或工具" /></div>
              <div class="runtime-filter"><button :class="['filter-chip', { chosen: runtimeFilter === 'all' }]" @click="runtimeFilter = 'all'">全部</button><button :class="['filter-chip', { chosen: runtimeFilter === 'installed' }]" @click="runtimeFilter = 'installed'">已安装</button></div>
              <template v-for="group in groupedRuntimes" :key="group.id">
                <div class="runtime-group-label">{{ group.label }}</div>
                <button v-for="runtime in group.items" :key="runtime.id" :class="['runtime-select-item', { chosen: selectedRuntime === runtime.id }]" @click="openRuntime(runtime.id)">
                  <span class="runtime-icon small-icon" :style="{ '--runtime-color': runtime.color }">{{ runtime.glyph }}</span>
                  <span class="runtime-select-copy"><b>{{ runtime.name }}</b><small :class="{ muted: !currentVersionFor(runtime.id) }">{{ currentVersionFor(runtime.id) ?? '未安装' }}</small></span>
                  <i>›</i>
                </button>
              </template>
              <div v-if="!groupedRuntimes.length" class="runtime-search-empty">没有匹配的环境</div>
              <div class="selector-foot"><span class="status-led led-on"></span> 本机记录保存在此设备</div>
            </aside>

            <div class="runtime-detail">
              <section class="surface-card detail-header">
                <div class="detail-brand"><div class="runtime-icon large-icon" :style="{ '--runtime-color': selectedMeta.color }">{{ selectedMeta.glyph }}</div><div><div class="eyebrow small-eyebrow">{{ selectedMeta.subtitle }}</div><h2>{{ selectedMeta.name }}</h2></div></div>
                <div class="detail-state">
                  <span v-if="currentInstallation" class="current-badge">当前使用 {{ currentInstallation.version }}</span>
                  <span v-else class="source-badge">未检测到</span>
                  <button v-if="currentInstallation" class="path-chip" v-tip="currentInstallation.executablePath" @click="copyPath(currentInstallation.executablePath)"><span>{{ currentInstallation.executablePath }}</span><i>复制</i></button>
                </div>
                <div class="detail-actions"><button class="button button-soft" @click="registerManual(selectedRuntime)">＋ 手动登记</button></div>
              </section>

              <nav class="detail-tabs">
                <button :class="['detail-tab', { active: detailTab === 'versions' }]" @click="detailTab = 'versions'">版本 <span class="tab-count">{{ selectedInstallations.length }}</span></button>
                <button :class="['detail-tab', { active: detailTab === 'sources' }]" @click="detailTab = 'sources'">软件源</button>
                <button :class="['detail-tab', { active: detailTab === 'releases' }]" @click="detailTab = 'releases'">可用版本</button>
              </nav>

              <div class="tab-scroll">
                <section v-if="detailTab === 'versions'" class="tab-panel">
                  <div class="tab-panel-heading"><div><h3>本机版本 <span class="count-chip">{{ selectedInstallations.length }}</span></h3><p>存在多个版本时可切换当前使用的版本；切换会写入当前用户 PATH，可在设置中撤销。</p><p class="resolve-line">软件当前解析到：<span class="mono copyable" v-tip data-tip="点击复制" @click="copyPath(resolvedCurrentPath ?? '')">{{ resolvedCurrentPath ?? '未解析到可执行文件' }}</span></p></div></div>
                  <div v-if="selectedInstallations.length" class="installation-list surface-card">
                    <article v-for="installation in selectedInstallations" :key="installation.id" class="installation-row">
                      <div class="installation-status"><span class="status-led led-on"></span></div><div class="installation-main"><div class="installation-name"><b>{{ installation.runtimeId === 'jdk' && installation.javaKind === 'jre' ? 'Java Runtime' : selectedMeta.name }} {{ installation.version }}</b><span v-if="installation.isCurrent" class="current-badge">当前使用</span><span v-else-if="installation.isDefault" class="warn-badge" v-tip data-tip="已写入用户 PATH，但系统 PATH 中有优先级更高的同类目录，实际未生效；点击“使用此版本”可修复">未生效</span><span v-if="installation.javaKind === 'jre'" class="source-badge">JRE · 无编译器</span><span v-if="!installation.verified" class="source-badge">版本待确认</span><span :class="['source-badge', `source-${installation.source}`]">{{ installation.source === 'manual' ? '手动' : installation.source === 'managed' ? '托管' : 'PATH' }}</span></div><div class="installation-path copyable" v-tip="`${installation.executablePath}\n点击复制`" @click="copyPath(installation.executablePath)">{{ installation.executablePath }}</div></div><div class="installation-actions"><button v-if="installation.javaKind !== 'jre' && !installation.isCurrent" class="small-action" @click="activate(installation)">使用此版本</button><button v-if="installation.source === 'managed'" class="small-action danger-action" @click="uninstallRuntime(installation)">卸载</button><button v-if="installation.source === 'manual'" class="more-action" v-tip data-tip="从列表移除（不会卸载）" @click="removeManual(installation)">···</button></div>
                    </article>
                  </div>
                  <div v-else class="empty-state surface-card"><div class="empty-art"><span>{{ selectedMeta.glyph }}</span><i>?</i></div><h3>还没有发现 {{ selectedMeta.name }}</h3><p>扫描 PATH 和常见安装位置，或手动选择可执行文件登记。</p><button class="button button-soft" @click="registerManual(selectedRuntime)">选择可执行文件</button></div>
                </section>

                <section v-else-if="detailTab === 'sources'" class="tab-panel">
                  <div class="tab-panel-heading"><div><h3>{{ packageManagerLabel || '软件源' }}</h3><p v-if="activePackageManager && packageConfigReady">写入用户级配置，仅修改对应配置项，并保留 .bak 备份。</p><p v-else-if="activePackageManager">本机还没检测到 {{ selectedMeta.name }}，先安装或用「＋ 手动登记」登记后再配置。</p><p v-else>该环境暂未提供软件源或本地缓存配置项。</p></div></div>
                  <div v-if="packageConfigReady" class="mirror-card surface-card">
                    <div class="mirror-row"><input v-model="packageRegistry" class="mirror-input" spellcheck="false" placeholder="自定义软件源地址" /><button class="small-action" :disabled="packageBusy" @click="testPackageRegistry">测试连接</button><button class="button button-dark small-button" :disabled="packageBusy" @click="applyPackageRegistry()">应用</button></div>
                    <div class="mirror-current">当前：<span class="mono copyable" v-tip data-tip="点击复制" @click="copyPath(packageRegistry)">{{ packageRegistry || '未读取' }}</span></div>
                    <div class="mirror-presets"><button v-for="preset in packagePresetList" :key="preset.url" :class="['mirror-preset', { chosen: packageRegistry.startsWith(preset.url.replace(/\/$/, '')) }]" @click="applyPackageRegistry(preset.url)">{{ preset.label }}</button></div>
                    <div class="mirror-row mirror-cache"><input v-model="packageCacheDir" class="mirror-input" spellcheck="false" placeholder="本地缓存 / 仓库路径，例如 D:\\DevCache" /><button class="button button-dark small-button" :disabled="packageBusy" @click="applyPackageCacheDir">应用路径</button></div>
                    <div class="mirror-current">{{ activePackageManager === 'npm' ? 'npm cache 目录' : activePackageManager === 'pip' ? 'pip cache-dir 目录' : 'Maven localRepository' }}：<span class="mono copyable" v-tip data-tip="点击复制" @click="copyPath(packageCacheDir)">{{ packageCacheDir || '未读取' }}</span> <span v-if="packageCacheDir" class="mirror-tag">{{ packageCacheDirFromFile ? '已配置' : '默认位置' }}</span></div>
                  </div>
                  <div v-else-if="activePackageManager" class="empty-state surface-card"><div class="empty-art"><span>{{ selectedMeta.glyph }}</span><i>?</i></div><h3>尚未检测到 {{ selectedMeta.name }}</h3><p>本机没有找到 {{ selectedMeta.name }}，所以不显示默认的镜像与缓存地址——那只是工具的默认约定，不是你的配置。安装或用「＋ 手动登记」登记之后，这里才会显示 {{ packageConfigTarget }} 设置。</p><button class="button button-soft" @click="detailTab = 'releases'">查看可用版本</button></div>
                  <div v-else class="empty-state surface-card"><div class="empty-art"><span>{{ selectedMeta.glyph }}</span><i>·</i></div><h3>{{ selectedMeta.name }} 暂无可配置的软件源</h3><p>该环境暂未提供软件源或本地缓存配置项。</p></div>
                </section>

                <section v-else class="tab-panel">
                  <div class="tab-panel-heading"><div><h3>官方可用版本</h3><p>版本信息与校验值来自各项目官方发布源。</p></div><button class="quiet-link" :disabled="catalogLoading" @click="loadCatalog">{{ catalogLoading ? '读取中…' : catalog.length ? '↻ 刷新列表' : '获取版本列表' }}</button></div>
                  <div v-if="catalogLoading" class="catalog-loading surface-card"><span class="loader"></span> 正在从官方源读取版本与校验信息…</div>
                  <div v-else-if="catalog.length" class="catalog-list">
                    <article v-for="item in catalog" :key="`${item.version}-${item.architecture}`" class="catalog-card surface-card">
                      <div class="catalog-version"><span class="release-mark"></span><div><b>{{ item.version }}</b><small>{{ item.architecture === 'x64' ? 'Windows x64' : item.architecture === 'arm64' ? 'Windows ARM64' : 'Windows' }} <span v-if="item.checksum">· {{ item.checksum.algorithm.toUpperCase() }} 可验证</span></small></div></div>
                      <p>{{ item.note }}</p>
                      <div class="catalog-actions"><button class="button button-outline small-button" @click="copyLink(item)">复制{{ item.downloadUrl ? '直链' : '官网链接' }}</button><button v-if="item.downloadUrl" class="button button-outline small-button" @click="openDownloadLink(item)">浏览器下载 ↗</button><button v-if="item.downloadUrl && item.checksum" class="button button-outline small-button" @click="handleManualFile(item)">导入并校验</button><button v-if="item.installSupported" class="button button-dark small-button" @click="startDownload(item)">应用内下载 <span>↓</span></button><button v-else class="button button-dark small-button" @click="openOfficial(selectedRuntime)">打开官方网站 <span>↗</span></button></div>
                    </article>
                  </div>
                  <div v-else class="catalog-placeholder surface-card"><span class="catalog-orbit">↗</span><div><b>尚未读取版本列表</b><small>使用右上方的“获取版本列表”读取官方发布信息。</small></div></div>
                  <div class="managed-warning"><span>i</span><p>下载归档不等于安装：只有来自官方源、且带校验值的归档才会开放应用内安装，安装过程也不会执行安装包里的脚本。</p></div>
                </section>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="page === 'downloads'" class="page-content">
          <div class="page-title-row"><div><div class="eyebrow"><span class="eyebrow-line"></span> DOWNLOAD CENTER</div><h1>下载任务</h1><p class="lead">应用内下载支持暂停与断点续传，也可以复制官方链接自行下载并校验导入。</p></div><div class="title-actions"><button class="button button-dark" @click="openDownloadDirectory">打开下载目录 ↗</button></div></div>
          <div class="download-explainer surface-card"><div class="download-explainer-icon">↯</div><div><b>系统代理已接入</b><p>{{ proxyStatus?.resolution ?? '读取当前系统代理…' }}<span> · 可在设置中切换系统代理、直连或自定义代理</span></p></div><button class="quiet-link" @click="page = 'settings'">代理设置 →</button></div>
          <div class="download-list surface-card" v-if="downloads.length">
            <article v-for="task in downloads" :key="task.id" class="download-row">
              <div class="download-file-icon" :class="statusClass(task.status)">{{ task.status === 'completed' ? '✓' : task.status === 'failed' ? '!' : '↓' }}</div>
              <div class="download-content"><div class="download-title-row"><div class="download-title">{{ taskTitle(task) }} <span>{{ task.version }}</span><span v-if="task.kind === 'app'" class="source-badge">更新包</span></div><span :class="['task-status', statusClass(task.status)]">{{ statusLabel(task.status) }}</span></div><div class="download-progress-line"><div class="progress-track large-progress"><i :class="{ indeterminate: !task.totalBytes && task.status === 'downloading' }" :style="{ width: `${task.totalBytes ? progress(task) : 30}%` }"></i></div><span>{{ formatBytes(task.receivedBytes) }}<template v-if="task.totalBytes"> / {{ formatBytes(task.totalBytes) }}</template></span></div><div v-if="task.error" class="download-error">{{ task.error }}</div><div v-else-if="task.warning" class="download-warning">{{ task.warning }}</div><div class="download-meta"><span class="mono copyable" v-tip="`${task.filePath}\n点击复制`" @click="copyPath(task.filePath)">{{ task.source === 'manual' ? (task.warning ? '浏览器下载 · 仅本地校验' : '浏览器下载 · 已校验') : task.status === 'downloading' ? `${formatBytes(task.speedBytesPerSecond)}/s` : task.fileName }}</span><span v-if="task.status === 'downloading' && task.totalBytes">{{ progress(task) }}%</span><span v-else class="mono">{{ new Date(task.createdAt).toLocaleDateString('zh-CN') }}</span></div></div>
              <div class="download-actions"><button v-if="task.status === 'downloading' || task.status === 'queued'" class="small-action" @click="pauseTask(task.id)">暂停</button><button v-else-if="['paused', 'failed', 'cancelled'].includes(task.status)" class="small-action" @click="resumeTask(task.id)">{{ task.status === 'failed' ? '重试 / 续传' : '继续下载' }}</button><button v-if="task.status === 'completed' && task.kind === 'runtime' && task.runtimeId && isInstallableRuntime(task.runtimeId) && !isInstalled(task)" class="button button-dark small-button" :disabled="Boolean(installingTaskId)" @click="installTask(task)">{{ installingTaskId === task.id ? '安装中…' : '安装' }}</button><span v-else-if="task.status === 'completed' && task.kind === 'runtime' && isInstalled(task)" class="installed-hint">已安装</span><button v-if="task.status === 'completed' && task.kind === 'app'" class="button button-dark small-button" :disabled="installingUpdateId === task.id" @click="installUpdate(task)">{{ updateActionLabel(task) }}</button><button v-if="!['completed', 'cancelled'].includes(task.status)" class="more-action" v-tip data-tip="取消并保留已下载部分" @click="cancelTask(task.id)">×</button><button class="more-action" v-tip data-tip="复制来源链接" @click="copyTaskLink(task)">↗</button><button class="more-action" v-tip data-tip="删除任务" @click="removeTask(task)">✕</button></div>
            </article>
          </div>
          <div v-else class="empty-download surface-card"><div class="download-empty-orbit"><span>↓</span><i></i></div><h2>下载列表是空的</h2><p>在环境与工具库选择版本开始下载，或复制官方直链后用浏览器下载。</p><button class="button button-dark" @click="page = 'runtimes'">浏览可用版本 <span>→</span></button></div>
          <p class="download-footnote">下载文件保存在本机应用数据目录。校验失败的文件会被删除；应用关闭后，未完成任务可继续下载。</p>
        </section>

        <section v-else class="page-content">
          <div class="page-title-row"><div><div class="eyebrow"><span class="eyebrow-line"></span> PREFERENCES</div><h1>设置</h1><p class="lead">EnvHub 以本机数据为主，网络设置只影响应用内请求。</p></div></div>
          <div class="settings-layout">
            <div class="settings-main">
              <section class="settings-card surface-card"><div class="settings-card-heading"><div class="settings-icon">◐</div><div><h3>外观</h3><p>选择适合你工作环境的显示模式。</p></div></div><div class="theme-picker"><button v-for="mode in (['light', 'dark', 'system'] as ThemeMode[])" :key="mode" :class="['theme-option', { chosen: snapshot?.theme === mode }]" @click="setTheme(mode)"><div :class="['theme-preview', `preview-${mode}`]"><span></span><i></i><b></b></div><span>{{ mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统' }}</span><i v-if="snapshot?.theme === mode" class="chosen-check">✓</i></button></div></section>
              <section class="settings-card surface-card"><div class="settings-card-heading"><div class="settings-icon">🔑</div><div><h3>管理权限</h3><p>切换需要修改系统 PATH 的版本时，默认每次都会请求管理员授权。</p></div><span class="settings-live" :class="{ 'is-off': !helperEnabled }"><i></i>{{ helperEnabled ? '已启用一次性授权' : '未启用' }}</span></div>
                <div class="proxy-modes"><button v-if="!helperEnabled" class="proxy-mode wide" @click="enableHelper"><span><b>启用一次性授权</b><small>创建仅用于修改系统 PATH 的计划任务，之后切换不再弹 UAC</small></span></button><button v-else class="proxy-mode wide" @click="disableHelper"><span><b>撤销授权</b><small>删除计划任务，恢复为每次操作请求管理员确认</small></span></button></div>
              </section>
              <section class="settings-card surface-card"><div class="settings-card-heading"><div class="settings-icon proxy-icon">↯</div><div><h3>网络与代理</h3><p>版本查询与应用内下载使用 Chromium 网络栈，支持系统代理和 PAC。</p></div><span class="settings-live"><i></i>已接入</span></div>
                <div class="proxy-modes"><button :class="['proxy-mode', { chosen: shownProxyMode === 'system' }]" @click="saveProxy('system')"><span><b>使用系统代理</b><small>自动读取 Windows 代理 / PAC 配置</small></span></button><button :class="['proxy-mode', { chosen: shownProxyMode === 'direct' }]" @click="saveProxy('direct')"><span><b>直接连接</b><small>不经过代理服务器</small></span></button><button :class="['proxy-mode', { chosen: shownProxyMode === 'manual' }]" @click="proxyModeDraft = 'manual'"><span><b>自定义代理</b><small>HTTP(S) 或 SOCKS 代理地址</small></span></button></div>
                <div v-if="shownProxyMode === 'manual'" class="manual-proxy"><label for="proxy-server">代理服务器地址</label><div class="input-action"><input id="proxy-server" v-model="manualProxyServer" placeholder="http://127.0.0.1:7890" /><button class="button button-dark small-button" :disabled="busy" @click="saveProxy('manual')">应用</button></div><small>例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080。暂不保存代理账号密码。</small></div>
                <div class="proxy-diagnostic"><span :class="['diagnostic-pulse', { 'pulse-error': proxyStatus?.reachable === false, 'pulse-good': proxyStatus?.reachable }]" ></span><div><b>连接路由</b><small>{{ proxyStatus?.resolution ?? '正在读取代理解析结果…' }}<template v-if="proxyStatus?.reachable"> · {{ proxyStatus.latencyMs }} ms</template><template v-else-if="proxyStatus?.reachable === false"> · {{ proxyStatus.testError }}</template></small></div><button class="quiet-link" :disabled="testingProxy" @click="testProxy">{{ testingProxy ? '检测中…' : '连接测试 ↻' }}</button></div>
              </section>
              <section class="settings-card surface-card"><div class="settings-card-heading"><div class="settings-icon">↑</div><div><h3>关于与更新</h3><p>检查本仓库 GitHub Releases 上的正式版本；更新包在应用内下载后由你确认安装。</p></div><span class="settings-live" :class="{ 'is-off': !updateState || updateState.state === 'failed' }"><i></i>{{ updateState?.state === 'available' ? '有新版本' : updateState?.state === 'latest' ? '已是最新' : updateState?.state === 'failed' ? '检查失败' : '尚未检查' }}</span></div>
                <div class="data-path"><span>当前版本</span><span class="mono">{{ APP_VERSION }} · {{ APP_STAGE }}</span><span class="data-desc">使用形态：{{ updateFormText }}</span></div>
                <div class="data-path"><span>线上版本</span><span class="mono">{{ updateState?.info?.latestVersion ?? '—' }}</span><button class="quiet-link" :disabled="updateChecking" @click="checkUpdate(true, true)">{{ updateChecking ? '检查中…' : '检查更新 ↻' }}</button></div>
                <div class="data-path"><span>检查结果</span><span class="data-desc">{{ updateCheckText }}</span><span class="data-desc">{{ updateCheckedText }}</span></div>
                <template v-if="updateInfo">
                  <ul v-if="updateInfo.notes.length" class="update-notes"><li v-for="line in updateInfo.notes" :key="line">{{ line }}</li></ul>
                  <div class="update-actions">
                    <template v-if="updateTask && updateTask.status === 'completed'">
                      <button class="button button-dark small-button" :disabled="installingUpdateId === updateTask.id" @click="installUpdate(updateTask)">{{ updateActionLabel(updateTask) }}</button>
                    </template>
                    <template v-else-if="updateTask && ['paused', 'failed', 'cancelled'].includes(updateTask.status)">
                      <button class="button button-dark small-button" @click="resumeTask(updateTask.id)">继续下载</button>
                    </template>
                    <template v-else-if="updateTask">
                      <button class="button button-outline small-button" @click="page = 'downloads'">查看下载进度</button>
                    </template>
                    <template v-else>
                      <button class="button button-dark small-button" :disabled="updateBusy || !updateInfo.asset?.checksum" v-tip="updateInfo.blockedReason ?? ''" @click="downloadUpdate">应用内下载</button>
                    </template>
                    <button class="button button-outline small-button" @click="openReleasePage">打开发布页面 ↗</button>
                    <span v-if="updateInfo.asset" class="data-desc">{{ updateAssetText }}</span>
                  </div>
                </template>
                <div v-if="ignoredUpdateVersions.length" class="update-actions"><span class="data-desc">已忽略：<span class="mono">{{ ignoredUpdateVersions.join('、') }}</span></span><button class="quiet-link" @click="restoreIgnoredUpdates">恢复提示 ↻</button></div>
                <div class="settings-foot">更新包来自本仓库的 GitHub Releases，下载后按官方 SHA-256 校验；不会静默安装，也不会改动已装好的运行环境与清单。</div>
              </section>
              <section class="settings-card surface-card"><div class="settings-card-heading"><div class="settings-icon">⌂</div><div><h3>本机数据</h3><p>运行时、下载文件和清单都存在本机；可以换到其他磁盘。</p></div></div><div class="data-path"><span>数据目录</span><span class="mono copyable" v-tip data-tip="点击复制" @click="copyPath(snapshot?.managedRoot ?? '')">{{ snapshot?.managedRoot }}</span><button class="quiet-link" @click="changeStorageRoot">更改 →</button></div><div class="data-path"><span>下载目录</span><span class="mono copyable" v-tip data-tip="点击复制" @click="copyPath(downloadDirectory)">{{ downloadDirectory }}</span><button class="quiet-link" @click="openDownloadDirectory">打开 →</button></div><div v-if="snapshot?.pathBackups?.length" class="data-path"><span>PATH 备份</span><span class="data-desc">最近一次修改 · <span class="mono">{{ new Date(snapshot.pathBackups[snapshot.pathBackups.length - 1].at).toLocaleString('zh-CN') }}</span></span><button class="quiet-link" @click="undoLastPathChange">撤销修改 →</button></div><div class="data-path"><span>环境变量</span><span class="data-desc">清理用户 PATH 中的重复项与失效目录</span><button class="quiet-link" @click="repairPath">修复 PATH →</button></div><div class="settings-foot">不创建账户或上传扫描清单。在线查询时仅请求官方公开版本目录。</div></section>
            </div>
          </div>
        </section>
        </div>
        </transition>
      </div>
    </main>
    <transition name="modal"><div v-if="confirmDialog" class="modal-backdrop" @click.self="closeConfirm(false)" @keydown.esc="closeConfirm(false)"><div ref="confirmCard" class="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" tabindex="-1"><h3 id="confirm-title">{{ confirmDialog.title }}</h3><p v-for="line in confirmDialog.lines" :key="line" class="modal-line">{{ line }}</p><div class="modal-actions"><button class="button button-outline" @click="closeConfirm(false)">{{ confirmDialog.cancelText ?? '取消' }}</button><button :class="['button', confirmDialog.danger ? 'button-danger' : 'button-dark']" @click="closeConfirm(true)">{{ confirmDialog.confirmText ?? '确定' }}</button></div></div></div></transition>
    <transition name="toast"><div v-if="tooltip" :class="['custom-tooltip', { below: tooltip.below }]" :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }">{{ tooltip.text }}</div></transition>
    <transition name="toast"><div v-if="operation" class="operation-banner"><span class="loader"></span><div class="operation-body"><b>{{ operation.title }}</b><small v-if="operation.detail">{{ operation.detail }}</small><div v-if="typeof operation.percent === 'number'" class="operation-track"><i :style="{ width: `${operation.percent}%` }"></i></div></div></div></transition>
    <transition name="toast"><div v-if="notice" class="toast-message"><span>✳</span>{{ notice }}</div></transition>
  </div>
</template>
