#!/usr/bin/env node
/**
 * 下载一份官方 Node 运行时到 `node-runtime/`，供 electron-builder 打进安装包（ADR-0053 §2）。
 *
 * 为什么要带一份：工作台用到 Node 22 才有的 API（`node:zlib` 的 zstd 解码是硬依赖），
 * 而 Electron 自带的是 20.18 —— 直接用它起服务会秒崩。
 *
 * 但**不是非带不可**：壳启动时会挨个实测候选 node（内置 → `~/.pop-agent/node` →
 * PATH 里用户自己的 → Electron 自带），哪个能跑用哪个。所以：
 *   - 想让用户「下载即用、机器上没有 node 也行」→ 跑这个脚本，包里带一份；
 *   - 想省 ~50MB（用户基本都有 node 22+）→ 不跑，包就小。
 *
 * 只下**当前平台/架构**那一份（不出 universal，理由见 electron-builder.yml）。
 * 校验 sha256（拿 SHASUMS256.txt），失败就退出码非 0 —— 打包流水线里要能卡住。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/** 官方版本：与 engines 要求的 ≥22.19 对齐，取 22 线最新 */
const NODE_VERSION = process.env.POP_AGENT_NODE_VERSION ?? "v22.22.0";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "node-runtime");
const MIRROR = (process.env.NODE_MIRROR ?? "https://nodejs.org/dist").replace(/\/+$/, "");

/**
 * 目标平台/架构：**默认宿主，可用参数覆盖**（2026-11-24 加）。
 *
 * 为什么需要覆盖：交叉出包（在 mac 上打 Windows 包）时，运行时必须是**目标**那一份 ——
 * 用宿主的 darwin 运行时装进 Windows 包，用户双击就是「服务起不来」。
 *   node scripts/fetch-node-runtime.mjs --platform win --arch x64
 * 平台名照 Node 官方发行包的写法：darwin / win / linux（`win` 不是 `win32`）。
 */
function platformTriple(argv = process.argv.slice(2), env = process.env) {
	const flag = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const rawPlatform = flag("--platform") ?? env.POP_AGENT_NODE_PLATFORM ?? process.platform;
	const rawArch = flag("--arch") ?? env.POP_AGENT_NODE_ARCH ?? process.arch;
	const platform = rawPlatform === "win32" ? "win" : rawPlatform === "darwin" || rawPlatform === "linux" ? rawPlatform : rawPlatform;
	const arch = rawArch === "arm64" ? "arm64" : rawArch === "x64" || rawArch === "x86_64" ? "x64" : rawArch;
	return { platform, arch };
}

async function fetchText(url) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`下载失败 ${url}：HTTP ${response.status}`);
	return response.text();
}

async function fetchBuffer(url) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`下载失败 ${url}：HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

async function main() {
	const { platform, arch } = platformTriple();
	const base = `node-${NODE_VERSION}-${platform}-${arch}`;
	const archive = platform === "win" ? `${base}.zip` : `${base}.tar.gz`;
	const url = `${MIRROR}/${NODE_VERSION}/${archive}`;
	console.log(`[runtime] 目标 ${platform}-${arch}，Node ${NODE_VERSION}`);
	console.log(`[runtime] 下载 ${url}`);

	// 1) 校验和：官方 SHASUMS256.txt 里挑这一行
	const sums = await fetchText(`${MIRROR}/${NODE_VERSION}/SHASUMS256.txt`);
	const expected = sums
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.find((parts) => parts[1] === archive)?.[0];
	if (!expected) throw new Error(`SHASUMS256.txt 里没有 ${archive}`);

	// 2) 下载 + 校验（不校验的话，一个坏包会以「运行时报错」的形式出现在用户机器上）
	const buffer = await fetchBuffer(url);
	const actual = createHash("sha256").update(buffer).digest("hex");
	if (actual !== expected) throw new Error(`sha256 不匹配：期望 ${expected}，实际 ${actual}`);
	console.log(`[runtime] sha256 校验通过（${actual.slice(0, 12)}…）`);

	// 3) 解包 → 摊平成 node-runtime/{bin/node | node.exe}
	const tmpDir = join(ROOT, ".tmp-node-runtime");
	rmSync(tmpDir, { recursive: true, force: true });
	mkdirSync(tmpDir, { recursive: true });
	const archivePath = join(tmpDir, archive);
	writeFileSync(archivePath, buffer);
	// Windows 10+ 自带 bsdtar，能直接解 zip；POSIX 上 tar 本来就有
	const tar = spawnSync("tar", ["-xf", archivePath, "-C", tmpDir], { stdio: "inherit" });
	if (tar.status !== 0) throw new Error("解包失败（需要系统里有 tar；Windows 10+ 自带）");

	rmSync(TARGET, { recursive: true, force: true });
	const extracted = join(tmpDir, base);
	const moved = spawnSync("mv", [extracted, TARGET], { stdio: "inherit" });
	if (moved.status !== 0) throw new Error("移动到 node-runtime 失败");
	rmSync(tmpDir, { recursive: true, force: true });

	const nodeBin = platform === "win" ? join(TARGET, "node.exe") : join(TARGET, "bin", "node");
	if (!existsSync(nodeBin)) throw new Error(`装完了但没找到 ${nodeBin}`);

	// 4) 瘦身：`include/` 是给 node-gyp 编译原生模块用的 C 头文件（64MB），我们不在用户机器上编译；
	//    文档类文件同理。保留 bin/{node,npm,npx} 与 lib/node_modules/npm —— MCP 靠 npx 起。
	for (const extra of ["include", "share", "CHANGELOG.md", "README.md", "LICENSE"]) {
		rmSync(join(TARGET, extra), { recursive: true, force: true });
	}
	console.log(`[runtime] 完成：${nodeBin}`);
}

main().catch((error) => {
	console.error(`[runtime] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
