import { contextBridge, ipcRenderer } from 'electron'
import type { EnvHubApi } from '../shared/contracts'

// Electron 会把主进程抛出的错误包成 "Error invoking remote method 'x': Error: 原始信息"，
// 直接展示给用户是英文噪音。这里统一剥掉前缀，只保留主进程写好的中文提示。
const invokePrefix = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(invokePrefix, ''))
  }
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: EnvHubApi = {
  app: {
    getSnapshot: () => call('app:get-snapshot'),
    setTheme: (theme) => call('app:set-theme', theme),
    openExternal: (url) => call('app:open-external', url),
    copyText: (text) => call('app:copy-text', text),
    chooseManagedRoot: () => call('app:choose-managed-root'),
    setManagedRoot: (path, moveExisting) => call('app:set-managed-root', path, moveExisting)
  },
  runtime: {
    scan: () => call('runtime:scan'),
    registerManual: (runtimeId) => call('runtime:register-manual', runtimeId),
    removeManual: (id) => call('runtime:remove-manual', id),
    catalog: (runtimeId) => call('runtime:catalog', runtimeId),
    copyLink: (runtimeId, version) => call('app:copy-link', runtimeId, version),
    openDownloadLink: (runtimeId, version) => call('runtime:open-download-link', runtimeId, version),
    activate: (id) => call('runtime:activate', id),
    install: (downloadId, activate) => call('runtime:install', downloadId, activate),
    takeOverPriority: (id) => call('runtime:takeover-priority', id),
    uninstall: (id) => call('runtime:uninstall', id),
    refreshCurrent: (runtimeId) => call('runtime:refresh-current', runtimeId),
    resolveCurrent: (runtimeId) => call('runtime:resolve-current', runtimeId)
  },
  download: {
    start: (runtimeId, version) => call('download:start', runtimeId, version),
    pause: (id) => call('download:pause', id),
    resume: (id) => call('download:resume', id),
    cancel: (id) => call('download:cancel', id),
    remove: (id, deleteFile) => call('download:remove', id, deleteFile),
    importFile: (runtimeId, version) => call('download:import', runtimeId, version),
    getDirectory: () => call('download:directory'),
    onUpdate: (callback) => subscribe('download:update', callback)
  },
  network: {
    getProxyStatus: () => call('network:get-proxy'),
    setProxy: (settings) => call('network:set-proxy', settings),
    testProxy: () => call('network:test-proxy')
  },
  packages: {
    getConfig: (manager) => call('packages:get', manager),
    setRegistry: (manager, registry) => call('packages:set', manager, registry),
    setCacheDir: (manager, cacheDir) => call('packages:set-cache', manager, cacheDir),
    testRegistry: (manager, registry) => call('packages:test', manager, registry),
    undoLastPathChange: () => call('packages:undo-path'),
    repairPath: () => call('environment:repair-path')
  },
  privileged: {
    status: () => call('privileged:status'),
    enable: () => call('privileged:enable'),
    disable: () => call('privileged:disable')
  },
  onSnapshot: (callback) => subscribe('app:snapshot', callback),
  onOperationProgress: (callback) => subscribe('operation:progress', callback),
  onNotice: (callback) => subscribe('app:notice', callback)
}

contextBridge.exposeInMainWorld('envhub', api)
