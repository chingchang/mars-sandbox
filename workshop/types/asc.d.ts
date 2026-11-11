// The part of the AssemblyScript compiler's programmatic API the workshop uses.
// The package's own .d.ts redeclares global `console` (with only `log`) and would
// shadow Node's, so tsconfig maps "assemblyscript/asc" here instead.
declare module "assemblyscript/asc" {
  export interface MemoryStream { write(chunk: Uint8Array | string): void; reset(): void; toBuffer(): Uint8Array; toString(): string }
  export interface APIOptions {
    stdout?: MemoryStream; stderr?: MemoryStream;
    readFile?: (filename: string, baseDir: string) => string | null | Promise<string | null>;
    writeFile?: (filename: string, contents: Uint8Array | string, baseDir: string) => void | Promise<void>;
    listFiles?: (dirname: string, baseDir: string) => string[] | null | Promise<string[] | null>;
  }
  export interface APIResult { error: (Error & { message?: string }) | null; stdout: MemoryStream; stderr: MemoryStream; stats: unknown }
  export function main(argv: string[], options?: APIOptions): Promise<APIResult>;
  export function createMemoryStream(fn?: (chunk: Uint8Array | string) => void): MemoryStream;
  const asc: { main: typeof main; createMemoryStream: typeof createMemoryStream };
  export default asc;
}
