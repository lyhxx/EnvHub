# EnvHub 开发文档

面向参与 EnvHub 开发的工程师，说明架构、约定与扩展方式。产品介绍见 [README.md](../README.md)，版本记录见 [CHANGELOG.md](../CHANGELOG.md)。

## 1. 环境要求

- Windows 10 / 11（x64；ARM64 会按架构请求对应资产，部分项目暂无 ARM 包）
- Node.js ≥ 20（开发机实测 24.x）
- npm（随 Node 安装）

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run dev` | 开发模式。`scripts/dev.cjs` 会在 `node_modules/.cache/envhub-dev-electron/` 生成一份把名称/图标改为 EnvHub 的 Electron 宿主副本，再通过 `ELECTRON_EXEC_PATH` 启动，避免任务栏显示 "Electron" |
| `npm run typecheck` | 主进程 + 渲染进程类型检查 |
| `npm run build` | 类型检查后编译到 `out/` |
| `npm run dist` | 编译并生成 NSIS 安装包到 `release/` |

调试提示：

- **修改 preload 或主进程后必须重启 `npm run dev`**，HMR 只作用于渲染进程。
- 渲染进程可用 DevTools；主进程日志输出在终端。
- 配置与记录：`%APPDATA%\EnvHub\db.json`（Electron userData 目录），损坏时自动读取 `db.json.bak`；会话锁为同目录下的 `session.lock`。
- 运行时与下载：默认在 `%LOCALAPPDATA%\EnvHub\`（`runtimes\<环境>\<版本>`、`downloads\`），可在设置中迁移；换目录后以 `db.json` 的 `managedRoot` 为准。

## 3. 架构

```
Renderer (Vue 3, 无 Node 能力)
   │  window.envhub.*（preload contextBridge，强类型）
   ▼
IPC 层（src/main/ipc.ts）
   │  通道白名单 + 来源校验 + 参数校验
   ▼
主进程服务
   ├─ runtime/service.ts    环境检测、版本源、资产解析、"当前使用"解析
   ├─ services/downloads.ts 下载队列（并发 3、Range 续传、SHA-256）
   ├─ services/install.ts   托管安装/卸载（extract-zip）
   ├─ services/environment.ts 用户/系统 PATH、JAVA_HOME、提权接管、特权助手、撤销与修复
   ├─ services/storage.ts   数据目录切换与搬移
   ├─ services/packages.ts  npm / pip / Maven 镜像与缓存
   ├─ services/network.ts   代理设置与连接测试
   ├─ services/notifications.ts 主进程主动提示
   └─ storage/store.ts      本机 JSON 存储（原子写 + 备份），变更统一广播
```

实现约束：

1. 渲染进程不接触任何系统能力，全部经 IPC 白名单。
2. IPC 只接受 `runtimeId` + `version` 这类原始值；下载 URL、资产信息一律由主进程重新解析，禁止从界面传入 URL。
3. 不存在"执行任意命令"的通道。命令执行使用固定可执行文件 + 参数数组，`windowsHide`，带超时。
4. 状态只有一个出口：主进程写入 `store` 后广播 `app:snapshot`，渲染进程不再各自轮询；高频进度走独立通道（`download:update`、`operation:progress`、`app:notice`）。

## 4. 目录结构

```
src/
├── main/
│   ├── index.ts              # 入口：单实例、会话锁、窗口、自动扫描、代理初始化
│   ├── ipc.ts               # 全部 IPC 通道注册
│   ├── runtime/service.ts   # 检测 + 版本源 + 资产校验 + 当前版本解析
│   ├── services/
│   │   ├── downloads.ts     # 下载队列与校验
│   │   ├── install.ts       # 安装 / 卸载
│   │   ├── environment.ts   # PATH / JAVA_HOME / 提权接管 / 助手 / 修复
│   │   ├── storage.ts       # 数据目录切换与搬移
│   │   ├── packages.ts      # 包管理器配置
│   │   ├── network.ts       # 代理
│   │   └── notifications.ts # 主进程提示
│   └── storage/store.ts     # JSON 存储
├── preload/index.ts         # contextBridge API
├── renderer/
│   ├── index.html           # 含 CSP
│   └── src/
│       ├── App.vue          # 全部页面（概览 / 环境与工具 / 下载 / 设置）
│       ├── main.ts
│       ├── styles.css       # 设计系统（CSS 变量 + 全局规则）
│       └── assets/brand/    # 品牌资源
└── shared/
    ├── contracts.ts         # IPC 契约、数据类型
    ├── runtimeMeta.ts       # 环境目录元数据
    └── appInfo.ts           # 版本号
