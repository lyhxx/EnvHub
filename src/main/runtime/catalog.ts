import { net } from 'electron'
import type { ChecksumAlgorithm, FileChecksum, RuntimeCatalogItem, RuntimeId } from '../../shared/contracts'
import { runtimeMeta } from '../../shared/runtimeMeta'
import { isInstallableRuntime } from '../../shared/installable'
import { displayVersion } from '../../shared/versions'
import { APP_VERSION } from '../../shared/appInfo'

// 各环境的官方版本清单都在这里取。原则：
// 1) 只读官方发布源，不用第三方镜像；
// 2) 只有「官方 ZIP 归档 + 官方校验值」才开放应用内安装，其余只提供版本列表与官方链接；
// 3) 结果按 URL 缓存，避免反复请求（GitHub 接口对匿名调用有次数限制）；
// 4) 每个请求都有超时，单个来源失败不会让界面一直转圈，也不会静默变成空列表。

type Architecture = 'x64' | 'arm64'

interface CacheEntry { at: number; value: string; finalUrl: string }
const cache = new Map<string, CacheEntry>()
const cacheTtl = 5 * 60 * 1000
const requestTimeout = 15_000

function cached(key: string): CacheEntry | null {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < cacheTtl) return hit
  return null
}

async function fetchTextWithUrl(url: string, allowedHosts: string | string[]): Promise<{ text: string; finalUrl: string }> {
  const allowed = Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts]
  const key = `text:${url}`
  const hit = cached(key)
  if (hit) return { text: hit.value, finalUrl: hit.finalUrl }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeout)
  try {
    const response = await net.fetch(url, { headers: { 'User-Agent': `EnvHub/${APP_VERSION}` }, signal: controller.signal })
    const finalUrl = response.url || url
    if (!allowed.includes(new URL(finalUrl).hostname.toLowerCase())) throw new Error('版本源重定向到了非预期域名')
    if (response.status === 403 || response.status === 429) throw new Error('官方版本源暂时限制了访问频率，请稍后再试')
    if (!response.ok) throw new Error(`版本源请求失败：HTTP ${response.status}`)
    const text = await response.text()
    cache.set(key, { at: Date.now(), value: text, finalUrl })
    return { text, finalUrl }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('官方版本源响应超时，请检查网络或代理后重试')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText(url: string, allowedHosts: string | string[]): Promise<string> {
  return (await fetchTextWithUrl(url, allowedHosts)).text
}

async function fetchJson<T>(url: string, allowedHosts: string | string[]): Promise<T> {
  return JSON.parse(await fetchText(url, allowedHosts)) as T
}

// 全部来源都失败时不要把空列表交给界面（那样看起来像"官方没有版本"）。
function ensureNotEmpty(items: RuntimeCatalogItem[], label: string): RuntimeCatalogItem[] {
  if (!items.length) throw new Error(`暂时无法从官方源读取${label}版本，请检查网络或代理后重试`)
  return items
}

function pageUrlOf(runtimeId: RuntimeId): string {
  return runtimeMeta.find((item) => item.id === runtimeId)?.officialUrl ?? 'https://github.com/lyhxx/EnvHub'
}

function parts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function compareVersionsDesc(left: string, right: string): number {
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function checksumOf(algorithm: ChecksumAlgorithm, value: string | undefined): FileChecksum | undefined {
  const expected = algorithm === 'sha1' ? 40 : algorithm === 'sha256' ? 64 : 128
  const normalized = (value ?? '').trim().toLowerCase()
  return new RegExp(`^[a-f0-9]{${expected}}$`).test(normalized) ? { algorithm, value: normalized } : undefined
}

function item(runtimeId: RuntimeId, version: string, architecture: Architecture, extra: Partial<RuntimeCatalogItem> = {}): RuntimeCatalogItem {
  // 只有「该环境支持应用内安装 + 有官方直链 + 有官方校验值」三个条件同时满足才开放安装。
  const installSupported = isInstallableRuntime(runtimeId) && Boolean(extra.downloadUrl) && Boolean(extra.checksum)
  return {
    runtimeId, version, architecture, pageUrl: pageUrlOf(runtimeId),
    ...extra,
    installSupported
  }
}

// ── Node.js：取最近几个 LTS 大版本 ────────────────────────────────────────────────
async function nodeCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const releases = await fetchJson<{ version: string; lts: string | false }[]>('https://nodejs.org/dist/index.json', 'nodejs.org')
  const latestPerMajor = new Map<number, string>()
  for (const release of releases) {
    if (!release.lts) continue
    const major = parts(release.version.replace(/^v/, ''))[0] ?? 0
    if (!latestPerMajor.has(major)) latestPerMajor.set(major, release.version.replace(/^v/, ''))
  }
  const versions = [...latestPerMajor.values()].slice(0, 3)
  if (!versions.length) throw new Error('官方源没有返回 Node.js LTS 版本，请稍后再试')
  return Promise.all(versions.map(async (version) => {
    const fileName = `node-v${version}-win-${architecture}.zip`
    const base = `https://nodejs.org/dist/v${version}`
    try {
      const checksums = await fetchText(`${base}/SHASUMS256.txt`, 'nodejs.org')
      const checksum = checksumOf('sha256', checksums.split(/\r?\n/).find((line) => line.endsWith(`  ${fileName}`))?.split(/\s+/)[0])
      return item('node', version, architecture, {
        downloadUrl: `${base}/${fileName}`, fileName, checksum,
        note: checksum ? '官方 LTS ZIP；下载后会校验 SHA-256，可直接在应用内安装。' : '官方校验值未找到，暂不允许应用内下载。'
      })
    } catch {
      // 校验清单读不到时仍然给出直链，至少可以复制链接用浏览器下载。
      return item('node', version, architecture, {
        downloadUrl: `${base}/${fileName}`, fileName,
        note: '暂时读不到该版本的校验清单，可复制直链用浏览器下载；应用内安装暂不可用。'
      })
    }
  }))
}

// ── JDK：Eclipse Temurin ────────────────────────────────────────────────────────
async function jdkCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const majors = [25, 21, 17, 11]
  const assets = await Promise.all(majors.map(async (major) => {
    try {
      const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${architecture}&image_type=jdk&os=windows&vendor=eclipse`
      const data = await fetchJson<{
        release_name?: string
        version?: { semver?: string }
        binary?: { package?: { link?: string; checksum?: string; name?: string } }
      }[]>(url, 'api.adoptium.net')
      const release = data[0]
      const pkg = release?.binary?.package
      if (!pkg?.link || !pkg.checksum) return null
      // Adoptium v3 的版本在 version.semver（形如 21.0.12+101.0.LTS），去掉构建元数据后与 java -version 一致。
      const raw = release.version?.semver ?? release.release_name?.replace(/^jdk-/, '') ?? String(major)
      const version = displayVersion(raw) || String(major)
      const fileName = pkg.name ?? new URL(pkg.link).pathname.split('/').pop() ?? `jdk-${major}.zip`
      return item('jdk', version, architecture, {
        downloadUrl: pkg.link, fileName, checksum: checksumOf('sha256', pkg.checksum),
        note: 'Eclipse Temurin JDK ZIP；下载后会校验 SHA-256，可直接在应用内安装。'
      })
    } catch {
      return null
    }
  }))
  return ensureNotEmpty(assets.filter((entry): entry is RuntimeCatalogItem => entry !== null), 'Temurin JDK')
}

// ── Python：官方 FTP 目录（安装包是 .exe，只做版本列表与浏览器下载） ──────────────
async function pythonCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const listing = await fetchText('https://www.python.org/ftp/python/', 'www.python.org')
  const versions = [...listing.matchAll(/href="(\d+)\.(\d+)\.(\d+)\/"/g)]
    .map((match) => `${match[1]}.${match[2]}.${match[3]}`)
    .filter((version) => {
      const [major, minor] = parts(version)
      return major === 3 && (minor ?? 0) >= 6
    })
    .sort(compareVersionsDesc)
    .slice(0, 10)
  return ensureNotEmpty(versions.map((version) => item('python', version, architecture, {
    downloadUrl: `https://www.python.org/ftp/python/${version}/python-${version}-amd64.exe`,
    fileName: `python-${version}-amd64.exe`,
    pageUrl: `https://www.python.org/downloads/release/python-${version.replace(/\./g, '')}/`,
    note: '官方 Windows 安装包（.exe）：可在浏览器下载后运行安装；安装完成后 EnvHub 会自动识别。'
  })), 'Python')
}

