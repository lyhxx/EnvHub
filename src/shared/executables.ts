import type { RuntimeId } from './contracts'

// 每个环境的可执行文件信息，主进程与安装流程共用一份，避免多处维护漂移。

// 1) 用于在 PATH / 候选目录里寻找该环境（含脚本类工具）。
export const runtimeExecutables: Record<RuntimeId, string[]> = {
  python: ['python.exe', 'python3.exe'],
  node: ['node.exe'],
  bun: ['bun.exe'],
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

// 2) 官方归档解压后，可执行文件相对于归档根的路径。
export const relativeExecutables: Record<RuntimeId, string> = {
  python: 'python.exe',
  node: 'node.exe',
  bun: 'bun.exe',
  jdk: 'bin\\java.exe',
  git: 'git.exe',
  go: 'bin\\go.exe',
  rust: 'rustc.exe',
  dotnet: 'dotnet.exe',
  php: 'php.exe',
  ruby: 'bin\\ruby.exe',
  maven: 'bin\\mvn.cmd',
  gradle: 'bin\\gradle.bat',
  docker: 'docker.exe'
}
