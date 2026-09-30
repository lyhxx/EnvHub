# EnvHub 开发文档

面向参与 EnvHub 开发的工程师，说明架构、约定与扩展方式。产品介绍见 [README.md](../README.md)，版本记录见 [CHANGELOG.md](../CHANGELOG.md)。

## 1. 环境要求

- Windows 10 / 11（x64；ARM64 会按架构请求对应资产，部分项目暂无 ARM 包）
- Node.js ≥ 20.19（开发机实测 24.x；vite / electron-vite / plugin-vue 的 engines 要求 `^20.19.0 || >=22.12.0`）
- npm（随 Node 安装）

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run dev` | 开发模式。`scripts/dev.cjs` 会在 `node_modules/.cache/envhub-dev-electron/` 生成一份把名称/图标改为 EnvHub 的 Electron 宿主副本，再通过 `ELECTRON_EXEC_PATH` 启动，避免任务栏显示 "Electron" |
| `npm run typecheck` | 主进程 + 渲染进程类型检查 |
| `npm run build` | 类型检查后编译到 `out/` |
| `npm run dist` | 编译并生成安装版与绿色版到 `release/` |

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
   ├─ services/downloads.ts 下载队列（并发 3、Range 续传、按算法校验哈希）
   ├─ services/install.ts   托管安装/卸载（extract-zip）
   ├─ services/environment.ts 用户/系统 PATH、JAVA_HOME、提权接管、特权助手、撤销与修复
   ├─ services/storage.ts   数据目录切换与搬移
   ├─ services/packages.ts  npm / pip / Maven 镜像与缓存
   ├─ services/network.ts   代理设置与连接测试
   ├─ services/updater.ts   更新检查、发行形态判定、更新包下载与安装
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
│   ├── runtime/service.ts   # 检测 + 资产校验 + 当前版本解析
│   ├── runtime/catalog.ts   # 各环境的官方版本清单（可安装性判定）
│   ├── services/
│   │   ├── downloads.ts     # 下载队列与校验
│   │   ├── install.ts       # 安装 / 卸载
│   │   ├── environment.ts   # PATH / JAVA_HOME / 提权接管 / 助手 / 修复
│   │   ├── storage.ts       # 数据目录切换与搬移
│   │   ├── packages.ts      # 包管理器配置
│   │   ├── network.ts       # 代理
│   │   ├── updater.ts       # 更新检查与应用内更新
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
    ├── runtimeMeta.ts       # 环境目录元数据（含搜索关键词 relatedTools）
    ├── executables.ts       # 各环境的可执行文件名与归档内相对路径
    ├── downloadHosts.ts     # 各环境允许下载的域名（校验与下载共用）
    ├── installable.ts       # 支持应用内安装的环境名单（主进程与界面共用）
    ├── versions.ts          # 版本号比较（官方发布名 vs 本地实际报出）
    ├── update.ts            # 更新检查的纯函数：版本比较、产物匹配、发布说明摘要
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
| `update:check` | `force` | 检查更新（`force` 忽略 5 分钟缓存），返回状态 + 版本信息 |
| `update:download` | — | 按当前发行形态把更新包加入下载队列 |
| `update:install` | `downloadId` | 安装版：退出并启动安装程序；其他形态：打开文件所在目录 |
| `update:open-release` | — | 用浏览器打开发布页面（仅本仓库 releases 地址） |
| `update:ignore` / `update:restore` | `version` / — | 忽略此版本 / 恢复更新提示 |

事件（主进程 → 渲染进程）：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `app:snapshot` | `AppSnapshot` | 数据变更广播（唯一的全量状态出口） |
| `download:update` | `DownloadTask` | 下载任务进度/状态变化（高频，不落盘） |
| `operation:progress` | `{ percent, detail }` | 长任务进度（如跨盘搬移） |
| `app:notice` | `string` | 主进程主动提示（如清理了中断残留） |

## 6. 数据存储

`%APPDATA%\EnvHub\db.json`（原子写：先写 `.tmp` 再 rename；备份 `.bak` 只保存"上一次由本进程成功写出的内容"，避免运行期被外部写坏的 db.json 污染健康备份；db.json 损坏时先改名留档为 `db.json.corrupt-<时间戳>`，再从 `.bak` 回退）。写入串行化，结构带 `schemaVersion`。同目录的 `session.lock` 用于识别异常退出。

关键字段：
```jsonc
{
  "schemaVersion": 1,
  "theme": "system",                 // light | dark | system
  "proxy": { "mode": "system", "server": "" },
  "packageConfigs": {                // 只持久化 registry；cacheDir 每次启动都从真实配置文件重新读取
    "npm":   { "registry": "https://registry.npmjs.org/" },
    "pip":   { "registry": "https://pypi.org/simple" },
    "maven": { "registry": "https://repo.maven.apache.org/maven2" }
  },
  "managedRoot": "C:\\Users\\<user>\\AppData\\Local\\EnvHub",  // 可迁移
  "previousManagedRoot": "D:\\envhub",                          // 上一次的位置（仅记录，不再参与扫描）
  "installations": [ { "runtimeId": "node", "version": "24.15.0", "source": "path|manual|managed",
                       "executablePath": "…", "managedDir": "…", "isDefault": false, "isCurrent": true } ],
  "downloads": [ { "id": "…", "kind": "runtime|app", "runtimeId": "node|null", "status": "…", "receivedBytes": 0,
                   "checksum": { "algorithm": "sha256|sha512|sha1", "value": "…" } } ],
  "managedPaths": { "node": "C:\\…\\runtimes\\node\\24.21.0" },  // EnvHub 写入 PATH 的目录
  "pathBackups": [ { "at": "…", "previousPath": "…", "appliedPath": "…",
                     "previousMachinePath": "…", "appliedMachinePath": "…" } ],
  "ignoredUpdateVersions": [ "0.4.0" ]                           // 点过「忽略此版本」的版本号
}
```

`downloads` 分两类：`kind: "runtime"` 是运行环境归档（解压后安装，`runtimeId` 必有），`kind: "app"` 是 EnvHub 自身的更新包（`runtimeId` 为 `null`，只交给用户手动安装）。旧库里的任务没有 `kind`，规范化时按 `runtime` 处理。

下载进度只在状态翻转时落盘，进度本身仅存内存。

托管目录中的每个版本都带一份 `.envhub.json` 标记，用于应用重装或数据目录迁移后重新登记。安装流程会先写入 `state: "installing"` 的标记、完成后再改成 `state: "ready"`；启动扫描时只清理带"安装中"标记的目录与空目录，**没有标记的目录一律保留**（只提示，避免误删用户数据）。旧版本写入的标记没有 `state` 字段，按"已完成"处理。

`previousManagedRoot` 只作为上一次位置的记录，不再参与扫描：选择"仅切换"后旧目录的内容仍留在磁盘上，但不会再被登记进来。

### 环境变量写入（PATH / JAVA_HOME）约定

- 写入前保存完整快照（`managedPaths` / `pathBackups`），撤销时只恢复真正被改动过的项。
- 写入走注册表 `HKCU:\Environment` 并显式指定值类型：`Path` 用 `ExpandString`（保留 `%VAR%` 展开语义），其他变量用 `String`。
- **不要用 `[Environment]::SetEnvironmentVariable(...,'User')`**：它写注册表的同时会同步广播 `WM_SETTINGCHANGE`，实测在本机阻塞约 10 秒（等待所有窗口响应），并且会把 `Path` 的值类型降级成普通字符串。
- 变更通知由独立后台进程发送（`SendMessageTimeout` + `SMTO_ABORTIFHUNG` + 1 秒超时），主流程不等待；连续多次写入合并为一次通知。后台脚本用 PowerShell 的 `Add-Type` 声明 P/Invoke，调用的是 Windows 自带的 .NET Framework 编译器，目标机器无需额外安装。
- 读取环境变量时用一次 PowerShell 调用批量取回（用户 PATH、系统 PATH、`JAVA_HOME`），结果缓存 5 秒、写入成功后直接回填，避免一次操作启动多个进程。
- 生效 PATH = 系统 PATH 在前 + 用户 PATH 在后。任何 PATH 变化（切换版本、提权清理、修 PATH、撤销、换数据目录）后都必须**整体**重算所有运行时的“当前使用”标记，不能只刷新被操作的那一个。
- 「修复 PATH」只删除**确认失效**的条目：`%VAR%` 展开不出来（注册表里有、但当前进程没继承，例如刚写入的 `JAVA_HOME`）时无法判断，一律保留；清理后若一条都不剩则整体中止。
- 激活版本前先校验（例如 JRE 不能设为默认 JDK），因为激活会立刻写 PATH 与 `JAVA_HOME`——先写再报错会把用户环境改坏。

## 7. 扩展一个新环境

当前环境元数据集中在 `src/shared/runtimeMeta.ts`，检测逻辑在 `src/main/runtime/service.ts`。新增一个环境的最小步骤：

1. `src/shared/contracts.ts`：把 id 加入 `RuntimeId` 联合类型。
2. `src/shared/runtimeMeta.ts`：添加 `{ id, name, shortName, glyph, subtitle, description, color, officialUrl, group }`（`group` 必填：`runtime` / `toolchain` / `container`）。
3. `src/main/runtime/service.ts`：
   - `commands`：加可执行文件名、版本参数、版本解析正则（不要加会阻塞的交互式命令）。
   - `commonCandidates`：加常见安装目录（PATH 之外的候选位置）。
   - 若只有脚本（`.cmd/.bat`），放入 `scriptCommands`，并且**不要执行它**，改用路径推断版本。
4. 共享清单（新增环境时逐项登记，避免多处漂移）：
   - `src/shared/executables.ts`：`runtimeExecutables`（可执行文件名，用于探测与遮蔽检测）与 `relativeExecutables`（归档内相对路径，用于托管安装）。
   - `src/shared/downloadHosts.ts`：该环境允许下载的域名（版本校验与实际下载共用）。
   - `src/shared/installable.ts`：若支持应用内安装，把 id 加进名单。
5. `src/main/runtime/catalog.ts`：新增该环境的版本源实现（约定见下）。
6. 界面不需要改动：词云、列表、详情页、"安装"按钮都由上述元数据与共享清单驱动。

### 版本源与校验值约定

- 只读官方发布源（官方 API / 官方目录 / 官方 GitHub Releases），不引入第三方镜像。
- 版本清单按 URL 缓存 5 分钟；GitHub 接口对匿名调用有次数限制，403 / 429 会提示稍后再试。
- 每个请求 15 秒超时（`requestTimeout`）；**全部来源失败时抛错**，不要返回空列表（界面会显示成"官方没有版本"）；单个来源失败保留其余结果，并且不要丢掉直链。用 `ensureNotEmpty()` 统一这个约定。
- **开放应用内安装的前提是：官方 ZIP 归档 + 官方校验值**。`installSupported` 由 `downloadUrl` 与 `checksum` 同时存在推导，`validateProviderAsset` 会二次校验（并确认该环境在 `installable.ts` 名单内）。
- 校验算法不统一：Go / Gradle / Bun / Node.js / JDK 是 SHA-256，Apache Maven 是 SHA-512，因此契约里用 `checksum: { algorithm, value }`。
- 发行包来源优先选**永久保留且快**的官方源：Maven 用 Maven Central（`repo.maven.apache.org`，同时提供 `.sha512`），失败回退 `archive.apache.org/dist`；PHP 的下载基址取官方重定向后的地址，不要写死。
- 版本号比较统一用 `src/shared/versions.ts` 的 `sameVersion`：官方发布名与本地实际报出经常不一致（例如 Temurin 的 `21.0.12.1+1` 与 `java -version` 的 `21.0.12.1`）。
- 检查清单：改动某个环境的版本源前，先用真实请求核对字段结构（Adoptium v3 就把版本从 `version_data.semver` 迁到了 `version.semver`）；改完用真实数据跑一遍（含一次完整下载与校验）。

> 0.5.0 计划把上述 catalog 实现拆到 `src/main/runtime/providers/<id>.ts`，每个 Provider 声明 detect/catalog/install 能力，进一步降低耦合。

## 8. 扩展包管理器配置

`src/main/services/packages.ts`：

- `configFiles`：配置文件路径；
- `defaultCacheDirs`：未配置时展示的默认位置；
- `parseRegistry` / `parseCacheDir`：从文件读取真实值；
- `updateNpmrc` / `updatePipIni` / `updateMavenSettings` 与 `updateKeyLine` / `updateIniGlobalKey` / `updateMavenLocalRepository`：写入对应键。

约定：写入前保留 `.bak`，只改动目标键，其余内容原样保留；地址必须 HTTPS（localhost 例外），路径必须是绝对路径且不含 `..`。

界面还有一条显示规则：**没装这个工具、本机也没有它的配置文件时，不显示默认值**。`getPackageConfig` 返回的 `configFileExists` 说明配置文件是否真的存在，界面用它（配合该环境是否有本机版本）决定是展示配置卡片还是"尚未检测到"的空状态——默认的镜像与缓存地址只是工具约定，摆出来会被误读成"已经配好了"。`cacheDirFromFile` 则决定缓存路径的标签是「已配置」还是「默认位置」。

## 9. 更新检查与应用内更新

实现在 `src/main/services/updater.ts`，界面在概览页横幅与设置 → 关于与更新。

- 数据来源：`api.github.com/repos/lyhxx/EnvHub/releases/latest`（只跟正式版，不含预览版）。复用 Chromium 网络栈，因此走用户配置的代理；15 秒超时；结果缓存 5 分钟，启动检查与设置页检查不会重复打接口（匿名调用限额 60 次/小时）。
- 判断规则：线上版本**严格高于**本地 `APP_VERSION` 才提示（`src/shared/update.ts` 的 `isNewerVersion`）；相等或本地更高都不提示。不区分开发模式——正常开发时本地版本不会低于线上版本，这条规则在开发模式下也不会误报。
- 产物匹配：按当前发行形态挑资产（`matchesUpdateAsset`，同时限定 `EnvHub-` 前缀与形态后缀，避免把别的环境发布的同类归档当成更新包）。形态判定在 `currentRunForm()`：有 `PORTABLE_EXECUTABLE_FILE` / `PORTABLE_EXECUTABLE_DIR` → 绿色单文件版；程序同目录有 `Uninstall EnvHub.exe` → 安装版；都不是 → 解压版。**更新不会改变用户的发行形态**。
- 下载：走与运行时归档同一个队列（`startAppUpdateDownload` → `enqueue`），任务 `kind: "app"`、`runtimeId: null`，因此同样有并发上限、断点续传、卡死看门狗与哈希校验。校验值取 Release 资产的 `digest`（sha256）；没有校验值就不开放应用内下载（与运行时的「官方 ZIP + 官方校验值」同一原则）。主机白名单是 `src/shared/downloadHosts.ts` 的 `appUpdateHosts`。
- 安装：安装版「退出并安装」——**先 detached 拉起安装程序、确认 spawn 成功再 `app.quit()`**（顺序反了会出现"EnvHub 退了、什么都没发生"），装完由 NSIS 的 `runAfterFinish` 重新拉起；绿色单文件版与解压版只 `shell.showItemInFolder`，交回用户手动替换。不做自我替换，也不做静默安装（静默安装需要代码签名）。
- 忽略记录：`ignoredUpdateVersions`（数组）存在 db.json；用数组而不是单个字段，避免某个版本被撤回、`latest` 回退后又提示一遍。忽略 / 恢复后同步内存缓存里的 `ignored` 标记，不额外打接口。
- 本地验证：把 `APP_VERSION` 临时改成比线上低的版本号，就能看到横幅与整条流程；`src/shared/update.ts` 里的纯函数（版本比较、产物匹配、发布说明摘要）可以脱离 Electron 直接跑测试。

## 10. 安全约定

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，preload 只暴露具名方法。
- IPC 校验发送方为主窗口主框架，且 URL 属于应用自身（开发为 dev server 源，生产为打包后的 `index.html`）。
- 渲染进程传入的 `runtimeId` 必须在注册表内；`version` 长度受限并在主进程重新解析为资产后才使用。
- 下载：HTTPS + 域名白名单（`src/shared/downloadHosts.ts`，校验入口与下载逐跳共用）；校验值只取官方发布（`checksum.algorithm` 支持 sha256 / sha512 / sha1），校验失败删除文件；应用内下载仅对「官方 ZIP + 官方校验值」的环境开放。同版本的重复下载请求会复用队列中未完成的任务；连接建立后 60 秒拿不到响应头也会中止（与"60 秒没有数据"同一套看门狗）。
- 安装解压：`extract-zip` 防路径穿越；失败回滚。同一版本在进程内只允许一个安装流程（并发进入会互相删除解压内容）；目标目录若已有 EnvHub 的 `ready` 标记但清单里没有记录（例如 db 被重置），拒绝删除重装，先让用户重扫把记录找回来；托管目录拼接前会校验前缀，避免越界删除。
- 卸载：目标必须位于当前或上一个数据目录的 `runtimes` 下（前缀比较带路径分隔符）且非符号链接。
- 数据目录迁移：子目录逐个搬移，任一步失败会把已搬走的目录搬回原处再报错，不允许出现"文件在新目录、配置还指旧目录"的半迁移状态。
- 版本源：只读官方发布源；清单按 URL 缓存 5 分钟；GitHub 匿名接口的 403 / 429 提示稍后再试；接口字段变更前先用真实请求核对（例如 Adoptium v3 的版本在 `version.semver`）。
- PATH 写入：默认只写当前用户 PATH（写入前备份、超长中止、可撤销）。注意 Windows 的生效 PATH 是"系统 PATH 在前、用户 PATH 在后"，因此写入用户 PATH 不保证优先级；`services/environment.ts` 会按生效顺序检查是否存在排在更前面的同类可执行文件，并在结果中返回 `shadowedBy`，界面据此提示用户。
- 系统 PATH 修改：仅在用户确认"移除并生效"后执行，且只删除遮蔽用的目录条目，不新增任何内容；方式为一次性提权或用户显式启用的计划任务助手，原值存入 `pathBackups` 可撤销。系统 PATH 始终以 `ExpandString` 写入，避免 `%SystemRoot%` 这类条目失去展开能力。
- 特权助手：以 `.ps1` 文件注册到计划任务，每次运行前重写脚本内容，保证不会执行旧版本实现；禁用时会注销该任务。**待办**：界面目前只在「设置 → 管理权限」里提供启用入口，切换版本遇到系统 PATH 遮蔽时没有引导用户去开启（详见 README 路线图的「授权引导」）。
- 代理：仅接受 http/https/socks4/socks5，不保存账号密码，不接收带路径/查询的地址。
- 扫描写回：以扫描结果为底，把扫描期间用户新增（登记/安装）的记录并回来，并把「默认版本」以最新状态为准——整表覆盖会抹掉用户刚做的操作。PATH 变化另有 `environmentRevision` 复核。
- 更新：只读本仓库的 GitHub Releases，打开发布页只允许本仓库的 releases 地址；更新包使用独立的主机白名单（`appUpdateHosts`）且必须有 `digest` 才允许应用内下载；"退出并安装"只看产物名是否匹配安装版，与界面按钮文案同一判断；启动安装程序前先确认进程已创建，再正常退出（保证 `session.lock` 清理与数据落盘）。
- CI 权限：发布工作流需要 `contents: write`，该权限作用于整个 job（含 `npm ci`）。已知取舍：依赖安装阶段也持有可写 token；GITHUB_TOKEN 仅限本仓库且随运行结束失效，如需彻底隔离可拆成"构建（只读）+ 发布（可写）"两个 job。

## 11. 构建与发布

`electron-builder` 配置在 `package.json` 的 `build` 字段：

- `appId`: `cn.javai.envhub`；
- 安装包图标：`build/icon.ico`（随窗口图标一起使用，打包时通过 `extraResources` 复制到 `resources/icon.ico`）；
- 目标三个：NSIS（`oneClick: false`，允许选择安装目录）、portable（免安装单文件）、zip（免安装解压版）。产物名按目标区分：`release/EnvHub-<version>-setup.exe`、`release/EnvHub-<version>-portable.exe`、`release/EnvHub-<version>-win-x64.zip`。
- 本地打包走国内镜像（`scripts/dist.cjs` 设置 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`）；只有 `CI=true` 时才跳过镜像、直接用 GitHub（用真值判断会被 `CI=false` 这类环境误伤）。

