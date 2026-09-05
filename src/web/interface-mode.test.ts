import { describe, it, expect } from 'vitest';
import {
  decideInterfaceMode,
  resolveWebPort,
  resolveWebHost,
  isWebMode,
  DEFAULT_WEB_PORT,
} from './interface-mode.js';

describe('decideInterfaceMode', () => {
  it('defaults to the web UI with no flags', () => {
    expect(decideInterfaceMode([], {})).toBe('web');
    expect(decideInterfaceMode(['run', 'x.json'], {})).toBe('web');
  });

  it('--yolo still runs the web UI (Docker bypass is orthogonal)', () => {
    // The whole point: `huu --yolo` = web UI, native (no Docker).
    expect(decideInterfaceMode(['--yolo'], {})).toBe('web');
    expect(isWebMode(['--yolo'], {})).toBe(true);
  });

  it('--cli and --tui force the terminal UI', () => {
    expect(decideInterfaceMode(['--cli'], {})).toBe('cli');
    expect(decideInterfaceMode(['--tui'], {})).toBe('cli');
    expect(decideInterfaceMode(['run', 'x.json', '--cli'], {})).toBe('cli');
  });

  it('HUU_CLI=1 defaults to the terminal UI', () => {
    expect(decideInterfaceMode([], { HUU_CLI: '1' })).toBe('cli');
    expect(decideInterfaceMode([], { HUU_CLI: 'true' })).toBe('cli');
  });

  it('--web overrides HUU_CLI=1', () => {
    expect(decideInterfaceMode(['--web'], { HUU_CLI: '1' })).toBe('web');
  });
});

// PRECEDENCE: flag > env > saved config > default. The saved config is the
// standing preference `huu setup` writes; a flag or env var is a statement
// about ONE invocation, and a standing preference never overrules something
// the user just typed. These four tests are the whole rule.
describe('decideInterfaceMode — the saved setup choice', () => {
  const savedCli = { interface: 'cli' as const };
  const savedWeb = { interface: 'web' as const };

  it('honours the saved `cli` choice with no flag and no env', () => {
    expect(decideInterfaceMode([], {}, savedCli)).toBe('cli');
    expect(isWebMode([], {}, savedCli)).toBe(false);
  });

  it('an explicit --web BEATS a saved `cli`', () => {
    expect(decideInterfaceMode(['--web'], {}, savedCli)).toBe('web');
  });

  it('an explicit --cli BEATS a saved `web`', () => {
    expect(decideInterfaceMode(['--cli'], {}, savedWeb)).toBe('cli');
    expect(decideInterfaceMode(['--tui'], {}, savedWeb)).toBe('cli');
  });

  it('HUU_CLI=1 BEATS a saved `web` (env outranks the standing preference)', () => {
    expect(decideInterfaceMode([], { HUU_CLI: '1' }, savedWeb)).toBe('cli');
  });

  it('omitting the config changes nothing for existing call sites', () => {
    expect(decideInterfaceMode([], {})).toBe('web');
    expect(decideInterfaceMode([], {}, savedWeb)).toBe('web');
  });
});

describe('resolveWebPort', () => {
  it('falls back to the default port', () => {
    expect(resolveWebPort([], {})).toBe(DEFAULT_WEB_PORT);
  });

  it('honors --port=<n>', () => {
    expect(resolveWebPort(['--port=8080'], {})).toBe(8080);
  });

  it('honors HUU_WEB_PORT when no flag', () => {
    expect(resolveWebPort([], { HUU_WEB_PORT: '9000' })).toBe(9000);
  });

  it('the flag wins over the env var', () => {
    expect(resolveWebPort(['--port=8080'], { HUU_WEB_PORT: '9000' })).toBe(8080);
  });

  it('ignores invalid values (out of range, non-numeric) and uses the default', () => {
    expect(resolveWebPort(['--port=0'], {})).toBe(DEFAULT_WEB_PORT);
    expect(resolveWebPort(['--port=99999'], {})).toBe(DEFAULT_WEB_PORT);
    expect(resolveWebPort(['--port=abc'], {})).toBe(DEFAULT_WEB_PORT);
    expect(resolveWebPort([], { HUU_WEB_PORT: 'nope' })).toBe(DEFAULT_WEB_PORT);
  });
});

describe('resolveWebHost', () => {
  it('defaults to 0.0.0.0 so the LAN can reach it', () => {
    expect(resolveWebHost({})).toBe('0.0.0.0');
  });

  it('honors HUU_WEB_HOST natively', () => {
    expect(resolveWebHost({ HUU_WEB_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('forces 0.0.0.0 inside the container regardless of override (published port needs it)', () => {
    expect(
      resolveWebHost({ HUU_IN_CONTAINER: '1', HUU_WEB_HOST: '127.0.0.1' }),
    ).toBe('0.0.0.0');
  });
});
