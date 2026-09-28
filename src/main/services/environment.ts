import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { PathBackup, RuntimeInstallation } from '../../shared/contracts'
import { store } from '../storage/store'

const exec = promisify(execFile)
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
// 系统 PATH 所在的注册表位置（HKLM 需要提权）。
const machineEnvironmentKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

async function runPowerShell(script: string, timeoutMs = 12_000): Promise<void> {
  // 先切到 UTF-8 输出，避免中文报错信息在 stderr 里变成乱码。
  const prefixed = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
  const encoded = Buffer.from(prefixed, 'utf16le').toString('base64')
  await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })
}

// 短时间内多次读取环境变量时复用结果，避免一次切换动作里反复启动 PowerShell。
const pathCache = new Map<string, { value: string; at: number }>()
const pathCacheTtl = 5000

// 每次成功写入环境变量都会自增。扫描这类长流程可以用它判断"期间是否被改过"，
// 避免拿扫描开始时的旧 PATH 覆盖掉刚写入的状态。
let writeRevision = 0

export function environmentRevision(): number {
  return writeRevision
}

function cacheGet(key: string): string | null {
  const hit = pathCache.get(key)
  if (hit && Date.now() - hit.at < pathCacheTtl) return hit.value
  return null
}

function cacheSet(key: string, value: string): void {
  pathCache.set(key, { value, at: Date.now() })
}

function cacheClear(): void {
  pathCache.clear()
}

// 写入成功后直接把已知的新值灌回缓存，省掉一次"回读校验"的进程启动。
// 只有在快照本来就存在时才更新，避免用不完整的快照顶替真实值。
function cacheApplyWrite(name: string, value: string): void {
  const upper = name.toUpperCase()
  if (upper === 'PATH' || upper === 'JAVA_HOME') {
    const cached = cacheGet('snapshot')
    if (cached === null) { pathCache.delete('snapshot'); return }
    const snapshot = JSON.parse(cached) as EnvironmentSnapshot
    if (upper === 'PATH') snapshot.userPath = value
    else snapshot.javaHome = value
    cacheSet('snapshot', JSON.stringify(snapshot))
    return
  }
  cacheSet(`user-var:${name.toLowerCase()}`, value)
}

interface EnvironmentSnapshot {
  userPath: string
  machinePath: string
  javaHome: string
}

// 一次 PowerShell 调用读齐所有需要的环境变量，避免多次进程启动的开销。
async function readEnvironmentSnapshot(fresh = false): Promise<EnvironmentSnapshot> {
  if (fresh) pathCache.delete('snapshot')
  const cached = cacheGet('snapshot')
  if (cached !== null) return JSON.parse(cached) as EnvironmentSnapshot
  const expression = `([ordered]@{ userPath = [string][Environment]::GetEnvironmentVariable('Path','User'); machinePath = [string][Environment]::GetEnvironmentVariable('Path','Machine'); javaHome = [string][Environment]::GetEnvironmentVariable('JAVA_HOME','User') } | ConvertTo-Json -Compress)`
  const raw = await readPowerShellValue(expression)
  const snapshot = JSON.parse(raw) as EnvironmentSnapshot
  snapshot.userPath = snapshot.userPath ?? ''
  snapshot.machinePath = snapshot.machinePath ?? ''
  snapshot.javaHome = snapshot.javaHome ?? ''
  cacheSet('snapshot', JSON.stringify(snapshot))
  return snapshot
}

async function withValueFile<T>(value: string, use: (path: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), 'envhub-env-'))
  const file = join(folder, 'value.txt')
  try {
    await writeFile(file, value, 'utf8')
    return await use(file)
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

// PowerShell 5.1 重定向输出使用系统 ANSI 代码页，中文路径会乱码；统一改成写 UTF-8 文件再读。
async function readPowerShellValue(expression: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'envhub-read-'))
  const file = join(folder, 'out.txt')
  try {
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$value = ${expression}`,
      `[System.IO.File]::WriteAllText('${file.replace(/'/g, "''")}', [string]$value, (New-Object System.Text.UTF8Encoding($false)))`
    ].join('; ')
    await runPowerShell(script)
    const text = await readFile(file, 'utf8')
    return text.replace(/\r?\n$/, '')
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function readUserPath(): Promise<string> {
  return (await readEnvironmentSnapshot()).userPath
}

