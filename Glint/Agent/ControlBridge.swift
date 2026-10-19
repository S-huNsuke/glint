import Foundation
import Darwin
import Security

/// Inbound control channel — the reverse of `AgentBridge`. Where the agent
/// socket only *receives* hook events to drive sidebar state, this one
/// *receives commands* and drives panes: focus a pane, inject text/keys,
/// list panes. It speaks line-delimited JSON, one request → one response
/// (vs. `agent.sock`'s fire-and-forget).
///
///     >> {"cmd":"focus","pane":"<uuid>:<seq>"}            << {"ok":true}
///     >> {"cmd":"send-text","pane":"…","text":"yes","enter":true,"token":"…"}
///     >> {"cmd":"send-key","pane":"…","keys":["down","enter"],"token":"…"}
///     >> {"cmd":"list"}   << {"ok":true,"panes":[{"pane":…,"title":…,"cwd":…,"agent":…}]}
///
/// Auth is **stateless**: each command carries an optional `token`; the
/// server validates per-line. State-changing commands (`send-*`) require a
/// matching token; `focus`/`list` are allowed without one. The token is
/// regenerated every launch into a 0600 file under `~/.glint/run/` — being
/// able to read it ≈ already being able to read the user's private files.
/// See docs/external-pane-control.md §4.4.
final class ControlBridge {
    static let shared = ControlBridge()

    private(set) var socketPath: String = ""
    private(set) var tokenPath: String = ""
    private var token: String = ""
    private let lifecycleLock = NSLock()
    private var generation: UUID?
    private var acceptedClients: Set<Int32> = []
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private let queue = DispatchQueue(label: "glint.control.bridge", qos: .utility)
    /// Lifecycle mutations run on main; accept/serve readers use the same lock.
    var isRunning: Bool {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        return generation != nil
    }

    private init() {}

