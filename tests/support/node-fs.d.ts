// Tests are typechecked with the Workers types, which do not include Node's built-ins.
// This declares the slice of Node that the tests use: node:fs (kit.test.ts reads wrangler.jsonc;
// narra-authorize.test.ts sets up a temporary agent workspace), node:http and node:child_process
// (narra-authorize.test.ts runs agent/bin/narra.mjs against a fake Narra endpoint).
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function copyFileSync(from: string, to: string): void;
}

declare module 'node:http' {
  export interface Server {
    listen(port: number, host: string, cb: () => void): void;
    address(): { port: number } | string | null;
    close(cb: () => void): void;
  }
  export function createServer(
    handler: (
      req: { on(event: string, cb: (chunk?: unknown) => void): void },
      res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void },
    ) => void,
  ): Server;
}

declare module 'node:child_process' {
  export function spawn(
    command: string,
    args: string[],
    options?: { env?: Record<string, string | undefined> },
  ): {
    stdout: { on(event: 'data', cb: (chunk: unknown) => void): void };
    on(event: 'close', cb: (code: number | null) => void): void;
  };
}
