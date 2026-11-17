export const MAX_ADMIN_CREDENTIALS = 3;

export function acceptableAdminCredential(info: { credentialDeviceType: string; credentialBackedUp: boolean }) {
  return info.credentialDeviceType === 'singleDevice' && !info.credentialBackedUp;
}

export function canEnrollAdminCredential(activeCount: number) {
  return Number.isSafeInteger(activeCount) && activeCount >= 0 && activeCount < MAX_ADMIN_CREDENTIALS;
}
