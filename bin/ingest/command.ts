import { spawnSync } from 'child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): CommandResult;
}

function sanitizeStderr(stderr: string): string {
  return stderr
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/\b(authorization|cookie|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export const defaultCommandRunner: CommandRunner = {
  run(command, args, options) {
    const result = spawnSync(command, args, {
      cwd: options?.cwd,
      encoding: 'utf8',
      shell: false,
      timeout: options?.timeoutMs,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    const status = result.status ?? 1;

    if (result.error || status !== 0) {
      const detail = sanitizeStderr(stderr);
      throw new Error(`Command ${command} failed with exit code ${status}${detail ? `: ${detail}` : ''}`);
    }

    return { stdout, stderr, status };
  },
};
