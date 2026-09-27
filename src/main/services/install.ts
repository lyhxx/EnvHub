import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import extractZip from 'extract-zip'
import type { RuntimeId, RuntimeInstallation } from '../../shared/contracts'
import { probeRuntimeVersion, refreshCurrentFlag } from '../runtime/service'
import { store } from '../storage/store'
import { applyDefaultVersion, removeManagedPath } from './environment'

const installableRuntimes: RuntimeId[] = ['node', 'jdk']

export function isInstallableRuntime(runtimeId: RuntimeId): boolean {
  return installableRuntimes.includes(runtimeId)
}

async function findExecutable(root: string, runtimeId: RuntimeId): Promise<string | null> {
  const relative = runtimeId === 'node' ? 'node.exe' : join('bin', 'java.exe')
  try {
    const direct = join(root, relative)
    const stat = await lstat(direct)
    if (stat.isFile()) return direct
  } catch { /* try one nested directory below the archive root */ }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = join(root, entry.name, relative)
    try {
      const stat = await lstat(nested)
      if (stat.isFile()) return nested
    } catch { /* keep looking */ }
  }
  return null
}

export async function installDownloadedRuntime(downloadId: string, activate: boolean): Promise<RuntimeInstallation> {
  const snapshot = store.snapshot()
  const task = snapshot.downloads.find((item) => item.id === downloadId)
  if (!task) throw new Error('找不到该下载任务')
  if (task.status !== 'completed') throw new Error('请等待下载完成后再安装')
  if (!isInstallableRuntime(task.runtimeId)) throw new Error('该运行环境暂不支持应用内安装')

  const root = join(snapshot.managedRoot, 'runtimes', task.runtimeId, task.version)
  if (snapshot.installations.some((item) => item.managedDir && resolve(item.managedDir).toLowerCase() === resolve(root).toLowerCase())) {
    throw new Error('该版本已安装')
  }

  await mkdir(dirname(root), { recursive: true })
  await rm(root, { recursive: true, force: true })
  try {
    await extractZip(task.filePath, { dir: root })
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`解压失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const executablePath = await findExecutable(root, task.runtimeId)
  if (!executablePath) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw new Error('解压完成但没有找到可执行文件，已回滚本次安装')
  }

  const detectedVersion = (await probeRuntimeVersion(task.runtimeId, executablePath)) ?? task.version
  await writeFile(join(root, '.envhub.json'), JSON.stringify({
    runtimeId: task.runtimeId, requestedVersion: task.version, detectedVersion,
    url: task.url, sha256: task.sha256, installedAt: new Date().toISOString()
  }, null, 2), 'utf8')

  const installation: RuntimeInstallation = {
    id: randomUUID(), runtimeId: task.runtimeId, version: detectedVersion,
    executablePath, managedDir: root, source: 'managed', verified: detectedVersion === task.version,
    isDefault: false, detectedAt: new Date().toISOString(),
    ...(task.runtimeId === 'jdk' ? { javaKind: 'jdk' as const } : {})
  }
  await store.setInstallations([...store.snapshot().installations.filter((item) => item.id !== installation.id), installation])
  await refreshCurrentFlag(task.runtimeId)
  if (activate) {
    await applyDefaultVersion(installation)
    await store.activate(installation.id)
  }
  return installation
}

export async function uninstallManagedRuntime(id: string): Promise<void> {
  const installation = store.snapshot().installations.find((item) => item.id === id)
  if (!installation) throw new Error('找不到该环境记录')
  if (installation.source !== 'managed' || !installation.managedDir) throw new Error('EnvHub 只能卸载自己托管的版本')
  const runtimeRoot = resolve(store.snapshot().managedRoot, 'runtimes')
  const target = resolve(installation.managedDir)
  if (!target.toLowerCase().startsWith(runtimeRoot.toLowerCase())) throw new Error('拒绝删除托管目录之外的路径')
  const info = await lstat(target).catch(() => null)
  if (info?.isSymbolicLink()) throw new Error('目标目录是链接，已阻止删除')
  if (info) await rm(target, { recursive: true, force: true })
  await store.removeInstallation(id)
  const managedDirectory = store.snapshot().managedPaths[installation.runtimeId]
  if (managedDirectory && resolve(managedDirectory).toLowerCase() === resolve(dirname(installation.executablePath)).toLowerCase()) {
    await removeManagedPath(installation.runtimeId)
  }
  await refreshCurrentFlag(installation.runtimeId)
}
