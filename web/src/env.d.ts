/**
 * 前端全局类型补充。
 * 注意：这里刻意不引 `vite/client`（vite 尚未安装），
 * 只声明本项目真正用到的资源模块类型。
 */

declare module "*.css";
declare module "*.svg" {
	const src: string;
	export default src;
}
/** 预生成的状态语音片段，按 `?url` 当静态资源引入（见 assets/cues 与 scripts/make-voice-cues.mjs） */
declare module "*.mp3?url" {
	const src: string;
	export default src;
}

/**
 * 桌面壳注入的唯一一个能力（见 `electron/preload.ts`）：把拖进来的 `File` 换成真实路径。
 * 浏览器 / 远程访问时这个对象不存在 —— 调用方一律 `?.`，拿不到就退回「上传字节」那条老路。
 */
declare global {
	interface Window {
		popAgentFiles?: { pathOf?: (file: File) => string };
	}
}
