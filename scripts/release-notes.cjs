// 从 CHANGELOG.md 里抽取指定版本的条目，作为 GitHub Release 的发布说明。
// 用法：
//   node scripts/release-notes.cjs 0.3.0            # 输出到 stdout
//   node scripts/release-notes.cjs 0.3.0 --out notes.md
// 不带版本号时取 package.json 的版本。

const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const version = process.argv[2] || require(join(root, 'package.json')).version
const outIndex = process.argv.indexOf('--out')
const outFile = outIndex >= 0 ? process.argv[outIndex + 1] : null

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/)
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const headingPattern = new RegExp(`^##\\s*\\[?${escapeRegExp(version)}\\]?(\\s|$)`)

const start = lines.findIndex((line) => headingPattern.test(line.trim()))
if (start < 0) {
  console.error(`CHANGELOG.md 里找不到 ${version} 的条目`)
  process.exit(1)
}

let end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
if (end < 0) end = lines.length

// 只取"更新内容"：去掉版本标题行（Release 标题已有版本号），并止于"已知限制"（那不是本次更新的内容）。
const section = lines.slice(start + 1, end)
const stopAt = section.findIndex((line) => /^###\s*已知限制/.test(line.trim()))
const body = (stopAt >= 0 ? section.slice(0, stopAt) : section)
  .join('\n')
  .replace(/^\s*\n+/, '')
  .replace(/\s+$/, '')

const downloads = [
  `**下载**：\`EnvHub-${version}-setup.exe\`（安装版）· \`EnvHub-${version}-portable.exe\`（免安装绿色版）`,
  '',
  ''
].join('\n')

const text = `${downloads}${body}\n`
if (outFile) {
  writeFileSync(outFile, text, 'utf8')
  console.log(`已写入 ${outFile}（${Buffer.byteLength(text, 'utf8')} 字节）`)
} else {
  process.stdout.write(text)
}
