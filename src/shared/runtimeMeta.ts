import type { RuntimeMeta } from './contracts'

export const runtimeMeta: RuntimeMeta[] = [
  { id: 'python', name: 'Python', shortName: 'PY', glyph: 'Py', subtitle: '通用开发 · 数据科学', description: '通用开发与数据科学', color: '#3974c6', officialUrl: 'https://www.python.org/downloads/windows/', group: 'runtime' },
  { id: 'node', name: 'Node.js', shortName: 'Node', glyph: 'N', subtitle: 'JavaScript · 工具链', description: 'JavaScript 运行时与工具链', color: '#438b5a', officialUrl: 'https://nodejs.org/en/download', group: 'runtime' },
  { id: 'bun', name: 'Bun', shortName: 'BUN', glyph: 'B', subtitle: 'JavaScript 运行时', description: 'Bun 运行时', color: '#d8a928', officialUrl: 'https://bun.sh/', group: 'runtime' },
  { id: 'jdk', name: 'Java / JDK', shortName: 'JDK', glyph: 'J', subtitle: 'Java 开发工具包', description: 'Java 开发工具包', color: '#bd624a', officialUrl: 'https://adoptium.net/temurin/releases/', group: 'runtime' },
  { id: 'go', name: 'Go', shortName: 'GO', glyph: 'Go', subtitle: '并发 · 云原生', description: 'Go 语言工具链', color: '#00a7c8', officialUrl: 'https://go.dev/dl/', group: 'runtime' },
  { id: 'rust', name: 'Rust', shortName: 'RUST', glyph: 'R', subtitle: '系统编程 · Cargo', description: 'Rust 编译器与 Cargo', color: '#b86e4b', officialUrl: 'https://www.rust-lang.org/tools/install', group: 'runtime' },
  { id: 'dotnet', name: '.NET', shortName: '.NET', glyph: '.N', subtitle: 'C# · SDK', description: '.NET SDK', color: '#7656b5', officialUrl: 'https://dotnet.microsoft.com/download', group: 'runtime' },
  { id: 'php', name: 'PHP', shortName: 'PHP', glyph: 'P', subtitle: 'Web · 后端', description: 'PHP 运行时', color: '#777bb4', officialUrl: 'https://windows.php.net/download/', group: 'runtime' },
  { id: 'ruby', name: 'Ruby', shortName: 'RUBY', glyph: 'Rb', subtitle: 'Web · 脚本', description: 'Ruby 运行时', color: '#b94750', officialUrl: 'https://rubyinstaller.org/downloads/', group: 'runtime' },
  { id: 'git', name: 'Git', shortName: 'GIT', glyph: '⌘', subtitle: '分布式版本控制', description: '分布式版本控制', color: '#d86c43', officialUrl: 'https://git-scm.com/download/win', group: 'toolchain' },
  { id: 'maven', name: 'Maven', shortName: 'MVN', glyph: 'M', subtitle: 'Java 构建 · 依赖', description: 'Apache Maven', color: '#9a6b3e', officialUrl: 'https://maven.apache.org/download.cgi', group: 'toolchain' },
  { id: 'gradle', name: 'Gradle', shortName: 'GRADLE', glyph: 'Gr', subtitle: 'JVM 构建工具', description: 'Gradle 构建工具', color: '#267e75', officialUrl: 'https://gradle.org/releases/', group: 'toolchain' },
  { id: 'docker', name: 'Docker', shortName: 'DOCKER', glyph: 'D', subtitle: '容器 · 镜像', description: 'Docker CLI', color: '#2496ed', officialUrl: 'https://www.docker.com/products/docker-desktop/', group: 'container' }
]

export const runtimeGroups: { id: RuntimeMeta['group']; label: string }[] = [
  { id: 'runtime', label: '运行时' },
  { id: 'toolchain', label: '构建与工具' },
  { id: 'container', label: '容器' }
]
