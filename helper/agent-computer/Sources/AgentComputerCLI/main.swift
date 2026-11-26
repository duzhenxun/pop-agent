import Darwin
import Foundation

/// 命令行入口：`/Applications/Agent Computer.app/Contents/MacOS/agent-computer <命令> [参数]`
///
/// 为什么要有它：Agent 只会跑 bash。把 CLI 做进 App 里，「装一个 App」就同时有了
/// helper（真干活）和命令行（Agent 调），不再需要 node / npm / PATH。
///
/// 协议与 `Sources/AgentComputer/Protocol.swift` 完全一致（JSON-RPC over Unix socket，
/// 帧格式 = uint32 小端长度 + UTF-8 JSON），API 版本 `turbo-1`。
/// 输出与 TS 版 CLI 逐字同形：成功 `{"ok":true,"result":…}`，失败 `{"ok":false,"error":{…}}` + 退出码 1。
///
/// 一个额外的好处：socket 连不上时它会自己去 `open` 那个 App（最多等 10 秒），
/// 所以 Agent 的第一条命令不会因为「App 没开着」直接失败。

// MARK: - 错误与输出

/// 与 helper 的错误名对齐（`data.name`），`retryable` 决定 Agent 能不能自动重试
struct CLIError: Error {
	let name: String
	let message: String
	let retryable: Bool

	init(_ name: String, _ message: String, retryable: Bool = false) {
		self.name = name
		self.message = message
		self.retryable = retryable
	}
}

