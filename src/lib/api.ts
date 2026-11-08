const base = import.meta.env.PROD ? '' : (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export function apiUrl(path: string) { return !base || /^https?:\/\//.test(path) ? path : `${base}${path.startsWith('/') ? path : '/' + path}`; }
export async function apiJson<T>(url: string, options: RequestInit = {}): Promise<{ data: T | null; error: string | null; status: number }> {
  try {
    const response = await fetch(apiUrl(url), { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { data: null, error: payload.message || 'Request failed. Please try again.', status: response.status };
    return { data: payload as T, error: null, status: response.status };
  } catch { return { data: null, error: 'Cannot reach the server. Please check your connection and try again.', status: 0 }; }
}
