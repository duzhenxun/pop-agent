/**
 * 「我是不是跑在桌面壳里」—— 只在需要**跟着壳变布局**的地方用。
 *
 * 为什么必须判断：壳（electron/main.ts）用 `titleBarStyle: "hiddenInset"`，没有系统标题栏，
 * 只有 macOS 那三个红绿灯浮在窗口左上角。于是页面得自己让出那块位置、自己当拖动区；
 * 而在浏览器里这两件事都不该发生（否则顶栏会凭空多出 76px 空白，还把文字选择弄坏）。
 *
 * 判定方式：壳里 `navigator.userAgent` 一定带 `Electron/<version>`（Electron 行为，与
 * `app.commandLine` 无关）。刻意**不用** preload/IPC 传标记 —— 壳的设计就是零 IPC
 * （ADR-0053：不给渲染进程开任何特权通道），为一行样式加一条通道不划算。
 *
 * 为什么挂在 `<html data-shell>` 上而不是 body：和其它全局开关（`data-theme`、
 * `is-mobile-shell`）同一个位置，CSS 也好写；而且首帧之前就能生效，不会先闪一下错位。
 *
 * 三个取值：
 *   - 不存在 → 浏览器（默认形态）
 *   - `electron-mac` → macOS 壳（红绿灯 + 拖动区）
 *   - `electron` → Windows / Linux 壳（系统还给着标题栏，不需要让位）
 */
export function initShell(): void {
	const ua = navigator.userAgent;
	if (!ua.includes("Electron/")) return;
	// UA 里 mac 的写法是 "Macintosh; Intel Mac OS X 10_15_7"（Apple Silicon 也一样写 Intel）
	const mac = /Macintosh|Mac OS X/.test(ua);
	document.documentElement.dataset.shell = mac ? "electron-mac" : "electron";
}

/** 供 JS 里需要按壳分支的地方用（现在只有 CSS 用得上，留着免得各处自己写 UA 判断） */
export function isElectronShell(): boolean {
	return (document.documentElement.dataset.shell ?? "").startsWith("electron");
}
