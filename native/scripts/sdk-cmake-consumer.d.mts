export function findTool(name: string, env: Record<string, string | undefined>): string | undefined;
export function consumerEnvironment(environment: Record<string, string | undefined>, directory: string): Record<string, string | undefined>;
export function checkCmakeConsumer(options: {
  archive: string; name: string; work: string; env: Record<string, string | undefined>;
  run: (command: string, args: string[], options?: object) => unknown; abi: number; version: string;
}): void;