// ── Go：官方 JSON 带 SHA-256，ZIP 可直接应用内安装 ────────────────────────────────
async function goCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const releases = await fetchJson<{ version: string; stable: boolean; files: { filename: string; os: string; arch: string; kind: string; sha256?: string }[] }[]>(
    'https://go.dev/dl/?mode=json&include=all', 'go.dev'
  )
  const wanted = architecture === 'arm64' ? 'arm64' : 'amd64'
  return ensureNotEmpty(releases
    .filter((release) => release.stable)
    .slice(0, 8)
    .map((release) => {
      const version = release.version.replace(/^go/, '')
      const file = release.files.find((entry) => entry.kind === 'archive' && entry.os === 'windows' && entry.arch === wanted)
      const checksum = checksumOf('sha256', file?.sha256)
      return item('go', version, architecture, {
        ...(file ? { downloadUrl: `https://go.dev/dl/${file.filename}`, fileName: file.filename } : {}),
        checksum,
        note: checksum ? '官方 Windows ZIP；下载后会校验 SHA-256，可直接在应用内安装。' : '官方校验值未找到，暂不允许应用内下载。'
      })
    }), 'Go')
}

// ── Bun：GitHub Releases（附带 sha256 digest），ZIP 可应用内安装 ───────────────────
interface GitHubRelease {
  tag_name: string
  html_url: string
  assets: { name: string; browser_download_url: string; digest?: string | null }[]
}

