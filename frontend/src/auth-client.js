export function createApiClient(getToken, getSignal = () => undefined) {
  return async function api(path, options) {
    const token = await getToken();
    const response = await fetch(path, {
      ...options,
      signal: options?.signal ?? getSignal(),
      headers: {
        ...(options?.body ? { 'content-type': 'application/json' } : {}),
        ...options?.headers,
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  };
}
