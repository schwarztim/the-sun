import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, type LoggerOptions } from '../src/logger.js';

class Capture extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.lines.push(chunk.toString());
    cb();
  }
}

describe('createLogger', () => {
  let sink: Capture;
  let opts: LoggerOptions;

  beforeEach(() => {
    sink = new Capture();
    opts = { level: 'debug', stream: sink, pretty: false };
  });

  it('emits JSON lines with level and msg', () => {
    const log = createLogger(opts);
    log.info('hello', { service: 'ms365' });
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.level).toBe(30);
    expect(parsed.msg).toBe('hello');
    expect(parsed.service).toBe('ms365');
  });

  it('supports child loggers with bound fields', () => {
    const log = createLogger(opts).child({ component: 'validator' });
    log.warn('stale token');
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.component).toBe('validator');
    expect(parsed.msg).toBe('stale token');
  });
});