/// 一行 JSON 打到 stdout（不换行 → 不，还是换行，方便 bash 里 `| jq`）
func emit(_ object: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
		FileHandle.standardOutput.write(Data(#"{"ok":false,"error":{"message":"结果无法序列化","name":"cliError","retryable":false}}"#.utf8))
		return
	}
	var out = data
	out.append(0x0A)
	FileHandle.standardOutput.write(out)
}

// MARK: - 帧（必须与 Framing.swift 一致）

enum Frame {
	static let headerBytes = 4
	static let maxFrameBytes = 8 * 1024 * 1024

	static func encode(_ value: [String: Any]) throws -> Data {
		let body = try JSONSerialization.data(withJSONObject: value, options: [])
		guard !body.isEmpty, body.count <= maxFrameBytes else {
			throw CLIError("badArguments", "帧大小超出范围：\(body.count)")
		}
		var out = Data(capacity: headerBytes + body.count)
		var length = UInt32(body.count).littleEndian
		withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
		out.append(body)
		return out
	}

	final class Decoder {
		private var buffer = Data()

		func push(_ chunk: Data) throws -> [[String: Any]] {
			buffer.append(chunk)
			var frames: [[String: Any]] = []
			while buffer.count >= Frame.headerBytes {
				let header = buffer.prefix(Frame.headerBytes)
				let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
				guard length > 0, Int(length) <= Frame.maxFrameBytes else {
					throw CLIError("helperFault", "帧长度非法：\(length)")
				}
				let total = Frame.headerBytes + Int(length)
				guard buffer.count >= total else { break }
				let body = buffer.subdata(in: Frame.headerBytes..<total)
				buffer.removeSubrange(0..<total)
				let parsed = try JSONSerialization.jsonObject(with: body)
				guard let dict = parsed as? [String: Any] else {
					throw CLIError("helperFault", "帧内容不是 JSON 对象")
				}
				frames.append(dict)
			}
			return frames
		}
	}
}

// MARK: - 路径约定（与 src/paths.ts 一致）

enum Paths {
	static let apiVersion = "turbo-1"

	/// 用户主目录：**先看 `$HOME`**，再退回系统给的。
	/// 为什么：Agent / sudo / 测试进程里的 `$HOME` 可能与真实用户不同，
	/// 而 `FileManager.homeDirectoryForCurrentUser` 只看 getpwuid，会忽略这个覆盖
	/// （单测想在不碰真实用户目录的情况下验证，就靠这一条）。
	static func homeDir() -> String {
		if let fromEnv = ProcessInfo.processInfo.environment["HOME"], !fromEnv.isEmpty { return fromEnv }
		return FileManager.default.homeDirectoryForCurrentUser.path
	}

	static func supportDir() -> String {
		"\(homeDir())/Library/Application Support/AgentComputer"
	}

	static func socketPath() -> String {
		if let override = ProcessInfo.processInfo.environment["CUT_SOCKET_PATH"], !override.isEmpty {
			return override
		}
		return "\(supportDir())/agent-computer.sock"
	}

	/// 本会话的稳定 ID：helper 用它把同一段操作串起来，一台机器只生成一次
	static func stableSessionId() -> String {
		if let override = ProcessInfo.processInfo.environment["AGENT_COMPUTER_SESSION"], !override.isEmpty {
			return override
		}
		let file = "\(supportDir())/cli-session-id"
		if let existing = try? String(contentsOfFile: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
			!existing.isEmpty
		{
			return existing
		}
		let id = UUID().uuidString
		try? FileManager.default.createDirectory(atPath: supportDir(), withIntermediateDirectories: true)
		try? "\(id)\n".write(toFile: file, atomically: true, encoding: .utf8)
		return id
	}

	/// 已安装的 App（/Applications 优先，其次 ~/Applications）
	static func installedAppPath() -> String? {
		for path in ["/Applications/Agent Computer.app", "\(homeDir())/Applications/Agent Computer.app"]
		where FileManager.default.fileExists(atPath: path) {
			return path
		}
		return nil
	}

	/// 写进 Skill 的命令前缀：优先已安装 App 里那个，其次当前这个可执行文件
	static func cliCommand() -> String {
		if let app = installedAppPath() {
			return shellQuote("\(app)/Contents/MacOS/agent-computer")
		}
		return shellQuote(resolvedExecutablePath())
	}

	static func resolvedExecutablePath() -> String {
		let raw = CommandLine.arguments.first ?? "agent-computer"
		let resolved = URL(fileURLWithPath: raw).resolvingSymlinksInPath().path
		return resolved.isEmpty ? raw : resolved
	}

	static func shellQuote(_ text: String) -> String {
		let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/.:@-")
		if text.unicodeScalars.allSatisfy({ safe.contains($0) }) { return text }
		return "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
	}

	/// 祖先进程 pid：helper 据此认出「宿主应用」并保护它不被误操作
	static func ancestorPids() -> [Int] {
		var pids: [Int] = []
		var pid = Int(getppid())
		for _ in 0..<12 where pid > 1 {
			pids.append(pid)
			let process = Process()
			process.executableURL = URL(fileURLWithPath: "/bin/ps")
			process.arguments = ["-o", "ppid=", "-p", "\(pid)"]
			let pipe = Pipe()
			process.standardOutput = pipe
			process.standardError = FileHandle.nullDevice
			do { try process.run() } catch { break }
			let data = pipe.fileHandleForReading.readDataToEndOfFile()
			process.waitUntilExit()
			let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			guard let next = Int(text) else { break }
			pid = next
		}
		return pids
	}
}

// MARK: - socket 客户端

final class HelperSocket {
	private var fd: Int32 = -1
	private let decoder = Frame.Decoder()
	private var nextId = 1

	init(path: String, timeout: TimeInterval) throws {
		fd = socket(AF_UNIX, SOCK_STREAM, 0)
		guard fd >= 0 else { throw CLIError("helperFault", "创建 socket 失败：\(errno)", retryable: true) }
		var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
		setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

		var addr = sockaddr_un()
		addr.sun_family = sa_family_t(AF_UNIX)
		let bytes = Array(path.utf8)
		guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
			Darwin.close(fd)
			throw CLIError("badArguments", "socket 路径太长：\(path)")
		}
		withUnsafeMutableBytes(of: &addr.sun_path) { raw in
			for (index, byte) in bytes.enumerated() { raw[index] = byte }
		}
		let result = withUnsafePointer(to: &addr) { pointer in
			pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockAddr in
				connect(fd, sockAddr, socklen_t(MemoryLayout<sockaddr_un>.size))
			}
		}
		guard result == 0 else {
			let code = errno
			Darwin.close(fd)
			throw CLIError("helperFault", "连接 helper 失败：\(String(cString: strerror(code)))", retryable: true)
		}
	}

	func close() {
		if fd >= 0 {
			Darwin.close(fd)
			fd = -1
		}
	}

	/// 发一条 JSON-RPC；返回整个回复信封（含 result / error）
	func call(method: String, params: [String: Any], timeout: TimeInterval) throws -> [String: Any] {
		let id = nextId
		nextId += 1
		let request: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method, "params": params]
		let payload = try Frame.encode(request)
		try writeAll(payload)

		var buffer = [UInt8](repeating: 0, count: 64 * 1024)
		while true {
			let read = recv(fd, &buffer, buffer.count, 0)
			if read > 0 {
				let chunk = Data(buffer[0..<Int(read)])
				for reply in try decoder.push(chunk) where (reply["id"] as? Int) == id {
					return reply
				}
				continue
			}
			if read == 0 {
				throw CLIError("helperFault", "helper 断开了连接", retryable: true)
			}
			let code = errno
			if code == EAGAIN || code == EWOULDBLOCK {
				throw CLIError("timedOut", "等了 \(Int(timeout)) 秒没等到 helper 回复（可能卡在系统对话框上）", retryable: true)
			}
			throw CLIError("helperFault", "读取 helper 回复失败：\(String(cString: strerror(code)))", retryable: true)
		}
	}

	private func writeAll(_ data: Data) throws {
		var offset = 0
		try data.withUnsafeBytes { raw in
			guard let base = raw.baseAddress else { return }
			while offset < data.count {
				let written = send(fd, base.advanced(by: offset), data.count - offset, 0)
				if written <= 0 {
					let code = errno
					throw CLIError("helperFault", "写入 helper 失败：\(String(cString: strerror(code)))", retryable: true)
				}
				offset += written
			}
		}
	}
}

