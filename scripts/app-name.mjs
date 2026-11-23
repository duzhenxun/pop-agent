/**
 * 把**开发态**那个 Electron 壳改名成产品名（Dock / 菜单栏 / 切换器里都显示 PopAgent）。
 *
 * 为什么需要动到「包名」而不是只改 plist：
 *   - 菜单栏顶部那个加粗名字来自 `Info.plist` 的 `CFBundleName` / `CFBundleDisplayName`；
 *   - **Dock 图标下面的名字取的是 .app 包本身的名字**（`Electron.app` → "Electron"）。
 *     实测：只改 plist、甚至 `killall Dock` 都还是 Electron；把整个包改名成 `PopAgent.app`
 *     之后立刻变成 PopAgent。所以这里两件事都做。
 *
 * 改的是 `node_modules/electron/dist`（`npm i` 会覆盖回去），所以 `npm run app` /
 * `npm run app:dev` 启动前都会跑一遍；幂等，已经改好就直接退出。
 * 打包版不受影响：`electron-builder.yml` 里 `productName: PopAgent`。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRAND_NAME = "PopAgent";
const BUNDLE_ID = "com.popagent.app";

const ELECTRON_PKG = join(ROOT, "node_modules", "electron");
const DIST_DIR = join(ELECTRON_PKG, "dist");
/**
 * 版本号：**本仓 package.json 那一份**（唯一来源，服务端 `server/util/version.ts` 读的也是它）。
 *
 * 为什么在这里改：开发态跑的壳是 Electron 自己的 `.app` 改名的，`Info.plist` 里
 * `CFBundleShortVersionString` / `CFBundleVersion` 还是 Electron 的版本 ——
 * 于是「关于 PopAgent」面板写出「版本 33.4.11 (33.4.11)」（用户 2026-11-24 报的）。
 * 打包版由 electron-builder 按 package.json 写，本来是对的；这里补上开发态这一份。
 */
const PKG_VERSION = (() => {
	try {
		const parsed = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		return typeof parsed.version === "string" ? parsed.version.trim() : "";
	} catch {
		return "";
	}
})();

const ELECTRON_APP = join(DIST_DIR, "Electron.app");
const BRAND_APP = join(DIST_DIR, `${BRAND_NAME}.app`);
const PATH_FILE = join(ELECTRON_PKG, "path.txt");
/** `path.txt` 里记的是「相对 dist 的可执行文件路径」，electron 的 index.js 靠它找二进制 */
const BRAND_ENTRY = `${BRAND_NAME}.app/Contents/MacOS/${BRAND_NAME}`;

if (process.platform !== "darwin") {
	// 只有 macOS 需要这层改名；其它平台菜单栏/程序坞不露包名
	process.exit(0);
}
if (!existsSync(DIST_DIR)) {
	// 还没装 electron（只装了运行依赖）：什么也不做，别把 npm run 弄失败
	process.exit(0);
}

let changed = false;

// 1) 包名：Electron.app → PopAgent.app（只在不冲突时重命名）
if (existsSync(ELECTRON_APP) && !existsSync(BRAND_APP)) {
	renameSync(ELECTRON_APP, BRAND_APP);
	changed = true;
}
if (!existsSync(BRAND_APP)) process.exit(0);

// 2) 可执行文件：Contents/MacOS/Electron → Contents/MacOS/PopAgent
const macosDir = join(BRAND_APP, "Contents", "MacOS");
const plainBin = join(macosDir, "Electron");
const brandBin = join(macosDir, BRAND_NAME);
if (existsSync(plainBin) && !existsSync(brandBin)) {
	copyFileSync(plainBin, brandBin);
	changed = true;
}

// 3) Info.plist：名字 / 显示名 / 标识 / 可执行名
const plistPath = join(BRAND_APP, "Contents", "Info.plist");
const wanted = {
	CFBundleName: BRAND_NAME,
	CFBundleDisplayName: BRAND_NAME,
	CFBundleExecutable: BRAND_NAME,
	CFBundleIdentifier: BUNDLE_ID,
	// 版本：主版本号 + 构建号都用 package.json 的 version（读不到就留原值不动）
	...(PKG_VERSION ? { CFBundleShortVersionString: PKG_VERSION, CFBundleVersion: PKG_VERSION } : {}),
};
const readKey = (key) => {
	try {
		return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plistPath], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};