async function githubReleases(repository: string, perPage = 10): Promise<GitHubRelease[]> {
  return fetchJson<GitHubRelease[]>(`https://api.github.com/repos/${repository}/releases?per_page=${perPage}`, 'api.github.com')
}

async function bunCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const releases = await githubReleases('oven-sh/bun')
  const assetName = `bun-windows-${architecture === 'arm64' ? 'aarch64' : 'x64'}.zip`
  const items: RuntimeCatalogItem[] = []
  for (const release of releases.slice(0, 8)) {
    if (/-canary|-profile/i.test(release.tag_name)) continue
    const version = release.tag_name.replace(/^bun-v/, '')
    const asset = release.assets.find((entry) => entry.name === assetName)
    if (!asset) continue
    const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : undefined
    const checksum = checksumOf('sha256', digest)
    items.push(item('bun', version, architecture, {
      downloadUrl: asset.browser_download_url, fileName: asset.name, checksum,
      note: checksum ? '官方 Windows ZIP；下载后会校验 SHA-256，可直接在应用内安装。' : '官方未提供校验值，请用浏览器下载后手动登记。'
    }))
  }
  return ensureNotEmpty(items, 'Bun')
}

// ── Rust：版本列表 + 官方 MSI 链接（安装建议走 rustup） ────────────────────────────
async function rustCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const releases = await githubReleases('rust-lang/rust', 8)
  const target = architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  return ensureNotEmpty(releases
    .filter((release) => /^v?\d+\.\d+\.\d+$/.test(release.tag_name))
    .map((release) => {
      const version = release.tag_name.replace(/^v/, '')
      return item('rust', version, architecture, {
        downloadUrl: `https://static.rust-lang.org/dist/rust-${version}-${target}.msi`,
        fileName: `rust-${version}-${target}.msi`,
        note: '官方 MSI 安装包；推荐用 rustup 安装与切换版本，EnvHub 提供版本识别与官网入口。'
      })
    }), 'Rust')
}

// ── .NET：官方 SDK ZIP（官方只发布 hash，算法未标注，暂不应用内安装） ──────────────
async function dotnetCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const rid = architecture === 'arm64' ? 'win-arm64' : 'win-x64'
  const index = await fetchJson<{ 'releases-index': { 'channel-version': string; 'support-phase'?: string; 'latest-sdk': string; 'releases.json': string }[] }>(
    'https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json', 'dotnetcli.blob.core.windows.net'
  )
  const channels = (index['releases-index'] ?? []).filter((channel) => channel['support-phase'] !== 'eol').slice(0, 6)
  const items = await Promise.all(channels.map(async (channel) => {
    try {
      const releases = await fetchJson<{ releases: { sdk?: { version: string; files: { name: string; rid?: string; url: string }[] } }[] }>(
        channel['releases.json'], 'builds.dotnet.microsoft.com'
      )
      const sdk = releases.releases[0]?.sdk
      const file = sdk?.files?.find((entry) => entry.url.endsWith(`${rid}.zip`))
      // 预览版（版本号里带 -rc/-preview）不进列表。
      if (!sdk || !file || sdk.version.includes('-')) return null
      return item('dotnet', sdk.version, architecture, {
        downloadUrl: file.url, fileName: file.name,
        note: '官方 SDK ZIP；可复制直链用浏览器下载，或使用官方安装器安装后由 EnvHub 登记版本。'
      })
    } catch {
      return null
    }
  }))
  return ensureNotEmpty(items.filter((entry): entry is RuntimeCatalogItem => entry !== null).slice(0, 4), '.NET SDK')
}

