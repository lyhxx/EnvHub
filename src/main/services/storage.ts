import { createReadStream, createWriteStream } from 'node:fs'
import { access, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { BrowserWindow } from 'electron'
import { store } from '../storage/store'
import { readUserPath, removeManagedPath } from './environment'

export interface ManagedRootChangeResult {
  root: string
  moved: boolean
  rewritten: number
  cleanedPathEntries: number
}

function emitMoveProgress(percent: number, detail: string): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('operation:progress', { percent, detail })
}

interface FileEntry { path: string; size: number }

async function listFiles(root: string, relative = ''): Promise<FileEntry[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  const files: FileEntry[] = []
  for (const entry of entries) {
    const next = relative ? join(relative, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, next))
    } else if (entry.isFile()) {
      const info = await lstat(join(root, next))
      files.push({ path: next, size: info.size })
    }
    // 链接与特殊文件跳过：复制后可能失效，宁可少复制也不要产生坏数据。
  }
  return files
}

async function copyTreeWithProgress(from: string, to: string, label: string): Promise<void> {
  const files = await listFiles(from)
  const total = files.reduce((sum, file) => sum + file.size, 0) || 1
  let copied = 0
  let lastEmit = 0
  emitMoveProgress(0, `正在复制 ${label}…`)
  for (const file of files) {
    const target = join(to, file.path)
    await mkdir(dirname(target), { recursive: true })
    await pipeline(createReadStream(join(from, file.path)), createWriteStream(target))
    copied += file.size
    const now = Date.now()
    if (now - lastEmit > 400 || copied === total) {
      lastEmit = now
      const mb = (copied / 1024 / 1024).toFixed(0)
      emitMoveProgress(Math.min(99, Math.round((copied / total) * 100)), `正在复制 ${label}… 已写入 ${mb} MB`)
    }
  }
  await rm(from, { recursive: true, force: true })
  emitMoveProgress(100, `${label} 复制完成`)
}

function normalize(value: string): string {
  return value.replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length === 0
  } catch {
    return false
  }
}

// 拒绝驱动器根目录与系统目录，避免把 runtimes / downloads 建到这些位置。
const forbiddenRootPatterns = [
  /^[a-z]:$/i,
  /^[a-z]:[\\/]windows$/i,
  /^[a-z]:[\\/]program files$/i,
  /^[a-z]:[\\/]program files \(x86\)$/i,
  /^[a-z]:[\\/]programdata$/i,
  /^[a-z]:[\\/]users$/i,
  /^[a-z]:[\\/]windows[\\/]system32$/i
]

function assertUsableRoot(root: string): void {
  if (!/^[a-zA-Z]:[\\/]/.test(root) || root.includes('..') || root.length > 180) throw new Error('请选择有效的本地目录')
  if (forbiddenRootPatterns.some((pattern) => pattern.test(root))) {
    throw new Error('不能使用驱动器根目录或系统目录，请新建一个专用文件夹，例如 D:\\EnvHub')
  }
}

export async function changeManagedRoot(nextRoot: string, moveExisting: boolean): Promise<ManagedRootChangeResult> {
  const root = nextRoot.trim().replace(/[\\/]+$/, '')
  assertUsableRoot(root)
  const previousRoot = store.snapshot().managedRoot
  if (normalize(previousRoot) === normalize(root)) throw new Error('新位置与当前位置相同')

  await mkdir(root, { recursive: true })
  try {
    const probe = join(root, '.envhub-write-test')
    await writeFile(probe, 'ok', 'utf8')
    await rm(probe, { force: true })
  } catch {
    throw new Error('该目录不可写，请换一个位置')
  }

  const children = ['runtimes', 'downloads', 'privileged']
  let moved = false
  if (moveExisting) {
    for (const child of children) {
      const from = join(previousRoot, child)
      const to = join(root, child)
      try { await access(from) } catch { continue }
      try { await access(to) } catch { continue /* 目标不存在，可以移动 */ }
      if (await isEmptyDirectory(to)) {
        await rm(to, { recursive: true, force: true })
        continue
      }
      throw new Error(`目标目录中已存在非空的 ${child} 文件夹：${to}\n请清空它，或改选其他目录`)
    }
    for (const child of children) {
      const from = join(previousRoot, child)
      const to = join(root, child)
      try { await access(from) } catch { continue }
      try {
        await rename(from, to)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTEMPTY') {
          // 跨盘或无法原子重命名：降级为带进度的复制 + 删除源目录。
          await copyTreeWithProgress(from, to, child)
        } else {
          throw new Error(`移动 ${child} 失败：${code ?? '未知错误'}`)
        }
      }
    }
    moved = true
  }

  await store.setManagedRoot(root, previousRoot)

  let rewritten = 0
  let cleanedPathEntries = 0
  if (moved) {
    const fromPrefix = `${normalize(previousRoot)}\\`
    const rewrite = (value: string): string => join(root, value.slice(previousRoot.length).replace(/^[\\/]+/, ''))
    const installations = store.snapshot().installations.map((item) => {
      if (item.source !== 'managed' || !item.managedDir) return item
      if (!normalize(item.managedDir).startsWith(fromPrefix)) return item
      rewritten += 1
      return { ...item, managedDir: rewrite(item.managedDir), executablePath: rewrite(item.executablePath) }
    })
    if (rewritten) await store.setInstallations(installations, false)

    for (const [runtimeId, directory] of Object.entries(store.snapshot().managedPaths)) {
      if (!directory || !normalize(directory).startsWith(fromPrefix)) continue
      await store.setManagedPath(runtimeId as Parameters<typeof removeManagedPath>[0], rewrite(directory), {
        at: new Date().toISOString(), previousPath: await readUserPathSafe(), appliedPath: await readUserPathSafe()
      })
      cleanedPathEntries += 1
    }

    // 下载文件的落盘路径与 PATH 备份里的旧目录同样要跟着搬，否则安装和撤销都会指向已经不存在的路径。
    const pathPattern = new RegExp(escapeRegExp(previousRoot).replace(/[\\/]/g, '[\\\\/]'), 'gi')
    const replaceRoot = (value: string): string => value.replace(pathPattern, root)
    await store.setDownloads(store.snapshot().downloads.map((task) => ({
      ...task,
      filePath: join(root, 'downloads', `${task.id}-${task.fileName}`)
    })))
    await store.setPathBackups(store.snapshot().pathBackups.map((backup) => ({
      ...backup,
      previousPath: replaceRoot(backup.previousPath),
      appliedPath: replaceRoot(backup.appliedPath),
      ...(backup.previousJavaHome ? { previousJavaHome: replaceRoot(backup.previousJavaHome) } : {}),
      ...(backup.appliedJavaHome ? { appliedJavaHome: replaceRoot(backup.appliedJavaHome) } : {}),
      ...(backup.previousMachinePath ? { previousMachinePath: replaceRoot(backup.previousMachinePath) } : {}),
      ...(backup.appliedMachinePath ? { appliedMachinePath: replaceRoot(backup.appliedMachinePath) } : {})
    })))
  }

  await mkdir(join(root, 'downloads'), { recursive: true })
  return { root, moved, rewritten, cleanedPathEntries }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readUserPathSafe(): Promise<string> {
  try { return await readUserPath() } catch { return '' }
}
