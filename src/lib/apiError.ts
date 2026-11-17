export function apiErrorMessage(status: number, message?: unknown): string {
  if (typeof message === 'string' && message.trim()) return message;
  if (status >= 500) return 'The server is unavailable. If using localhost, start the local API and MySQL, then try again. Your password has not been verified.';
  return 'Request failed. Please try again.';
}
