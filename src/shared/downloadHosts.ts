import type { RuntimeId } from './contracts'

// 各环境允许下载的最终主机名。校验入口（首跳）与实际下载（含重定向）共用这一份清单，避免两处漂移。
export const downloadHosts: Record<RuntimeId, string[]> = {
  node: ['nodejs.org'],
  jdk: ['api.adoptium.net', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
  python: ['python.org', 'www.python.org'],
  git: ['git-scm.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
  go: ['go.dev', 'dl.google.com', 'golang.org'],
  rust: ['rust-lang.org', 'static.rust-lang.org', 'github.com', 'objects.githubusercontent.com'],
  dotnet: ['dotnet.microsoft.com', 'download.visualstudio.microsoft.com', 'builds.dotnet.microsoft.com'],
  php: ['windows.php.net', 'downloads.php.net', 'php.net'],
  ruby: ['rubyinstaller.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
  maven: ['maven.apache.org', 'archive.apache.org', 'downloads.apache.org', 'dlcdn.apache.org', 'repo.maven.apache.org'],
  gradle: ['gradle.org', 'services.gradle.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
  docker: ['docker.com', 'docs.docker.com'],
  bun: ['bun.sh', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
}

export function isAllowedDownloadHost(runtimeId: RuntimeId, url: string): boolean {
  try {
    return downloadHosts[runtimeId].includes(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}
