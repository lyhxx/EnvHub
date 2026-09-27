import type { EnvHubApi } from '../shared/contracts'

declare global {
  interface Window {
    envhub: EnvHubApi
  }
}

export {}
