export { classifyAddress, type DeniedAddressReason } from './address.js';
export { AllowlistError, parseAllowlist, type Allowlist } from './allowlist.js';
export {
  ConfigError,
  EGRESS_PROXY_SETTINGS,
  loadConfig,
  loadProxyConfig,
  loadSharedConfig,
  type EgressProxyConfig,
  type ProxyConfig,
  type SettingDescription,
  type SharedEgressProxyConfig,
} from './config.js';
export { verifyCredential, type CredentialRefusal, type CredentialVerdict } from './credential.js';
export { createEgressProxy, type DenialReason, type EgressProxyOptions } from './proxy.js';