```

## 5. IPC 通道

| 通道 | 参数 | 说明 |
| --- | --- | --- |
| `app:get-snapshot` | — | 读取整份本机数据（环境、下载、配置、备份） |
| `app:set-theme` | `theme` | 浅色/深色/跟随系统 |
| `app:open-external` | `url` | 打开官网（域名白名单） |
| `app:copy-text` | `text` | 写系统剪贴板 |
| `app:copy-link` | `runtimeId, version` | 复制官方下载/页面链接（主进程解析） |
| `runtime:open-download-link` | `runtimeId, version` | 用浏览器打开官方直链 |
| `runtime:scan` | — | 扫描本机环境，刷新"当前使用"标记 |
| `runtime:refresh-current` | `runtimeId?` | 重新解析"当前使用"（省略则重算全部环境） |
| `runtime:resolve-current` | `runtimeId` | 按生效 PATH 解析当前实际生效的可执行文件 |
| `runtime:register-manual` | `runtimeId` | 手动登记可执行文件 |
| `runtime:remove-manual` | `id` | 从清单移除手动登记项 |
| `runtime:catalog` | `runtimeId` | 读取官方可用版本 |
| `runtime:activate` | `id` | 设为默认：写用户 PATH（JDK 同步 JAVA_HOME），并重算全部"当前使用"标记 |
| `runtime:takeover-priority` | `id` | 提权移除系统 PATH 中遮蔽该版本的目录 |
| `runtime:install` | `downloadId, activate` | 解压托管安装 |
| `runtime:uninstall` | `id` | 卸载托管版本 |
| `download:start` | `runtimeId, version` | 创建下载任务 |
| `download:pause` / `resume` / `cancel` | `id` | 任务控制 |
| `download:remove` | `id, deleteFile` | 删除任务（活动任务会先取消） |
| `download:import` | `runtimeId, version` | 导入浏览器下载的 ZIP 并校验 |
| `download:directory` | — | 打开下载目录 |
| `network:get-proxy` / `test-proxy` / `set-proxy` | — | 代理状态、连接测试、设置 |
| `packages:get` | `manager` | 读取镜像 + 缓存配置（真实文件值） |
| `packages:set` | `manager, registry` | 写镜像 |
| `packages:set-cache` | `manager, cacheDir` | 写缓存/仓库路径 |
| `packages:test` | `manager, registry` | 测试镜像连通性 |
| `packages:undo-path` | — | 撤销上一次 PATH / JAVA_HOME 修改 |
| `environment:repair-path` | — | 清理用户 PATH 中的重复项与失效目录 |
| `app:choose-managed-root` | — | 选择新的数据目录 |
| `app:set-managed-root` | `path, moveExisting` | 切换数据目录（可选搬移现有内容） |
| `privileged:status` / `enable` / `disable` | — | 官方助手任务的状态与管理 |

事件（主进程 → 渲染进程）：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `app:snapshot` | `AppSnapshot` | 数据变更广播（唯一的全量状态出口） |
| `download:update` | `DownloadTask` | 下载任务进度/状态变化（高频，不落盘） |
| `operation:progress` | `{ percent, detail }` | 长任务进度（如跨盘搬移） |
| `app:notice` | `string` | 主进程主动提示（如清理了中断残留） |

## 6. 数据存储

`%APPDATA%\EnvHub\db.json`（原子写：先写 `.tmp` 再 rename；启动时滚动备份到 `.bak`；损坏时回退并保留现场）。写入串行化，结构带 `schemaVersion`。同目录的 `session.lock` 用于识别异常退出。

关键字段：

```jsonc
{
  "schemaVersion": 1,
  "theme": "system",                 // light | dark | system
  "proxy": { "mode": "system", "server": "" },
  "packageConfigs": {                // 镜像与缓存（同时以真实配置文件为准）
    "npm":   { "registry": "https://registry.npmjs.org/", "cacheDir": "…" },
    "pip":   { "registry": "https://pypi.org/simple" },
    "maven": { "registry": "https://repo.maven.apache.org/maven2" }
  },
  "managedRoot": "C:\\Users\\<user>\\AppData\\Local\\EnvHub",  // 可迁移
  "previousManagedRoot": "D:\\envhub",                          // 上次的位置，用于找回记录
  "installations": [ { "runtimeId": "node", "version": "24.15.0", "source": "path|manual|managed",
                       "executablePath": "…", "managedDir": "…", "isDefault": false, "isCurrent": true } ],
  "downloads": [ { "id": "…", "status": "…", "receivedBytes": 0, "sha256": "…" } ],
  "managedPaths": { "node": "C:\\…\\runtimes\\node\\24.21.0" },  // EnvHub 写入 PATH 的目录
  "pathBackups": [ { "at": "…", "previousPath": "…", "appliedPath": "…",
                     "previousMachinePath": "…", "appliedMachinePath": "…" } ]
}
```

下载进度只在状态翻转时落盘，进度本身仅存内存。

托管目录中的每个版本都带一份 `.envhub.json` 标记，用于应用重装或数据目录迁移后重新登记；启动时会清理没有该标记的安装目录（上次中断的残留）。

### 环境变量写入（PATH / JAVA_HOME）约定

- 写入前保存完整快照（`managedPaths` / `pathBackups`），撤销时只恢复真正被改动过的项。
- 写入走注册表 `HKCU:\Environment` 并显式指定值类型：`Path` 用 `ExpandString`（保留 `%VAR%` 展开语义），其他变量用 `String`。
- **不要用 `[Environment]::SetEnvironmentVariable(...,'User')`**：它写注册表的同时会同步广播 `WM_SETTINGCHANGE`，实测在本机阻塞约 10 秒（等待所有窗口响应），并且会把 `Path` 的值类型降级成普通字符串。
- 变更通知由独立后台进程发送（`SendMessageTimeout` + `SMTO_ABORTIFHUNG` + 1 秒超时），主流程不等待；连续多次写入合并为一次通知。后台脚本用 PowerShell 的 `Add-Type` 声明 P/Invoke，调用的是 Windows 自带的 .NET Framework 编译器，目标机器无需额外安装。
- 读取环境变量时用一次 PowerShell 调用批量取回（用户 PATH、系统 PATH、`JAVA_HOME`），结果缓存 5 秒、写入成功后直接回填，避免一次操作启动多个进程。
- 生效 PATH = 系统 PATH 在前 + 用户 PATH 在后。任何 PATH 变化（切换版本、提权清理、修 PATH、撤销、换数据目录）后都必须**整体**重算所有运行时的“当前使用”标记，不能只刷新被操作的那一个。

## 7. 扩展一个新环境

当前环境元数据集中在 `src/shared/runtimeMeta.ts`，检测逻辑在 `src/main/runtime/service.ts`。新增一个环境的最小步骤：

1. `src/shared/contracts.ts`：把 id 加入 `RuntimeId` 联合类型。
2. `src/shared/runtimeMeta.ts`：添加 `{ id, name, shortName, glyph, subtitle, description, color, officialUrl }`。
3. `src/main/runtime/service.ts`：
   - `commands`：加可执行文件名、版本参数、版本解析正则（不要加会阻塞的交互式命令）。
   - `commonCandidates`：加常见安装目录（PATH 之外的候选位置）。
   - 若只有脚本（`.cmd/.bat`），放入 `scriptCommands`，并且**不要执行它**，改用路径推断版本。
   - `validateProviderAsset.hosts`：加入允许下载的官方域名。
   - `getCatalog`：如需应用内下载，新增该环境的版本源分支（必须提供 SHA-256 才允许应用内下载）。
4. `src/main/services/install.ts`：若支持应用内安装，在 `installableRuntimes` 与 `findExecutable` 中登记可执行文件相对路径。
5. 界面不需要改动：词云、列表、详情页都由 `runtimeMeta` 驱动。

> 0.5.0 计划把上述逻辑拆到 `src/main/runtime/providers/<id>.ts`，每个 Provider 声明 detect/catalog/install 能力，进一步降低耦合。

## 8. 扩展包管理器配置

`src/main/services/packages.ts`：

- `configFiles`：配置文件路径；
- `defaultCacheDirs`：未配置时展示的默认位置；
- `parseRegistry` / `parseCacheDir`：从文件读取真实值；
- `updateNpmrc` / `updatePipIni` / `updateMavenSettings` 与 `updateKeyLine` / `updateIniGlobalKey` / `updateMavenLocalRepository`：写入对应键。

约定：写入前保留 `.bak`，只改动目标键，其余内容原样保留；地址必须 HTTPS（localhost 例外），路径必须是绝对路径且不含 `..`。

## 9. 安全约定

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，preload 只暴露具名方法。
- IPC 校验发送方为主窗口主框架，且 URL 属于应用自身（开发为 dev server 源，生产为打包后的 `index.html`）。
- 渲染进程传入的 `runtimeId` 必须在注册表内；`version` 长度受限并在主进程重新解析为资产后才使用。
- 下载：HTTPS + 域名白名单；重定向逐跳校验；SHA-256 校验失败删除文件。
- 安装解压：`extract-zip` 防路径穿越；失败回滚。
- 卸载：目标必须位于 `managedRoot\runtimes` 内且非符号链接。
- PATH 写入：默认只写当前用户 PATH（写入前备份、超长中止、可撤销）。注意 Windows 的生效 PATH 是"系统 PATH 在前、用户 PATH 在后"，因此写入用户 PATH 不保证优先级；`services/environment.ts` 会按生效顺序检查是否存在排在更前面的同类可执行文件，并在结果中返回 `shadowedBy`，界面据此提示用户。
- 系统 PATH 修改：仅在用户确认"移除并生效"后执行，且只删除遮蔽用的目录条目，不新增任何内容；方式为一次性提权或用户显式启用的计划任务助手，原值存入 `pathBackups` 可撤销。系统 PATH 始终以 `ExpandString` 写入，避免 `%SystemRoot%` 这类条目失去展开能力。
- 特权助手：以 `.ps1` 文件注册到计划任务，每次运行前重写脚本内容，保证不会执行旧版本实现；禁用时会注销该任务。
- 代理：仅接受 http/https/socks4/socks5，不保存账号密码，不接收带路径/查询的地址。

## 10. 构建与发布

`electron-builder` 配置在 `package.json` 的 `build` 字段：

- `appId`: `cn.javai.envhub`；
- 安装包图标：`build/icon.ico`（随窗口图标一起使用，打包时通过 `extraResources` 复制到 `resources/icon.ico`）；
- 目标：NSIS（`oneClick: false`，允许选择安装目录），产物 `release/EnvHub-<version>-setup.exe`。

版本号维护：

1. 修改 `package.json` 的 `version`；
2. 同步 `src/shared/appInfo.ts` 的 `APP_VERSION`（侧栏展示用）；
3. 在 `CHANGELOG.md` 增加对应版本记录。

未接入代码签名：正式对外分发前需要配置证书，否则 SmartScreen 会提示未知发布者。

## 11. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 改了 preload 后界面报方法不存在 | HMR 不覆盖 preload，重启 `npm run dev` |
| 任务栏显示 "Electron" | 开发模式需通过 `scripts/dev.cjs` 启动（即 `npm run dev`），它会准备带品牌信息的宿主副本 |
| 设为默认后当前终端没变化 | 环境变量对已运行进程无效，需要新开终端；若系统 PATH 中还有更靠前的同类目录，界面会给出提示 |
| 界面提示"未生效" | 已写入用户 PATH，但系统 PATH 里有更靠前的同类目录；点"使用此版本"后按提示移除遮蔽目录 |
| 切换版本后新终端仍是旧版本 | 环境变量变更通知由后台进程发送，若 Explorer 长期未重启可能读不到新值；注销或重启 Explorer 后再试 |
| 切换版本很快，但"当前使用"标记更新慢 | 属于旧版本缺陷（只刷新单个环境），0.2.0 起任何 PATH 变化都会整体重算 |
| 安装按钮报"该版本已安装" | 已存在同一版本的托管记录；如需重装先卸载 |
| 镜像"当前"显示默认位置 | 配置文件里没有对应键，显示的是该工具默认路径；点"应用"后写入 |
| PATH 改错了 | 设置页 → 本机数据 → 撤销修改（恢复上一次 PATH 与 JAVA_HOME） |
| 换了数据目录后旧目录还在 | 迁移只复制不删除，确认新目录可用后自行清理旧目录 |
| 提示"已清理 1 个未完成目录" | 上次安装中断留下的半成品目录（缺少 `.envhub.json` 标记），属正常清理 |
