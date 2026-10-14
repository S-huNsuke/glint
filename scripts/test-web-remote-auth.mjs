import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  hmacSha256, hkdfExtractExpand, hkdfExpand, aesGcmSeal, aesGcmOpen,
} from "../Glint/Resources/WebRemote/crypto.mjs";

const source = readFileSync(new URL("../Glint/Resources/WebRemote/web-remote.js", import.meta.url), "utf8");
const accessKey = "01".repeat(32);
const challenge = Buffer.alloc(32, 7).toString("base64");
const encoder = new TextEncoder();

/** 模拟无副作用的界面操作；无参数；无返回值。 */
function noop() {}

/** 提取真实客户端函数；参数为函数名；返回未经修改的函数源码。 */
function shippedFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf("\n}", start) + 2;
  return source.slice(start, end);
}

/** 创建隔离的 DOM/WebSocket 环境；无参数；返回真实客户端处理器与观察记录。 */
function harness() {
  const sockets = [], writes = [], statuses = [], states = [];
  const storage = new Map();
  const elements = {
    authDialog: {
      open: false,
      /** 关闭认证弹窗；无参数；无返回值。 */
      close() { this.open = false; },
    },
    authError: { textContent: "" },
    emptyState: { classList: { add: noop, remove: noop } },
    terminal: { classList: { add: noop, remove: noop } },
  };
  class MockWebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    /** 建立测试连接；无参数；返回测试连接实例。 */
    constructor() {
      this.readyState = MockWebSocket.OPEN;
      this.handlers = new Map();
      this.sent = [];
      this.closeCount = 0;
      sockets.push(this);
    }
    /** 注册事件；参数为类型和处理器；无返回值。 */
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    /** 记录待发送帧；参数为帧；无返回值。 */
    send(data) { this.sent.push(data); }
    /** 标记连接关闭；无参数；无返回值。 */
    close() { this.closeCount += 1; this.readyState = MockWebSocket.CLOSED; }
    /** 投递 WebSocket 事件；参数为事件类型和数据；返回处理器结果。 */
    emit(type, data) { return this.handlers.get(type)?.({ data }); }
  }
  const context = vm.createContext({
    WebSocket: MockWebSocket, TextEncoder, TextDecoder, Uint8Array, DataView, Date,
    hmacSha256, hkdfExtractExpand, hkdfExpand, aesGcmSeal, aesGcmOpen,
    clearTimeout: noop, setTimeout: noop, updateFilesButton: noop, fitTerminal: noop,
    applyBrand: noop, applyTheme: noop, chooseInitialPane: noop,
    /** 返回预设访问密钥；无参数；返回十六进制密钥。 */
    loadToken: () => accessKey,
    /** 返回测试服务地址；无参数；返回 WebSocket URL。 */
    websocketURL: () => "ws://localhost/control",
    /** 记录状态变化；参数为状态和文案；返回记录条数。 */
    setStatus: (...args) => statuses.push(args),
    /** 用翻译键代替文案；参数为翻译键；返回该键。 */
    t: key => key,
    /** 打开模拟认证弹窗；无参数；无返回值。 */
    showAuth: () => { elements.authDialog.open = true; },
    /** 记录业务状态渲染；参数为状态；返回记录条数。 */
    renderState: state => states.push(state), elements,
    sessionStorage: {
      /** 读取会话存储；参数为键；返回保存的值。 */
      getItem: key => storage.get(key),
      /** 保存会话存储；参数为键和值；返回存储 Map。 */
      setItem: (key, value) => storage.set(key, value),
      /** 删除会话存储；参数为键；返回是否存在该键。 */
      removeItem: key => storage.delete(key),
    },
    terminal: {
      /** 记录终端渲染并完成回调；参数为字节与回调；无返回值。 */
      write: (bytes, callback) => { writes.push(Buffer.from(bytes).toString()); callback?.(); },
      reset: noop, focus: noop,
    },
    /** 将字节编码为 base64；参数为字节；返回 base64 文本。 */
    encodeBase64: bytes => Buffer.from(bytes).toString("base64"),
    /** 将 base64 解码为字节；参数为文本；返回字节数组。 */
    decodeBase64: value => Uint8Array.from(Buffer.from(value, "base64")),
  });
  vm.runInContext(`
    const PROOF_LABEL = "glint-webremote/v1/proof", SESSION_INFO = "glint-webremote/v1/session";
    const C2S_INFO = "c2s", S2C_INFO = "s2c";
    const textEncoder = new TextEncoder(), textDecoder = new TextDecoder();
    let autoFocusTerminal = false;
  `, context);
  vm.runInContext(source.slice(source.indexOf("let socket;"), source.indexOf("const mobileSidebarLayout =")), context);
  for (const name of ["hexToBytes", "concatBytes", "nonceFor", "counterFromNonce", "handleError", "errorLabel", "sendInputBytes"]) {
    vm.runInContext(shippedFunction(name), context);
  }
  vm.runInContext(source.slice(source.indexOf("function connect("), source.indexOf("function applyBrand(")), context);
  /** 执行真实客户端表达式；参数为源码；返回表达式结果。 */
  function run(code) { return vm.runInContext(code, context); }
  /** 投递明文消息；参数为消息及可选连接；返回处理器结果。 */
  function plain(message, connection = sockets.at(-1)) {
    return connection.emit("message", typeof message === "string" ? message : JSON.stringify(message));
  }
  /** 使用真实协议构造服务器加密帧；参数为消息和计数器；返回二进制帧。 */
  function serverFrame(message, counter = 0) {
    const session = hkdfExtractExpand(Buffer.from(accessKey, "hex"), Buffer.from(challenge, "base64"), encoder.encode("glint-webremote/v1/session"), 32);
    const key = hkdfExpand(session, encoder.encode("s2c"), 32);
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
    return Uint8Array.from([...nonce, ...aesGcmSeal(key, nonce, encoder.encode(JSON.stringify(message)))]).buffer;
  }
  /** 建立并授权加密会话；无参数；无返回值。 */
  function authorize() {
    plain({ type: "auth-challenge", challenge });
    sockets.at(-1).emit("message", serverFrame({ type: "authenticated" }));
    run('selectedPane = "pane"');
  }
  run("connect()");
  return { sockets, writes, statuses, states, elements, run, plain, serverFrame, authorize };
}

