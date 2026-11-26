import AppKit

/// 首次运行引导窗口。
///
/// 为什么需要它：macOS 的隐私授权不允许程序自己勾自己（TCC 是系统级保护），
/// 所以能优化的只有「路径」——把「打开系统设置 → 隐私与安全性 → 辅助功能 →
/// 找到条目 → 勾选」压缩成「点一个按钮 → 勾一下」，并且自动轮询结果。
///
/// 关键细节：**先调用带 prompt 的权限 API，再打开设置面板**。
/// 不先调一次，`Agent Computer` 根本不会出现在辅助功能列表里，用户会以为程序坏了。
final class Onboarding: NSObject, NSWindowDelegate {
	static let shared = Onboarding()

	private var window: NSWindow?
	private var timer: Timer?
	private var accessibilityLabel: NSTextField?
	private var screenLabel: NSTextField?
	/// 两颗「去授权」按钮：那一项已经授权了就不该再露出来（2026-11-26 用户）
	private var accessibilityButton: NSButton?
	private var screenButton: NSButton?
	/// 权限卡下面那条**状态行**（「还差一步…」/「都好了…」）
	private var statusLabel: NSTextField?
	private var doneButton: NSButton?
	/// 本次显示时是否「已经全就绪」。已经就绪就不跑倒计时自动关，
	/// 否则从菜单打开会看到窗口一闪就没了（2026-11-24 反馈）。
	private var readyWhenShown = false
	/// 从「没就绪」变成「就绪」的时刻；只有本次显示内发生的转换才自动关窗
	private var grantedAt: Date?
	/**
	 * 本次显示里，用户点过窗口上的「去授权」。
	 *
	 * 自动收窗**只认这条路**：`CGPreflightScreenCaptureAccess()` 在 App 刚起来、TCC 还没
	 * 应答的时候会短暂返回 false，下一拍又变 true —— 那是一次假转换，不该被当成
	 * 「用户刚授完权」而把窗口收掉（2026-11-24 用户看到的「一闪就没了」就是它）。
	 * 用户自己去系统设置里勾的，窗口就老老实实等着他点「完成」。
	 */
	private var userWentToSettings = false
	private var loggedInvisible = false
	private var lastBeep = Date.distantPast

	private let supportDir = FileManager.default.homeDirectoryForCurrentUser
		.appendingPathComponent("Library/Application Support/AgentComputer")

	private var markerFile: URL { supportDir.appendingPathComponent("onboarding.json") }

