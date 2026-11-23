#!/usr/bin/env node
/**
 * 打包前的准备：生成一份**只有生产依赖**的 node_modules（ADR-0053 §6）。
 *
 * 为什么要单独一份：服务是 spawn 出去的独立 node 进程，它得从 `resources/node_modules`
 * 往上找到 express / pi / node-pty；而仓库自己的 `node_modules` 里躺着一整套 devDependencies
 * （vite / react / typescript / electron…），直接拷进安装包等于白送 100MB+。
 *
 * 做法：在 `.pkg/` 里放一份 package.json + package-lock.json（+ .npmrc，让 electron 之外
 * 该跑的脚本照跑），对那个目录 `npm ci --omit=dev`。**不动仓库自己的 node_modules** ——
 * 打包之后开发环境照样能用。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(ROOT, ".pkg");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} 失败（退出码 ${result.status}）`);
	}
}

console.log("[pkg] 准备生产依赖到 .pkg/node_modules");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const file of ["package.json", "package-lock.json", ".npmrc"]) {
	if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(STAGE, file));
}

/**
 * 环境里那个 `npm_config_allow_scripts` 会让**项目内**安装直接报 EALLOWSCRIPTS
 * （npm 认为命令行参数只该用于全局/npx）。这里清掉它，让 `.pkg/.npmrc` 说了算。
 */
const env = { ...process.env };
delete env.npm_config_allow_scripts;
run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--prefix", STAGE], { env });

/**
 * 裁掉运行时用不到的东西（实测省 ~50MB，直接决定安装包能不能小一档）。
 *
 * 一条铁律：**只删「打包产物/类型声明」这类绝不参与运行的东西**。
 *
 * 教训（2026-11-23 实测）：第一版连 `doc/`、`test/`、`*.md` 一起删，结果服务直接起不来 ——
 * `yaml` 包里有个 `doc/` 目录是**真代码**（`require("../doc/directives.js")`），
 * pi 也可能在运行时读自己的 `.md` 模板。所以现在只删：
 *   - `.map`（sourcemap，29MB）
 *   - `.d.ts` / `.d.mts`（类型声明，15MB）
 *   - `.tsbuildinfo` 与几个工具配置文件（几十字节 × N）
 * 目录一个都不动 —— 省下来的 4MB 不值得拿「服务起不来」去换。
 */
const PRUNE_FILE_PATTERNS = [/\.map$/i, /\.d\.ts$/i, /\.d\.mts$/i, /\.tsbuildinfo$/i];
const PRUNE_FILE_NAMES = new Set([
	"tsconfig.json",
	".eslintrc",
	".eslintrc.json",
	".eslintrc.js",
	".prettierrc",
	".prettierrc.json",
	".editorconfig",
	".npmignore",
	".gitignore",
	".travis.yml",
	"appveyor.yml",
	".nycrc",
	".nycrc.json",
]);
function pruneModuleTree(dir, removed) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			pruneModuleTree(full, removed);
			continue;
		}
		if (!entry.isFile()) continue;
		// LICENSE / 版权文件不删：分包时要带着
		if (/^licen[cs]e/i.test(entry.name) || /^notice/i.test(entry.name)) continue;
		if (PRUNE_FILE_NAMES.has(entry.name) || PRUNE_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
			try {
				const size = statSync(full).size;
				rmSync(full, { force: true });
				removed.bytes += size;
				removed.count += 1;
			} catch {
				// 删不掉就算了，不值得为此失败
			}
		}
	}
}

/**
 * node-pty 会把**四个平台**的预编译二进制一起发（58MB）。我们按当前平台出包，
 * 其余三个纯属白送 —— 只留当前平台这一份（同一份在 mac arm64/x64 之间也不通用）。
 */
const prebuilds = join(STAGE, "node_modules", "node-pty", "prebuilds");
if (existsSync(prebuilds)) {
	const keep = `${process.platform}-${process.arch}`;
	for (const entry of readdirSync(prebuilds)) {
		if (entry !== keep) rmSync(join(prebuilds, entry), { recursive: true, force: true });
	}
	console.log(`[pkg] node-pty 只保留 ${keep}`);
}

/** 报错要能看懂：生产依赖缺哪个，打出来的包就会在用户机器上起不来 */
const removed = { bytes: 0, count: 0 };
pruneModuleTree(join(STAGE, "node_modules"), removed);
console.log(
	`[pkg] 裁掉 sourcemap / 类型 / 文档 / 测试：${(removed.bytes / 1048576).toFixed(1)}MB（${removed.count} 个文件）`,
);

for (const required of ["express", "ws", "node-pty", "@earendil-works/pi-coding-agent"]) {
	if (!existsSync(join(STAGE, "node_modules", required))) {
		throw new Error(`生产依赖里缺 ${required} —— 打出来的包会起不来`);
	}
}
/**
 * 最后一道闸：**用裁完的依赖真起一次服务**。
 *
 * 这一步是加了血泪的（见上面 `doc/` 的教训）：裁剪类的 bug 在打包时完全看不出来，
 * 只有用户双击时才变成「窗口开了、服务没起」。这里按打包后的布局（dist + web/dist +
 * node_modules 三者同级）跑一遍，看到 ready 行才算过 —— 20 秒的代价换掉一整类事故。
 */
cpSync(join(ROOT, "dist"), join(STAGE, "dist"), { recursive: true });
mkdirSync(join(STAGE, "web"), { recursive: true });
cpSync(join(ROOT, "web", "dist"), join(STAGE, "web", "dist"), { recursive: true });

const smokePort = 25199;
const smoke = spawnSync(process.execPath, [join(STAGE, "dist", "server", "cli.js")], {
	env: {
		...process.env,
		POP_AGENT_APP: "1",
		POP_AGENT_WEB_DIST: join(STAGE, "web", "dist"),
		POP_AGENT_PORT: String(smokePort),
		POP_AGENT_DATA_DIR: join(STAGE, ".smoke-data"),
		POP_AGENT_CWD: join(STAGE, ".smoke-data"),
		POP_AGENT_UPDATE_CHECK: "off",
	},
	timeout: 60_000,
	encoding: "utf8",
});
const smokeOutput = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`;
rmSync(join(STAGE, ".smoke-data"), { recursive: true, force: true });
if (!smokeOutput.includes("__POP_AGENT_READY__")) {
	throw new Error(`裁剪后的依赖起不来服务（这包发出去就是「窗口开了、服务没起」）：\n${smokeOutput.slice(-1200)}`);
}
console.log("[pkg] 自检通过：裁完的依赖能起服务");
console.log("[pkg] 完成：.pkg/{node_modules,dist,web}");
