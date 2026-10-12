import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'glint-git-review-'));
let failures = 0;
let passed = 0;

/** Run an executable. Parameters: executable, argv, options. Returns stdout or throws on failure. */
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${executable}: ${result.stderr || result.error}`);
  return result.stdout;
}

/** Extract one production Swift function. Parameters: source and signature. Returns its complete body. */
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Missing production function: ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  assert.equal(depth, 0);
  return source.slice(start, end);
}

/** Record a behavioral check without hiding other failures. Parameters: name and body. Returns nothing. */
function check(name, body) {
  try { body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  const service = readFileSync(join(root, 'Glint/Git/GitService.swift'), 'utf8');
  const diff = readFileSync(join(root, 'Glint/Git/GitDiff.swift'), 'utf8');
  // Compile the complete production diff extension; only the process runner and
  // unrelated application types are stand-ins, so command flags are exercised.
  const support = String.raw`
import Foundation
enum GitTimeout { case read }
struct GitResult { let stdout: String; let ok: Bool; let wasSignaled = false }
protocol GitRunner: Sendable {
    func run(_ args: [String], cwd: String?) throws -> GitResult
    func countUntrackedAdditions(repo: String, paths: [String]) async -> [String: Int]
}
struct LocalGitRunner: GitRunner {
    /// Execute real Git. Parameters: argv and cwd. Returns decoded output and success.
    func run(_ args: [String], cwd: String?) throws -> GitResult {
        let process = Process(), output = Pipe(), errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = args
        process.currentDirectoryURL = cwd.map { URL(fileURLWithPath: $0) }
        process.standardOutput = output; process.standardError = errors
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return GitResult(stdout: String(decoding: data, as: UTF8.self), ok: process.terminationStatus == 0)
    }
    /// Stub unused untracked counts. Parameters: repo and paths. Returns an empty map.
    func countUntrackedAdditions(repo: String, paths: [String]) async -> [String: Int] { [:] }
}
struct GitService {
    let runner: any GitRunner = LocalGitRunner()
    /// Forward production diff calls to Git. Parameters: argv, cwd, failure policy, timeout. Returns output.
    func git(_ args: [String], cwd: String?, allowFailure: Bool, timeout: GitTimeout) async throws -> GitResult {
        try runner.run(args, cwd: cwd)
    }
}
`;
  const entry = String.raw`
