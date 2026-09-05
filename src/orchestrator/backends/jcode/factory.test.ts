import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { translateJcodeOutput } from './event-mapper.js';
import { buildJcodeArgs, jcodeAgentFactory, withJcodeApiKey } from './factory.js';
import {
  resolveHermeticEnabled,
  jcodeAgentDir,
  buildJcodeSessionEnvironment,
  jcodeApiKeyEnvVar,
  jcodeProviderProfile,
} from './hermetic.js';
import { API_KEY_REGISTRY } from '../../../lib/api-key-registry.js';
import { DEFAULT_PROVIDER, PROVIDERS, type LlmProvider } from '../../../lib/providers.js';
import {
  jcodeMissingApiKeyMessage,
  jcodeMissingExecutableMessage,
} from '../../../lib/jcode-bundle.js';
import type { AgentTask, AppConfig } from '../../../lib/types.js';
import type { AgentEvent } from '../../types.js';

// ---------------------------------------------------------------------------
// event-mapper
// ---------------------------------------------------------------------------

describe('translateJcodeOutput', () => {
  function collect(): { events: AgentEvent[]; emit: (e: AgentEvent) => void } {
    const events: AgentEvent[] = [];
    return { events, emit: (e) => events.push(e) };
  }

  it('ignores empty/whitespace-only lines', () => {
    const { events, emit } = collect();
    translateJcodeOutput('', emit);
    translateJcodeOutput('   ', emit);
    expect(events).toEqual([]);
  });

  it('[start] → state_change(streaming) + log "jcode agent started"', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[start]', emit);
    expect(events).toEqual([
      { type: 'state_change', state: 'streaming' },
      { type: 'log', message: 'jcode agent started' },
    ]);
  });

  it('[write] with path → 3 events including file_write', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[write] src/foo.ts', emit);
    expect(events).toEqual([
      { type: 'state_change', state: 'tool_running' },
      { type: 'log', message: 'tool: write → src/foo.ts' },
      { type: 'file_write', file: 'src/foo.ts' },
    ]);
  });

  it('[edit] with path → 3 events including file_write', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[edit] lib/bar.js', emit);
    expect(events).toEqual([
      { type: 'state_change', state: 'tool_running' },
      { type: 'log', message: 'tool: edit → lib/bar.js' },
      { type: 'file_write', file: 'lib/bar.js' },
    ]);
  });

  it('[read] with path → no file_write', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[read] src/foo.ts', emit);
    expect(events).toEqual([
      { type: 'state_change', state: 'tool_running' },
      { type: 'log', message: 'tool: read → src/foo.ts' },
    ]);
  });

  it('[bash] with command → state_change + log', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[bash] npm test', emit);
    expect(events).toEqual([
      { type: 'state_change', state: 'tool_running' },
      { type: 'log', message: 'tool: bash → npm test' },
    ]);
  });

  it('[tokens] with in/out → usage event + token log', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[tokens] in:100 out:50', emit);
    expect(events).toEqual([
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 50,
      },
      { type: 'log', message: 'tokens +100in +50out' },
    ]);
  });

  it('[tokens] with full info (cr, cw, cost, model) → usage carries all', () => {
    const { events, emit } = collect();
    translateJcodeOutput(
      '[tokens] in:200 out:80 cr:800 cw:200 cost:0.001234 model:deepseek-v4-pro',
      emit,
    );
    expect(events).toEqual([
      {
        type: 'usage',
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        cost: 0.001234,
        model: 'deepseek-v4-pro',
      },
      { type: 'log', message: 'tokens +200in +80out +800cr +200cw $0.001234' },
    ]);
  });

  it('[tokens] with no meaningful values → no usage event', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[tokens] garbage', emit);
    expect(events).toEqual([]);
  });

  it('[thinking] → stream(thinking) delta', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[thinking] let me reason about this', emit);
    expect(events).toEqual([
      { type: 'stream', channel: 'thinking', delta: 'let me reason about this' },
    ]);
  });

  it('[thinking] with empty body → no event', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[thinking] ', emit);
    expect(events).toEqual([]);
  });

  it('[end] → log "jcode agent finished"', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[end]', emit);
    expect(events).toEqual([{ type: 'log', message: 'jcode agent finished' }]);
  });

  it('[error] → error AgentEvent', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[error] rate limit exceeded', emit);
    expect(events).toEqual([{ type: 'error', message: 'rate limit exceeded' }]);
  });

  it('[error] without message → "unknown jcode error"', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[error]', emit);
    expect(events).toEqual([{ type: 'error', message: 'unknown jcode error' }]);
  });

  it('[retry] → warn-level log with attempt count and reason', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[retry] 2/5 rate limit', emit);
    expect(events).toEqual([
      {
        type: 'log',
        level: 'warn',
        message: 'jcode auto-retry 2/5: rate limit',
      },
    ]);
  });

  it('[retry-ok] → info log', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[retry-ok] 3', emit);
    expect(events).toEqual([
      { type: 'log', message: 'jcode auto-retry recovered on attempt 3' },
    ]);
  });

  it('[retry-exhausted] → warn-level log', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[retry-exhausted] timeout after 60s', emit);
    expect(events).toEqual([
      {
        type: 'log',
        level: 'warn',
        message: 'jcode auto-retry exhausted: timeout after 60s',
      },
    ]);
  });

  it('[compaction] → compaction event with reason', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[compaction] threshold', emit);
    expect(events).toEqual([{ type: 'compaction', reason: 'threshold' }]);
  });

  it('[compaction] without reason → "unknown"', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[compaction]', emit);
    expect(events).toEqual([{ type: 'compaction', reason: 'unknown' }]);
  });

  it('untagged line → stream(assistant) delta', () => {
    const { events, emit } = collect();
    translateJcodeOutput('Here is the result of the analysis:', emit);
    expect(events).toEqual([
      { type: 'stream', channel: 'assistant', delta: 'Here is the result of the analysis:' },
    ]);
  });

  it('unknown tag → log (never silently dropped)', () => {
    const { events, emit } = collect();
    translateJcodeOutput('[unknown-tag] some payload', emit);
    expect(events).toEqual([
      { type: 'log', message: '[unknown-tag] some payload' },
    ]);
  });

  it('does not throw on any input', () => {
    const { emit } = collect();
    expect(() => translateJcodeOutput('', emit)).not.toThrow();
    expect(() => translateJcodeOutput('[start]', emit)).not.toThrow();
    expect(() => translateJcodeOutput('plain text', emit)).not.toThrow();
    expect(() => translateJcodeOutput('[tokens] in:abc out:xyz', emit)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// hermetic
// ---------------------------------------------------------------------------

describe('resolveHermeticEnabled (jcode)', () => {
  it('defaults ON; only explicit 0/false opt out', () => {
    expect(resolveHermeticEnabled({})).toBe(true);
    expect(resolveHermeticEnabled({ HUU_JCODE_HERMETIC: '1' })).toBe(true);
    expect(resolveHermeticEnabled({ HUU_JCODE_HERMETIC: '0' })).toBe(false);
    expect(resolveHermeticEnabled({ HUU_JCODE_HERMETIC: 'false' })).toBe(false);
    expect(resolveHermeticEnabled({ HUU_JCODE_HERMETIC: ' FALSE ' })).toBe(false);
  });
});

describe('jcodeAgentDir', () => {
  it('returns ~/.huu/jcode-agent (ends with the expected tail)', () => {
    const dir = jcodeAgentDir();
    expect(dir.endsWith('.huu/jcode-agent')).toBe(true);
  });
});

describe('buildJcodeSessionEnvironment', () => {
  it('hermetic (default): sets JCODE_MEMORY_ENABLED=false, JCODE_NO_TELEMETRY=1, isolates agent dir', () => {
    const result = buildJcodeSessionEnvironment();
    expect(result.hermetic).toBe(true);
    expect(result.agentDir).toBeDefined();
    expect(result.env.JCODE_MEMORY_ENABLED).toBe('false');
    expect(result.env.JCODE_NO_TELEMETRY).toBe('1');
    expect(result.env.JCODE_AGENT_DIR).toBe(result.agentDir);
  });

  it('hermetic: preserves parent env keys', () => {
    const result = buildJcodeSessionEnvironment({
      env: { PARENT_KEY: 'parent-value' } as NodeJS.ProcessEnv,
    });
    expect(result.env.PARENT_KEY).toBe('parent-value');
  });

  it('legacy escape hatch (HUU_JCODE_HERMETIC=0): returns parent env as-is, no forced vars', () => {
    const parent = { HUU_JCODE_HERMETIC: '0', EXISTING: 'yes' } as NodeJS.ProcessEnv;
    const result = buildJcodeSessionEnvironment({ env: parent });
    expect(result.hermetic).toBe(false);
    expect(result.agentDir).toBeUndefined();
    expect(result.env.EXISTING).toBe('yes');
    // Legacy mode does NOT force the hermetic env vars.
    expect(result.env.JCODE_MEMORY_ENABLED).toBeUndefined();
    expect(result.env.JCODE_NO_TELEMETRY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Missing binary — the actionable failure
// ---------------------------------------------------------------------------

// huu runs pipelines inside a container that deliberately does NOT ship jcode
// (no public distribution URL exists); the host wrapper lends its own install
// as a read-only mount at /opt/jcode. When neither is there, `spawn('jcode')`
// raises ENOENT and the raw text is `spawn jcode ENOENT` — true and useless.
// This drives the REAL spawn with a PATH that has no jcode.
describe('jcodeAgentFactory — jcode absent from the environment', () => {
  const task: AgentTask = {
    agentId: 1,
    files: ['src/foo.ts'],
    branchName: 'huu/test/agent-1',
    worktreePath: '/tmp/does-not-matter',
    stageIndex: 0,
    stageName: 'Stage 1',
  };
  const config = { apiKey: 'k', modelId: 'deepseek-v4' } as AppConfig;

  async function runWithoutJcodeOnPath(): Promise<{ error: Error; events: AgentEvent[] }> {
    const savedPath = process.env.PATH;
    // A PATH with no jcode anywhere. `spawn` resolves the binary through the
    // env it is handed (libuv swaps `environ` before execvp), and the jcode
    // session env is spread from process.env — so setting it here is enough.
    process.env.PATH = join(tmpdir(), 'huu-no-jcode-here');
    const events: AgentEvent[] = [];
    try {
      const agent = await jcodeAgentFactory(
        task,
        config,
        '',
        process.cwd(),
        (e) => events.push(e),
        undefined,
      );
      let error: Error | null = null;
      try {
        await agent.prompt('do the thing');
      } catch (e) {
        error = e as Error;
      }
      await agent.dispose();
      if (!error) throw new Error('expected prompt() to reject when jcode is missing');
      return { error, events };
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  }

  it('rejects with an ACTIONABLE message instead of a raw ENOENT', async () => {
    const { error } = await runWithoutJcodeOnPath();
    expect(error.message).not.toMatch(/^spawn jcode ENOENT$/);
    expect(error.message).toContain('/opt/jcode');
    expect(error.message).toContain('--no-docker');
    expect(error.message).toContain('npm run dev');
  });

  it('emits the same message as an error event so the agent log shows it', async () => {
    const { events } = await runWithoutJcodeOnPath();
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect((err as { message: string }).message).toBe(jcodeMissingExecutableMessage());
  });
});

// ---------------------------------------------------------------------------
// The PROVIDER decides the profile, the model namespace and the credential var
// ---------------------------------------------------------------------------

// THE regression this file exists for. `buildJcodeArgs` used to hard-code
// `--provider-profile deepseek-v4-pro`, and `withJcodeApiKey` used to hard-code
// `DEEPSEEK_API_KEY`, while `config.apiKey` carried whatever key huu had
// resolved for the provider the user actually chose. An OpenRouter run
// therefore sent an `sk-or-…` secret to api.deepseek.com as a Bearer token —
// a credential leak, not a misconfiguration, and one no 401 message would ever
// have blamed correctly.
describe('buildJcodeArgs — argv is derived from the provider', () => {
  /** Read one option's value out of the argv, so order changes cannot fake a pass. */
  function optionOf(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  }

  // MUTATION KILLED: restoring a constant profile
  // (`'--provider-profile', JCODE_PROVIDER_PROFILE`). It sends every run to
  // DeepSeek's base_url whatever the user picked.
  it('sends an OpenRouter run to the OpenRouter profile', () => {
    const args = buildJcodeArgs('anthropic/claude-opus-5', 'do it', 'openrouter');
    expect(optionOf(args, '--provider-profile')).toBe('openrouter');
    expect(optionOf(args, '--provider-profile')).toBe(jcodeProviderProfile('openrouter'));
  });

  it('sends a DeepSeek run to the DeepSeek profile', () => {
    const args = buildJcodeArgs('deepseek/deepseek-v4-pro', 'do it', 'deepseek');
    expect(optionOf(args, '--provider-profile')).toBe(jcodeProviderProfile('deepseek'));
  });

  it('never hands one provider the OTHER provider’s profile', () => {
    // The invariant, stated over the whole table rather than per pair: a run's
    // profile belongs to its own provider and to no other.
    for (const info of PROVIDERS) {
      const args = buildJcodeArgs('deepseek/deepseek-v4-pro', 'p', info.id);
      const profile = optionOf(args, '--provider-profile');
      expect(profile).toBe(jcodeProviderProfile(info.id));
      for (const other of PROVIDERS) {
        if (other.id === info.id) continue;
        expect(profile).not.toBe(jcodeProviderProfile(other.id));
      }
    }
  });

  // MUTATION KILLED: passing `modelId` straight through
  // (`'--model', modelId`) — the shape that made every catalog id unusable
  // against api.deepseek.com, since jcode forwards `--model` verbatim.
  it('renders --model in the endpoint’s namespace, both directions', () => {
    expect(
      optionOf(buildJcodeArgs('deepseek/deepseek-v4-pro', 'p', 'deepseek'), '--model'),
    ).toBe('deepseek-v4-pro');
    expect(
      optionOf(buildJcodeArgs('anthropic/claude-opus-5', 'p', 'openrouter'), '--model'),
    ).toBe('anthropic/claude-opus-5');
    // The SAME catalog id, rendered two ways — one canonical entry, two wires.
    expect(
      optionOf(buildJcodeArgs('deepseek/deepseek-v4-pro', 'p', 'openrouter'), '--model'),
    ).toBe('deepseek/deepseek-v4-pro');
  });

  it('falls back to the backend default when no provider was chosen', () => {
    const args = buildJcodeArgs('deepseek/deepseek-v4-pro', 'p');
    expect(optionOf(args, '--provider-profile')).toBe(jcodeProviderProfile(DEFAULT_PROVIDER));
  });

  it('keeps the CLI contract: options first, `--`, then the prompt LAST', () => {
    const args = buildJcodeArgs('anthropic/claude-opus-5', '--fix the bug', 'openrouter');
    expect(args.slice(0, 2)).toEqual(['run', '--no-update']);
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('--fix the bug');
  });
});

// ---------------------------------------------------------------------------
// The credential — pure precedence, and WHICH variable it lands in
// ---------------------------------------------------------------------------

describe('withJcodeApiKey', () => {
  it('injects the key huu resolved (config.apiKey) into the spawn env', () => {
    const { env, source } = withJcodeApiKey({ PATH: '/usr/bin' }, 'sk-resolved');
    expect(source).toBe('config');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-resolved');
    // Everything the parent env carried still travels.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('trims the resolved key (a trailing newline from a secret mount is not a key)', () => {
    const { env } = withJcodeApiKey({}, '  sk-resolved\n');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-resolved');
  });

  it('the resolved key WINS over a different inherited value', () => {
    const { env, source } = withJcodeApiKey(
      { DEEPSEEK_API_KEY: 'sk-stale-from-shell' },
      'sk-resolved',
    );
    expect(source).toBe('config');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-resolved');
  });

  it('falls back to the inherited env var when huu resolved nothing', () => {
    const { env, source } = withJcodeApiKey({ DEEPSEEK_API_KEY: 'sk-from-shell' }, '');
    expect(source).toBe('env');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-from-shell');
  });

  it('NEVER blanks an existing env var with an empty resolved key', () => {
    for (const empty of ['', '   ', undefined]) {
      const { env, source } = withJcodeApiKey({ DEEPSEEK_API_KEY: 'sk-from-shell' }, empty);
      expect(source).toBe('env');
      expect(env.DEEPSEEK_API_KEY).toBe('sk-from-shell');
    }
  });

  it('reports source "none" and creates no empty var when there is no key anywhere', () => {
    const { env, source } = withJcodeApiKey({ PATH: '/usr/bin' }, '');
    expect(source).toBe('none');
    // Not `''` — an empty variable would look "set" to jcode and to any
    // downstream reader.
    expect('DEEPSEEK_API_KEY' in env).toBe(false);
  });

  it('never mutates the env it was handed', () => {
    const parent: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'sk-from-shell' };
    const { env } = withJcodeApiKey(parent, 'sk-resolved');
    expect(parent.DEEPSEEK_API_KEY).toBe('sk-from-shell');
    expect(env).not.toBe(parent);
  });

  // -- the variable is the PROVIDER's, never a constant ---------------------

  /** Every `providerBound` env var in the registry — the set a key may land in. */
  const PROVIDER_KEY_VARS = API_KEY_REGISTRY.filter((s) => s.providerBound).map(
    (s) => s.envVar,
  );

  // MUTATION KILLED: reinstating `const DEEPSEEK_KEY_ENV_VAR = …` as the
  // injection target. With it, `withJcodeApiKey(env, orKey, 'openrouter')` puts
  // the OpenRouter secret in DEEPSEEK_API_KEY — which the DeepSeek profile then
  // sends to api.deepseek.com.
  it('puts the key in the env var of the provider it was resolved for', () => {
    const or = withJcodeApiKey({}, 'sk-or-v1-secret', 'openrouter');
    expect(or.envVar).toBe(jcodeApiKeyEnvVar('openrouter'));
    expect(or.env.OPENROUTER_API_KEY).toBe('sk-or-v1-secret');

    const ds = withJcodeApiKey({}, 'sk-deepseek-secret', 'deepseek');
    expect(ds.envVar).toBe(jcodeApiKeyEnvVar('deepseek'));
    expect(ds.env.DEEPSEEK_API_KEY).toBe('sk-deepseek-secret');
  });

  it('NEVER writes the key into another provider’s env var', () => {
    // Stated over the whole registry so a third provider is covered the day it
    // is added, not the day someone remembers to extend this test.
    for (const info of PROVIDERS) {
      const secret = `sk-secret-for-${info.id}`;
      const { env, envVar } = withJcodeApiKey({}, secret, info.id);
      expect(envVar).toBe(jcodeApiKeyEnvVar(info.id));
      for (const otherVar of PROVIDER_KEY_VARS) {
        if (otherVar === envVar) continue;
        expect(env[otherVar]).toBeUndefined();
      }
      // And the value is nowhere else in the env either.
      const leaked = Object.entries(env).filter(
        ([name, value]) => name !== envVar && value === secret,
      );
      expect(leaked).toEqual([]);
    }
  });

  it('strips an INHERITED foreign provider key out of the child env', () => {
    // The agent subprocess runs arbitrary shell in the worktree. A run carries
    // the credential it was authorized to spend and no other.
    const { env } = withJcodeApiKey(
      {
        DEEPSEEK_API_KEY: 'sk-deepseek-from-shell',
        DEEPSEEK_API_KEY_FILE: '/run/secrets/deepseek_api_key',
        PATH: '/usr/bin',
      },
      'sk-or-v1-secret',
      'openrouter',
    );
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-secret');
    expect('DEEPSEEK_API_KEY' in env).toBe(false);
    expect('DEEPSEEK_API_KEY_FILE' in env).toBe(false);
    // Non-provider variables are untouched — this strips credentials, not env.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('falls back to the chosen provider’s OWN inherited var, not the default’s', () => {
    const { env, source, provider } = withJcodeApiKey(
      { OPENROUTER_API_KEY: 'sk-or-v1-from-shell' },
      '',
      'openrouter',
    );
    expect(provider).toBe<LlmProvider>('openrouter');
    expect(source).toBe('env');
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-from-shell');
  });

  it('reports source "none" when only the OTHER provider has a key', () => {
    // Exactly the case that used to "work" by spending the wrong credential.
    const { source } = withJcodeApiKey(
      { DEEPSEEK_API_KEY: 'sk-deepseek-from-shell' },
      '',
      'openrouter',
    );
    expect(source).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// The DeepSeek credential — end to end through a REAL spawn
// ---------------------------------------------------------------------------

// A subprocess is the only thing that can prove the key actually TRAVELS: the
// container gets the key as a secret mount and the wrapper excludes the env
// var, so before this the spawned jcode saw no DEEPSEEK_API_KEY at all. The
// stand-in `jcode` here echoes back what it received, so the assertion is on
// the child's own view of its environment, not on huu's intent.
describe('jcodeAgentFactory — the DeepSeek key reaches the subprocess', () => {
  const task: AgentTask = {
    agentId: 1,
    files: ['src/foo.ts'],
    branchName: 'huu/test/agent-1',
    worktreePath: '/tmp/does-not-matter',
    stageIndex: 0,
    stageName: 'Stage 1',
  };

  // Drains stdin with the `read` BUILTIN, never `cat`: PATH below holds only
  // this temp dir, so an external command would not resolve — and a stand-in
  // that exits without consuming the prompt makes huu's `stdin.write` raise
  // EPIPE, which surfaces as an uncaught exception, not a test failure.
  const FAKE_JCODE = [
    '#!/bin/sh',
    'while read -r _line; do :; done',
    'echo "key=${DEEPSEEK_API_KEY:-<unset>}"',
    '',
  ].join('\n');

  /**
   * Run one agent against a stand-in `jcode` and return its raw transcript.
   * `envKey` is what the PARENT process exports (undefined = unset).
   */
  async function transcriptWith(
    configApiKey: string,
    envKey: string | undefined,
  ): Promise<{ transcript: string; events: AgentEvent[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'huu-jcode-key-'));
    writeFileSync(join(dir, 'jcode'), FAKE_JCODE);
    chmodSync(join(dir, 'jcode'), 0o755);

    const savedPath = process.env.PATH;
    const savedKey = process.env.DEEPSEEK_API_KEY;
    process.env.PATH = dir;
    if (envKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = envKey;

    const events: AgentEvent[] = [];
    try {
      const agent = await jcodeAgentFactory(
        task,
        { apiKey: configApiKey, modelId: 'deepseek-v4-pro' } as AppConfig,
        '',
        dir,
        (e) => events.push(e),
        undefined,
      );
      await agent.prompt('do the thing');
      // `getTranscript` is optional on SpawnedAgent; the jcode backend
      // implements it, and reading the child's own echo is the whole point.
      expect(agent.getTranscript).toBeDefined();
      const transcript = await agent.getTranscript!();
      await agent.dispose();
      return { transcript, events };
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedKey;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the key huu resolved lands in the child env, even with NO env var set', async () => {
    const { transcript } = await transcriptWith('sk-resolved-by-huu', undefined);
    expect(transcript).toContain('key=sk-resolved-by-huu');
  });

  it('the resolved key overrides a stale exported one', async () => {
    const { transcript } = await transcriptWith('sk-resolved-by-huu', 'sk-stale-from-shell');
    expect(transcript).toContain('key=sk-resolved-by-huu');
    expect(transcript).not.toContain('sk-stale-from-shell');
  });

  it('an empty resolved key leaves the exported one intact (no blanking)', async () => {
    const { transcript } = await transcriptWith('', 'sk-from-shell');
    expect(transcript).toContain('key=sk-from-shell');
    expect(transcript).not.toContain('key=<unset>');
  });

  it('refuses to spawn — with an ACTIONABLE message — when no key exists anywhere', async () => {
    const savedKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const events: AgentEvent[] = [];
    try {
      await expect(
        jcodeAgentFactory(
          task,
          { apiKey: '', modelId: 'deepseek-v4-pro' } as AppConfig,
          '',
          process.cwd(),
          (e) => events.push(e),
          undefined,
        ),
      ).rejects.toThrow(/DEEPSEEK_API_KEY/);
    } finally {
      if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedKey;
    }

    // Same text on the agent log, so the failure is visible where the user
    // watches the run — mirrors the missing-binary path.
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect((err as { message: string }).message).toBe(jcodeMissingApiKeyMessage());
  });
});

describe('jcodeMissingApiKeyMessage', () => {
  it('names the variable, every way to supply it, and the setup guide', () => {
    const msg = jcodeMissingApiKeyMessage();
    // The variable the provider profile actually reads.
    expect(msg).toContain('DEEPSEEK_API_KEY');
    // Every supported channel, so the user is not left guessing which one huu
    // honors — the saved key, the env var, the `_FILE` companion.
    expect(msg).toContain('Options');
    expect(msg).toContain('DEEPSEEK_API_KEY_FILE');
    expect(msg).toContain('/run/secrets/deepseek_api_key');
    expect(msg).toContain('docs/jcode-setup-guide.md');
  });
});

// ---------------------------------------------------------------------------
// The leak, closed end to end — a REAL spawn, from AppConfig to child argv/env
// ---------------------------------------------------------------------------

// Everything above is unit-level: it pins what huu INTENDS. This block pins
// what the child process actually RECEIVES, because that is where the secret
// leaves. The stand-in `jcode` echoes its own argv and its own view of both
// providers' credential variables, so a regression anywhere on the path —
// factory, hermetic env, argv builder — fails here even if every unit stays
// green.
//
// MUTATION KILLED: any change that reconnects `config.provider` from the spawn
// (dropping the field in an AppConfig builder, pinning the profile, pinning the
// env var). All three produced the SAME observable: `--provider-profile
// deepseek-v4-pro` plus `DEEPSEEK_API_KEY=<the OpenRouter secret>`.
describe('jcodeAgentFactory — the spawned child honors config.provider', () => {
  const task: AgentTask = {
    agentId: 1,
    files: [],
    branchName: 'huu/test/agent-1',
    worktreePath: '/tmp/does-not-matter',
    stageIndex: 0,
    stageName: 'Stage 1',
  };

  // Echoes on ONE line each so the assertions can be exact-match, not substring
  // (a substring test would pass on `DEEPSEEK_API_KEY=<unset>OPENROUTER…`).
  const ECHO_JCODE = [
    '#!/bin/sh',
    'echo "ARGV=$*"',
    'echo "DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-<unset>}"',
    'echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-<unset>}"',
    '',
  ].join('\n');

  async function spawnWith(
    config: Partial<AppConfig>,
    env: Record<string, string>,
  ): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), 'huu-jcode-provider-'));
    writeFileSync(join(dir, 'jcode'), ECHO_JCODE);
    chmodSync(join(dir, 'jcode'), 0o755);

    const saved: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    process.env.PATH = dir;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    for (const [k, v] of Object.entries(env)) process.env[k] = v;

    try {
      const agent = await jcodeAgentFactory(
        task,
        { modelId: 'deepseek/deepseek-v4-pro', ...config } as AppConfig,
        '',
        dir,
        () => {},
        undefined,
      );
      await agent.prompt('do the thing');
      const transcript = await agent.getTranscript!();
      await agent.dispose();
      return transcript.split('\n');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The single line starting with `<name>=`, or undefined. */
  function line(lines: string[], name: string): string | undefined {
    return lines.find((l) => l.startsWith(`${name}=`));
  }

  it('OpenRouter run: OpenRouter profile, OpenRouter var, NO DeepSeek var', async () => {
    const lines = await spawnWith(
      { provider: 'openrouter', modelId: 'anthropic/claude-opus-5', apiKey: '' },
      { OPENROUTER_API_KEY: 'sk-or-v1-THE-SECRET' },
    );
    expect(line(lines, 'ARGV')).toContain('--provider-profile openrouter');
    expect(line(lines, 'ARGV')).toContain('--model anthropic/claude-opus-5');
    expect(line(lines, 'OPENROUTER_API_KEY')).toBe(
      'OPENROUTER_API_KEY=sk-or-v1-THE-SECRET',
    );
    // The whole point: the secret is NOT in DeepSeek's variable, and the
    // profile is not DeepSeek's, so it cannot reach api.deepseek.com.
    expect(line(lines, 'DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY=<unset>');
    expect(line(lines, 'ARGV')).not.toContain('deepseek-v4-pro');
  });

  it('DeepSeek run: DeepSeek profile, BARE model id, NO OpenRouter var', async () => {
    const lines = await spawnWith(
      { provider: 'deepseek', modelId: 'deepseek/deepseek-v4-pro', apiKey: '' },
      { DEEPSEEK_API_KEY: 'sk-THE-DEEPSEEK-SECRET' },
    );
    expect(line(lines, 'ARGV')).toContain('--provider-profile deepseek-v4-pro');
    // Stripped: api.deepseek.com does not know `deepseek/deepseek-v4-pro`.
    expect(line(lines, 'ARGV')).toContain('--model deepseek-v4-pro --');
    expect(line(lines, 'DEEPSEEK_API_KEY')).toBe(
      'DEEPSEEK_API_KEY=sk-THE-DEEPSEEK-SECRET',
    );
    expect(line(lines, 'OPENROUTER_API_KEY')).toBe('OPENROUTER_API_KEY=<unset>');
  });

  it('an exported DeepSeek key never travels on an OpenRouter run', async () => {
    const lines = await spawnWith(
      {
        provider: 'openrouter',
        modelId: 'anthropic/claude-opus-5',
        apiKey: 'sk-or-v1-RESOLVED-BY-HUU',
      },
      { DEEPSEEK_API_KEY: 'sk-DEEPSEEK-FROM-SHELL', OPENROUTER_API_KEY: 'sk-or-v1-shell' },
    );
    expect(line(lines, 'OPENROUTER_API_KEY')).toBe(
      'OPENROUTER_API_KEY=sk-or-v1-RESOLVED-BY-HUU',
    );
    expect(line(lines, 'DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY=<unset>');
  });

  it('refuses an OpenRouter run when only the DeepSeek key exists', async () => {
    // Before, this "succeeded" — by spending the DeepSeek credential. The
    // refusal must also NAME the right variable, or it sends the user to set up
    // exactly the key the run must not use.
    const events: AgentEvent[] = [];
    const savedDs = process.env.DEEPSEEK_API_KEY;
    const savedOr = process.env.OPENROUTER_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-DEEPSEEK-FROM-SHELL';
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(
        jcodeAgentFactory(
          task,
          {
            apiKey: '',
            modelId: 'anthropic/claude-opus-5',
            provider: 'openrouter',
          } as AppConfig,
          '',
          process.cwd(),
          (e) => events.push(e),
          undefined,
        ),
      ).rejects.toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (savedDs === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedDs;
      if (savedOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedOr;
    }
    const err = events.find((e) => e.type === 'error') as { message: string };
    expect(err.message).toBe(jcodeMissingApiKeyMessage('openrouter'));
    expect(err.message).not.toContain('DEEPSEEK_API_KEY');
  });
});