自动发布：推送 `v*` 标签触发 `.github/workflows/release.yml`，在 GitHub 上构建三份产物（安装版 / 绿色单文件版 / 绿色解压版）并创建 Release；发布说明由 `scripts/release-notes.cjs` 从 `CHANGELOG.md` 抽取该版本条目生成（去掉"已知限制"，并在开头列出三个下载文件），因此**发版前必须先在 CHANGELOG 写好对应版本**。工作流会校验标签与 `package.json`、`src/shared/appInfo.ts` 的版本一致，重复运行同一标签时覆盖已有产物与说明。

`scripts/dist.cjs` 用 `--publish never` 调用 electron-builder：只打包、不发布。electron-builder 会从 git 远端识别出 GitHub 仓库并自行尝试发布，在没有 `GH_TOKEN` 的环境下会在产物构建完成后报错退出，导致构建步骤被判失败——发布统一交给工作流的 `gh release`。

只有发版这一个工作流：日常提交不跑 CI。需要验证构建时在 Actions 页面手动触发 release.yml，**并选择 `main` 分支**（发布步骤的条件是"推送事件 + 标签 ref"，手动触发即使把 ref 选成标签也不会发版）。工作流用 `run-name` 指定运行标题（否则 GitHub 会拿提交信息当标题，开发用语会直接显示在 Actions 列表里）；需要重跑发布时用 Actions 的 **Re-run jobs**，不要移动标签——移动标签会再触发一次完整发布并新建一条运行记录。