struct Row: Encodable { let path: String; let kind: String; let additions: Int; let deletions: Int; let binary: Bool; let diff: String }
@main struct Regression {
    /// Drive production diff/quote functions. Parameters: command-line args. Returns JSON or shell token to stdout.
    static func main() async throws {
        let args = CommandLine.arguments
        if args[1] == "quote" { print(SSHGitRunner.quoteRemoteCwd(args[2])); return }
        if args[1] == "parse" {
            let paths = ["中文.txt", "tab\tfile.txt", "line\nfile.txt", "quote\"file.txt"]
            let names = paths.map { "M\0" + $0 + "\0" }.joined() + "D\0mode.txt\0"
            let nums = paths.map { "2\t1\t" + $0 + "\0" }.joined() + "-\t-\tbinary.dat\0"
            let files = GitService.mergeNameNumstat(nameStatus: names, numstat: nums)
            let rows = files.values.sorted { $0.path < $1.path }.map { Row(path: $0.path, kind: $0.kind.rawValue, additions: $0.additions, deletions: $0.deletions, binary: $0.isBinary, diff: "") }
            print(String(decoding: try JSONEncoder().encode(rows), as: UTF8.self)); return
        }
        let scope: DiffScope = args[1] == "working" ? .workingTree : .branch(base: args[3])
        let git = GitService()
        var rows: [Row] = []
        for file in await git.changedFiles(repo: args[2], scope: scope) {
            rows.append(Row(path: file.path, kind: file.kind.rawValue, additions: file.additions, deletions: file.deletions,
                            binary: file.isBinary, diff: await git.fileDiff(repo: args[2], scope: scope, file: file)))
        }
        print(String(decoding: try JSONEncoder().encode(rows), as: UTF8.self))
    }
}
`;
  const swiftPath = join(scratch, 'Regression.swift');
  const executable = join(scratch, 'regression');
  writeFileSync(swiftPath, support + diff + '\n' + extractFunction(service, 'func posixShellQuoted(')
    + '\nenum SSHGitRunner {\n' + extractFunction(service, 'static func quoteRemoteCwd(') + '\n}\n' + entry);
  run('/usr/bin/swiftc', ['-parse-as-library', '-module-cache-path', join(scratch, 'cache'), swiftPath, '-o', executable]);

  const paths = ['中文.txt', 'tab\tfile.txt', 'line\nfile.txt', 'quote"file.txt'];
  check('NUL parsing preserves names, mode-only changes and binary counts', () => {
    const rows = JSON.parse(run(executable, ['parse']));
    assert.deepEqual(rows.map(row => row.path).sort(), [...paths, 'mode.txt', 'binary.dat'].sort());
    for (const path of paths) assert.deepEqual(rows.find(row => row.path === path),
      { path, kind: 'modified', additions: 2, deletions: 1, binary: false, diff: '' });
    assert.equal(rows.find(row => row.path === 'mode.txt').kind, 'deleted');
    assert.equal(rows.find(row => row.path === 'binary.dat').binary, true);
  });

  const repo = join(scratch, 'repo');
  run('/usr/bin/git', ['init', '-q', repo]);
  run('/usr/bin/git', ['-C', repo, 'config', 'user.name', 'Regression']);
  run('/usr/bin/git', ['-C', repo, 'config', 'user.email', 'regression@example.invalid']);
  run('/usr/bin/git', ['-C', repo, 'config', 'diff.renames', 'true']);
  for (const path of [...paths, 'old.txt']) writeFileSync(join(repo, path), 'old\n');
  run('/usr/bin/git', ['-C', repo, 'add', '.']);
  run('/usr/bin/git', ['-C', repo, 'commit', '-qm', 'base']);
  const base = run('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD']).trim();
  for (const path of paths) writeFileSync(join(repo, path), 'new\n');
  run('/usr/bin/git', ['-C', repo, 'mv', 'old.txt', 'new.txt']);

  /** Validate Review rows against real files. Parameters: scope and arguments. Returns nothing. */
  function verifyScope(scope, args) {
    const rows = JSON.parse(run(executable, args));
    check(`${scope}: special filenames retain readable diffs and correct counts`, () => {
      for (const path of paths) {
        const row = rows.find(row => row.path === path);
        assert.ok(row, `Missing literal path ${JSON.stringify(path)}`);
        assert.equal(row.additions, 1); assert.equal(row.deletions, 1);
        assert.match(row.diff, /\+new/); assert.match(row.diff, /-old/);
      }
    });
    check(`${scope}: rename yields deletion and addition without phantom paths`, () => {
      assert.deepEqual(rows.map(row => row.path).sort(), [...paths, 'old.txt', 'new.txt'].sort());
      const old = rows.find(row => row.path === 'old.txt'), added = rows.find(row => row.path === 'new.txt');
      assert.equal(old.kind, 'deleted'); assert.equal(old.deletions, 1); assert.match(old.diff, /-old/);
      assert.equal(added.kind, 'added'); assert.equal(added.additions, 1); assert.match(added.diff, /\+old/);
    });
  }
  verifyScope('working tree', ['working', repo]);
  run('/usr/bin/git', ['-C', repo, 'add', '.']);
  run('/usr/bin/git', ['-C', repo, 'commit', '-qm', 'changes']);
  verifyScope('branch', ['branch', repo, base]);

  for (const shell of ['/bin/bash', '/bin/sh', '/bin/zsh']) {
    for (const path of ['~/code', '~/has space/a\'b;$(printf injected)`printf bad`', '~', '/absolute/a\'b;$(printf bad)', '~bad;rm/code']) {
      check(`${shell}: quotes ${JSON.stringify(path)} safely`, () => {
        const token = run(executable, ['quote', path]).trimEnd();
        const actual = run(shell, ['-c', `printf '%s' ${token}`]);
        const expected = path === '~' ? process.env.HOME : path.startsWith('~/') ? process.env.HOME + path.slice(1) : path;
        assert.equal(actual, expected);
      });
    }
    const username = run('/usr/bin/id', ['-un']).trim();
    check(`${shell}: named user tilde expands before quoted suffix`, () => {
      const token = run(executable, ['quote', `~${username}/has space`]).trimEnd();
      const home = run(shell, ['-c', `printf '%s' ~${username}`]);
      assert.equal(run(shell, ['-c', `printf '%s' ${token}`]), home + '/has space');
    });
  }
  console.log(`Git Review regression: ${passed} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
