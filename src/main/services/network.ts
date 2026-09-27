import { net, session } from 'electron'
import type { ProxySettings, ProxyStatus } from '../../shared/contracts'
import { store } from '../storage/store'

const testUrl = 'https://nodejs.org/'

export async function applyProxy(settings: ProxySettings): Promise<ProxyStatus> {
  if (settings.mode === 'system') {
    await session.defaultSession.setProxy({ mode: 'system' })
  } else if (settings.mode === 'direct') {
    await session.defaultSession.setProxy({ mode: 'direct' })
  } else {
    let parsed: URL
    try { parsed = new URL(settings.server) } catch { throw new Error('代理地址格式无效') }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('代理仅支持 http(s)/socks4/5 地址；暂不支持将账号密码写入配置')
    }
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: settings.server })
  }
  await store.setProxy(settings)
  try { return await getProxyStatus() }
  catch { return { settings, resolution: '代理设置已应用，但暂时无法读取路由状态', checkedUrl: testUrl } }
}

export async function getProxyStatus(): Promise<ProxyStatus> {
  const settings = store.snapshot().proxy
  const resolution = await session.defaultSession.resolveProxy(testUrl)
  return { settings, resolution: resolution.trim() || '未能解析代理状态', checkedUrl: testUrl }
}

export async function testProxyConnection(): Promise<ProxyStatus> {
  const status = await getProxyStatus()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  const started = Date.now()
  try {
    const response = await net.fetch('https://nodejs.org/dist/index.json', { signal: controller.signal, headers: { 'Range': 'bytes=0-0' } })
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`)
    await response.body?.cancel()
    return { ...status, reachable: true, latencyMs: Date.now() - started }
  } catch (error) {
    return { ...status, reachable: false, testError: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}
