/**
 * Ambient globals provided by the Minecraft Bedrock script runtime but not declared by
 * `@minecraft/server`. Included via each library's tsconfig so `console.*` type-checks
 * without per-call casts.
 */

declare const console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
};
