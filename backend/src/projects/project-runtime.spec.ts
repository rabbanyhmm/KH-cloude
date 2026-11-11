import { deepStrictEqual, equal, match, notEqual, throws } from 'node:assert/strict';
import {
  getConsoleCommandPolicy,
  getProjectVolumeArgs,
  getPythonStartCommand,
  quoteShellArgument,
  validateVolumeDestination,
} from './project-runtime';

// Pure unit tests: no Nest bootstrap, Prisma client, Docker daemon, or network.
describe('Python default entrypoint', () => {
  it('prefers runner.py over every older default', () => {
    equal(getPythonStartCommand(() => true), 'python runner.py');
  });

  for (const entrypoint of ['app.py', 'main.py', 'server.py', 'wsgi.py']) {
    it(`retains the ${entrypoint} fallback`, () => {
      equal(getPythonStartCommand((name) => name === entrypoint), `python ${entrypoint}`);
    });
  }

  it('preserves the app.py fallback when no entrypoint is found', () => {
    equal(getPythonStartCommand(() => false), 'python app.py');
  });

  it('retains the previous fallback precedence when runner.py is absent', () => {
    equal(getPythonStartCommand((name) => name !== 'runner.py'), 'python app.py');
    equal(getPythonStartCommand((name) => !['runner.py', 'app.py'].includes(name)), 'python main.py');
  });

  it('keeps configured starts, including an explicitly configured app.py', () => {
    for (const command of ['python app.py', 'gunicorn custom:app', 'python runner.py --port 8080']) {
      equal(getPythonStartCommand(() => true, ` ${command} `), command);
    }
  });

  it('does not inspect files when a start override exists', () => {
    equal(getPythonStartCommand(() => { throw new Error('unexpected file lookup'); }, 'custom'), 'custom');
  });

  it('treats blank or absent overrides as automatic detection', () => {
    for (const override of [undefined, null, '', '   ']) {
      equal(getPythonStartCommand(() => true, override), 'python runner.py');
    }
  });
});

