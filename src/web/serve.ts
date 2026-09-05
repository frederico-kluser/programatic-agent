/**
 * Bind + run the web server. This is the web-mode counterpart to Ink's
 * `render(<App/>)` in `cli.tsx`: it owns the port, prints the access banner,
 * and returns a promise that stays pending for the life of the process (the
 * CLI's signal handlers drive the actual exit, same as `waitUntilExit()`).
 */

import { networkInterfaces } from 'node:os';
import { createWebServer } from './server.js';
import { resolveWebHost, resolveWebPort } from './interface-mode.js';
import { termLog } from './terminal-log.js';
import { setResilient } from '../lib/crash-guard.js';
import { t } from '../lib/i18n/index.js';
import type { AgentBackendKind } from '../orchestrator/backends/registry.js';
import type { Pipeline } from '../lib/types.js';
import type { LlmProvider } from '../lib/providers.js';

export interface StartWebServerArgs {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  lockedBackend?: AgentBackendKind;
  /**
   * Provider locked from `--provider=`. Must travel on its own: both providers
   * map to the SAME `jcode` backend, so `lockedBackend` cannot carry it and
   * the browser's provider segment silently reverted to DeepSeek.
   */
  lockedProvider?: LlmProvider;
  initialPipeline?: Pipeline;
  defaultAutoScale: boolean;
  defaultConcurrency?: number;
}

/** Non-internal IPv4 addresses, for the "reachable on your network" URLs. */
function lanIPv4s(): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function withToken(url: string, token?: string): string {
  return token ? `${url}/?token=${encodeURIComponent(token)}` : url;
}

function printBanner(
  host: string,
  port: number,
  token: string | undefined,
  inContainer: boolean,
): void {
  const w = (s: string): void => {
    process.stdout.write(s + '\n');
  };
  w('');
  w(`  \x1b[35m●\x1b[0m \x1b[1mhuu\x1b[0m — ${t('cli.banner_web_ui')}`);
  if (inContainer) {
    // The container's own LAN IPs aren't reachable; the host wrapper prints
    // the authoritative localhost URL. Keep this concise.
    w(`    ${t('cli.banner_in_container', { port })}`);
  } else {
    w(
      `    \x1b[2m${t('cli.banner_local')}\x1b[0m     ` +
        withToken(`http://localhost:${port}`, token),
    );
    if (host === '0.0.0.0') {
      for (const ip of lanIPv4s()) {
        w(
          `    \x1b[2m${t('cli.banner_network')}\x1b[0m   ` +
            withToken(`http://${ip}:${port}`, token),
        );
      }
    }
  }
  // Name the secondary routes: they are reachable only by URL, so a banner
  // that omits them makes them effectively invisible. `/dev` also has a link
  // in the UI; `/simulation` deliberately does not (demo surface).
  if (!inContainer) {
    w(
      `    \x1b[2m${t('cli.banner_dev_mode')}\x1b[0m  ` +
        withToken(`http://localhost:${port}/dev`, token),
    );
  } else {
    w(`    \x1b[2m${t('cli.banner_dev_mode')}\x1b[0m  ${t('cli.banner_dev_hint')}`);
  }
  if (token) {
    w(`    \x1b[2m${t('cli.banner_token_required')}\x1b[0m`);
  } else if (host === '0.0.0.0' && !inContainer) {
    w(`    \x1b[2m${t('cli.banner_lan_warning')}\x1b[0m`);
  }
  w(`    \x1b[2m${t('cli.banner_stop')}\x1b[0m`);
  w('');
}

export async function startWebServer(opts: StartWebServerArgs): Promise<void> {
  const port = resolveWebPort(opts.args, opts.env);
  const host = resolveWebHost(opts.env);
  const token = opts.env.HUU_WEB_TOKEN?.trim() || undefined;
  const inContainer = opts.env.HUU_IN_CONTAINER === '1';

  const { server } = createWebServer({
    cwd: opts.cwd,
    lockedBackend: opts.lockedBackend,
    lockedProvider: opts.lockedProvider,
    initialPipeline: opts.initialPipeline,
    defaultAutoScale: opts.defaultAutoScale,
    defaultConcurrency: opts.defaultConcurrency,
    token,
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(t('cli.err_port_in_use', { port }) + '\n');
      } else {
        process.stderr.write(t('cli.err_web_start', { message: err.message }) + '\n');
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  printBanner(host, port, token, inContainer);
  termLog('info', 'web', t('cli.banner_termlog'));

  // The server is now LISTENING and about to host N concurrent runs. Flip the
  // process crash guard into resilient mode: from here on an uncaught error
  // (e.g. a detached agent-library timer) is contained + logged instead of
  // killing the process and every run with it. Startup errors above stay fatal
  // (a server that never bound should exit). A genuine meltdown still bails via
  // the guard's storm detector.
  setResilient(true);

  // Stay up until the process is signalled (cli.tsx owns SIGINT/SIGTERM and
  // calls process.exit). Resolving on 'close' lets a test shut it down too.
  await new Promise<void>((resolve) => server.once('close', resolve));
}
