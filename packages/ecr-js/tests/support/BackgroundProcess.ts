import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * A node script run in the background for a test: a scripted TCP server, a
 * fake Hub, a process holding the terminal. Waits for its "LISTENING host:port" line.
 */
export class BackgroundProcess {
  host = '';
  port = 0;
  output = '';

  private constructor(private readonly child: ChildProcess) {}

  static async start(script: string, args: string[] = [], env: Record<string, string> = {}, startTimeout = 15_000): Promise<BackgroundProcess> {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const bg = new BackgroundProcess(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void bg.stop();
        reject(new Error('The background process did not start: ' + bg.output));
      }, startTimeout);
      child.stdout!.on('data', (chunk: Buffer) => {
        bg.output += chunk.toString('utf8');
        const m = /LISTENING (\S+):([0-9]+)/.exec(bg.output);
        if (m !== null && bg.port === 0) {
          bg.host = m[1]!;
          bg.port = Number(m[2]);
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        bg.output += chunk.toString('utf8');
      });
      child.on('exit', () => {
        if (bg.port === 0) {
          clearTimeout(timer);
          reject(new Error('The background process exited: ' + bg.output));
        }
      });
    });
    return bg;
  }

  /** A free loopback port, for a server that cannot pick its own. */
  static freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  /** Kills it hard, the way a crash would, and waits for it to be gone. */
  stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill('SIGKILL');
    });
  }
}
