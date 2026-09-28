import { BrowserWindow, dialog, net, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ChecksumAlgorithm, DownloadTask, RuntimeCatalogItem } from '../../shared/contracts'
import { isAllowedDownloadHost } from '../../shared/downloadHosts'
import { APP_VERSION } from '../../shared/appInfo'
import { store } from '../storage/store'
import { validateProviderAsset } from '../runtime/service'

const active = new Map<string, AbortController>()
const pending = new Set<string>()
// 长时间收不到数据的任务：中止后要判失败，而不是像用户暂停那样静默退出。
const stalled = new Set<string>()
const concurrency = 3
const stallTimeout = 60_000
const userAgent = `EnvHub/${APP_VERSION}`

async function ensureDownloadsDirectory(): Promise<string> {
  const root = store.snapshot().managedRoot
  await mkdir(root, { recursive: true })
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('EnvHub 托管根目录不能是链接或非目录')
  const folder = join(root, 'downloads')
  await mkdir(folder, { recursive: true })
  const folderInfo = await lstat(folder)
  if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) throw new Error('下载目录不能是链接或非目录')
  return folder
}

function publish(task: DownloadTask): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('download:update', task)
}

function update(task: DownloadTask, patch: Partial<DownloadTask>, persist = false): void {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() })
  publish(task)
  if (persist && store.snapshot().downloads.some((item) => item.id === task.id)) void store.upsertDownload(task)
}

function safeName(fileName: string): string {
  const ext = extname(fileName).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12)
  const stem = basename(fileName, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || 'runtime-download'
  return `${stem}${ext || '.download'}`
}

function allowedFinalHost(item: RuntimeCatalogItem, url: string): boolean {
  return isAllowedDownloadHost(item.runtimeId, url)
}

async function hashFile(path: string, algorithm: ChecksumAlgorithm): Promise<string> {
  const hash = createHash(algorithm)
  const { createReadStream } = await import('node:fs')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function transfer(task: DownloadTask, item: RuntimeCatalogItem, controller: AbortController): Promise<void> {
  await ensureDownloadsDirectory()
  let offset = 0
  try {
    const existing = await lstat(task.filePath)
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('下载目标不是普通文件')
    offset = existing.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (offset > 0 && task.totalBytes !== null && offset === task.totalBytes && item.checksum) {
    const actual = await hashFile(task.filePath, item.checksum.algorithm)
    if (actual.toLowerCase() === item.checksum.value) {
      task.receivedBytes = offset
      update(task, { status: 'completed', receivedBytes: offset, totalBytes: offset, speedBytesPerSecond: 0 }, true)
      return
    }
    await unlink(task.filePath).catch(() => undefined)
    offset = 0
  }

  const headers: Record<string, string> = { 'User-Agent': userAgent }
  if (offset > 0) headers.Range = `bytes=${offset}-`
  let requestUrl = item.downloadUrl!
  let response: Response | undefined
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(requestUrl)
    if (parsed.protocol !== 'https:' || !allowedFinalHost(item, requestUrl)) throw new Error('下载重定向到了未授权域名，已阻止')
    response = await net.fetch(requestUrl, { headers, signal: controller.signal, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location || redirects === 5) throw new Error('下载重定向次数过多或缺少目标地址')
    await response.body?.cancel()
    requestUrl = new URL(location, requestUrl).toString()
  }
  if (!response) throw new Error('下载请求未返回响应')
  if (!response.ok && response.status !== 206) throw new Error(`下载请求失败（HTTP ${response.status}）`)

  const append = offset > 0 && response.status === 206
  if (append) {
    const rangeStart = response.headers.get('content-range')?.match(/^bytes (\d+)-/i)?.[1]
    if (!rangeStart || Number(rangeStart) !== offset) throw new Error('服务器续传位置与本地文件不一致；已停止续传')
  }
  if (offset > 0 && !append) offset = 0
  const range = response.headers.get('content-range')?.match(/\/(\d+)$/)
  const contentLength = Number(response.headers.get('content-length'))
  const totalBytes = range ? Number(range[1]) : Number.isFinite(contentLength) && contentLength > 0 ? contentLength + offset : null
  update(task, { status: 'downloading', receivedBytes: offset, totalBytes }, true)
  if (!response.body) throw new Error('下载服务器未返回文件内容')

  let lastEmit = Date.now()
  let lastBytes = offset
  let lastActivity = Date.now()
  // 连接卡住时不要永远停在"下载中"：超过 60 秒没有任何数据就中止并判失败，已下载部分保留，方便重试续传。
  const stallTimer = setInterval(() => {
    if (Date.now() - lastActivity > stallTimeout) {
      clearInterval(stallTimer)
      stalled.add(task.id)
      controller.abort()
    }
  }, 5_000)
  const source = Readable.fromWeb(response.body as never)
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      task.receivedBytes += chunk.length
      lastActivity = Date.now()
      const now = Date.now()
      if (now - lastEmit >= 350) {
        const speed = (task.receivedBytes - lastBytes) / ((now - lastEmit) / 1000)
        update(task, { receivedBytes: task.receivedBytes, totalBytes, speedBytesPerSecond: Math.max(0, speed) })
        lastEmit = now
        lastBytes = task.receivedBytes
      }
      callback(null, chunk)
    }
  })
  try {
    await pipeline(source, meter, createWriteStream(task.filePath, { flags: append ? 'a' : 'w' }), { signal: controller.signal })
  } finally {
    clearInterval(stallTimer)
  }

  if (item.checksum) {
    const actual = await hashFile(task.filePath, item.checksum.algorithm)
    if (actual.toLowerCase() !== item.checksum.value) {
      await unlink(task.filePath).catch(() => undefined)
      throw new Error(`${item.checksum.algorithm.toUpperCase()} 校验失败，文件已删除`)
    }
  }
  update(task, { status: 'completed', receivedBytes: task.receivedBytes, totalBytes: task.totalBytes ?? task.receivedBytes, speedBytesPerSecond: 0 }, true)
}

