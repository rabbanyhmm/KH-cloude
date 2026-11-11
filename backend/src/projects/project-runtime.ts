import { createHash } from 'crypto';

/** Select only a default; an explicit project start command always wins. */
export function getPythonStartCommand(
  hasFile: (name: string) => boolean,
  configuredStart?: string | null,
): string {
  if (configuredStart?.trim()) return configuredStart.trim();
  const entrypoint = ['runner.py', 'app.py', 'main.py', 'server.py', 'wsgi.py']
    .find(hasFile) || 'app.py';
  return `python ${entrypoint}`;
}

/** Docker --mount uses CSV syntax, so reject ambiguous fields rather than reinterpret them. */
export function validateVolumeDestination(destination: string): string {
  if (
    !destination.startsWith('/') ||
    /[\x00-\x1f\x7f,"\\]/.test(destination) ||
    destination.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`Invalid image volume destination: ${JSON.stringify(destination)}`);
  }

  // Equivalent container paths must reuse the same named volume.
  const normalized = destination.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized) {
    throw new Error('The container root cannot be an image volume destination.');
  }
  return normalized;
}

/** Pure mapping: no deployment IDs, slugs, host paths, or host filesystem access. */
export function getProjectVolumeArgs(projectId: string, imageVolumes: unknown): string[] {
  if (!projectId.trim()) throw new Error('A project ID is required for persistent volumes.');
  if (imageVolumes === null || imageVolumes === undefined) return [];
  if (typeof imageVolumes !== 'object' || Array.isArray(imageVolumes)) {
    throw new Error('Invalid image Config.Volumes: expected an object or null.');
  }

  const destinations = [...new Set(Object.keys(imageVolumes).map(validateVolumeDestination))].sort();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const projectHash = hash(projectId);
  return destinations.flatMap((destination) => [
    '--mount',
    `type=volume,source=kh-cloud-state-${projectHash}-${hash(destination)},target=${destination}`,
  ]);
}

/** Quote a single argument for the existing POSIX-shell deployment command runner. */
export function quoteShellArgument(argument: string): string {
  return `'${argument.replace(/'/g, `'"'"'`)}'`;
}

export function getConsoleCommandPolicy(command: string): { timeoutMs: number; timeoutMessage: string } {
  // Deliberately recognize direct invocations, not arbitrary shell scripts or mentions in arguments.
  // Allow executable/script paths, an optional exec, and Python's common -u/-B flags.
  const executablePath = '(?:[\\w./~+-]+/)?';
  const prefix = `^(?:exec\\s+)?${executablePath}`;
  const cli = new RegExp(`${prefix}(?:agy|antigravity)(?:\\s|$)`);
  const python = new RegExp(
    `${prefix}python(?:3(?:\\.\\d+)?)?(?:\\s+-[uB]+)*\\s+${executablePath}(login|app)\\.py(?:\\s+(.*))?$`,
  );
  const trimmed = command.trim();
  const pythonMatch = trimmed.match(python);
  const args = pythonMatch?.[2]?.trim() || '';
  const authCommand = /^(?:(?:agy|antigravity)\s+)?(?:login|auth)(?:-(?:start|begin|complete|finish|callback))?(?:\s|$)/;
  const authFlag = /^--(?:(?:agy|antigravity)-)?(?:login|auth)(?:-(?:agy|antigravity|start|begin|complete|finish|callback))?(?:=|\s|$)/;
  const isAuthCommand = pythonMatch && (
    pythonMatch[1] === 'login' || authCommand.test(args) || authFlag.test(args)
  );
  const timeoutMs = cli.test(trimmed) || isAuthCommand ? 180_000 : 25_000;
  return { timeoutMs, timeoutMessage: `Command timed out after ${timeoutMs / 1000} seconds.` };
}
