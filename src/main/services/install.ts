import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import extractZip from 'extract-zip'
import type { RuntimeInstallation } from '../../shared/contracts'
import { isInstallableRuntime } from '../../shared/installable'
import { relativeExecutables } from '../../shared/executables'
import { sameVersion } from '../../shared/versions'
import { probeRuntimeVersion, refreshAllCurrentFlags, refreshCurrentFlag } from '../runtime/service'
import { store } from '../storage/store'
import { applyDefaultVersion, removeManagedPath } from './environment'

function markerFile(root: string): string {
  return join(root, '.envhub.json')
}

// 归档解压后，可执行文件可能在根目录，也可能在一个带版本号的子目录里（Go / Maven / Gradle / JDK 都是后者）。
async function findByRelative(root: string, relative: string): Promise<string | null> {
  try {
    const direct = join(root, relative)
    if ((await lstat(direct)).isFile()) return direct
  } catch { /* try one nested directory below the archive root */ }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = join(root, entry.name, relative)
    try {
      if ((await lstat(nested)).isFile()) return nested
    } catch { /* keep looking */ }
  }
  return null
}

// 同一个版本只允许一个安装流程：并发进入会互相删除对方正在解压的内容。
const installingKeys = new Set<string>()

export async function installDownloadedRuntime(downloadId: string, activate: boolean): Promise<RuntimeInstallation> {
  const snapshot = store.snapshot()
  const task = snapshot.downloads.find((item) => item.id === downloadId)
  if (!task) throw new Error('找不到该下载任务')
  if (task.status !== 'completed') throw new Error('请等待下载完成后再安装')
  if (task.kind !== 'runtime' || !task.runtimeId) throw new Error('该下载不是运行环境归档，无法作为运行时安装')
  if (!isInstallableRuntime(task.runtimeId)) throw new Error('该运行环境暂不支持应用内安装')

  const runtimesRoot = resolve(snapshot.managedRoot, 'runtimes')
  const root = join(runtimesRoot, task.runtimeId, task.version)
  // 版本号来自官方清单，但仍做一次前缀守卫：下面的 rm 会递归删除这个目录。
  if (!`${resolve(root)}${sep}`.toLowerCase().startsWith(`${runtimesRoot}${sep}`.toLowerCase())) throw new Error('安装目录越界，已阻止')
  if (snapshot.installations.some((item) => item.managedDir && resolve(item.managedDir).toLowerCase() === resolve(root).toLowerCase())) {
    throw new Error('该版本已安装')
  }
  // 磁盘上有 EnvHub 写好的 ready 标记、但清单里没有记录（例如 db 被重置过）：
  // 不能直接删掉重装，先让用户扫描一次把记录找回来。
  const existingMarker = await readFile(markerFile(root), 'utf8').catch(() => null)
  if (existingMarker && /"state"\s*:\s*"ready"/.test(existingMarker)) {
    throw new Error('该目录已有 EnvHub 安装标记，但清单里没有对应记录；请先重新扫描环境，或手动清理该目录')
  }

  const key = `${task.runtimeId}@${task.version}`
  if (installingKeys.has(key)) throw new Error('该版本正在安装，请等待当前安装完成')
  installingKeys.add(key)
  try {
    await mkdir(dirname(root), { recursive: true })
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    // 先写"安装中"标记：解压中途崩溃时，下次扫描才知道这个目录是 EnvHub 留下的半成品（而不是用户数据）。
    await writeFile(markerFile(root), JSON.stringify({
      runtimeId: task.runtimeId, requestedVersion: task.version, url: task.url, checksum: task.checksum,
      state: 'installing', startedAt: new Date().toISOString()
    }, null, 2), 'utf8')

    try {
      await extractZip(task.filePath, { dir: root })
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(`解压失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const executablePath = await findByRelative(root, relativeExecutables[task.runtimeId])
    if (!executablePath) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('解压完成但没有找到可执行文件，已回滚本次安装')
    }

    const detectedVersion = (await probeRuntimeVersion(task.runtimeId, executablePath)) ?? task.version
    await writeFile(markerFile(root), JSON.stringify({
      runtimeId: task.runtimeId, requestedVersion: task.version, detectedVersion,
      url: task.url, checksum: task.checksum, state: 'ready', installedAt: new Date().toISOString()
    }, null, 2), 'utf8')

    const installation: RuntimeInstallation = {
      id: randomUUID(), runtimeId: task.runtimeId, version: detectedVersion,
      executablePath, managedDir: root, source: 'managed', verified: sameVersion(detectedVersion, task.version),
      isDefault: false, detectedAt: new Date().toISOString(),
      ...(task.runtimeId === 'jdk' ? { javaKind: 'jdk' as const } : {})
    }
    await store.setInstallations([...store.snapshot().installations, installation])
    if (activate) {
      await applyDefaultVersion(installation)
      await store.activate(installation.id)
      // 写入 PATH 可能顺带清理了其他运行时的托管目录，必须整体重算。
      await refreshAllCurrentFlags()
    } else {
      await refreshCurrentFlag(task.runtimeId)
    }
    return installation
  } finally {
    installingKeys.delete(key)
  }
}

export async function uninstallManagedRuntime(id: string): Promise<void> {
  const installation = store.snapshot().installations.find((item) => item.id === id)
  if (!installation) throw new Error('找不到该环境记录')
  if (installation.source !== 'managed' || !installation.managedDir) throw new Error('EnvHub 只能卸载自己托管的版本')
  const target = resolve(installation.managedDir)
  // 允许删除当前数据目录与上一个数据目录下的托管版本；前缀必须带分隔符，避免 runtimes-other 之类的旁路。
  const allowed = [store.snapshot().managedRoot, store.snapshot().previousManagedRoot]
    .filter((root): root is string => Boolean(root))
    .some((root) => `${target}${sep}`.toLowerCase().startsWith(`${resolve(root, 'runtimes')}${sep}`.toLowerCase()))
  if (!allowed) throw new Error('拒绝删除托管目录之外的路径')
  const info = await lstat(target).catch(() => null)
  if (info?.isSymbolicLink()) throw new Error('目标目录是链接，已阻止删除')
  if (info) await rm(target, { recursive: true, force: true })
  await store.removeInstallation(id)
  const managedDirectory = store.snapshot().managedPaths[installation.runtimeId]
  if (managedDirectory && resolve(managedDirectory).toLowerCase() === resolve(dirname(installation.executablePath)).toLowerCase()) {
    await removeManagedPath(installation.runtimeId)
  }
  await refreshAllCurrentFlags()
}