/** 验证明文输出不能进入已授权终端；无参数；无返回值。 */
function rejectsPlainOutput() {
  const h = harness();
  h.authorize();
  h.plain({ type: "output", pane: "pane", data: Buffer.from("forged").toString("base64") });
  assert.deepEqual(h.writes, []);
  assert.equal(h.sockets.at(-1).closeCount, 1);
}
test("encrypted sessions close on plaintext output without rendering it", rejectsPlainOutput);

/** 验证明文授权不能解锁输入；无参数；无返回值。 */
function rejectsPlainAuthentication() {
  const h = harness();
  h.plain({ type: "authenticated" });
  h.run('selectedPane = "pane"; sendInputBytes(textEncoder.encode("secret"))');
  assert.equal(h.run("authenticated"), false);
  assert.deepEqual(h.sockets.at(-1).sent, []);
  assert.equal(h.sockets.at(-1).closeCount, 1);
}
test("plaintext authenticated cannot authorize a session or expose input", rejectsPlainAuthentication);

/** 验证握手 proof 与协议一致；无参数；无返回值。 */
function acceptsChallengeProof() {
  const h = harness();
  h.plain({ type: "auth-challenge", challenge });
  const message = JSON.parse(h.sockets.at(-1).sent[0]);
  const expected = hmacSha256(Buffer.from(accessKey, "hex"), Buffer.concat([Buffer.from("glint-webremote/v1/proof"), Buffer.from(challenge, "base64")]));
  assert.deepEqual(message, { type: "authenticate", proof: Buffer.from(expected).toString("base64") });
  assert.equal(h.run("authenticated"), false);
}
test("a valid plaintext challenge sends only its HMAC proof", acceptsChallengeProof);