export async function readUserVariable(name: string): Promise<string> {
  if (name.toUpperCase() === 'JAVA_HOME') return (await readEnvironmentSnapshot()).javaHome
  const key = `user-var:${name.toLowerCase()}`
  const cached = cacheGet(key)
  if (cached !== null) return cached
  const value = await readPowerShellValue(`[Environment]::GetEnvironmentVariable('${name.replace(/'/g, "''")}','User')`)
  cacheSet(key, value)
  return value
}

export async function readMachinePath(): Promise<string> {
  return (await readEnvironmentSnapshot()).machinePath
}

function expandVariables(value: string): string {
  const lookup = new Map<string, string>()
  for (const [key, entry] of Object.entries(process.env)) {
    if (typeof entry === 'string') lookup.set(key.toUpperCase(), entry)
  }
  return value.replace(/%([^%]+)%/g, (match, name: string) => lookup.get(name.toUpperCase()) ?? match)
}

// Windows 的生效 PATH = 系统 PATH 在前、用户 PATH 在后（同名变量用户覆盖，但 PATH 是追加）。
// fresh=true 会绕过 5 秒缓存重新读取，供长流程（扫描）在写入后复核使用。
export async function effectivePathEntries(options: { fresh?: boolean } = {}): Promise<string[]> {
  const snapshot = await readEnvironmentSnapshot(options.fresh === true)
  const seen = new Set<string>()
  const entries: string[] = []
  for (const raw of [...splitPath(snapshot.machinePath), ...splitPath(snapshot.userPath)]) {
    const entry = expandVariables(raw).replace(/[\\/]+$/, '')
    const key = entry.toLocaleLowerCase('en-US')
    if (!entry || seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries
}

// PATH 里允许出现被引号包起来的条目（部分安装器会这么写），比较与重写前统一去掉引号。
function splitPath(value: string): string[] {
  return value
    .split(';')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean)
}

function normalize(value: string): string {
  return value.replace(/[\\/]+$/, '').toLocaleLowerCase('en-US')
}

// EnvHub 自己写入 PATH 的目录（当前数据目录 + 已记录的托管目录）。这些条目在任何 PATH 变化时都该被清掉。
function envHubPathRoots(): string[] {
  const snapshot = store.snapshot()
  const roots = new Set<string>()
  if (snapshot.managedRoot) roots.add(normalize(snapshot.managedRoot))
  for (const directory of Object.values(snapshot.managedPaths)) {
    if (directory) roots.add(normalize(directory))
  }
  return [...roots].filter(Boolean)
}

// 判定某个 PATH 条目是否属于 EnvHub：既认当前数据目录，也认历史遗留的乱码条目
// （它们仍包含 ASCII 的 EnvHub 路径片段，因此不依赖用户给数据目录起的名字）。
function isEnvHubEntry(entry: string, roots: string[]): boolean {
  const value = normalize(expandVariables(entry))
  if (!value) return false
  for (const root of roots) {
    if (value === root || value.startsWith(`${root}\\`) || value.startsWith(`${root}/`)) return true
  }
  return /[\\/]envhub[\\/](runtimes|privileged|downloads)([\\/]|$)/i.test(value)
}

function describeEnvironmentWriteError(error: unknown): Error {
  const raw = error as { killed?: boolean; signal?: string; code?: string | number | null; message?: string }
  if (raw.killed || raw.signal === 'SIGTERM') return new Error('写入环境变量超时：系统广播可能被其他程序阻塞，请稍后重试')
  if (raw.code) return new Error(`写入环境变量失败（${raw.code}），请检查权限后重试`)
  return error instanceof Error ? error : new Error('写入环境变量失败')
}

// 写完后要通知 Explorer“环境变量变了”，否则已打开的 Explorer 会把旧值传给新终端。
// 注意：不能用 [Environment]::SetEnvironmentVariable 来做这件事——实测它在本机会阻塞约 10 秒
// （等所有窗口响应），而且会把 PATH 的值类型从“可展开字符串”降级成普通字符串。
// 所以这里只发纯广播：向所有窗口发 WM_SETTINGCHANGE，不碰注册表；放在独立后台进程里，界面不等。
let broadcastTimer: NodeJS.Timeout | undefined
function scheduleEnvironmentBroadcast(): void {
  // 连续多次写入只广播一次：等写入落定后再发通知。
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined
    const script = [
      `Add-Type -Namespace EnvHub -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'`,
      `$result = [UIntPtr]::Zero`,
      `[EnvHub.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 0x0002, 1000, [ref]$result) | Out-Null`
    ].join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    try {
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, detached: true, stdio: 'ignore' })
      child.unref()
    } catch { /* 广播失败不影响写入结果，最坏情况是已打开的 Explorer 需要重启后才看到新变量 */ }
  }, 400)
}

