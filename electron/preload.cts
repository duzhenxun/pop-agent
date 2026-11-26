/**
 * 渲染进程里唯一需要的一点"本机能力"：把拖进来的 `File` 换成它的**真实路径**。
 *
 * 为什么需要它：把文件/文件夹拖进输入框时，最终要的是那个路径（写进提示词），
 * 而不是字节。但浏览器的 `File` 里没有路径 —— 早年的 `File.path` 是 Electron 的私有补丁，
 * Electron 32+ 已经删掉，官方替代是 `webUtils.getPathForFile(file)`，
 * 而 `webUtils` 只在**有 preload** 的渲染进程里拿得到（见 Electron 文档的 drag & drop 一节）。
 *
 * 三条边界：
 *   1. 只暴露这一个函数：不给 `ipcRenderer`、不开 `nodeIntegration`，渲染层拿不到别的 Node 能力；
 *   2. 拿不到就返回空串：浏览器 / 非 Electron 环境、或者调用方给的不是真 `File`，
 *      统一返回 `""`，由调用方决定怎么降级（现在是退回"上传字节"那条老路）；
 *   3. 这里**不读文件内容**、也不判断存在性 —— 只回答"这个东西在磁盘上的路径是什么"。
 *
 * 为什么文件名是 `.cts`（实测踩过，用户 2026-11-26）：**沙箱里的 preload 只能是 CJS**。
 * 仓库的 package.json 是 `"type": "module"`，`.ts` 编出来的 `.js` 就是 ESM；
 * 而 `sandbox: true` 下 Electron 把 preload 按 CJS 求值 —— 报 `Cannot use import statement
 * outside a module`，整个 preload 被丢弃，`window.popAgentFiles` 根本不存在，
 * 拖文件退回「上传副本」而且**一声不响**（看起来就是「没发路径」的老毛病）。
 * 走 ESM preload 得改名 `.mjs` **并关掉沙箱**（`sandbox: false`）—— 为这一个函数不值。
 * `.cts` 经 tsc（module: NodeNext）会编出 `preload.cjs`，跟 sandbox 正好配套。
 */
/**
 * 用 `import x = require(...)` 而不是 ESM 的 `import {…} from`：
 * `.cts` 在 `verbatimModuleSyntax` 下就是「CJS 文件里不许写 ESM 语法」（tsc 会报 TS1286）。
 * 编出来是 `const electron = require("electron")` —— 正是沙箱 preload 要的形状。
 */
import electron = require("electron");

const { contextBridge, webUtils } = electron;

contextBridge.exposeInMainWorld("popAgentFiles", {
	pathOf: (file: File): string => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
});