/** 验证合法密文授权、输出与输入；无参数；无返回值。 */
function acceptsEncryptedTraffic() {
  const h = harness();
  h.authorize();
  const connection = h.sockets.at(-1);
  connection.emit("message", h.serverFrame({ type: "output", pane: "pane", data: Buffer.from("real").toString("base64") }, 1));
  connection.emit("message", h.serverFrame({ type: "state", workspaces: [] }, 2));
  connection.emit("message", h.serverFrame({ type: "snapshot", pane: "pane", data: Buffer.from("snapshot").toString("base64") }, 3));
  h.run('sendInputBytes(textEncoder.encode("secret"))');
  assert.equal(h.run("authenticated"), true);
  assert.deepEqual(h.writes, ["real", "snapshot"]);
  assert.equal(h.states.length, 1);
  assert.equal(connection.closeCount, 0);
  const frame = connection.sent.at(-1);
  assert.ok(frame instanceof Uint8Array);
  const message = JSON.parse(new TextDecoder().decode(aesGcmOpen(h.run("c2sKey"), frame.subarray(0, 12), frame.subarray(12))));
  assert.equal(message.type, "input");
  assert.equal(Buffer.from(message.data, "base64").toString(), "secret");
}
test("verified binary authentication and business messages keep input encrypted", acceptsEncryptedTraffic);

/** 验证握手错误后可重试相同 challenge；无参数；无返回值。 */
function retriesUnauthorized() {
  const h = harness();
  h.plain({ type: "auth-challenge", challenge });
  h.plain({ type: "error", code: "unauthorized" });
  assert.equal(h.elements.authError.textContent, "unauthorized");
  assert.equal(h.elements.authDialog.open, true);
  assert.equal(h.run("authenticated"), false);
  assert.equal(h.run("encrypted"), false);
  assert.equal(h.run("token"), "");
  h.run(`token = ${JSON.stringify(accessKey)}; tryAuthenticate()`);
  assert.equal(h.sockets.at(-1).sent.length, 2);
  assert.equal(JSON.parse(h.sockets.at(-1).sent[1]).type, "authenticate");
  h.sockets.at(-1).emit("message", h.serverFrame({ type: "authenticated" }));
  assert.equal(h.run("authenticated"), true);
}
test("handshake unauthorized permits a new proof for the original challenge", retriesUnauthorized);

/** 验证业务发送不降级到明文；无参数；无返回值。 */
function refusesPlainBusiness() {
  for (const phase of ["", "authenticated = true", "encrypted = true; c2sKey = null"]) {
    const h = harness();
    h.run(phase);
    h.run('send({ type: "input", pane: "pane", data: "c2VjcmV0" }); send({ type: "list" })');
    assert.deepEqual(h.sockets.at(-1).sent, []);
  }
}
test("business sends require encryption and a client key", refusesPlainBusiness);

/** 验证重复 challenge 不重置已推导的会话；无参数；无返回值。 */
function rejectsRepeatedChallenge() {
  const h = harness();
  h.plain({ type: "auth-challenge", challenge });
  h.plain({ type: "auth-challenge", challenge: Buffer.alloc(32, 8).toString("base64") });
  assert.equal(h.sockets.at(-1).sent.length, 1);
  assert.equal(h.run("pendingChallenge"), challenge);
  assert.equal(h.sockets.at(-1).closeCount, 1);
}
test("a second plaintext challenge cannot replace the handshake challenge", rejectsRepeatedChallenge);

/** 验证密文会话拒绝所有明文控制消息；无参数；无返回值。 */
function rejectsPlainControl() {
  for (const message of [{ type: "auth-challenge", challenge }, { type: "error", code: "unauthorized" }, { type: "authenticated" }]) {
    const h = harness();
    h.authorize();
    h.plain(message);
    assert.equal(h.sockets.at(-1).closeCount, 1);
    assert.equal(h.run("token"), accessKey);
  }
}
test("encrypted sessions reject plaintext challenge, errors and authorization", rejectsPlainControl);