// MARK: - 连接 helper（App 没开就开它）

func connectHelper(deadline: TimeInterval = 10) throws -> (HelperSocket, [String: Any]) {
	let socketPath = Paths.socketPath()
	var launched = false
	var waited: TimeInterval = 0
	while true {
		do {
			let socket = try HelperSocket(path: socketPath, timeout: 30)
			let hello = try socket.call(
				method: "hello",
				params: ["clientApiVersion": Paths.apiVersion, "clientName": "agent-computer-cli"],
				timeout: 5
			)
			if let error = hello["error"] as? [String: Any] {
				socket.close()
				throw errorOf(error)
			}
			let result = hello["result"] as? [String: Any] ?? [:]
			let serverVersion = result["serverApiVersion"] as? String ?? ""
			guard serverVersion == Paths.apiVersion else {
				socket.close()
				throw CLIError("protocolMismatch", "helper 的 API 版本是 \(serverVersion)，本 CLI 只支持 \(Paths.apiVersion)")
			}
			return (socket, result)
		} catch {
			// 第一次连不上：把 App 打开再等一会儿（Agent 不会先手动开 App）
			if !launched, let app = Paths.installedAppPath() {
				launched = true
				let process = Process()
				process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
				process.arguments = [app]
				process.standardOutput = FileHandle.nullDevice
				process.standardError = FileHandle.nullDevice
				try? process.run()
				process.waitUntilExit()
			}
			guard launched, waited < deadline else { throw error }
			Thread.sleep(forTimeInterval: 0.5)
			waited += 0.5
		}
	}
}

func errorOf(_ error: [String: Any]) -> CLIError {
	let data = error["data"] as? [String: Any] ?? [:]
	return CLIError(
		data["name"] as? String ?? "helperError",
		error["message"] as? String ?? "helper 报错",
		retryable: data["retryable"] as? Bool ?? false
	)
}

