// 版本号比较：官方发布名与本地实际报出的版本经常不一致（例：Temurin 目录名 21.0.12.1+1，
// 而 java -version 报 21.0.12.1；Adoptium 的 semver 带 +101.0.LTS 构建元数据）。
// 这里统一按"前导数字段"比较，并允许一段是另一段的前缀，避免把已装好的版本判成待确认。

export function versionCore(value: string): string {
  const match = value.match(/^v?(\d+(?:\.\d+)*)/)
  return match ? match[1] : value.trim().toLowerCase()
}

export function sameVersion(left: string, right: string): boolean {
  const a = versionCore(left)
  const b = versionCore(right)
  if (!a || !b) return false
  if (a === b) return true
  return a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

// 用于展示与目录名：去掉构建元数据，保留可读的版本号。
export function displayVersion(value: string): string {
  return versionCore(value) || value
}
