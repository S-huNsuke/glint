import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Compile the actual Codable models, recovery helpers and test bodies with
// Command Line Tools. CLT has no XCTest: a small assertion runner below executes
// the same assertions. UI-only types are placeholders; no Store is initialized,
// no Application Support directory is accessed and no hooks are installed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'Glint/Workspace/WorkspaceStore.swift'), 'utf8');
const modelStart = source.indexOf('enum SplitDirection:');
const factoryStart = source.indexOf('\nextension Workspace {', modelStart);
const factoryEnd = source.indexOf('    /// The currently visible tab', factoryStart);
const visibilityStart = source.indexOf('    static func paneIsVisible(');
const visibilityEnd = source.indexOf('\n    private static func parsePaneKey', visibilityStart);
const selectedTabStart = source.indexOf('    var selectedTab: WorkspaceTab?');
const selectedTabEnd = source.indexOf('\n', selectedTabStart);
if ([modelStart, factoryStart, factoryEnd, visibilityStart, visibilityEnd, selectedTabStart, selectedTabEnd].some(index => index < 0)) {
  throw new Error('Model extraction markers changed; update the isolated test harness.');
}
const stubs = `import Foundation
struct Color {
    /// Stand in for UI color; hex is a color string; returns a placeholder color.
    init?(hex: String) {}
    /// Stand in for UI color; parameters are RGB components; returns a placeholder color.
    init(red: Double, green: Double, blue: Double) {}
}
enum PaneAgentKind: String { case claude, codex, opencode, devin, omp, grok }
struct WorkspacePaneKey { let workspace: UUID; let pane: PaneID }
`;
const models = stubs + source.slice(modelStart, factoryStart)
  + source.slice(factoryStart, factoryEnd) + '\n}\n'
  + 'extension Workspace {\n' + source.slice(selectedTabStart, selectedTabEnd) + '\n}\n'
  + 'enum WorkspaceStore {\n' + source.slice(visibilityStart, visibilityEnd) + '\n}\n';
const tests = fs.readFileSync(path.join(root, 'GlintTests/PersistenceRecoveryTests.swift'), 'utf8')
  .replace('@testable import Glint', '')
  .replace('import XCTest', 'import Foundation')
  .replace('XCTestCase', 'RecoveryTestCase')
  .replace(/\bXCTUnwrap\b/g, 'unwrap')
  .replace(/\bXCTAssertEqual\b/g, 'expectEqual')
  .replace(/\bXCTAssertGreaterThan\b/g, 'expectGreaterThan')
  .replace(/\bXCTAssertNotNil\b/g, 'expectNotNil')
  .replace(/\bXCTAssertNil\b/g, 'expectNil')
  .replace(/\bXCTAssertTrue\b/g, 'expectTrue')
  .replace(/^    @MainActor\s*$/gm, '');
const names = [...tests.matchAll(/func (test\w+)\(\) throws/g)].map(match => match[1]);
if (names.length === 0 || /\bXCT(?:Assert\w*|Unwrap)\b/.test(tests)) {
  throw new Error('No recovery tests found or unsupported XCTest assertion; update the isolated test harness.');
}
const assertions = `import Foundation
class RecoveryTestCase {}
struct AssertionFailure: Error { let message: String }
var failures = 0
/// Record assertion failure; message and source line are inputs; returns no value.
func fail(_ message: String, line: UInt) {
    failures += 1
    print("FAIL line \\(line): \\(message)")
}
/// Unwrap an optional test value; value and message are inputs; returns its payload or throws.
func unwrap<T>(_ value: T?, _ message: String = "Expected non-nil") throws -> T {
    guard let value else { throw AssertionFailure(message: message) }
    return value
}
/// Check equality; two values, message and source line are inputs; returns no value.
func expectEqual<T: Equatable>(_ a: T, _ b: T, _ message: String = "", line: UInt = #line) {
    if a != b { fail("\\(a) != \\(b) \\(message)", line: line) }
}
/// Check ordering; two values, message and source line are inputs; returns no value.
func expectGreaterThan<T: Comparable>(_ a: T, _ b: T, _ message: String = "", line: UInt = #line) {
    if a <= b { fail("\\(a) <= \\(b) \\(message)", line: line) }
}
/// Check absence; value, message and source line are inputs; returns no value.
func expectNil<T>(_ value: T?, _ message: String = "", line: UInt = #line) {
    if value != nil { fail("Expected nil \\(message)", line: line) }
}
/// Check presence; value, message and source line are inputs; returns no value.
func expectNotNil<T>(_ value: T?, _ message: String = "", line: UInt = #line) {
    if value == nil { fail("Expected non-nil \\(message)", line: line) }
}
/// Check a condition; value, message and source line are inputs; returns no value.
func expectTrue(_ value: Bool, _ message: String = "", line: UInt = #line) {
    if !value { fail("Expected true \\(message)", line: line) }
}
`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-persistence-regression-'));
try {
  fs.writeFileSync(path.join(dir, 'Models.swift'), models);
  fs.writeFileSync(path.join(dir, 'Tests.swift'), tests);
  fs.writeFileSync(path.join(dir, 'Assertions.swift'), assertions);
  fs.writeFileSync(path.join(dir, 'main.swift'),
    'import Foundation\nlet tests: [(String, (PersistenceRecoveryTests) -> () throws -> Void)] = [\n'
    + names.map(name => `("${name}", PersistenceRecoveryTests.${name})`).join(',\n')
    + `\n]\nlet suite = PersistenceRecoveryTests()
for (name, test) in tests {
    let before = failures
    do { try test(suite)() } catch { fail(String(describing: error), line: 0) }
    print("\\(failures == before ? "PASS" : "FAIL"): \\(name)")
}
print("Executed \\(tests.count) recovery cases; \\(failures) assertion failures")
exit(failures == 0 ? 0 : 1)
`);
  const binary = path.join(dir, 'persistence-tests');
  const compile = spawnSync('swiftc', ['-swift-version', '5', '-module-cache-path', path.join(os.tmpdir(), 'glint-recovery-module-cache'), '-o', binary,
    path.join(dir, 'Models.swift'), path.join(dir, 'Tests.swift'), path.join(dir, 'Assertions.swift'), path.join(dir, 'main.swift'),
    path.join(root, 'Glint/Workspace/Persistence.swift'), path.join(root, 'Glint/Agent/SafeJSON.swift')],
    { encoding: 'utf8' });
  process.stdout.write(compile.stdout ?? '');
  process.stderr.write(compile.stderr ?? '');
  if (compile.error) throw compile.error;
  if (compile.status !== 0) process.exitCode = compile.status ?? 1;
  else {
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    process.stdout.write(run.stdout ?? '');
    process.stderr.write(run.stderr ?? '');
    if (run.error) throw run.error;
    if (run.signal) process.stderr.write(`Recovery test process terminated by ${run.signal}\n`);
    process.exitCode = run.status ?? 1;
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
