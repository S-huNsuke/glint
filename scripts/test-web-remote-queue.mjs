import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'Glint/WebRemote/WebRemoteServer.swift'), 'utf8');
const start = source.indexOf('struct WebRemoteOutboundBuffer {');
const end = source.indexOf('\nstruct WebRemoteAuthThrottle', start);
if (start < 0 || end < 0) throw new Error('Outbound extraction markers changed');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glint-outbound-test-'));
/** Extract one production method; marker is its declaration; returns its body and signature. */
function method(marker) {
  const begin = source.indexOf(marker);
  if (begin < 0) throw new Error('Missing client method: ' + marker);
  const brace = source.indexOf('{', begin);
  let depth = 1;
  let finish = brace + 1;
  for (; finish < source.length && depth; finish++) {
    if (source[finish] === '{') depth++;
    if (source[finish] === '}') depth--;
  }
  return source.slice(begin, finish).replace(/^private /, '');
}
const client = String.raw`
final class SlowConnection {
    var cancellations = 0
    /// Record cancellation; no inputs; returns nothing.
    func cancel() { cancellations += 1 }
}
final class SlowClient {
    var cancelled = false
    var outbound = WebRemoteOutboundBuffer(maxQueuedOutputBytes: 512 * 1024)
    var pendingSelectionOutput = WebRemoteOutputBuffer(byteLimit: 32)
    let connection = SlowConnection()
    /// Simulate an already blocked sender; no inputs or result; never dequeues.
    func sendNextIfNeeded() {}
` + method('func cancel() {') + '\n' + method('func send(_ data: Data) {') + '\n}\n';
const tests = String.raw`
/// Assert a regression condition; value and label are inputs; returns nothing or exits.
func check(_ value: Bool, _ label: String) {
    guard value else { print("FAIL: \(label)"); exit(1) }
    print("PASS: \(label)")
}
var buffer = WebRemoteOutboundBuffer(maxQueuedOutputBytes: 512 * 1024)
let image = Data(repeating: 1, count: 7 * 1024 * 1024)
buffer.enqueueMessage(image)
check(buffer.next() != nil, "legal base64 image fits ordinary response budget")
for _ in 0..<32 { buffer.enqueueMessage(Data(repeating: 1, count: 1024 * 1024)) }
var bytes = 0
while let item = buffer.next() {
    if case let .message(data) = item { bytes += data.count }
}
check(bytes <= 16 * 1024 * 1024, "ordinary responses obey total byte budget")
buffer.removeAll()
for _ in 0..<1000 { buffer.enqueueMessage(Data()) }
var count = 0
while buffer.next() != nil { count += 1 }
check(count <= 256, "zero-byte responses obey item budget")
check(buffer.enqueueTerminalOutput(Data(repeating: 2, count: 512 * 1024), pane: "a"), "terminal output fits its separate budget")
check(!buffer.enqueueTerminalOutput(Data([1]), pane: "a"), "terminal stream overflow is rejected")
buffer.removeAll()
check(buffer.enqueueTerminalOutput(Data([1]), pane: "a"), "cancel clears byte accounting")
var mixed = WebRemoteOutboundBuffer(maxQueuedOutputBytes: 8, maxQueuedBytes: 10, maxQueuedItems: 2)
check(mixed.enqueueMessage(Data(repeating: 1, count: 8)), "ordinary message uses shared total")
check(!mixed.enqueueTerminalOutput(Data([1, 2, 3]), pane: "a"), "mixed queue cannot exceed shared bytes")
check(mixed.enqueueTerminalOutput(Data([1, 2]), pane: "a"), "mixed queue exact byte limit accepted")
check(!mixed.enqueueMessage(Data()), "ordinary messages obey shared item count")
_ = mixed.next()
check(mixed.enqueueMessage(Data(repeating: 1, count: 8)), "dequeue restores only consumed bytes")
mixed.removeAll()
check(mixed.enqueueMessage(Data(repeating: 1, count: 10)), "reset releases full shared budget")
let slow = SlowClient()
for _ in 0..<3 { slow.send(image) }
check(slow.cancelled && slow.connection.cancellations == 1, "slow sender cancels on ordinary queue overflow")
check(slow.outbound.next() == nil, "overflow cancellation releases all queued data")
slow.send(Data([1]))
check(slow.outbound.next() == nil, "cancelled connection ignores later responses")
`;
try {
  fs.writeFileSync(path.join(dir, 'main.swift'), 'import Foundation\n' + source.slice(source.indexOf('struct WebRemoteOutputBuffer {'), end) + client + tests);
  const build = spawnSync('swiftc', ['-swift-version', '5', '-module-cache-path', path.join(dir, 'cache'), path.join(dir, 'main.swift'), '-o', path.join(dir, 'test')], { encoding: 'utf8', timeout: 60000 });
  process.stderr.write(build.stderr ?? '');
  if (build.status !== 0) process.exitCode = 1;
  else {
    const run = spawnSync(path.join(dir, 'test'), [], { encoding: 'utf8', timeout: 10000 });
    process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
    process.exitCode = run.status ?? 1;
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