/// 发一条业务请求；deadline 是给 helper 的截止时间（秒）
func request(
	_ socket: HelperSocket,
	_ requestType: String,
	_ payload: [String: Any],
	deadline: TimeInterval = 120
) throws -> Any {
	let session: [String: Any] = [
		"sessionId": Paths.stableSessionId(),
		"turnId": NSNull(),
		"agent": [
			"name": ProcessInfo.processInfo.environment["AGENT_COMPUTER_AGENT"] ?? "agent-computer",
			"ancestorPids": Paths.ancestorPids(),
		],
	]
	let params: [String: Any] = [
		"requestType": requestType,
		"payload": payload,
		"deadlineUnixMillis": Int(Date().timeIntervalSince1970 * 1000 + deadline * 1000),
		"session": session,
	]
	// 需要人工审批的那几个请求，helper 可能弹确认框：本地多等一段
	let gated = ["observeApp", "act", "appCommands", "waitFor"].contains(requestType)
	let reply = try socket.call(
		method: "request",
		params: params,
		timeout: deadline + 5 + (gated ? 120 : 0)
	)
	if let error = reply["error"] as? [String: Any] { throw errorOf(error) }
	return reply["result"] ?? [:]
}

// MARK: - 参数解析

struct Args {
	var positionals: [String] = []
	var flags: [String: String] = [:]
	var booleans: Set<String> = []

	var allFlags: [String: Any] {
		var out: [String: Any] = flags
		for key in booleans { out[key] = true }
		return out
	}

	func text(_ key: String) -> String? { flags[key] }

	func int(_ key: String) throws -> Int? {
		guard let raw = flags[key] else { return nil }
		guard let value = Int(raw), value >= 0 else {
			throw CLIError("badArguments", "--\(key) 必须是非负整数")
		}
		return value
	}

	func number(_ key: String) -> Double? {
		guard let raw = flags[key] else { return nil }
		return Double(raw)
	}

	func point(_ key: String) throws -> (x: Double, y: Double)? {
		guard let raw = flags[key] else { return nil }
		let parts = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
		guard parts.count == 2, let x = Double(parts[0]), let y = Double(parts[1]) else {
			throw CLIError("badArguments", "--\(key) 需要 X,Y 形式的截图像素坐标")
		}
		return (x, y)
	}
}

func parse(_ argv: [String]) -> Args {
	var args = Args()
	var index = 0
	while index < argv.count {
		let token = argv[index]
		if token.hasPrefix("--") {
			let key = String(token.dropFirst(2))
			let next = index + 1 < argv.count ? argv[index + 1] : nil
			if let next, !next.hasPrefix("--") {
				args.flags[key] = next
				index += 2
				continue
			}
			args.booleans.insert(key)
			index += 1
			continue
		}
		args.positionals.append(token)
		index += 1
	}
	return args
}

func require(_ value: String?, _ what: String) throws -> String {
	guard let value, !value.isEmpty else { throw CLIError("badArguments", "缺少参数：\(what)") }
	return value
}

/// 点击 / 滚动这类动作的「打哪」参数：`--element N` 或 `--x X --y Y`
func target(_ args: Args) throws -> [String: Any] {
	let element = try args.int("element")
	let x = args.number("x")
	let y = args.number("y")
	if element != nil && (x != nil || y != nil) {
		throw CLIError("badArguments", "只能指定 --element，或者 --x 与 --y，不能同时指定")
	}
	if let element { return ["elementNumber": element] }
	if let x, let y { return ["x": x, "y": y] }
	throw CLIError("badArguments", "请指定 --element N，或同时指定 --x 与 --y（截图像素）")
}

func parseCommandPath(_ text: String) throws -> [String] {
	let parts: [String]
	if text.contains("▸") {
		parts = text.split(separator: "▸").map(String.init)
	} else {
		parts = text.components(separatedBy: ">").flatMap { $0.components(separatedBy: "→") }
	}
	let path = parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
	guard path.count >= 2 else {
		throw CLIError("badArguments", "「\(text)」不是菜单路径，请写成「菜单 ▸ 命令」，可先用 commands 查看")
	}
	guard path.count <= 8 else { throw CLIError("badArguments", "菜单路径最多 8 级") }
	return path
}

// MARK: - skill（把用法写进 ~/.agents/skills/agent-computer/）

enum Skill {
	static let id = "agent-computer"
	static let file = "SKILL.md"
	static let disabledFile = ".SKILL.md.disabled"
	static let marker = "<!-- managed-by: agent-computer -->"
	static let legacyMarkers = [
		"<!-- managed-by: pop-agent agent-computer -->",
		"<!-- managed-by: oh-my-agent-web agent-computer -->",
	]

