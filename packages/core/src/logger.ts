export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Returns a logger that prefixes every message with `[scope]`. */
  child(scope: string): Logger;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createConsoleLogger(level: LogLevel = 'info', scope?: string): Logger {
  const min = LEVELS[level];
  const prefix = scope ? `[${scope}] ` : '';
  const log =
    (lvl: Exclude<LogLevel, 'silent'>) => (message: string, meta?: Record<string, unknown>) => {
      if (LEVELS[lvl] < min) return;
      const line = `${prefix}${message}`;
      if (meta && Object.keys(meta).length > 0) console[lvl](line, meta);
      else console[lvl](line);
    };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (childScope) => createConsoleLogger(level, scope ? `${scope}:${childScope}` : childScope),
  };
}

/** A logger that discards everything. Useful in tests. */
export const silentLogger: Logger = createConsoleLogger('silent');