async function writeUserVariable(name: string, value: string, kind: 'ExpandString' | 'String' = 'ExpandString'): Promise<void> {
  let written = false
  try {
    await withValueFile(value, async (file) => {
      // 直接写注册表：立即返回，不会被 WM_SETTINGCHANGE 的窗口响应拖慢。
      const script = [
        `$value = [System.IO.File]::ReadAllText('${file.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)`,
        `Set-ItemProperty -Path 'HKCU:\\Environment' -Name '${name.replace(/'/g, "''")}' -Value $value -Type ${kind}`
      ].join('; ')
      await runPowerShell(script, 15_000)
    })
    written = true
  } finally {
    if (written) { writeRevision += 1; cacheApplyWrite(name, value); scheduleEnvironmentBroadcast() }
    else cacheClear()
  }
}

export interface ActivationResult {
  directory: string
  changed: boolean
  javaHome?: string
  shadowedBy?: string[]
  cleaned?: number
}

const runtimeExecutableNames: Partial<Record<RuntimeInstallation['runtimeId'], string[]>> = {
  node: ['node.exe'],
  bun: ['bun.exe'],
  python: ['python.exe'],
  jdk: ['java.exe'],
  git: ['git.exe'],
  go: ['go.exe'],
  rust: ['rustc.exe'],
  dotnet: ['dotnet.exe'],
  php: ['php.exe'],
  ruby: ['ruby.exe'],
  maven: ['mvn.cmd'],
  gradle: ['gradle.bat'],
  docker: ['docker.exe']
}

async function findShadowingDirectories(installation: RuntimeInstallation, effective: string[]): Promise<string[]> {
  const names = runtimeExecutableNames[installation.runtimeId] ?? []
  if (!names.length) return []
  const { access } = await import('node:fs/promises')
  const target = normalize(dirname(installation.executablePath))
  const shadowed: string[] = []
  for (const entry of effective) {
    const normalized = normalize(entry)
    if (normalized === target) break
    for (const name of names) {
      try {
        await access(join(entry, name))
        shadowed.push(entry)
        break
      } catch { /* not in this directory */ }
    }
    if (shadowed.length >= 3) break
  }
  return shadowed
}

