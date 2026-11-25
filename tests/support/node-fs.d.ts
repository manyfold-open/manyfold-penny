// Tests are typechecked with the Workers types, which do not include Node's built-ins.
// This declares the slice of node:fs that kit.test.ts uses (reading wrangler.jsonc).
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
