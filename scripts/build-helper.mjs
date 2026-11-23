#!/usr/bin/env node
/**
 * 打包前编译**内嵌的电脑控制 helper**（macOS）。
 *
 * 为什么要单独一步：helper 从「另一个要单独安装的 App」改成「PopAgent.app 里的一个二进制」之后，
 * 它必须是**构建产物**才能被 electron-builder 打进 `Resources/helper/agent-computer/`。
 * 而那个产物目录在 `.gitignore` 里（`release/`），干净 clone 里根本没有二进制 ——
 * 直接 `npm run app:dist` 会打出一个「电脑控制用不了」的包，而且**不会报错**（这才是最坑的）。
 * 所以 `app:dist` 先跑这一步。
 *
 * 只有 macOS：Windows 版电脑控制**还没做**（2026-11-24 用户决定先不做，界面上显示「敬请期待」），
 * 所以非 darwin 平台直接跳过，也不为此引入 dotnet 之类的新工具链。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_DIR = join(ROOT, "helper", "agent-computer");
const RELEASE_DIR = join(HELPER_DIR, "release");

/**
 * 电脑控制 helper 目前**只有 macOS 实现**（Swift + AppKit + Accessibility + ScreenCaptureKit）。
 *
 * Windows 版还没做（2026-11-24 用户决定：先不做 Windows 的电脑控制，界面上显示「敬请期待」）。
 * 所以这里不再尝试编 Windows 二进制，也不该让 macOS 打包因为「找不到 dotnet」而报错 ——
 * 非 darwin 平台直接跳过，只把目录建出来（electron-builder 的 `extraResources.from`
 * 指向不存在的目录会失败；而 macOS 包本来就不该带 exe）。
 */
if (process.platform !== "darwin") {
	console.log(`[helper] 跳过：电脑控制 helper 目前只有 macOS 实现（当前 ${process.platform}）`);
	process.exit(0);
}

if (!existsSync(join(HELPER_DIR, "Package.swift"))) {
	console.error(`[helper] 找不到 helper 源码：${HELPER_DIR}`);
	process.exit(1);
}

console.log("[helper] 编译内嵌电脑控制 helper（swift build -c release）");
const result = spawnSync("sh", [join(HELPER_DIR, "scripts", "build-app.sh")], {
	cwd: ROOT,
	stdio: "inherit",
});
if (result.status !== 0) {
	console.error(`[helper] 编译失败（退出码 ${result.status ?? "null"}）—— 这个包里的「电脑控制」会是坏的，先修好再打包`);
	process.exit(1);
}

const binary = join(RELEASE_DIR, "agent-computer");
if (!existsSync(binary)) {
	console.error(`[helper] 编译结束但没找到二进制：${binary}`);
	process.exit(1);
}
console.log(`[helper] macOS 内嵌二进制就绪：${binary}`);
