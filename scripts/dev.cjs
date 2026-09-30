const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electronPackage = path.dirname(require.resolve('electron'))
const electronDist = path.join(electronPackage, 'dist')
const cacheDir = path.join(root, 'node_modules', '.cache', 'envhub-dev-electron')
const devExecutable = path.join(cacheDir, 'EnvHub.exe')
const markerPath = path.join(cacheDir, '.envhub-dev-host')
const iconPath = path.join(root, 'build', 'icon.ico')
const cliPath = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const packageVersion = require(path.join(root, 'package.json')).version
const fileVersion = `${packageVersion}.0`

// rcedit 用来把开发宿主副本改名换图标。它由 electron-winstaller 附带（已声明为 devDependency），
// 但版本升级可能改变路径，所以这里逐个候选查找；实在找不到就跳过品牌化，不影响开发。
function findRcedit() {
  const candidates = [
    path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    path.join(root, 'node_modules', 'rcedit', 'bin', 'rcedit.exe'),
    path.join(root, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  ]
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? null
}

async function linkTree(source, target) {
  await fs.mkdir(target, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const targetName = entry.isFile() && entry.name.toLowerCase() === 'electron.exe' ? 'EnvHub.exe' : entry.name
    const targetPath = path.join(target, targetName)
    if (entry.isDirectory()) {
      await linkTree(sourcePath, targetPath)
    } else if (entry.isFile()) {
      if (entry.name.toLowerCase() === 'electron.exe') {
        await fs.copyFile(sourcePath, targetPath)
      } else {
        try { await fs.link(sourcePath, targetPath) }
        catch { await fs.copyFile(sourcePath, targetPath) }
      }
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(sourcePath)
      await fs.symlink(link, targetPath)
    }
  }
}

async function prepareBrandedElectron() {
  if (process.platform !== 'win32') {
    throw new Error('EnvHub 的自定义开发宿主目前仅支持 Windows。')
  }
  const sourceStat = await fs.stat(path.join(electronDist, 'electron.exe'))
  const iconStat = await fs.stat(iconPath)
  // stamp 里必须带上"当时有没有 rcedit"：缺 rcedit 时也写了同样的 stamp，
  // 补装依赖后 electron 解包时间不变，会一直命中旧 stamp，品牌化再也不会重做。
  const rcedit = findRcedit()
  const stamp = `host-v2|${sourceStat.size}|${sourceStat.mtimeMs}|${iconStat.mtimeMs}|${rcedit ? 'rcedit' : 'no-rcedit'}`
  try {
    const existingStamp = await fs.readFile(markerPath, 'utf8')
    await fs.access(devExecutable)
    if (existingStamp === stamp) return
  } catch { /* Create or refresh the ignored development-host cache. */ }

  await fs.rm(cacheDir, { recursive: true, force: true })
  await linkTree(electronDist, cacheDir)

  if (!(await fs.stat(devExecutable)).isFile()) throw new Error('无法准备 EnvHub.exe 开发宿主')

  const rceditPath = rcedit
  if (!rceditPath) {
    console.warn('未找到 rcedit.exe，跳过开发宿主品牌信息（任务栏可能显示 Electron）。执行 npm install 后重跑即可自动重做（stamp 已区分）。')
    await fs.writeFile(markerPath, stamp, 'utf8')
    return
  }

  const args = [
    devExecutable,
    '--set-icon', iconPath,
    '--set-version-string', 'FileDescription', 'EnvHub',
    '--set-version-string', 'ProductName', 'EnvHub',
    '--set-version-string', 'InternalName', 'EnvHub',
    '--set-version-string', 'OriginalFilename', 'EnvHub.exe',
    '--set-file-version', fileVersion,
    '--set-product-version', fileVersion
  ]
  const result = spawnSync(rceditPath, args, { cwd: root, windowsHide: true, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || 'rcedit 更新开发宿主资源失败')
  await fs.writeFile(markerPath, stamp, 'utf8')
}

prepareBrandedElectron().then(() => {
  if (process.argv.includes('--prepare-only')) {
    console.log('EnvHub development host is ready:', devExecutable)
    return
  }
  const child = spawn(process.execPath, [cliPath, 'dev'], {
    cwd: root,
    env: { ...process.env, ELECTRON_EXEC_PATH: devExecutable },
    stdio: 'inherit'
  })
  child.on('error', (error) => {
    console.error('无法启动 EnvHub 开发服务器:', error)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}).catch((error) => {
  console.error('EnvHub 开发宿主准备失败:', error)
  process.exitCode = 1
})