export async function applyDefaultVersion(installation: RuntimeInstallation): Promise<ActivationResult> {
  const directory = dirname(installation.executablePath)
  const javaHome = installation.runtimeId === 'jdk' ? dirname(directory) : undefined
  const previousPath = await readUserPath()
  const previousJavaHome = installation.runtimeId === 'jdk' ? await readUserVariable('JAVA_HOME') : undefined

  const entries = splitPath(previousPath)
  const roots = envHubPathRoots()
  const target = normalize(directory)
  const seen = new Set<string>()
  const kept: string[] = []
  let cleaned = 0
  for (const entry of entries) {
    const normalized = normalize(entry)
    // 目标自身的旧条目只是被挪到最前，不算"清理"；EnvHub 托管残留（含历史乱码条目）与重复项才算。
    if (normalized === target) continue
    if (isEnvHubEntry(entry, roots) || seen.has(normalized)) { cleaned += 1; continue }
    seen.add(normalized)
    kept.push(entry)
  }
  const applied = [directory, ...kept].join(';')
  if (applied.length > 30_000) throw new Error('用户 PATH 过长（超过 30000 字符），已中止写入，请先清理 PATH')

  const pathChanged = applied !== previousPath
  const javaChanged = Boolean(javaHome && javaHome !== previousJavaHome)

  // 先记录备份再写入：即使后续某一步失败，用户仍然可以撤销已经生效的部分。
  if (pathChanged || javaChanged) {
    const backup: PathBackup = {
      at: new Date().toISOString(),
      previousPath,
      appliedPath: pathChanged ? applied : previousPath,
      ...(javaHome ? { previousJavaHome: previousJavaHome || undefined, appliedJavaHome: javaHome } : {})
    }
    await store.setManagedPath(installation.runtimeId, directory, backup)
  }

  if (pathChanged) {
    try {
      await writeUserVariable('Path', applied)
    } catch (error) {
      // 写入超时/报错时回读校验：值可能已经写进去了（广播被拖慢导致超时），避免误报为失败。
      const currentFirst = splitPath(await readUserPath())[0]
      if (normalize(currentFirst ?? '') !== target) throw describeEnvironmentWriteError(error)
    }
  }

  if (javaChanged && javaHome) {
    try {
      await writeUserVariable('JAVA_HOME', javaHome, 'String')
    } catch (error) {
      // 不能像 PATH 那样"回读即认为成功"就放过：JAVA_HOME 没写上，Maven / Gradle / IDE 仍会用旧 JDK。
      const written = (await readUserVariable('JAVA_HOME')) === javaHome
      if (!written) {
        throw new Error(`${describeEnvironmentWriteError(error).message}（用户 PATH 已更新，Java 定位的 JDK 未更新；可在设置中撤销）`)
      }
    }
  }

  const shadowedBy = await findShadowingDirectories(installation, await effectivePathEntries())
  return { directory, changed: pathChanged, javaHome, ...(cleaned ? { cleaned } : {}), ...(shadowedBy.length ? { shadowedBy } : {}) }
}

export interface RepairResult {
  removed: number
  remaining: number
}

// 修复用户 PATH：去掉重复项与失效目录（目录不存在）。只处理用户 PATH，保留原始值备份。
export async function repairUserPath(): Promise<RepairResult> {
  const { access } = await import('node:fs/promises')
  const previousPath = await readUserPath()
  const entries = splitPath(previousPath)
  const seen = new Set<string>()
  const kept: string[] = []
  let removed = 0
  for (const entry of entries) {
    const normalized = normalize(expandVariables(entry))
    if (seen.has(normalized)) { removed += 1; continue }
    seen.add(normalized)
    try {
      await access(expandVariables(entry))
      kept.push(entry)
    } catch {
      removed += 1
    }
  }
  if (!removed) return { removed: 0, remaining: kept.length }
  if (!kept.length) throw new Error('清理后用户 PATH 会变成空值，已中止；请手动检查 PATH')
  const applied = kept.join(';')
  await writeUserVariable('Path', applied)
  await store.pushPathBackup({ at: new Date().toISOString(), previousPath, appliedPath: applied })
  return { removed, remaining: kept.length }
}

export async function removeManagedPath(runtimeId: RuntimeInstallation['runtimeId']): Promise<void> {
  const managed = store.snapshot().managedPaths[runtimeId]
  if (!managed) return
  const previousPath = await readUserPath()
  const entries = splitPath(previousPath)
  const kept = entries.filter((entry) => normalize(entry) !== normalize(managed))
  if (kept.length !== entries.length) {
    await writeUserVariable('Path', kept.join(';'))
    await store.pushPathBackup({ at: new Date().toISOString(), previousPath, appliedPath: kept.join(';') })
  }
  await store.clearManagedPath(runtimeId)
}