function pump(): void {
  while (active.size < concurrency && pending.size > 0) {
    const id = pending.values().next().value as string | undefined
    if (!id) return
    if (active.has(id)) return
    pending.delete(id)
    const task = store.snapshot().downloads.find((item) => item.id === id)
    if (!task || !['queued', 'paused'].includes(task.status)) continue
    void run(task)
  }
}

async function run(task: DownloadTask): Promise<void> {
  // The task metadata is revalidated by IPC before enqueue. Runtime catalogs are not accepted from arbitrary renderer URLs.
  const item: RuntimeCatalogItem = {
    runtimeId: task.runtimeId, version: task.version,
    architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
    downloadUrl: task.url, checksum: task.checksum, fileName: task.fileName,
    pageUrl: '', installSupported: true
  }
  const controller = new AbortController()
  active.set(task.id, controller)
  try {
    await transfer(task, item, controller)
  } catch (error) {
    if (controller.signal.aborted) {
      // 用户暂停/取消：保持原状态；超时中止：判为失败，保留已下载部分以便续传。
      if (stalled.has(task.id)) {
        stalled.delete(task.id)
        update(task, { status: 'failed', error: '长时间没有收到数据，已停止下载；可点「重试 / 续传」继续', speedBytesPerSecond: 0 }, true)
      }
      return
    }
    const current = store.snapshot().downloads.find((entry) => entry.id === task.id)
    if (current?.status === 'paused' || current?.status === 'cancelled') return
    update(task, { status: 'failed', error: error instanceof Error ? error.message : String(error), speedBytesPerSecond: 0 }, true)
  } finally {
    stalled.delete(task.id)
    active.delete(task.id)
    pump()
  }
}

export async function startDownload(item: RuntimeCatalogItem): Promise<DownloadTask> {
  validateProviderAsset(item)
  const pendingCount = store.snapshot().downloads.filter((task) => ['queued', 'downloading', 'paused'].includes(task.status)).length
  if (pendingCount >= 20) throw new Error('下载队列已满，请先完成或取消现有任务')
  const id = randomUUID()
  const fileName = safeName(item.fileName ?? new URL(item.downloadUrl!).pathname.split('/').pop() ?? `${item.runtimeId}-${item.version}.zip`)
  const task: DownloadTask = {
    id, runtimeId: item.runtimeId, version: item.version, url: item.downloadUrl!, fileName,
    filePath: join(store.snapshot().managedRoot, 'downloads', `${id}-${fileName}`),
    status: 'queued', receivedBytes: 0, totalBytes: null, speedBytesPerSecond: 0,
    checksum: item.checksum, source: 'internal', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }
  await store.upsertDownload(task)
  pending.add(id)
  publish(task)
  pump()
  return task
}

