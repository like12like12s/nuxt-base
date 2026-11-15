const DEFAULT_API_URL = 'http://127.0.0.1:{{kit.apiPort}}'

/** URL on the API for a request path on the UI (`/api/v1/x?y=1` -> `<API_URL>/api/v1/x?y=1`). */
export function apiTarget(apiUrl: string | undefined, path: string): string {
  return (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '') + path
}
