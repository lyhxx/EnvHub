import { contextBridge, ipcRenderer } from 'electron'
import type { EnvHubApi } from '../shared/contracts'

const api: EnvHubApi = {
  app: {
    getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
    setTheme: (theme) => ipcRenderer.invoke('app:set-theme', theme),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
    chooseManagedRoot: () => ipcRenderer.invoke('app:choose-managed-root'),
    setManagedRoot: (path, moveExisting) => ipcRenderer.invoke('app:set-managed-root', path, moveExisting)
  },
  runtime: {
    scan: () => ipcRenderer.invoke('runtime:scan'),
    registerManual: (runtimeId) => ipcRenderer.invoke('runtime:register-manual', runtimeId),
    removeManual: (id) => ipcRenderer.invoke('runtime:remove-manual', id),
    catalog: (runtimeId) => ipcRenderer.invoke('runtime:catalog', runtimeId),
    copyLink: (runtimeId, version) => ipcRenderer.invoke('app:copy-link', runtimeId, version),
    openDownloadLink: (runtimeId, version) => ipcRenderer.invoke('runtime:open-download-link', runtimeId, version),
    activate: (id) => ipcRenderer.invoke('runtime:activate', id),
    install: (downloadId, activate) => ipcRenderer.invoke('runtime:install', downloadId, activate),
    takeOverPriority: (id) => ipcRenderer.invoke('runtime:takeover-priority', id),
    uninstall: (id) => ipcRenderer.invoke('runtime:uninstall', id),
    refreshCurrent: (runtimeId) => ipcRenderer.invoke('runtime:refresh-current', runtimeId),
    resolveCurrent: (runtimeId) => ipcRenderer.invoke('runtime:resolve-current', runtimeId)  },
  download: {
    start: (runtimeId, version) => ipcRenderer.invoke('download:start', runtimeId, version),
    pause: (id) => ipcRenderer.invoke('download:pause', id),
    resume: (id) => ipcRenderer.invoke('download:resume', id),
    cancel: (id) => ipcRenderer.invoke('download:cancel', id),
    remove: (id, deleteFile) => ipcRenderer.invoke('download:remove', id, deleteFile),
    importFile: (runtimeId, version) => ipcRenderer.invoke('download:import', runtimeId, version),
    getDirectory: () => ipcRenderer.invoke('download:directory'),
    onUpdate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, task: Parameters<typeof callback>[0]) => callback(task)
      ipcRenderer.on('download:update', listener)
      return () => ipcRenderer.removeListener('download:update', listener)
    }
  },
  network: {
    getProxyStatus: () => ipcRenderer.invoke('network:get-proxy'),
    setProxy: (settings) => ipcRenderer.invoke('network:set-proxy', settings),
    testProxy: () => ipcRenderer.invoke('network:test-proxy')
  },
  packages: {
    getConfig: (manager) => ipcRenderer.invoke('packages:get', manager),
    setRegistry: (manager, registry) => ipcRenderer.invoke('packages:set', manager, registry),
    setCacheDir: (manager, cacheDir) => ipcRenderer.invoke('packages:set-cache', manager, cacheDir),
    testRegistry: (manager, registry) => ipcRenderer.invoke('packages:test', manager, registry),
    undoLastPathChange: () => ipcRenderer.invoke('packages:undo-path'),
    repairPath: () => ipcRenderer.invoke('environment:repair-path')
  },
  privileged: {
    status: () => ipcRenderer.invoke('privileged:status'),
    enable: () => ipcRenderer.invoke('privileged:enable'),
    disable: () => ipcRenderer.invoke('privileged:disable')
  },
  onSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof callback>[0]) => callback(snapshot)
    ipcRenderer.on('app:snapshot', listener)
    return () => ipcRenderer.removeListener('app:snapshot', listener)
  },
  onOperationProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on('operation:progress', listener)
    return () => ipcRenderer.removeListener('operation:progress', listener)
  },
  onNotice: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('app:notice', listener)
    return () => ipcRenderer.removeListener('app:notice', listener)
  }
}

contextBridge.exposeInMainWorld('envhub', api)
