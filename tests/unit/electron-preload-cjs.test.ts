/**
 * 桌面壳的 preload 必须是 **CJS**（实测踩过，用户 2026-11-26：「文件拖进对话框，发送时没有发路径」）。
 *
 * 现场：`electron/preload.ts` 编出来的 `preload.js` 是 ESM（仓库 package.json 是 `type: module`），
 * 而那个窗口是 `sandbox: true` —— 沙箱里的 preload 按 CJS 求值，于是
 * `SyntaxError: Cannot use import statement outside a module`，整个 preload 被丢弃：
 * `window.popAgentFiles` 不存在，拖文件静默退回「上传副本」，看起来就是「没发路径」。
 *
 * 实测（electron 33，`sandbox: true` + `type: module`）：
 *   preload.js（ESM） → Unable to load preload script / pathOf = undefined
 *   preload.cjs（CJS） → pathOf = function，且 `webUtils.getPathForFile` 在沙箱里可用
 *
 * 所以这里把「源码叫 .cts、产物叫 .cjs、壳指向 .cjs、tsconfig 收 .cts」四件事焊在一起。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const preloadCts = new URL("../../electron/preload.cts", import.meta.url);
const preloadTs = new URL("../../electron/preload.ts", import.meta.url);
const main = readFileSync(new URL("../../electron/main.ts", import.meta.url), "utf8");
const tsconfig = readFileSync(new URL("../../electron/tsconfig.json", import.meta.url), "utf8");

describe("桌面壳 preload（沙箱里只能 CJS）", () => {
	it("源码是 .cts（编出 .cjs），不许再出现 ESM 的 preload.ts", () => {
		assert.ok(existsSync(preloadCts), "electron/preload.cts 不见了");
		assert.ok(!existsSync(preloadTs), "electron/preload.ts 会把沙箱 preload 编成 ESM，删掉它");
	});

	it("preload 内容用 require 形状，不用 ESM import", () => {
		const source = readFileSync(preloadCts, "utf8");
		assert.match(source, /import electron = require\("electron"\)/);
		assert.doesNotMatch(source, /^\s*import\s*\{[^}]*\}\s*from\s*"electron"/m, "import {…} from 会被编成 ESM");
		assert.match(source, /contextBridge\.exposeInMainWorld\("popAgentFiles"/);
	});

	it("壳指向 .cjs，tsconfig 收 .cts", () => {
		assert.match(main, /new URL\("\.\/preload\.cjs", import\.meta\.url\)/);
		assert.doesNotMatch(main, /new URL\("\.\/preload\.js"/, "指向 .js 会重新变回加载失败");
		assert.match(tsconfig, /"\.\/\*\*\/\*\.cts"/);
	});
});
