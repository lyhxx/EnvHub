import type { AppRunForm } from './contracts'

// 更新检查里与界面无关的判断都放在这里，好处是可以脱离 Electron 直接跑测试：
// 只做「版本号比较 / 更新包匹配 / 发布说明摘要」三件事，不碰网络与文件。

export function versionSegments(value: string): number[] {
  const match = value.trim().match(/^v?(\d+(?:\.\d+)*)/)
  if (!match) return []
  return match[1].split('.').map((segment) => Number.parseInt(segment, 10) || 0)
}

// 线上版本必须严格高于本地版本才算「有新版本」：
// 相等说明已经是最新，本地更高说明当前工作区正在开发下一个版本，都不该提示更新。
export function isNewerVersion(candidate: string, current: string): boolean {
  const remote = versionSegments(candidate)
  const local = versionSegments(current)
  if (!remote.length || !local.length) return false
  for (let index = 0; index < Math.max(remote.length, local.length); index += 1) {
    const diff = (remote[index] ?? 0) - (local[index] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

// 三种发行形态各自对应的产物名（由 electron-builder 的 artifactName 决定）。
// 必须同时限定产品名前缀与形态后缀，否则别的环境发布的同类归档会被误判成 EnvHub 更新包。
const updateAssetPatterns: Record<AppRunForm, RegExp> = {
  installer: /^envhub-[\w.+-]+-setup\.exe$/i,
  portable: /^envhub-[\w.+-]+-portable\.exe$/i,
  zip: /^envhub-[\w.+-]+-win-x64\.zip$/i
}

export function matchesUpdateAsset(fileName: string, form: AppRunForm): boolean {
  return updateAssetPatterns[form].test(fileName.trim())
}

export function updateFormLabel(form: AppRunForm): string {
  return form === 'installer' ? '安装版' : form === 'portable' ? '绿色单文件版' : '解压版'
}

// 发布说明由 scripts/release-notes.cjs 生成（下载行 + 概述 + ### 亮点）。
// 界面只展示摘要：去掉下载行与小标题，最多取几行，避免把 Markdown 原样摊在横幅里。
export function summarizeReleaseNotes(body: string, maxLines = 4): string[] {
  const lines: string[] = []
  for (const raw of (body ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^\*\*下载\*\*/.test(line)) continue
    if (/^#{1,6}\s/.test(line)) continue
    const text = line.replace(/^[-*+]\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').trim()
    if (!text) continue
    lines.push(text.length > 140 ? `${text.slice(0, 139)}…` : text)
    if (lines.length >= maxLines) break
  }
  return lines
}