// ── PHP：官方 NTS ZIP（官方无校验文件，只做列表与浏览器下载） ─────────────────────
async function phpCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  // windows.php.net 的下载目录会重定向到 downloads.php.net，用重定向后的地址作为下载基址，避免路径写死。
  const listing = await fetchTextWithUrl('https://windows.php.net/downloads/releases/', ['windows.php.net', 'downloads.php.net'])
  const base = listing.finalUrl.endsWith('/') ? listing.finalUrl : `${listing.finalUrl}/`
  const best = new Map<string, string>()
  for (const match of listing.text.matchAll(/href="(php-(\d+\.\d+)\.(\d+)-nts-Win32-vs\d+-x64\.zip)"/g)) {
    const minor = match[2]
    const file = match[1]
    const current = best.get(minor)
    if (!current || compareVersionsDesc(current.replace(/^php-/, ''), file.replace(/^php-/, '')) > 0) best.set(minor, file)
  }
  // PHP 官方只发布 x64 构建，ARM64 上也列出 x64 包（可正常在 Windows ARM64 上运行）。
  const armNote = architecture === 'arm64' ? '（官方未提供 ARM64 构建，此处为 x64 包）' : ''
  return ensureNotEmpty([...best.values()]
    .sort(compareVersionsDesc)
    .slice(0, 5)
    .map((file) => {
      const version = file.match(/^php-(\d+\.\d+\.\d+)/)?.[1] ?? file
      return item('php', version, 'x64', {
        downloadUrl: `${base}${file}`, fileName: file, pageUrl: 'https://windows.php.net/download/',
        note: `官方 NTS ZIP（适合命令行）；官方未提供校验文件，EnvHub 不自动下载。解压后可用「手动登记」纳入管理。${armNote}`
      })
    }), 'PHP')
}

// ── Ruby：RubyInstaller 官方安装器 ───────────────────────────────────────────────
async function rubyCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const releases = await githubReleases('oneclick/rubyinstaller2', 12)
  const arch = architecture === 'arm64' ? 'arm' : 'x64'
  const items: RuntimeCatalogItem[] = []
  for (const release of releases) {
    const match = release.tag_name.match(/^RubyInstaller-(\d+\.\d+\.\d+)(-\d+)?$/)
    if (!match) continue
    const version = match[1]
    const full = `${match[1]}${match[2] ?? ''}`
    const asset = release.assets.find((entry) => entry.name === `rubyinstaller-${full}-${arch}.exe`)
    if (!asset) continue
    items.push(item('ruby', version, architecture, {
      downloadUrl: asset.browser_download_url, fileName: asset.name,
      note: '官方 RubyInstaller（.exe）；下载后运行安装，EnvHub 会识别新版本。'
    }))
  }
  return ensureNotEmpty(items.sort((left, right) => compareVersionsDesc(left.version, right.version)).slice(0, 6), 'Ruby')
}

// ── Git for Windows：官方安装器 ─────────────────────────────────────────────────
async function gitCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const releases = await githubReleases('git-for-windows/git', 40)
  const suffix = architecture === 'arm64' ? 'arm64' : '64-bit'
  // 同一个版本可能有多个发布（其中有只放 MinGit 的），所以遍历全部、找到真正的安装器再定稿。
  const found = new Map<string, RuntimeCatalogItem>()
  for (const release of releases) {
    const match = release.tag_name.match(/^v(\d+\.\d+\.\d+)\.windows\.(\d+)$/)
    if (!match) continue
    const version = match[1]
    const asset = release.assets.find((entry) => entry.name === `Git-${match[1]}.${match[2]}-${suffix}.exe`)
      ?? release.assets.find((entry) => entry.name.startsWith(`Git-${version}`) && entry.name.endsWith(`-${suffix}.exe`))
    if (asset) {
      found.set(version, item('git', version, architecture, {
        downloadUrl: asset.browser_download_url, fileName: asset.name,
        note: '官方 Windows 安装包（.exe）；下载后运行安装，EnvHub 会识别新版本。'
      }))
    } else if (!found.has(version)) {
      found.set(version, item('git', version, architecture, {
        pageUrl: release.html_url,
        note: '该版本未提供完整安装包，可前往官方发布页查看。'
      }))
    }
    if (found.size >= 10) break
  }
  return ensureNotEmpty([...found.values()].sort((left, right) => compareVersionsDesc(left.version, right.version)).slice(0, 5), 'Git')
}