版本号维护：

1. 修改 `package.json` 的 `version`；
2. 同步 `src/shared/appInfo.ts` 的 `APP_VERSION`（侧栏展示用）；
3. 在 `CHANGELOG.md` 增加对应版本记录；
4. 提交后打并推送标签（`git tag v<版本> && git push origin v<版本>`）。

未接入代码签名：正式对外分发前需要配置证书，否则 SmartScreen 会提示未知发布者。

界面截图放在 `docs/images/`（README 的「界面」一节引用），界面有明显改动后需要重新截图并替换同名文件；截图时不要暴露用户名等本机信息。

README 顶部的徽章：技术栈与版本从 `package.json` 动态读取（shields.io 的 dependency-version / dynamic-json 端点），升级依赖后无需手动改；平台与许可为静态徽章。不放本项目的版本号徽章（shields 缓存会让它停在旧版本，版本以 Releases 页面为准）。

## 12. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 改了 preload 后界面报方法不存在 | HMR 不覆盖 preload，重启 `npm run dev` |
| 任务栏显示 "Electron" | 开发模式需通过 `scripts/dev.cjs` 启动（即 `npm run dev`），它会准备带品牌信息的宿主副本 |
| 设为默认后当前终端没变化 | 环境变量对已运行进程无效，需要新开终端；若系统 PATH 中还有更靠前的同类目录，界面会给出提示 |
| 界面提示"未生效" | 已写入用户 PATH，但系统 PATH 里有更靠前的同类目录；点"使用此版本"后按提示移除遮蔽目录 |
| 切换版本后新终端仍是旧版本 | 环境变量变更通知由后台进程发送，若 Explorer 长期未重启可能读不到新值；注销或重启 Explorer 后再试 |
| 切换版本很快，但"当前使用"标记更新慢 | 属于旧版本缺陷（只刷新单个环境），0.2.0 起任何 PATH 变化都会整体重算 |
| 安装按钮报"该版本已安装" | 已存在同一版本的托管记录；如需重装先卸载 |
| 镜像“当前”显示默认位置 | 配置文件里没有对应键，显示的是该工具默认路径；点“应用”后写入。若本机连这个工具都没装（也没有配置文件），软件源页会显示“尚未检测到”，不展示任何默认值 |
| PATH 改错了 | 设置页 → 本机数据 → 撤销修改（恢复上一次 PATH 与 JAVA_HOME） |
| 换了数据目录后旧目录还在 | “搬移并切换”会把内容移到新目录（旧目录仅剩空壳）；“仅切换”只改配置，旧目录内容保留但不再纳入管理 |
| 提示“有 N 个版本目录缺少 EnvHub 标记” | 这些目录不是 EnvHub 装的或标记文件丢失，程序不会自动删除，确认后可手动清理 |
| “仅切换”数据目录后下载列表变空 | 下载文件仍留在旧目录，记录已无法使用（重启后路径会按新目录重算），因此切换时会清理并提示 |
| 下载卡在“下载中”不动 | 超过 60 秒没有任何数据（或建立连接后 60 秒拿不到响应头）会判为失败并保留已下载部分，点“重试 / 续传”继续 |
| 数据目录迁移中途失败 | 子目录是逐个搬移的，任一步失败会把已搬走的目录搬回原处再报错，不会留下“文件在新目录、记录还指旧目录”的半迁移状态；按提示处理占用/权限后重试 |
| “修复 PATH”会不会删掉 `%JAVA_HOME%\bin` 这类条目 | 不会：变量在当前进程里展开不出来时无法判断目录是否存在，一律保留；只有确认指向不存在目录的条目才会被清理 |
| 点“应用内下载”是灰的 | 该版本没有官方校验值、或没有匹配当前发行形态的产物；设置页 → 关于与更新 里有具体原因，也可以改用“浏览器下载” |
| 不想被某个版本反复提示 | 横幅右上 `···` → 忽略此版本；之后在设置页 → 关于与更新 可以恢复提示 |
| 补装依赖后任务栏还是 Electron | `scripts/dev.cjs` 的 stamp 已包含 rcedit 是否存在，补装后重跑 `npm run dev` 会自动重做品牌化；仍不行就删除 `node_modules/.cache/envhub-dev-electron` |
| 报错里不再有 `Error invoking remote method` | 已在 preload 统一剥离 Electron 的错误前缀，只展示主进程写好的中文提示 |