	static func dir() -> String {
		"\(Paths.homeDir())/.agents/skills/\(id)"
	}

	static func path() -> String { "\(dir())/\(file)" }

	static func installed() -> Bool { FileManager.default.fileExists(atPath: path()) }

	static func templatePath() -> String? {
		if let override = ProcessInfo.processInfo.environment["AGENT_COMPUTER_SKILL_TEMPLATE"],
			FileManager.default.fileExists(atPath: override)
		{
			return override
		}
		// 打包态：App 的 Resources/skills/agent-computer/SKILL.md
		if let resources = Bundle.main.resourceURL?.path {
			let candidate = "\(resources)/skills/\(id)/\(file)"
			if FileManager.default.fileExists(atPath: candidate) { return candidate }
		}
		// 命令行可执行文件不在标准 bundle 布局里时，Bundle.main 未必是那个 .app：
		// 按 `<exe>/../../Resources`（= Contents/Resources）再找一次
		var contents = URL(fileURLWithPath: Paths.resolvedExecutablePath())
		contents.deleteLastPathComponent()  // MacOS/
		contents.deleteLastPathComponent()  // Contents/
		let packaged = contents.appendingPathComponent("Resources/skills/\(id)/\(file)").path
		if FileManager.default.fileExists(atPath: packaged) { return packaged }
		// 开发态：从可执行文件往上找仓库里的 skills/
		var url = URL(fileURLWithPath: Paths.resolvedExecutablePath())
		for _ in 0..<6 {
			url.deleteLastPathComponent()
			let candidate = url.appendingPathComponent("skills/\(id)/\(file)").path
			if FileManager.default.fileExists(atPath: candidate) { return candidate }
		}
		return nil
	}

	static func managed(_ text: String) -> Bool {
		text.contains(marker) || legacyMarkers.contains { text.contains($0) }
	}

	static func install(cli: String = Paths.cliCommand()) throws -> [String: Any] {
		guard let template = templatePath() else {
			throw CLIError("helperFault", "找不到 SKILL.md 模板（App 包损坏？）")
		}
		let filePath = path()
		if FileManager.default.fileExists(atPath: filePath) {
			let current = (try? String(contentsOfFile: filePath, encoding: .utf8)) ?? ""
			guard managed(current) else {
				throw CLIError("badArguments", "\(filePath) 已存在且不是本工具写入的，请先改名或删除它再安装")
			}
		}
		let body = try String(contentsOfFile: template, encoding: .utf8).replacingOccurrences(of: "{{CLI}}", with: cli)
		try FileManager.default.createDirectory(atPath: dir(), withIntermediateDirectories: true)
		try body.write(toFile: filePath, atomically: true, encoding: .utf8)
		try? FileManager.default.removeItem(atPath: "\(dir())/\(disabledFile)")
		return ["file": filePath, "cli": cli]
	}

	static func remove() -> Bool {
		let filePath = path()
		guard FileManager.default.fileExists(atPath: filePath) else { return false }
		let current = (try? String(contentsOfFile: filePath, encoding: .utf8)) ?? ""
		guard managed(current) else { return false }
		try? FileManager.default.moveItem(atPath: filePath, toPath: "\(dir())/\(disabledFile)")
		return true
	}

	static func status() -> [String: Any] {
		let filePath = path()
		let isInstalled = FileManager.default.fileExists(atPath: filePath)
		var cli: Any = NSNull()
		if isInstalled, let text = try? String(contentsOfFile: filePath, encoding: .utf8) {
			for line in text.split(separator: "\n") where line.contains("```bash") == false && line.contains(" <命令>") {
				cli = line.replacingOccurrences(of: " <命令>", with: "").trimmingCharacters(in: .whitespaces)
				break
			}
		}
		return [
			"installed": isInstalled,
			"file": filePath,
			"cli": cli,
			"disabled": FileManager.default.fileExists(atPath: "\(dir())/\(disabledFile)"),
		]
	}
}

// MARK: - 用法

