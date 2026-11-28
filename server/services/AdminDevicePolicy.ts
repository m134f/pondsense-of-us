export const MAX_ADMIN_CREDENTIALS = 2;
export type AdminCredentialPolicy = 'device-bound' | 'sync-eligible';

export function isAdminCredentialPolicy(value: unknown): value is AdminCredentialPolicy {
  return value === 'device-bound' || value === 'sync-eligible';
}

export function acceptableAdminCredential(info: { credentialDeviceType: string; credentialBackedUp: boolean }, policy: AdminCredentialPolicy = 'device-bound') {
  if (policy === 'device-bound') return info.credentialDeviceType === 'singleDevice' && info.credentialBackedUp === false;
  return policy === 'sync-eligible' && info.credentialDeviceType === 'multiDevice' && typeof info.credentialBackedUp === 'boolean';
}

export function canEnrollAdminCredential(activeCount: number) {
  return Number.isSafeInteger(activeCount) && activeCount >= 0 && activeCount < MAX_ADMIN_CREDENTIALS;
}
