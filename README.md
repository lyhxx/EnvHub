<div align="center">

# EnvHub

**Windows 本地开发环境管理器**

[![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat)](https://github.com/lyhxx/EnvHub/releases)
[![Status](https://img.shields.io/badge/status-preview-orange?style=flat)](https://github.com/lyhxx/EnvHub)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?style=flat&logo=windows)](https://github.com/lyhxx/EnvHub)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat)](./LICENSE)

</div>

一个界面管好本机的开发环境：看有哪些版本、切换默认版本、下载安装新的、配置包管理器软件源。数据全在本机。

- 仓库地址：https://github.com/lyhxx/EnvHub
- 当前版本：0.2.0（Preview）
- [更新日志](./CHANGELOG.md) · [开发文档](./docs/DEVELOPMENT.md)

## 功能

**环境检测**
- 支持 13 个开发环境，自动扫描并识别版本，也可手动登记
- 列出每个环境的全部版本、安装位置与来源（系统原有 / 手动登记 / EnvHub 安装）
- 概览页词云展示整体情况，点击直达

**版本切换**
- 一键设为默认版本，通常 1 秒内完成，不需要管理员权限
- 同时标出终端里实际生效的版本
- 改动前自动备份，可一键撤销

**下载与安装**
- Node.js、JDK 支持应用内下载安装：断点续传、完整性校验、失败回滚
- 其他环境可复制官方链接用浏览器下载后导入，或登记本机已有版本
- 已安装版本可卸载，不影响其他安装

**软件源与缓存**
- npm、pip、Maven 的镜像地址与缓存目录可视化修改
- 读取本机配置的真实值，写入前保留备份，支持连接测试

**环境维护**
- 切换被系统 PATH 抢先时给出提示，可一键清理抢先目录（需一次管理员授权，只删除不新增）
- 一键清理用户 PATH 中的重复项与失效目录

**数据与恢复**
- 数据目录可迁移，跨磁盘显示进度，只复制不删除
- 异常退出自动提示并自检，中断残留自动清理，未完成下载恢复为暂停
- 无账号、无遥测

## 支持的环境

| 类别 | 环境 | 应用内安装 |
| --- | --- | --- |
| 运行时 | Python、Node.js、Bun、Java / JDK、Go、Rust、.NET、PHP、Ruby | Node.js、JDK |
| 构建与工具 | Git、Maven、Gradle | — |
| 容器 | Docker | — |

检测、版本查看与切换对以上环境全部适用；软件源配置覆盖 npm、pip、Maven。

## 安装与运行

系统要求：Windows 10 / 11（x64），无需另外安装运行时。

安装包：`release\EnvHub-0.2.0-setup.exe`

源码运行（需要 Node.js ≥ 20）：

```powershell
npm install
npm run dev       # 开发模式
npm run build     # 编译到 out/
npm run dist      # 生成安装包到 release/
```

## 界面

| 页面 | 作用 |
| --- | --- |
| 概览 | 环境词云 |
| 环境与工具 | 左侧环境列表，右侧「版本 / 软件源 / 可用版本」 |
| 下载 | 下载与安装任务 |
| 设置 | 主题、代理、数据目录、撤销修改 |

## 数据位置

- 配置与记录：`%APPDATA%\EnvHub\`
- 运行时与下载文件：`%LOCALAPPDATA%\EnvHub\`（可在设置里迁移）
- 环境变量与软件源配置的修改都会留备份，随时可撤销

## 已知限制

- 应用内安装目前覆盖 Node.js 与 JDK
- Maven、Gradle 的版本号从安装目录名推断，识别不出时标注"待确认"
- 清理系统 PATH 中抢先的目录需要一次管理员授权
- 环境变量的修改对新开的终端生效，已打开的窗口不受影响
- 暂未接入代码签名与自动更新

## 后续计划

- 更多环境接入应用内安装
- 包管理器全局包列表与升级
- 环境诊断：缺失变量、工具版本冲突
- 项目环境绑定：按项目切换版本

## 开发

- 技术栈：Electron、Vue 3、TypeScript、Vite，安装包由 electron-builder 生成
- 结构：`src/main`（主进程）、`src/preload`（接口）、`src/renderer`（界面）、`src/shared`（共享契约）
- 安全：界面不直接访问系统，全部经主进程白名单校验；下载仅允许官方域名的 HTTPS 地址并校验完整性；不提供执行任意命令的能力

## 许可证

MIT

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=lyhxx/EnvHub&type=Date)](https://star-history.com/#lyhxx/EnvHub&Date)
