import type { RuntimeId } from './contracts'

// 支持应用内安装的环境：必须是官方 ZIP 归档，且官方发布方能给出可校验的哈希。
// 主进程（安装、下载校验）与界面（是否显示"安装"按钮）共用这一份，避免两边漂移。
export const installableRuntimes: RuntimeId[] = ['node', 'jdk', 'go', 'bun', 'maven', 'gradle']

export function isInstallableRuntime(runtimeId: RuntimeId): boolean {
  return installableRuntimes.includes(runtimeId)
}
