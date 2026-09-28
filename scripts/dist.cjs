const { spawn } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

// electron-builder 会从 GitHub 下载 electron / nsis / winCodeSign 等工具包。
// 本地打包默认走国内镜像（可用环境变量覆盖）；CI 上不要设，直接用 GitHub 更快。
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= process.env.CI ? '' : 'https://npmmirror.com/mirrors/electron-builder-binaries/'
process.env.ELECTRON_MIRROR ||= process.env.CI ? '' : 'https://npmmirror.com/mirrors/electron/'
if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) delete process.env.ELECTRON_BUILDER_BINARIES_MIRROR
if (!process.env.ELECTRON_MIRROR) delete process.env.ELECTRON_MIRROR

const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
// 不指定 target，按 package.json 里配置的目标全部构建（安装版 + 绿色版）。
const child = spawn(process.execPath, [cli, '--win'], { cwd: root, stdio: 'inherit', env: process.env })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
child.on('error', (error) => {
  console.error('electron-builder 启动失败：', error)
  process.exitCode = 1
})