export async function pauseDownload(id: string): Promise<void> {
  const task = store.snapshot().downloads.find((item) => item.id === id)
  if (!task || !['queued', 'downloading'].includes(task.status)) return
  pending.delete(id)
  update(task, { status: 'paused', speedBytesPerSecond: 0 }, true)
  active.get(id)?.abort()
}

export async function resumeDownload(id: string): Promise<void> {
  const task = store.snapshot().downloads.find((item) => item.id === id)
  if (!task || !['paused', 'failed', 'cancelled'].includes(task.status)) return
  update(task, { status: 'queued', error: undefined }, true)
  pending.add(id)
  pump()
}

export async function cancelDownload(id: string): Promise<void> {
  const task = store.snapshot().downloads.find((item) => item.id === id)
  if (!task || ['completed', 'cancelled'].includes(task.status)) return
  pending.delete(id)
  update(task, { status: 'cancelled', speedBytesPerSecond: 0 }, true)
  active.get(id)?.abort()
}

export async function importDownloadedFile(item: RuntimeCatalogItem): Promise<DownloadTask | null> {
  const result = await dialog.showOpenDialog({
    title: `选择已下载的 ${item.runtimeId} ${item.version} ZIP`,
    properties: ['openFile'],
    filters: [{ name: 'ZIP 归档', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const sourcePath = result.filePaths[0]
  if (extname(sourcePath).toLowerCase() !== '.zip') throw new Error('此导入流程仅接受 ZIP 归档')
  const sourceInfo = await lstat(sourcePath)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('请选择普通 ZIP 文件，不能导入链接或特殊文件')
  if (sourceInfo.size > 8 * 1024 ** 3) throw new Error('文件超过 8 GB 导入上限')
  const folder = await ensureDownloadsDirectory()
  const id = randomUUID()
  const fileName = safeName(item.fileName ?? basename(sourcePath))
  const filePath = join(folder, `${id}-${fileName}`)
  await copyFile(sourcePath, filePath, constants.COPYFILE_EXCL)
  const stagedInfo = await stat(filePath)
  // 只算一次哈希：有官方校验值就按官方算法，否则记为本地 SHA-256。
  const algorithm: ChecksumAlgorithm = item.checksum?.algorithm ?? 'sha256'
  const actualHash = await hashFile(filePath, algorithm)
  if (item.checksum && actualHash !== item.checksum.value) {
    await unlink(filePath).catch(() => undefined)
    throw new Error(`${algorithm.toUpperCase()} 与官方发布值不匹配；导入副本已删除`)
  }
  const task: DownloadTask = {
    id, runtimeId: item.runtimeId, version: item.version, url: item.downloadUrl ?? item.pageUrl,
    fileName, filePath, status: 'completed', receivedBytes: stagedInfo.size, totalBytes: stagedInfo.size,
    speedBytesPerSecond: 0, checksum: item.checksum ?? { algorithm: 'sha256', value: actualHash }, source: 'manual',
    warning: item.checksum ? undefined : '没有官方校验值，只记录了本地 SHA-256；来源未经验证。',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }
  await store.upsertDownload(task)
  publish(task)
  return task
}

export async function removeDownload(id: string, deleteFile: boolean): Promise<void> {
  const task = store.snapshot().downloads.find((item) => item.id === id)
  if (!task) return
  if (['queued', 'downloading', 'paused'].includes(task.status)) await cancelDownload(id)
  const removed = await store.removeDownload(id)
  if (deleteFile && removed) await unlink(removed.filePath).catch(() => undefined)
}

export async function openDownloadDirectory(): Promise<void> {
  const folder = await ensureDownloadsDirectory()
  await shell.openPath(folder)
}

export function recoverDownloads(): void {
  for (const task of store.snapshot().downloads) {
    if (task.status === 'downloading' || task.status === 'queued') {
      task.status = 'paused'
      task.speedBytesPerSecond = 0
      task.updatedAt = new Date().toISOString()
      void store.upsertDownload(task)
    }
  }
}
