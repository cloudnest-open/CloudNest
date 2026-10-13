/** Tiny CSRF-aware API client for the CloudNest UI. */

let csrfToken = '';

async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method === 'POST' ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** Always fetch a token before the first unsafe request and after auth changes. */
export async function refreshCsrfToken(): Promise<void> {
  const { data } = await request('GET', '/api/auth/csrf-token');
  csrfToken = (data as { csrfToken?: string })?.csrfToken ?? '';
}

export const api = {
  setupStatus: () => request('GET', '/api/setup/status'),
  me: () => request('GET', '/api/auth/me'),
  setup: (password: string) => request('POST', '/api/setup', { password, confirm: password }),
  login: (password: string) => request('POST', '/api/auth/login', { username: 'admin', password }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('POST', '/api/auth/change-password', { currentPassword, newPassword, confirmNew: newPassword }),
};