export async function takeOverMachinePriority(installation: RuntimeInstallation): Promise<{ removed: string[] }> {
  const shadowed = await findShadowingDirectories(installation, await effectivePathEntries())
  if (!shadowed.length) return { removed: [] }

  const machinePath = await readMachinePath()
  const shadowSet = new Set(shadowed.map((entry) => normalize(expandVariables(entry))))
  const kept = splitPath(machinePath).filter((entry) => !shadowSet.has(normalize(expandVariables(entry))))
  const applied = kept.join(';')

  await writeMachinePathElevated(applied)

  await store.pushPathBackup({
    at: new Date().toISOString(),
    previousPath: await readUserPath(),
    appliedPath: await readUserPath(),
    previousMachinePath: machinePath,
    appliedMachinePath: applied
  })
  cacheClear()
  return { removed: shadowed }
}

function describePowerShellError(error: unknown): string {
  const raw = error as { stderr?: string; stdout?: string; message?: string }
  const text = `${raw.stderr ?? ''}\n${raw.stdout ?? ''}`
    .replace(/#< CLIXML/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/_x000D_|_x000A_/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !line.startsWith('CLIXML'))
  const detail = text.slice(-2).join(' / ').slice(0, 300)
  if (/cancel|取消|1223/i.test(detail)) return '已取消管理员授权，系统 PATH 未修改'
  return detail ? `提升权限执行失败：${detail}` : `提升权限执行失败：${raw.message?.split('\n')[0] ?? '未知错误'}`
}

async function runElevatedEncoded(encodedInner: string): Promise<void> {
  const launcher = [
    `$ErrorActionPreference = 'Stop'`,
    `$inner = @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedInner}')`,
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $inner -Verb RunAs -Wait -PassThru`,
    `exit $p.ExitCode`
  ].join('; ')
  try {
    await runPowerShell(launcher)
  } catch (error) {
    throw new Error(describePowerShellError(error))
  }
}

// 把机器级 PATH 写入提升权限的 PowerShell：内容较短时直接内嵌，过长时回退到临时文件。
const helperTaskName = 'EnvHub-PrivilegedHelper'

function helperDir(): string {
  return join(store.snapshot().managedRoot, 'privileged')
}

function helperScript(): string {
  const dir = helperDir()
  const requestPath = join(dir, 'request.json')
  const resultPath = join(dir, 'result.json')
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$request = Get-Content -Raw -Encoding UTF8 '${requestPath.replace(/'/g, "''")}' | ConvertFrom-Json`,
    `$result = '${resultPath.replace(/'/g, "''")}'`,
    `try {`,
    `  switch ([string]$request.action) {`,
    `    'set-machine-path' {`,
    `      $value = [string]$request.value`,
    `      if ($value.Length -gt 30000) { throw 'value too long' }`,
    `      Set-ItemProperty -LiteralPath '${machineEnvironmentKey}' -Name 'Path' -Value $value -Type ExpandString`,
    `    }`,
    `    default { throw ('unsupported action: ' + [string]$request.action) }`,
    `  }`,
    `  [System.IO.File]::WriteAllText($result, '{"ok":true}', (New-Object System.Text.UTF8Encoding($false)))`,
    `} catch {`,
    `  $message = $_.Exception.Message -replace '"',''`,
    `  [System.IO.File]::WriteAllText($result, ('{"ok":false,"error":"' + $message + '"}'), (New-Object System.Text.UTF8Encoding($false)))`,
    `  exit 1`,
    `}`
  ].join('\n')
}

export async function privilegedHelperStatus(): Promise<{ enabled: boolean }> {
  try {
    await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'), ['/Query', '/TN', helperTaskName], { timeout: 10_000, windowsHide: true, encoding: 'utf8' })
    return { enabled: true }
  } catch {
    return { enabled: false }
  }
}

// 助手脚本以文件形式落盘、由计划任务执行；每次运行前重写一次，保证用旧版本注册过的任务也能跑到最新实现。
async function writeHelperScript(): Promise<string> {
  const dir = helperDir()
  const scriptPath = join(dir, 'helper.ps1')
  await mkdir(dir, { recursive: true })
  // PowerShell 5.1 读取 .ps1 时按 BOM 判断编码，必须写入 UTF-8 BOM，否则中文路径会乱码。
  await writeFile(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(helperScript(), 'utf8')]))
  return scriptPath
}