for (const [key, value] of Object.entries(wanted)) {
	if (readKey(key) === value) continue;
	try {
		execFileSync("plutil", ["-replace", key, "-string", value, plistPath]);
		changed = true;
	} catch (error) {
		console.warn(`[app-name] 改 ${key} 失败（不影响运行）：${error instanceof Error ? error.message : String(error)}`);
	}
}

// 4) path.txt：让 `node_modules/.bin/electron` 指向新包里的二进制
const currentEntry = existsSync(PATH_FILE) ? readFileSync(PATH_FILE, "utf8").trim() : "";
if (currentEntry !== BRAND_ENTRY) {
	writeFileSync(PATH_FILE, BRAND_ENTRY);
	changed = true;
}

// 4.5) 包里的 .icns 也换成我们的图标（FKinder / Cmd-Tab / Dock 未启动前用的就是它）
//      源是 `web/public/icons/icon-{32,192,512,1024}.png`（npm run icons 生成），
//      这里按 .iconset 规范缩出十档，再用系统自带的 iconutil 打包。
const ICONS_DIR = join(ROOT, "web", "public", "icons");
const resourceDir = join(BRAND_APP, "Contents", "Resources");
const icnsPath = join(resourceDir, "PopAgent.icns");
const sourcePng = join(ICONS_DIR, "icon-512.png");
if (existsSync(sourcePng) && (!existsSync(icnsPath) || statSync(sourcePng).mtimeMs > statSync(icnsPath).mtimeMs)) {
	const iconset = join(tmpdir(), `PopAgent-${process.pid}.iconset`);
	const plan = [
		["icon_16x16.png", 16],
		["icon_16x16@2x.png", 32],
		["icon_32x32.png", 32],
		["icon_32x32@2x.png", 64],
		["icon_128x128.png", 128],
		["icon_128x128@2x.png", 256],
		["icon_256x256.png", 256],
		["icon_256x256@2x.png", 512],
		["icon_512x512.png", 512],
		["icon_512x512@2x.png", 1024],
	];
	try {
		mkdirSync(iconset, { recursive: true });
		for (const [name, size] of plan) {
			// 优先用最接近且不小于目标尺寸的源图，避免放大糊掉
			const src = [1024, 512, 192, 32].map((n) => join(ICONS_DIR, `icon-${n}.png`)).find((p) => existsSync(p));
			const from = existsSync(join(ICONS_DIR, "icon-1024.png")) && size > 512 ? join(ICONS_DIR, "icon-1024.png") : src;
			execFileSync("sips", ["-z", String(size), String(size), from, "--out", join(iconset, name)], { stdio: "ignore" });
		}
		execFileSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath], { stdio: "ignore" });
		execFileSync("plutil", ["-replace", "CFBundleIconFile", "-string", "PopAgent", plistPath]);
		changed = true;
	} catch (error) {
		console.warn(`[app-name] 生成 .icns 失败（Dock 仍会用运行时 setIcon 的那张）：${error instanceof Error ? error.message : String(error)}`);
	} finally {
		rmSync(iconset, { recursive: true, force: true });
	}
}

// 5) 让 LaunchServices 重新登记（否则 Dock / 切换器可能还认旧包）
try {
	execFileSync(
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
		["-f", BRAND_APP],
	);
} catch {
	/* 忽略：登记不上只影响图标/名字的刷新时机 */
}
try {
	execFileSync("touch", [BRAND_APP]);
} catch {
	/* 忽略 */
}

console.log(
	changed
		? `[app-name] 开发态壳已改名为 ${BRAND_NAME}（Dock / 菜单栏 / 切换器）`
		: `[app-name] 开发态壳已经是 ${BRAND_NAME}，无需改动`,
);