	/// 用户点过「稍后」就不再自动弹（但菜单栏随时能叫出来）
	private var dismissed: Bool {
		guard let data = try? Data(contentsOf: markerFile),
			let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			return false
		}
		return json["dismissed"] as? Bool ?? false
	}

	private func markDismissed() {
		try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
		let json: [String: Any] = ["dismissed": true, "at": ISO8601DateFormatter().string(from: Date())]
		if let data = try? JSONSerialization.data(withJSONObject: json) {
			try? data.write(to: markerFile)
		}
	}

	/// 启动时调用：没有权限且没被「稍后」过，就弹一次系统提示 + 显示引导窗口
	func showIfNeeded() {
		let ready = Permissions.accessibilityGranted() && Permissions.screenRecordingGranted()
		guard !ready else { return }
		if !dismissed {
			// 这一步会弹系统对话框「想控制这台电脑」，同时把 app 加进辅助功能列表
			Permissions.requestAccessibility()
		}
		show()
		registerScreenRecording()
	}

	/// 把 app **登记进「录屏与系统录音」列表**（用户 2026-11-23：「默认没添加进去」）。
	///
	/// 为什么必须单独调一次：`CGPreflight…` 是纯读的状态检查，**不会**让 app 出现在那个列表里；
	/// 只有 `CGRequest…` 才会写 TCC 记录。以前只有引导窗上的「去授权」按钮调它，
	/// 所以没点过那个按钮的机器上，用户打开系统设置根本找不到「Agent Computer」这一条。
	///
	/// 放在窗口显示之后、下一拍再调：这个调用会一直等到用户回答系统提示才返回，
	/// 直接写在 `applicationDidFinishLaunching` 里会让引导窗口卡着不出现。
	/// 这里只做「登记」，**不强迫开启** —— 开关由用户自己决定。
	private func registerScreenRecording() {
		guard !Permissions.screenRecordingGranted() else { return }
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
			guard let self, !Permissions.screenRecordingGranted() else { return }
			let granted = Permissions.requestScreenRecording()
			Log.write("申请屏幕录制（登记进列表）：granted=\(granted)")
			self.refresh()
		}
	}

	func show() {
		// 每次打开都重置倒计时：不能把上一次的 grantedAt 带过来，
		// 否则 elapsed 早就超时，窗口刚出来就被 orderOut 掉。
		grantedAt = nil
		userWentToSettings = false
		loggedInvisible = false
		readyWhenShown = Permissions.accessibilityGranted() && Permissions.screenRecordingGranted()
		Log.write(
			"show()：readyWhenShown=\(readyWhenShown) accessibility=\(Permissions.accessibilityGranted()) screen=\(Permissions.screenRecordingGranted())"
		)
		if let window {
			placeWindow(window)
			window.makeKeyAndOrderFront(nil)
			window.orderFrontRegardless()
			NSApp.activate(ignoringOtherApps: true)
			refresh()
			// 上次隐藏时轮询自己停了（see startPolling），复用时得重新起来，
			// 否则再打开这个窗口授权状态就不再跟着变了。
			startPolling()
			beepOnce()
			return
		}
		let window = buildWindow()
		self.window = window
		placeWindow(window)
		NSApp.activate(ignoringOtherApps: true)
		window.makeKeyAndOrderFront(nil)
		// accessory app 的 activate 可能被系统忽略：再强制抬一次，避免「点了没反应」
		window.orderFrontRegardless()
		refresh()
		startPolling()
		beepOnce()
		Log.write(
			"引导窗口：visible=\(window.isVisible) frame=\(window.frame) "
				+ "screen=\(window.screen?.frame.debugDescription ?? "nil") "
				+ "occlusion=\(window.occlusionState.rawValue) "
				+ "policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive)"
		)
	}

	/// 放到「鼠标所在的那块屏幕」中央。
	///
	/// 多屏时 `window.center()` 可能落到副屏上 —— 用户在另一块屏幕上双击，就会以为程序没反应。
	private func placeWindow(_ window: NSWindow) {
		let mouse = NSEvent.mouseLocation
		let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
		guard let visible = screen?.visibleFrame else { return }
		let size = window.frame.size
		window.setFrameOrigin(
			NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2)
		)
	}

	/// 一声轻提示：窗口在副屏/被遮挡时，声音至少说明「它起来了」
	private func beepOnce() {
		guard Date().timeIntervalSince(lastBeep) > 3 else { return }
		lastBeep = Date()
		NSSound(named: "Ping")?.play()
	}

	// MARK: - 界面

	private func buildWindow() -> NSWindow {
		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 360, height: 320),
			styleMask: [.titled, .closable, .fullSizeContentView],
			backing: .buffered,
			defer: false
		)
		window.title = "Agent Computer"
		window.titlebarAppearsTransparent = true
		// 明确给系统窗口底色：不写的话，透明标题栏 + 材质会让整片背景带壁纸色调（偏暖）
		window.backgroundColor = .windowBackgroundColor
		window.isReleasedWhenClosed = false
		window.delegate = self
		// 关键：后台 app 抢不到前台（macOS 限制），所以靠「层级 + 跟随所有 Space」保证可见。
		// .statusBar 高于普通/浮动窗口，能压在最大化的 Chrome 之上；全屏 Space 由 fullScreenAuxiliary 覆盖。
		window.level = .statusBar
		window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

		let icon = NSImageView()
		icon.image = NSApp.applicationIconImage
		icon.imageScaling = .scaleProportionallyUpOrDown
		icon.translatesAutoresizingMaskIntoConstraints = false
		icon.widthAnchor.constraint(equalToConstant: 46).isActive = true
		icon.heightAnchor.constraint(equalToConstant: 46).isActive = true

		// 标题位置放**应用名**，那句「还差一步就能用了」挪到底部状态行（2026-11-26 用户：
		// 「还差一步就能用了，放下面」）—— 它本来就是个状态判断，跟着权限状态一起变更合理。
		let title = NSTextField(labelWithString: "Agent Computer")
		title.font = .systemFont(ofSize: 17, weight: .semibold)

		// 副标题（那句「macOS 不允许应用自己给自己授权…」）2026-11-26 用户要求去掉：
		// 权限卡本身已经说清要什么，这一段只是在重复解释，还把 header 撑成两行压到卡片上。

		// 标题那一行右边跟一个版本徽标（2026-11-26 用户：「这里面加一个版本显示」）：
		// 版本对排查最关键 —— 用户说「授权了还是不行」时，第一件事就是问他装的是哪一版。
		let titleRow = NSStackView(views: [title, versionBadge()])
		titleRow.orientation = .horizontal
		titleRow.alignment = .centerY
		titleRow.spacing = 8

		let header = NSStackView(views: [icon, titleRow])
		header.orientation = .horizontal
		header.alignment = .centerY
		header.spacing = 12

		let accessibilityRow = makePermissionRow(
			name: "辅助功能",
			detail: "读界面、点击、输入都要它",
			action: #selector(grantAccessibility)
		)
		accessibilityLabel = accessibilityRow.status
		accessibilityButton = accessibilityRow.button
		let screenRow = makePermissionRow(
			name: "屏幕录制",
			detail: "只用来看截图，不给也能操作",
			action: #selector(grantScreenRecording)
		)
		screenLabel = screenRow.status
		screenButton = screenRow.button
		// 两行各自装进一张「卡片」：一眼能看出这两条是同一组的两个开关，
		// 也比纯分隔线更有层次（2026-11-26 用户：「排版布局弄好看一些」）。
		let permissions = NSStackView(views: [card(accessibilityRow.view), card(screenRow.view)])
		permissions.orientation = .vertical
		permissions.alignment = .width
		permissions.spacing = 10

		// 状态行：放在权限卡下面、横跨整行（2026-11-26 用户圈出来的那块空白）。
		// 它就是「还差几步能用」这一句 —— 以前挤在底栏、和按钮抢地方，还被截断。
		let status = NSTextField(wrappingLabelWithString: "还差 2 步才会生效")
		status.font = .systemFont(ofSize: 15, weight: .bold)
		status.alignment = .center
		status.textColor = .secondaryLabelColor
		status.setContentCompressionResistancePriority(.required, for: .vertical)
		statusLabel = status

		let later = NSButton(title: "稍后", target: self, action: #selector(dismiss))
		later.bezelStyle = .rounded
		later.controlSize = .regular
		let done = NSButton(title: "已授权，重新检测", target: self, action: #selector(donePressed))
		done.bezelStyle = .rounded
		done.controlSize = .regular
		done.keyEquivalent = "\r"
		doneButton = done
		// 两颗按钮一样宽：换文案（「已授权，重新检测」→「完成」）时右边缘不跳
		later.widthAnchor.constraint(equalToConstant: 68).isActive = true

		let footer = NSStackView(views: [NSView(), later, done])
		footer.orientation = .horizontal
		footer.alignment = .centerY
		footer.spacing = 8

		let separator = divider()
		// 高度顺序：header（图标或两行文字谁高算谁）→ 两张卡 → 状态行 → 分隔线 → 按钮行
		for block in [header, permissions, status as NSView] {
			block.setContentCompressionResistancePriority(.required, for: .vertical)
		}
		let spring = NSView()
		spring.setContentHuggingPriority(.init(1), for: .vertical)
		let stack = NSStackView(views: [header, permissions, status, spring, separator, footer])
		stack.orientation = .vertical
		stack.alignment = .leading
		stack.spacing = 12
		stack.translatesAutoresizingMaskIntoConstraints = false

		// 内边距用**容器约束**给，不用 `stack.edgeInsets`：后者会让 arranged subview 的
		// 宽度约束跟栈自身宽度对数不上（实测 header 会从 x=0 起跑、footer 差 5pt）。
		// 这样写之后每块都明确 `width == stack.width`：卡片与右列（状态 + 按钮）必然对齐。
		let content = NSView()
		content.addSubview(stack)
		NSLayoutConstraint.activate([
			stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
			stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
			stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 34),
			stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
		])
		for block in [header, permissions, status, separator, footer] {
			block.translatesAutoresizingMaskIntoConstraints = false
			block.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
		}
		window.contentView = content
		// `AGENT_COMPUTER_LOG_LAYOUT=1`：把关键块的最终 frame 打进 helper.log。
		// 改排版时用它核对「卡片有没有撑满、右列有没有对齐」——比截图稳，也不依赖录屏权限。
		if ProcessInfo.processInfo.environment["AGENT_COMPUTER_LOG_LAYOUT"] == "1" {
			DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
				let cards = permissions.arrangedSubviews.map { "\($0.frame)" }.joined(separator: " ")
				Log.write(
					"layout: content=\(content.frame) stack=\(stack.frame) header=\(header.frame) "
						+ "permissions=\(permissions.frame) status=\(status.frame) footer=\(footer.frame) cards=[\(cards)]"
				)
			}
		}
		return window
	}

	/// 卡片底色：浅色下纯白、深色下白色 6% 叠加。
	///
	/// 为什么不用 `controlBackgroundColor`：这个窗口（透明标题栏 + 材质）里它会解析成偏灰的
	/// 中间色，卡片和窗口底几乎糊在一起（用户 2026-11-26：「背景换个专业点的」）。
	private func surfaceColor() -> NSColor {
		let dark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
		return dark ? NSColor.white.withAlphaComponent(0.06) : NSColor.white
	}

	/// 版本号：只认 `Info.plist`（打包后由 electron-builder / build-app.sh 写进去）
	private func version() -> String {
		(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
	}

	/// 标题右边那枚 `v0.5.0` 小徽标
	private func versionBadge() -> NSView {
		let label = NSTextField(labelWithString: "v\(version())")
		label.font = .monospacedDigitSystemFont(ofSize: 10, weight: .medium)
		label.textColor = .secondaryLabelColor

		let box = NSView()
		box.wantsLayer = true
		box.layer?.backgroundColor = surfaceColor().cgColor
		box.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.55).cgColor
		box.layer?.borderWidth = 1
		box.layer?.cornerRadius = 9
		label.translatesAutoresizingMaskIntoConstraints = false
		box.addSubview(label)
		NSLayoutConstraint.activate([
			label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 8),
			label.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -8),
			label.centerYAnchor.constraint(equalTo: box.centerYAnchor),
			box.heightAnchor.constraint(equalToConstant: 19),
		])
		return box
	}

	/// 把一行装进圆角卡片里（带内边距）
	///
	/// 底色用 `controlBackgroundColor`（浅色 = 白，深色 = 深灰）+ `separatorColor` 细描边：
	/// 这才是 macOS 设置类界面的标准做法。原来那版是「quaternaryLabelColor 叠透明度」，
	/// 在带壁纸色调的窗口底上会泛成暖褐灰，用户 2026-11-26 直接说「换个专业点的」。
	private func card(_ content: NSView) -> NSView {
		let box = NSView()
		box.wantsLayer = true
		box.layer?.backgroundColor = surfaceColor().cgColor
		box.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.55).cgColor
		box.layer?.borderWidth = 1
		box.layer?.cornerRadius = 8
		content.translatesAutoresizingMaskIntoConstraints = false
		box.addSubview(content)
		NSLayoutConstraint.activate([
			content.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
			content.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -12),
			content.topAnchor.constraint(equalTo: box.topAnchor, constant: 9),
			content.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -9),
		])
		return box
	}


	private func divider() -> NSBox {
		let box = NSBox()
		box.boxType = .separator
		return box
	}

	private func makePermissionRow(name: String, detail: String, action: Selector) -> (view: NSView, status: NSTextField, button: NSButton) {
		let nameLabel = NSTextField(labelWithString: name)
		nameLabel.font = .systemFont(ofSize: 12.5, weight: .medium)
		nameLabel.widthAnchor.constraint(equalToConstant: 70).isActive = true

		let detailLabel = NSTextField(labelWithString: detail)
		detailLabel.font = .systemFont(ofSize: 10.5)
		detailLabel.textColor = .tertiaryLabelColor

		let left = NSStackView(views: [nameLabel, detailLabel])
		left.orientation = .vertical
		left.alignment = .leading
		left.spacing = 2

		let status = NSTextField(labelWithString: "检查中…")
		status.font = .systemFont(ofSize: 11.5)
		status.textColor = .secondaryLabelColor
		// 定宽 + 右对齐：两行的「✓ 已允许」必须落在同一条竖线上，否则切状态时整行会跳
		status.alignment = .right
		status.widthAnchor.constraint(equalToConstant: 62).isActive = true

		let button = NSButton(title: "去授权", target: self, action: action)
		button.bezelStyle = .rounded
		button.controlSize = .small
		button.font = .systemFont(ofSize: 11.5)
		button.widthAnchor.constraint(equalToConstant: 66).isActive = true

		let row = NSStackView(views: [left, NSView(), status, button])
		row.orientation = .horizontal
		row.alignment = .centerY
		row.spacing = 8
		return (row, status, button)
	}

	// MARK: - 动作

	@objc private func grantAccessibility() {
		userWentToSettings = true
		// 顺序很重要：先请求（让 app 出现在列表里），再打开面板
		Permissions.requestAccessibility()
		openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
		refresh()
	}

	@objc private func grantScreenRecording() {
		userWentToSettings = true
		Permissions.requestScreenRecording()
		openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
		refresh()
	}

	/// 按钮在「已就绪」后变成「完成」，点它直接关窗；否则只是重新检测
	@objc private func donePressed() {
		Log.write("donePressed()：accessibility=\(Permissions.accessibilityGranted()) screen=\(Permissions.screenRecordingGranted())")
		if Permissions.accessibilityGranted() && Permissions.screenRecordingGranted() {
			Log.write("donePressed：收窗")
			window?.orderOut(nil)
			return
		}
		if Permissions.accessibilityGranted() {
			// 屏幕录制授权后必须重启进程才生效
			restartHelper()
			return
		}
		refresh()
	}

	@objc private func dismiss() {
		Log.write("dismiss()：用户点稍后")
		markDismissed()
		window?.orderOut(nil)
	}

	@objc private func refresh() {
		let accessibility = Permissions.accessibilityGranted()
		let screen = Permissions.screenRecordingGranted()

		accessibilityLabel?.stringValue = accessibility ? "✓ 已允许" : "✗ 未允许"
		accessibilityLabel?.textColor = accessibility ? .systemGreen : .systemOrange
		screenLabel?.stringValue = screen ? "✓ 已允许" : "✗ 未允许"
		screenLabel?.textColor = screen ? .systemGreen : .systemOrange
		// 已经授权的那一项不再显示「去授权」——留着只会让人以为还有事要做
		accessibilityButton?.isHidden = accessibility
		screenButton?.isHidden = screen

		// 状态行：没齐就报「还差 N 步」（N = 缺几项权限），齐了报「已就绪」。
		// 2026-11-26 用户：字号要大、颜色要红，一眼能看出还卡着事。
		// 文案不再解释「为什么」——权限卡自己写着要什么，这句只报数。
		let missing = (accessibility ? 0 : 1) + (screen ? 0 : 1)
		if missing > 0 {
			statusLabel?.stringValue = "还差 \(missing) 步才会生效"
			statusLabel?.font = .systemFont(ofSize: 15, weight: .bold)
			statusLabel?.textColor = .systemRed
		}
		if accessibility && screen {
			statusLabel?.stringValue = "已就绪，可以开始操作了。"
			statusLabel?.font = .systemFont(ofSize: 15, weight: .bold)
			statusLabel?.textColor = .systemGreen
			doneButton?.title = "完成"
			// 只对「看着它变成已允许」的那种收窗：留 1.5s 让用户看清绿勾再收起。
			// 打开时就已经就绪（菜单里点进来的）就停在窗口上，等用户自己关。
			guard !readyWhenShown, userWentToSettings else { return }
			if grantedAt == nil { grantedAt = Date() }
			// 让用户看见「已允许」再自动关掉，不要一闪而过
			if let grantedAt, Date().timeIntervalSince(grantedAt) > 1.5 {
				Log.write("自动收窗：grantedAt=+\(String(format: "%.2f", Date().timeIntervalSince(grantedAt)))s readyWhenShown=\(readyWhenShown)")
				window?.orderOut(nil)
			}
		} else if accessibility {
			// 屏幕录制授权后必须重启进程才生效 —— 按钮直接做成「重启」，不用用户自己去找
			doneButton?.title = "重启"
		} else {
			doneButton?.title = "已授权，重新检测"
		}
	}

	private func startPolling() {
		timer?.invalidate()
		timer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
			guard let self else { return }
			self.refresh()
			if self.window?.isVisible != true {
				if self.window != nil, !self.loggedInvisible {
					self.loggedInvisible = true
					Log.write(
						"窗口变成不可见：isVisible=\(self.window?.isVisible ?? false) mini=\(self.window?.isMiniaturized ?? false) "
							+ "onActiveSpace=\(self.window?.isOnActiveSpace ?? false) keys=\(self.window?.isKeyWindow ?? false)"
					)
				}
				self.timer?.invalidate()
				self.timer = nil
			}
		}
	}

	/// 屏幕录制授权后必须重启进程才生效
	func restartHelper() {
		let bundle = Bundle.main
		if bundle.bundleIdentifier != nil {
			let process = Process()
			process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
			process.arguments = ["-a", bundle.bundlePath]
			try? process.run()
		} else {
			let process = Process()
			process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
			try? process.run()
		}
		exit(0)
	}

	private func openSettings(_ target: String) {
		guard let url = URL(string: target) else { return }
		NSWorkspace.shared.open(url)
	}

	func windowWillClose(_ notification: Notification) {
		Log.write("windowWillClose()")
		timer?.invalidate()
		timer = nil
	}
}