let usage = """
电脑控制 CLI（随 Agent Computer.app 分发，不需要 node）

用法：agent-computer <命令> [参数] [--选项 值]

  status                              helper 运行状态与权限
  access [--request]                  权限检查；--request 会弹系统授权提示
  apps                                列出应用
  observe <应用> [--full]             界面树 + 截图
  click <应用> --element N            按编号点击（或 --x X --y Y 用截图像素）
  type <应用> <文字> [--element N]    输入文字
  keys <应用> <组合键>                按键，如 cmd+s
  fill <应用> --element N --value V   替换输入框内容
  paste <应用> <文字> [--format text|markdown|html]
  scroll <应用> <up|down|left|right> [--element N] [--pages N]
  drag <应用> --from X,Y --to X,Y     拖拽（截图像素）
  invoke <应用> --element N --name 名 执行无障碍动作
  commands <应用> [--query 词]        列出菜单命令
  run-command <应用> "菜单 ▸ 命令"    执行菜单命令
  wait <应用> --until X [--text T] [--element N] [--timeout 10]
  preview <on|off>                    实时预览浮窗
  finish                              结束操作会话
  skill [install|remove|status]       安装 / 卸载 / 查看给 Agent 用的 Skill
  version                             打印版本号

命令只是把参数转给 helper；它跑不起来时先看 status。
"""

// MARK: - 主流程

func version() -> String {
	if let fromBundle = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String { return fromBundle }
	// 裸可执行文件（不是 .app 的标准入口）时 Bundle.main 读不到 Info.plist，按路径兜一次
	var contents = URL(fileURLWithPath: Paths.resolvedExecutablePath())
	contents.deleteLastPathComponent()
	contents.deleteLastPathComponent()
	let plist = contents.appendingPathComponent("Info.plist")
	if let data = try? Data(contentsOf: plist),
		let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
		let value = dict["CFBundleShortVersionString"] as? String
	{
		return value
	}
	return "dev"
}

func act(_ socket: HelperSocket, app: String, step: [String: Any]) throws -> Any {
	try request(socket, "act", ["app": app, "step": step])
}