// ── Maven：元数据与发行包都取自 Maven Central（永久保留、速度快），失败再回退 Apache 归档 ──
async function mavenCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const xml = await fetchText('https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml', 'repo.maven.apache.org')
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1])
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .sort(compareVersionsDesc)
    .slice(0, 6)
  const items = await Promise.all(versions.map(async (version) => {
    const major = parts(version)[0] ?? 3
    const fileName = `apache-maven-${version}-bin.zip`
    const sources = [
      { url: `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${version}/${fileName}`, host: 'repo.maven.apache.org' },
      { url: `https://archive.apache.org/dist/maven/maven-${major}/${version}/binaries/${fileName}`, host: 'archive.apache.org' }
    ]
    for (const source of sources) {
      try {
        const checksum = checksumOf('sha512', await fetchText(`${source.url}.sha512`, source.host))
        if (checksum) {
          return item('maven', version, architecture, {
            downloadUrl: source.url, fileName, checksum,
            note: '官方 ZIP；下载后会校验 SHA-512，可直接在应用内安装。'
          })
        }
      } catch { /* 换下一个来源 */ }
    }
    return item('maven', version, architecture, {
      pageUrl: 'https://maven.apache.org/download.cgi',
      note: '暂时读不到该版本的官方校验值，可在官网页面手动下载。'
    })
  }))
  return ensureNotEmpty(items, 'Maven')
}

// ── Gradle：官方版本 JSON 自带 checksumUrl 与 SHA-256，可应用内安装 ───────────────
async function gradleCatalog(architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  const versions = await fetchJson<{ version: string; downloadUrl?: string; checksum?: string; snapshot?: boolean; nightly?: boolean; rcFor?: string; milestoneFor?: string; broken?: boolean }[]>(
    'https://services.gradle.org/versions/all', 'services.gradle.org'
  )
  const seen = new Set<string>()
  const stable = versions.filter((entry) => {
    if (!entry.version || !entry.downloadUrl || !entry.checksum) return false
    if (entry.snapshot || entry.nightly || entry.rcFor || entry.milestoneFor || entry.broken) return false
    if (/-(rc|milestone|snapshot)/i.test(entry.version)) return false
    if (seen.has(entry.version)) return false
    seen.add(entry.version)
    return true
  })
  return ensureNotEmpty(stable
    .sort((left, right) => compareVersionsDesc(left.version, right.version))
    .slice(0, 6)
    .map((entry) => item('gradle', entry.version, architecture, {
      downloadUrl: entry.downloadUrl, fileName: `gradle-${entry.version}-bin.zip`,
      checksum: checksumOf('sha256', entry.checksum),
      note: '官方 ZIP；下载后会校验 SHA-256，可直接在应用内安装。'
    })), 'Gradle')
}

export async function loadCatalog(runtimeId: RuntimeId, architecture: Architecture): Promise<RuntimeCatalogItem[]> {
  switch (runtimeId) {
    case 'node': return nodeCatalog(architecture)
    case 'jdk': return jdkCatalog(architecture)
    case 'python': return pythonCatalog(architecture)
    case 'go': return goCatalog(architecture)
    case 'bun': return bunCatalog(architecture)
    case 'rust': return rustCatalog(architecture)
    case 'dotnet': return dotnetCatalog(architecture)
    case 'php': return phpCatalog(architecture)
    case 'ruby': return rubyCatalog(architecture)
    case 'git': return gitCatalog(architecture)
    case 'maven': return mavenCatalog(architecture)
    case 'gradle': return gradleCatalog(architecture)
    default:
      return [{
        runtimeId, version: '由官方安装器维护', architecture,
        pageUrl: pageUrlOf(runtimeId), installSupported: false,
        note: '该环境由官方安装器维护（EnvHub 只识别已有的安装与版本），请从官网获取。'
      }]
  }
}
