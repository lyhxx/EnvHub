const { spawn } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

// electron-builder 会从 GitHub 下载 nsis / winCodeSign 等工具包，这里统一走国内镜像，避免打包长时间卡住。
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'

const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const child = spawn(process.execPath, [cli, '--win', 'nsis'], { cwd: root, stdio: 'inherit', env: process.env })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
child.on('error', (error) => {
  console.error('electron-builder 启动失败：', error)
  process.exitCode = 1
})
