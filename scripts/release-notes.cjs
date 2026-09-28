// 从 CHANGELOG.md 里抽取指定版本的条目，作为 GitHub Release 的发布说明。
// 取值规则：概述段 + `### 亮点` 小节（用户可见的少数几条），详细的新增/变更/修复留在 CHANGELOG 里给开发者看。
// 没有 `### 亮点` 小节时退回完整条目，并在 stderr 提醒补写。
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
const isSectionHeading = (line) => /^###\s/.test(line.trim())

const start = lines.findIndex((line) => headingPattern.test(line.trim()))
if (start < 0) {
  console.error(`CHANGELOG.md 里找不到 ${version} 的条目`)
  process.exit(1)
}

let end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
if (end < 0) end = lines.length
const section = lines.slice(start + 1, end)

const highlightIndex = section.findIndex((line) => /^###\s*亮点/.test(line.trim()))
let body
if (highlightIndex >= 0) {
  // 概述段 + 亮点小节，遇到下一个 ### 就停（后面的「新增/变更/修复」属于日志，不进发版说明）
  const nextSection = section.findIndex((line, index) => index > highlightIndex && isSectionHeading(line))
  body = section.slice(0, nextSection >= 0 ? nextSection : section.length)
} else {
  const stopAt = section.findIndex((line) => /^###\s*已知限制/.test(line.trim()))
  body = stopAt >= 0 ? section.slice(0, stopAt) : section
  process.stderr.write(`${version} 没有「### 亮点」小节，发版说明退回完整条目；建议补上 3~6 条用户可见的改动。\n`)
}

body = body.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '')

const downloads = [
  `**下载**：\`EnvHub-${version}-setup.exe\`（安装版）· \`EnvHub-${version}-portable.exe\`（免安装单文件）· \`EnvHub-${version}-win-x64.zip\`（免安装解压版）`,
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