    /// Canonical socket + token paths. Debug builds use separate filenames so
    /// a dev Glint and a prod Glint don't collide on the same path.
    private static func socketPaths() -> (socket: String, token: String) {
        let runDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".glint", isDirectory: true)
            .appendingPathComponent("run", isDirectory: true)
        #if DEBUG
        return (runDir.appendingPathComponent("control-debug.sock").path,
                runDir.appendingPathComponent("control-debug.token").path)
        #else
        return (runDir.appendingPathComponent("control.sock").path,
                runDir.appendingPathComponent("control.token").path)
        #endif
    }

    /// Bind + listen on `~/.glint/run/control.sock` (Debug: `control-debug.sock`).
    /// Same 0700-parent / 0600-socket discipline as `AgentBridge` — see its
    /// `start()` for the rationale on why a private parent dir matters here.
    /// Takes no parameters; returns nothing and stays stopped on bind failure.
    func start() {
        guard !isRunning else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let runDir = home
            .appendingPathComponent(".glint", isDirectory: true)
            .appendingPathComponent("run", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: runDir,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            NSLog("[glint] control run dir create failed: \(error)")
            return
        }
        chmod(runDir.path, 0o700)

        let (path, tokPath) = Self.socketPaths()
        socketPath = path
        tokenPath = tokPath

        // Fresh token every launch; the old one dies with the process.
        token = Self.generateToken()
        writeToken(to: tokPath)

        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            NSLog("[glint] control socket() failed: \(String(cString: strerror(errno)))")
            return
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        path.withCString { src in
            withUnsafeMutableBytes(of: &addr.sun_path) { dst in
                let dstPtr = dst.baseAddress!.assumingMemoryBound(to: CChar.self)
                _ = strlcpy(dstPtr, src, dst.count)
            }
        }

        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindRC = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
                Darwin.bind(fd, saPtr, addrLen)
            }
        }
        guard bindRC == 0 else {
            NSLog("[glint] control bind(\(path)) failed: \(String(cString: strerror(errno)))")
            close(fd)
            return
        }
        chmod(path, 0o600)

        guard listen(fd, 16) == 0 else {
            NSLog("[glint] control listen() failed: \(String(cString: strerror(errno)))")
            close(fd)
            return
        }

        // A cancelled source can have a queued handler. Nonblocking accept
        // plus the lifecycle lock prevents that handler accepting a reused FD.
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        lifecycleLock.lock()
        listenFD = fd
        generation = UUID()
        lifecycleLock.unlock()
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in self?.acceptOne() }
        src.setCancelHandler { close(fd) }
        src.resume()
        acceptSource = src
        NSLog("[glint] control bridge listening on \(path)")
    }

    /// Stop listening and remove the socket + token so the
    /// externalControlEnabled toggle can revoke access live — no app restart.
    /// No parameters; returns nothing. Accepted connections are shut down;
    /// their serving tasks retain ownership of close() to prevent FD reuse.
    func stop() {
        lifecycleLock.lock()
        guard generation != nil else { lifecycleLock.unlock(); return }
        generation = nil
        token = ""
        listenFD = -1
        for fd in acceptedClients { _ = shutdown(fd, SHUT_RDWR) }
        lifecycleLock.unlock()
        acceptSource?.cancel()
        acceptSource = nil
        if !socketPath.isEmpty { unlink(socketPath) }
        // Drop the token too — a fresh one is minted on the next start(), so a
        // stale on-disk token can't authorize anything while we're off.
        if !tokenPath.isEmpty { unlink(tokenPath) }
        NSLog("[glint] control bridge stopped")
    }

    /// Remove any socket/token left from a previous run while we stay disabled,
    /// so "off" leaves nothing on disk. A clean stop() already does this; this
    /// covers a crash / force-quit where stop() never ran. No-op if running.
    func reapStale() {
        guard !isRunning else { return }
        let (sock, tok) = Self.socketPaths()
        unlink(sock)
        unlink(tok)
    }

    // MARK: token

    private static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func writeToken(to path: String) {
        unlink(path)
        FileManager.default.createFile(
            atPath: path,
            contents: Data(token.utf8),
            attributes: [.posixPermissions: 0o600]
        )
        chmod(path, 0o600)
    }

    /// Compare a supplied token on main immediately before execution; returns
    /// whether it matches the nonempty live token without early byte exits.
    private func tokenMatches(_ provided: String?) -> Bool {
        guard let provided, !token.isEmpty else { return false }
        let a = Array(provided.utf8)
        let b = Array(token.utf8)
        var diff = UInt8(a.count == b.count ? 0 : 1)
        let n = max(a.count, b.count)
        for i in 0..<n {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            diff |= (x ^ y)
        }
        return diff == 0
    }

    // MARK: accept / serve

    /// Accept a client for the current generation; no inputs or return value.
    private func acceptOne() {
        lifecycleLock.lock()
        guard let run = generation, listenFD >= 0 else { lifecycleLock.unlock(); return }
        let client = accept(listenFD, nil, nil)
        guard client >= 0 else { lifecycleLock.unlock(); return }
        _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
        acceptedClients.insert(client)
        lifecycleLock.unlock()
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var noPipe: Int32 = 1
        _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout<Int32>.size))
        DispatchQueue.global(qos: .utility).async { self.serve(fd: client, generation: run) }
    }

    /// Runs off the accept queue. Each request line is parsed here, dispatched
    /// onto the main queue (where the store + surfaces live), and the response
    /// line written straight back on this connection.
    /// Parameters: owned client descriptor and accepting generation. Returns
    /// nothing; closes its descriptor after EOF, shutdown, timeout or failure.
    private func serve(fd: Int32, generation: UUID) {
        defer {
            lifecycleLock.lock()
            acceptedClients.remove(fd)
            close(fd)
            lifecycleLock.unlock()
        }
        var buf = Data()
        var tmp = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = tmp.withUnsafeMutableBufferPointer { bp -> Int in
                Darwin.read(fd, bp.baseAddress, bp.count)
            }
            if n <= 0 { break }
            buf.append(tmp, count: n)
            while let nl = buf.firstIndex(of: 0x0A) {
                let line = buf.subdata(in: buf.startIndex..<nl)
                buf.removeSubrange(buf.startIndex...nl)
                var resp = handle(line: line, generation: generation)
                resp.append(0x0A)
                resp.withUnsafeBytes { raw in
                    _ = Darwin.write(fd, raw.baseAddress, raw.count)
                }
            }
            if buf.count > (1 << 20) { break }
        }
    }

    /// Handle a request from one accepting generation; returns a JSON response.
    /// The main-thread gate orders revocation before all queued store actions.
    private func handle(line: Data, generation: UUID) -> Data {
        guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              let cmd = obj["cmd"] as? String else {
            return Self.errorResponse("bad-request")
        }

        var response = Self.errorResponse("unknown-cmd")
        DispatchQueue.main.sync {
            self.lifecycleLock.lock()
            let active = self.generation == generation
            self.lifecycleLock.unlock()
            guard active else {
                response = Self.errorResponse("unauthorized")
                return
            }
            let requiresToken = (cmd == "send-text" || cmd == "send-key")
            guard !requiresToken || self.tokenMatches(obj["token"] as? String) else {
                response = Self.errorResponse("unauthorized")
                return
            }
            guard let store = WorkspaceStore.current else {
                response = Self.errorResponse("bad-request")
                return
            }
            switch cmd {
            case "list":
                response = Self.okResponse(["panes": store.controlListPanes()])

            case "focus":
                guard let pane = obj["pane"] as? String else {
                    response = Self.errorResponse("bad-request"); return
                }
                response = store.controlFocus(pane: pane).map(Self.errorResponse) ?? Self.okResponse([:])

            case "send-text":
                guard let pane = obj["pane"] as? String, let text = obj["text"] as? String else {
                    response = Self.errorResponse("bad-request"); return
                }
                let enter = (obj["enter"] as? Bool) ?? false
                response = store.controlSendText(pane: pane, text: text, enter: enter)
                    .map(Self.errorResponse) ?? Self.okResponse([:])

            case "send-key":
                guard let pane = obj["pane"] as? String else {
                    response = Self.errorResponse("bad-request"); return
                }
                let keys: [String]
                if let arr = obj["keys"] as? [String] { keys = arr }
                else if let k = obj["key"] as? String { keys = [k] }
                else { response = Self.errorResponse("bad-request"); return }
                response = store.controlSendKeys(pane: pane, keys: keys)
                    .map(Self.errorResponse) ?? Self.okResponse([:])

            default:
                response = Self.errorResponse("unknown-cmd")
            }
        }
        return response
    }

    // MARK: responses

    private static func okResponse(_ extra: [String: Any]) -> Data {
        var dict: [String: Any] = ["ok": true]
        for (k, v) in extra { dict[k] = v }
        return serialize(dict)
    }

    private static func errorResponse(_ code: String) -> Data {
        serialize(["ok": false, "error": code])
    }

    private static func serialize(_ dict: [String: Any]) -> Data {
        SafeJSON.data(dict)
            ?? Data(#"{"ok":false,"error":"bad-request"}"#.utf8)
    }
}
