/** The marker signals a deliberate browser read; it is not a credential. */
export function officeReadOptions(signal: AbortSignal): RequestInit {
  return {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Office-Read': '1' },
    mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
  };
}
