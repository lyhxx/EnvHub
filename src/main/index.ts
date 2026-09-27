import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { store } from './storage/store'
import { registerIpc } from './ipc'
import { applyProxy } from './services/network'
import { recoverDownloads } from './services/downloads'
import { scanRuntime } from './runtime/service'
import { notifyRenderer } from './services/notifications'

app.setName('EnvHub')
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
if (hasLock && process.platform === 'win32') app.setAppUserModelId('cn.javai.envhub')

let mainWindow: BrowserWindow | null = null

function updateNativeFrameTheme(): void {
  const dark = nativeTheme.shouldUseDarkColors
  const color = dark ? '#171c19' : '#f4f5f2'
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setBackgroundColor(color)
  mainWindow.setTitleBarOverlay({ color, symbolColor: dark ? '#dce5de' : '#344139', height: 40 })
}

function createWindow(): void {
  const windowIcon = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'build', 'icon.ico')
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: 'EnvHub',
    icon: windowIcon,
    backgroundColor: '#f4f5f3',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f4f5f2', symbolColor: '#344139', height: 40 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  mainWindow.removeMenu()
  mainWindow.setMenuBarVisibility(false)
  updateNativeFrameTheme()
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      try { if (new URL(url).origin === new URL(devUrl).origin) return } catch { /* invalid URL */ }
    }
    if (!devUrl && url.split(/[?#]/)[0] === pathToFileURL(join(__dirname, '../renderer/index.html')).href) return
    event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

if (hasLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    await store.load()
    store.onChange((snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('app:snapshot', snapshot)
      }
    })
    const sessionFile = join(app.getPath('userData'), 'session.lock')
    let abnormalExit = false
    try {
      const previous = await readFile(sessionFile, 'utf8')
      abnormalExit = previous.trim().length > 0
    } catch { /* 首次启动或上次正常退出 */ }
    await writeFile(sessionFile, `${process.pid}@${new Date().toISOString()}`, 'utf8').catch(() => undefined)
    nativeTheme.themeSource = store.snapshot().theme
    nativeTheme.on('updated', updateNativeFrameTheme)
    try {
      await applyProxy(store.snapshot().proxy)
    } catch {
      // A stale or malformed saved proxy must not prevent the app from starting.
      await store.setProxy({ mode: 'system', server: '' })
      await applyProxy({ mode: 'system', server: '' })
    }
    recoverDownloads()
    registerIpc()
    createWindow()
    app.on('will-quit', () => { void rm(sessionFile, { force: true }) })
    setTimeout(() => {
      if (abnormalExit) notifyRenderer('上次未正常退出，已检查数据完整性并恢复未完成任务')
      void scanRuntime().catch(() => undefined)
    }, 1200)
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  }).catch((error) => {
    console.error('EnvHub failed to initialize', error)
    app.quit()
  })
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