/** 验证畸形和未知明文帧断开；无参数；无返回值。 */
function rejectsInvalidPlain() {
  for (const message of ["{", "null", "[]", '{"type":"unknown"}', '{"type":"state","workspaces":[]}', '{"type":"auth-challenge"}', '{"type":"auth-challenge","challenge":"bad"}', '{"type":"error"}']) {
    const h = harness();
    assert.doesNotThrow(h.plain.bind(null, message));
    assert.equal(h.sockets.at(-1).closeCount, 1, message);
    assert.equal(h.states.length, 0);
    assert.equal(h.sockets.at(-1).sent.length, 0);
  }
}
test("malformed or unexpected plaintext frames close the handshake safely", rejectsInvalidPlain);

/** 验证过期连接的所有事件不改变新会话；无参数；无返回值。 */
function ignoresStaleSocket() {
  const h = harness();
  const obsolete = h.sockets.at(-1);
  h.run("connect()");
  const current = h.sockets.at(-1);
  h.run('token = ""; lastServerMessageAt = 123');
  const previousStatusCount = h.statuses.length;
  obsolete.emit("open");
  obsolete.emit("error");
  obsolete.emit("close");
  h.plain({ type: "authenticated" }, obsolete);
  obsolete.emit("message", h.serverFrame({ type: "authenticated" }));
  assert.equal(h.run("lastServerMessageAt"), 123);
  assert.equal(h.statuses.length, previousStatusCount);
  assert.equal(h.elements.authDialog.open, false);
  assert.equal(h.run("authenticated"), false);
  assert.equal(current.closeCount, 0);
}
test("stale socket open, error, close and message events do not mutate the current session", ignoresStaleSocket);

/** 验证未通过验证的二进制帧不能授权；无参数；无返回值。 */
function rejectsInvalidBinary() {
  const h = harness();
  h.plain({ type: "auth-challenge", challenge });
  const frame = new Uint8Array(h.serverFrame({ type: "authenticated" }));
  frame[frame.length - 1] ^= 1;
  h.sockets.at(-1).emit("message", frame.buffer);
  assert.equal(h.run("authenticated"), false);
  assert.equal(h.run("encrypted"), false);
  assert.equal(h.sockets.at(-1).closeCount, 1);
}
test("tampered binary authentication never establishes a session", rejectsInvalidBinary);

/** 验证缺密钥时等待人工输入；无参数；无返回值。 */
function waitsForToken() {
  const h = harness();
  h.run('token = ""');
  h.plain({ type: "auth-challenge", challenge });
  assert.equal(h.sockets.at(-1).sent.length, 0);
  assert.equal(h.sockets.at(-1).closeCount, 0);
  h.run(`token = ${JSON.stringify(accessKey)}; tryAuthenticate()`);
  assert.equal(h.sockets.at(-1).sent.length, 1);
  assert.equal(JSON.parse(h.sockets.at(-1).sent[0]).type, "authenticate");
}
test("a challenge can wait for the user to enter an access key", waitsForToken);

/** 验证合法握手请求错误仍显示错误；无参数；无返回值。 */
function acceptsHandshakeError() {
  const h = harness();
  h.plain({ type: "error", code: "bad-request" });
  assert.deepEqual(h.statuses.at(-1), ["error", "bad_request"]);
  assert.equal(h.sockets.at(-1).closeCount, 0);
  assert.equal(h.run("authenticated"), false);
}
test("a supported plaintext handshake error remains visible", acceptsHandshakeError);

/** 验证已建立密文会话不被认证错误降级；无参数；无返回值。 */
function refusesEncryptedDowngrade() {
  const h = harness();
  h.authorize();
  const connection = h.sockets.at(-1);
  connection.emit("message", h.serverFrame({ type: "error", code: "unauthorized" }, 1));
  h.run('tryAuthenticate(); send({ type: "list" })');
  assert.equal(connection.closeCount, 1);
  assert.equal(h.run("encrypted"), true);
  assert.equal(connection.sent.length, 1);
}
test("an encrypted unauthorized error closes without downgrading or resending a proof", refusesEncryptedDowngrade);
