/**
 * `fetch` with a deadline whose timer is cleared as soon as the response arrives. A pending
 * `AbortSignal.timeout()` timer keeps a Durable Object running, and billed, until it fires, even
 * after the request finished: a /sync that answered in 0.1 s held MatrixSync for its whole
 * 20 s deadline, and every poller read held the poller for 15 s.
 */
export async function fetchWithDeadline(input: string | URL | Request, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