func run(_ command: String, _ args: Args) throws -> Any {
	// 不需要 helper 的两个命令先处理
	if command == "version" || command == "--version" || command == "-v" {
		return ["version": version()]
	}
	if command == "skill" {
		switch args.positionals.first ?? "status" {
		case "install": return try Skill.install()
		case "remove", "uninstall":
			var result = Skill.status()
			result["removed"] = Skill.remove()
			return result
		case "status": return Skill.status()
		default:
			throw CLIError("badArguments", "未知的 skill 子命令（可用 install / remove / status）")
		}
	}

	let (socket, hello) = try connectHelper()
	defer { socket.close() }

	if command == "status" {
		return [
			"running": true,
			"helperVersion": hello["helperVersion"] ?? NSNull(),
			"permissions": hello["permissions"] ?? [String: Any](),
		]
	}

	switch command {
	case "access":
		return try request(socket, args.booleans.contains("request") ? "requestAccess" : "accessStatus", [:])
	case "apps":
		return try request(socket, "findApps", [:])
	case "observe":
		let app = try require(args.positionals.first, "应用名")
		return try request(socket, "observeApp", [
			"app": app,
			"fullTree": args.booleans.contains("full"),
			"includeScreenshot": true,
		])
	case "click":
		let app = try require(args.positionals.first, "应用名")
		var step = try target(args)
		step["type"] = "clickAt"
		if let button = args.text("button") { step["button"] = button }
		if let times = try args.int("times") { step["clickTimes"] = times }
		return try act(socket, app: app, step: step)
	case "type":
		let app = try require(args.positionals.first, "应用名")
		var step: [String: Any] = ["type": "writeText", "text": try require(args.positionals.dropFirst().first, "文字")]
		if let element = try args.int("element") { step["elementNumber"] = element }
		return try act(socket, app: app, step: step)
	case "keys":
		let app = try require(args.positionals.first, "应用名")
		let key = try require(args.positionals.dropFirst().first, "组合键")
		return try act(socket, app: app, step: ["type": "sendKeys", "key": key])
	case "fill":
		let app = try require(args.positionals.first, "应用名")
		guard let element = try args.int("element") else { throw CLIError("badArguments", "fill 需要 --element N") }
		guard let value = args.text("value") else { throw CLIError("badArguments", "fill 需要 --value") }
		return try act(socket, app: app, step: ["type": "fillValue", "elementNumber": element, "value": value])
	case "paste":
		let app = try require(args.positionals.first, "应用名")
		var step: [String: Any] = ["type": "pasteText", "text": try require(args.positionals.dropFirst().first, "文字")]
		if let format = args.text("format") { step["format"] = format }
		return try act(socket, app: app, step: step)
	case "scroll":
		let app = try require(args.positionals.first, "应用名")
		let direction = try require(args.positionals.dropFirst().first, "方向 up|down|left|right")
		guard ["up", "down", "left", "right"].contains(direction) else {
			throw CLIError("badArguments", "方向必须是 up、down、left 或 right")
		}
		var step = try target(args)
		step["type"] = "scrollView"
		step["direction"] = direction
		if let pages = try args.int("pages") { step["pages"] = pages }
		return try act(socket, app: app, step: step)
	case "drag":
		let app = try require(args.positionals.first, "应用名")
		guard let from = try args.point("from"), let to = try args.point("to") else {
			throw CLIError("badArguments", "drag 需要 --from X,Y 与 --to X,Y")
		}
		return try act(socket, app: app, step: [
			"type": "dragItem", "startX": from.x, "startY": from.y, "endX": to.x, "endY": to.y,
		])
	case "invoke":
		let app = try require(args.positionals.first, "应用名")
		guard let element = try args.int("element") else { throw CLIError("badArguments", "invoke 需要 --element N") }
		let name = try require(args.text("name"), "--name")
		return try act(socket, app: app, step: ["type": "invokeAction", "elementNumber": element, "name": name])
	case "run-command":
		let app = try require(args.positionals.first, "应用名")
		let path = try parseCommandPath(try require(args.positionals.dropFirst().first, "菜单路径"))
		return try act(socket, app: app, step: ["type": "runCommand", "path": path])
	case "commands":
		let app = try require(args.positionals.first, "应用名")
		let reply = try request(socket, "appCommands", ["app": app])
		guard let query = args.text("query")?.lowercased(),
			var dict = reply as? [String: Any],
			let commands = dict["commands"] as? [[String: Any]]
		else { return reply }
		dict["commands"] = commands.filter { command in
			let text = (try? JSONSerialization.data(withJSONObject: command, options: [.sortedKeys]))
				.flatMap { String(data: $0, encoding: .utf8) } ?? ""
			return text.lowercased().contains(query)
		}
		return dict
	case "wait":
		let app = try require(args.positionals.first, "应用名")
		let until = try require(args.text("until"), "--until")
		let seconds = args.text("timeout").flatMap(Double.init) ?? 10
		guard seconds > 0, seconds <= 60 else { throw CLIError("badArguments", "--timeout 必须在 0–60 秒之间") }
		var payload: [String: Any] = ["app": app, "until": until, "timeoutMs": Int(seconds * 1000)]
		if let text = args.text("text") { payload["text"] = text }
		if let element = try args.int("element") { payload["elementNumber"] = element }
		return try request(socket, "waitFor", payload, deadline: seconds + 20)
	case "preview":
		let mode = try require(args.positionals.first, "on 或 off")
		guard mode == "on" || mode == "off" else { throw CLIError("badArguments", "preview 只接受 on 或 off") }
		return try request(socket, "previewPanel", ["show": mode == "on"])
	case "finish":
		return try request(socket, "finishTurn", [:])
	default:
		throw CLIError("badArguments", "未知命令：\(command)（运行 help 查看用法）")
	}
}

let argv = Array(CommandLine.arguments.dropFirst())
let command = argv.first ?? "help"
if command == "help" || command == "--help" || command == "-h" {
	print(usage)
	exit(0)
}

do {
	let result = try run(command, parse(Array(argv.dropFirst())))
	emit(["ok": true, "result": result])
} catch let error as CLIError {
	emit(["ok": false, "error": ["name": error.name, "message": error.message, "retryable": error.retryable]])
	exit(1)
} catch {
	emit(["ok": false, "error": ["name": "cliError", "message": "\(error)", "retryable": false]])
	exit(1)
}
