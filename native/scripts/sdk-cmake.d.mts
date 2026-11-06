export function sdkVersion(manifest: string): string;
export function cmakeDependencies(arguments_: string[], platform: string): {setup: string; libraries: string};
export function sdkCmakeConfig(options: {platform: string; version: string; abi: number; nativeLibraries: string[]}): string;
