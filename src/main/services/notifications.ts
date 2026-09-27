import { BrowserWindow } from 'electron'

// 主进程向前端发送一次性提示（不进入状态存储）。
export function notifyRenderer(message: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('app:notice', message)
  }
}
