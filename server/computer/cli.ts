#!/usr/bin/env node
/**
 * 薄壳：电脑控制的命令一律交给 **App 里的 `agent-computer`** 去执行。
 *
 * 真正的实现在 `Agent Computer.app/Contents/MacOS/agent-computer`（Swift，随 App 分发，
 * 不需要 node）：同一套 turbo-1 协议、同样的一行 JSON 输出。这里只做三件事：
 *   1. 找到那个可执行文件（`/Applications/Agent Computer.app/...`，可用 `AGENT_COMPUTER_CLI` 覆盖）；
 *   2. 原样把 argv 交给它，stdio 直通（JSON 一行一行出去，退出码照搬）；
 *   3. 找不到 App 时按同样的 JSON 形状报错，并给出下载地址。
 *
 * 为什么不再自己实现一份：CLI 已经跟着 App 走了（装一个 App 就够），这份再实现一遍
 * 就等于两个维护点 —— 协议、参数、错误名任何一处改动都要改两遍，早就会漂。
 *
 * 保留 `parseCommandPath` 导出：面板与单测用到这个纯函数，App 里那份是同语义实现。
 */
import { spawnSync } from "node:child_process";
import { appCliPath, helperDownloadUrl } from "./paths.js";

/** 菜单路径：支持 `文件 ▸ 存储`、`File > Save`、`File → Save` */
export function parseCommandPath(text: string): string[] {
	const parts = text.includes("▸") ? text.split("▸") : text.split(/\s+>\s+|\s*→\s*/);
	const path = parts.map((p) => p.trim()).filter(Boolean);
	if (path.length < 2) {
		throw new Error(`「${text}」不是菜单路径，请写成「菜单 ▸ 命令」，可先用 commands 查看`);
	}
	if (path.length > 8) throw new Error("菜单路径最多 8 级");
	return path;
}

function fail(name: string, message: string): never {
	process.stdout.write(`${JSON.stringify({ ok: false, error: { name, message, retryable: false } })}\n`);
	process.exit(1);
}

function main(argv: string[]): void {
	const cli = appCliPath();
	if (!cli) {
		fail(
			"helperMissing",
			`没找到 Agent Computer.app（在 /Applications 或 ~/Applications 下），先从 ${helperDownloadUrl()} 装一个`,
		);
	}
	const result = spawnSync(cli, argv, { stdio: "inherit" });
	if (result.error) fail("cliError", `执行 ${cli} 失败：${result.error.message}`);
	process.exit(result.status ?? 1);
}

// 仅作为入口运行时才执行（被 import 做单测时不执行）
const entry = process.argv[1];
if (entry !== undefined && /cli\.(c|m)?(j|t)s$/.test(entry)) main(process.argv.slice(2));
