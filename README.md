<div align="center">

# EnvHub

**Windows 本地开发环境管理器**

[![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat)](https://github.com/lyhxx/EnvHub/releases)
[![Status](https://img.shields.io/badge/status-preview-orange?style=flat)](https://github.com/lyhxx/EnvHub)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?style=flat&logo=windows)](https://github.com/lyhxx/EnvHub)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat)](./LICENSE)

</div>

一台 Windows 开发机上，Python、Node、JDK、Go 往往装了不止一套，切换版本靠手改 PATH，收尾还得记着别把系统变量改坏。EnvHub 把这些收进一个界面：看清本机装了什么、一键切换默认版本、需要新版本时直接下载安装，顺手把包管理器的软件源和缓存目录也配好。

- 仓库地址：https://github.com/lyhxx/EnvHub
- 当前版本：0.2.0（Preview）
- 更新日志：[CHANGELOG.md](./CHANGELOG.md)
- 开发文档：[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)

## 用它做什么

### 看清本机有哪几套环境

概览页把受支持的环境铺成词云：装了的按品牌色高亮，没装的灰显。点进去能看到该环境的全部版本、安装位置和来源——系统里原本就有的、手动登记的，还是 EnvHub 安装的。

### 一键切换默认版本

点"使用此版本"，该版本会被排到当前用户 PATH 的最前，通常 1 秒内完成，无需管理员权限。改动前会保存完整快照，设置里可以一键撤销。列表同时标出"当前使用"的版本，也就是终端里实际会跑的那一个。

Windows 的规则是系统 PATH 排在用户 PATH 前面，所以偶尔会出现"已经切换、终端却还是旧版本"。这种情况 EnvHub 会直接指出来，并可以在你确认后清理那几个抢先的目录——只删除、不新增，原始值同样可撤销。

### 缺什么就装什么

版本列表取自各项目官方源。Node.js 和 JDK 可以直接在应用内下载安装（断点续传、完整性校验、失败自动回滚），其他环境可以复制官方链接用浏览器下载后导入，或者把本机已有的手动登记进来。

### 软件源与缓存

npm、pip、Maven 的镜像地址与缓存目录都能在界面里查看和修改。打开页面读到的就是本机配置文件的真实值，没配置过则显示该工具的默认位置；写入前保留备份，可以测试连接再决定。

### 数据可以搬家

数据目录支持迁移，跨盘时会流式复制并显示进度，而且只复制、不删除。上次异常退出会给出提示并自检，中断留下的残留目录会被清理，未完成的下载恢复为暂停状态。

## 支持的环境

| 类别 | 环境 |
| --- | --- |
| 运行时 | Python、Node.js、Bun、Java / JDK、Go、Rust、.NET、PHP、Ruby |
| 构建与工具 | Git、Maven、Gradle |
| 容器 | Docker |

检测、版本查看与切换对以上环境通用。应用内下载安装目前覆盖 Node.js 与 JDK；软件源配置覆盖 npm、pip、Maven。新增环境的扩展方式见[开发文档](./docs/DEVELOPMENT.md)。

## 界面

| 页面 | 作用 |
| --- | --- |
| 概览 | 环境词云，本机环境的整体情况 |
| 环境与工具 | 左侧环境列表，右侧分「版本 / 软件源 / 可用版本」三个页签 |
| 下载 | 下载与安装任务队列 |
| 设置 | 主题、网络代理、数据目录、撤销修改 |

## 安装与运行

系统要求：Windows 10 / 11（x64）。安装包自带所需运行时，无需另外安装。

安装包：

```
release\EnvHub-0.2.0-setup.exe
```

源码运行（需要 Node.js ≥ 20）：

```powershell
npm install
npm run dev
```

其他命令：

```powershell
npm run typecheck   # 类型检查
npm run build       # 编译到 out/
npm run dist        # 生成安装包到 release/
```

## 数据与隐私

- 全部数据存在本机，没有账号，没有遥测，不会上传你的环境信息。
- 默认位置：配置与记录在 `%APPDATA%\EnvHub\`，运行时与下载文件在 `%LOCALAPPDATA%\EnvHub\`，都可以在设置里迁移。
- 修改环境变量、软件源和缓存目录之前都会留备份，随时可撤销。
- 卸载 EnvHub 只会移除应用本身，不会动你的项目和已下载的软件。

## 已知限制

- 应用内下载安装目前覆盖 Node.js 与 JDK，其余环境可以手动登记或从官网获取，能力会持续扩充。
- Maven、Gradle 的版本号从安装目录名推断，无法识别时会标注"待确认"。
- 清理系统 PATH 中抢先的目录需要一次管理员授权，且只删除这些目录。
- 环境变量的修改对新开的终端生效，已经打开的窗口不受影响。
- 安装包暂未做代码签名，Windows 可能提示"未知发布者"。

## 后续计划

- 为更多环境接入应用内安装。
- 包管理器全局包列表与升级。
- 环境诊断扩展：缺失的环境变量、多个工具指向不同版本等冲突检查。
- 项目环境绑定：按项目切换运行时版本。
- 安装包代码签名。

计划会随实际使用情况调整，不代表承诺。

## 技术栈

- [Electron](https://www.electronjs.org/) - 桌面应用框架
- [Vue 3](https://cn.vuejs.org/) - 前端框架
- [TypeScript](https://www.typescriptlang.org/) - 类型系统
- [Vite](https://cn.vitejs.dev/) / [electron-vite](https://electron-vite.org/) - 构建工具
- [electron-builder](https://www.electron.build/) - 打包与安装器

## 项目结构

```
src/
├── main/        主进程：环境检测、下载、安装、环境变量与配置文件读写
├── preload/     安全暴露给界面的接口
├── renderer/    界面
└── shared/      共享契约与元数据
```

## 安全与权限

- 界面层不直接接触系统和文件，所有操作经主进程按白名单校验后执行。
- 下载只允许官方域名的 HTTPS 地址，逐跳校验重定向，并核对完整性；校验失败的安装包会被删除。
- 不提供"执行任意命令"的能力。
- 需要管理员权限的操作只在你确认后触发，且只做一件事：删除系统 PATH 里抢先的目录。

## 许可证

MIT

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=lyhxx/EnvHub&type=Date)](https://star-history.com/#lyhxx/EnvHub&Date)
