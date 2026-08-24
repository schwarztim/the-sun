import pino, { type Logger as PinoLogger } from 'pino';
import type { Writable } from 'node:stream';

export interface LoggerOptions {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  stream?: Writable;
  pretty?: boolean;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function wrap(p: PinoLogger): Logger {
  return {
    debug: (msg, f) => p.debug(f ?? {}, msg),
    info:  (msg, f) => p.info(f ?? {}, msg),
    warn:  (msg, f) => p.warn(f ?? {}, msg),
    error: (msg, f) => p.error(f ?? {}, msg),
    child: (b) => wrap(p.child(b)),
  };
}

export function createLogger(opts: LoggerOptions): Logger {
  const base = pino(
    {
      level: opts.level,
      ...(opts.pretty
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    opts.stream ?? process.stderr
  );
  return wrap(base);
}