export async function enablePrivilegedHelper(): Promise<void> {
  const scriptPath = await writeHelperScript()

  const register = [
    `$ErrorActionPreference = 'Stop'`,
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${JSON.stringify(`-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`)}`,
    `$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Highest`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)`,
    `Register-ScheduledTask -TaskName '${helperTaskName}' -Action $action -Principal $principal -Settings $settings -Force | Out-Null`
  ].join('; ')
  await runElevatedEncoded(Buffer.from(register, 'utf16le').toString('base64'))
}

export async function disablePrivilegedHelper(): Promise<void> {
  const unregister = `$ErrorActionPreference = 'Stop'; Unregister-ScheduledTask -TaskName '${helperTaskName}' -Confirm:$false`
  await runElevatedEncoded(Buffer.from(unregister, 'utf16le').toString('base64'))
}

async function runPrivilegedHelper(value: string): Promise<void> {
  const dir = helperDir()
  const requestPath = join(dir, 'request.json')
  const resultPath = join(dir, 'result.json')
  // 任务可能还是用旧版本注册的：每次运行前刷新脚本内容，避免跑到过时的写入实现。
  await writeHelperScript()
  await mkdir(dir, { recursive: true })
  await rm(resultPath, { force: true }).catch(() => undefined)
  await writeFile(requestPath, JSON.stringify({ action: 'set-machine-path', value }), 'utf8')

  const schtasks = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe')
  await exec(schtasks, ['/Run', '/TN', helperTaskName], { timeout: 10_000, windowsHide: true, encoding: 'utf8' })

  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    try {
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as { ok?: boolean; error?: string }
      if (result.ok) return
      throw new Error(`特权助手执行失败：${result.error ?? '未知错误'}`)
    } catch (error) {
      if (error instanceof SyntaxError) continue
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  throw new Error('特权助手没有在预期时间内返回结果')
}

async function writeMachinePathElevated(value: string): Promise<void> {
  const { enabled } = await privilegedHelperStatus()
  if (enabled) {
    try {
      await runPrivilegedHelper(value)
      // 系统 PATH 变了也要通知一次，新终端才会重新读取。
      writeRevision += 1
      scheduleEnvironmentBroadcast()
      return
    } catch (error) {
      if (!/没有在预期时间内返回结果/.test(error instanceof Error ? error.message : '')) throw error
      // 助手任务失效时回退到一次性授权，避免卡住用户。
    }
  }
  await writeMachinePathElevatedOnce(value)
  writeRevision += 1
  scheduleEnvironmentBroadcast()
}

async function writeMachinePathElevatedOnce(value: string): Promise<void> {
  const setStatement = `Set-ItemProperty -LiteralPath '${machineEnvironmentKey}' -Name 'Path' -Value $value -Type ExpandString`
  const embedded = `$ErrorActionPreference = 'Stop'\n$value = @'\n${value}\n'@\n${setStatement}`
  const embeddedEncoded = Buffer.from(embedded, 'utf16le').toString('base64')
  if (embeddedEncoded.length <= 22000) return runElevatedEncoded(embeddedEncoded)

  return withValueFile(value, async (file) => {
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$value = [System.IO.File]::ReadAllText('${file.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)`,
      setStatement
    ].join('\n')
    return runElevatedEncoded(Buffer.from(script, 'utf16le').toString('base64'))
  })
}

export async function undoLastPathChange(): Promise<boolean> {
  const backup = store.snapshot().pathBackups.at(-1)
  if (!backup) return false
  await writeUserVariable('Path', backup.previousPath)
  if (backup.appliedJavaHome) await writeUserVariable('JAVA_HOME', backup.previousJavaHome ?? '', 'String')
  if (backup.appliedMachinePath !== undefined && backup.previousMachinePath !== undefined) {
    await writeMachinePathElevated(backup.previousMachinePath)
  }
  await store.popPathBackup()
  return true
}
