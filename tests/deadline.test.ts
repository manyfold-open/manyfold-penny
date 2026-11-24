import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithDeadline } from '../src/worker/gateway/deadline';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchWithDeadline', () => {
  it('leaves no timer behind once the response is in (a pending timer keeps a Durable Object billed)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => new Response('ok'));
    expect(await (await fetchWithDeadline('https://x.test/', {}, 20_000)).text()).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still aborts a request that outlives its deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
    );
    const pending = fetchWithDeadline('https://x.test/', {}, 1_000);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