describe('image-declared project volumes', () => {
  it('adds nothing for images without declared volumes', () => {
    for (const volumes of [null, undefined, {}]) {
      deepStrictEqual(getProjectVolumeArgs('project-a', volumes), []);
    }
  });

  it('builds only named volume mounts, with a full project and destination hash', () => {
    const args = getProjectVolumeArgs('project-a', { '/data': {} });
    equal(args.length, 2);
    equal(args[0], '--mount');
    match(args[1], /^type=volume,source=kh-cloud-state-[a-f0-9]{64}-[a-f0-9]{64},target=\/data$/);
  });

  it('reuses the same mounts across redeploys and reroutes regardless of declaration order', () => {
    const initial = getProjectVolumeArgs('project-a', { '/data': {}, '/home': {} });
    const redeploy = getProjectVolumeArgs('project-a', { '/home': {}, '/data': {} });
    const reroute = getProjectVolumeArgs('project-a', JSON.parse('{"/data":{},"/home":{}}'));
    deepStrictEqual(initial, redeploy);
    deepStrictEqual(initial, reroute);
  });

  it('separates projects even when they share an ID prefix or sanitized spelling', () => {
    const volumes = { '/data': {} };
    notEqual(getProjectVolumeArgs('12345678-a', volumes)[1], getProjectVolumeArgs('12345678-b', volumes)[1]);
    notEqual(getProjectVolumeArgs('project/a', volumes)[1], getProjectVolumeArgs('project-a', volumes)[1]);
  });

  it('hashes the destination instead of using a collision-prone sanitized name', () => {
    const args = getProjectVolumeArgs('project-a', { '/a/b': {}, '/a-b': {} });
    const sources = [args[1], args[3]].map((arg) => arg.split(',target=')[0]);
    notEqual(sources[0], sources[1]);
  });

  it('normalizes equivalent destinations without creating duplicate mounts', () => {
    deepStrictEqual(
      getProjectVolumeArgs('project-a', { '/data/': {}, '//data': {}, '/data': {} }),
      getProjectVolumeArgs('project-a', { '/data': {} }),
    );
    equal(validateVolumeDestination('/data//home/'), '/data/home');
  });

  it('keeps mount arguments intact for spaces and shell metacharacters', () => {
    const destination = "/data/user's $(id) `id` ; & $HOME";
    const args = getProjectVolumeArgs('project-a', { [destination]: {} });
    equal(args.length, 2);
    equal(args[1].split(',target=')[1], destination);
    equal(quoteShellArgument("a'b"), "'a'\"'\"'b'");
    equal(quoteShellArgument('$HOME $(id) `id` ; &'), "'$HOME $(id) `id` ; &'");
    equal(quoteShellArgument(''), "''");
  });

  it('does not mutate the image metadata', () => {
    const volumes = Object.freeze({ '/data/': Object.freeze({}) });
    getProjectVolumeArgs('project-a', volumes);
    deepStrictEqual(volumes, { '/data/': {} });
  });

  for (const invalid of [
    '', '/', '///', 'relative/path', './data', 'C:\\data', '/data/../home', '/data/./home',
    '/data,type=bind,source=/etc', '/data"quoted', '/data\\home', '/data\nextra', '/data\r', '/data\t', '/data\0', '/data\x7f',
  ]) {
    it(`rejects invalid or ambiguous destination ${JSON.stringify(invalid)}`, () => {
      throws(() => validateVolumeDestination(invalid), /destination/);
      throws(() => getProjectVolumeArgs('project-a', { '/valid': {}, [invalid]: {} }), /destination/);
    });
  }

  it('fails on malformed volume metadata instead of silently creating anonymous volumes', () => {
    for (const volumes of [[], ['/data'], '/data', 42, true]) {
      throws(() => getProjectVolumeArgs('project-a', volumes), /Config.Volumes/);
    }
    throws(() => getProjectVolumeArgs('', { '/data': {} }), /project ID/);
    throws(() => getProjectVolumeArgs('   ', { '/data': {} }), /project ID/);
  });
});

describe('one-shot console timeout policy', () => {
  for (const command of [
    'agy', 'agy login', 'agy auth login', 'antigravity', 'antigravity auth login',
    './agy login', '/data/home/.local/bin/antigravity login', ' exec agy login ',
    'python login.py', 'python3 login.py --agy', 'python3.11 -u -B /app/login.py',
    '.venv/bin/python -u ./login.py', 'python app.py login', 'python app.py auth',
    'python app.py agy login', 'python app.py antigravity auth login',
    'python app.py --login-agy', 'python app.py --agy-login',
    'python app.py --agy-login-start', 'python app.py --agy-login-complete https://example.invalid/callback',
    'python app.py --antigravity-auth', 'python3 -u app.py login-start',
    'python3 app.py login-complete https://example.invalid/callback',
  ]) {
    it(`allows 180 seconds for ${command}`, () => {
      deepStrictEqual(getConsoleCommandPolicy(command), {
        timeoutMs: 180_000,
        timeoutMessage: 'Command timed out after 180 seconds.',
      });
    });
  }

  for (const command of [
    '', 'ls -la', 'sleep 200', 'npm start', 'python runner.py', 'python app.py',
    'python app.py --help', 'python main.py login', 'python server.py auth',
    'python app.py serve login', 'python app.py --message "try --login now"',
    'python -c "print(\'login.py\')"', 'python app.py login-report',
    'python app.py --login-config', 'python login.py.bak', 'cat login.py',
    'agy-helper login', 'my-antigravity login', 'echo agy login', 'echo python login.py',
    'sh -c "agy login"',
  ]) {
    it(`retains 25 seconds for ${command || '(empty)'}`, () => {
      deepStrictEqual(getConsoleCommandPolicy(command), {
        timeoutMs: 25_000,
        timeoutMessage: 'Command timed out after 25 seconds.',
      });
    });
  }
});
