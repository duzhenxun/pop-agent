/**
 * STT provider 注册表。
 *
 * 加一家厂商 = 新建一个文件实现 `SttProvider`，然后在 `PROVIDERS` 里加一行。
 * `server/asr/bridge.ts` 完全不需要动 —— 它只调用这里的 `createSession()`。
 *
 * 现有：
 *   · `openai-compatible` —— `/v1/audio/transcriptions` 形状（Whisper 及大量网关）
 *
 * 想加火山豆包 / 阿里千问：
 *   1. 新建 `server/stt/volcengine.ts`，实现 `SttProvider`（签名/WebSocket 都在里面自己处理）
 *   2. 在下面 `PROVIDERS` 数组里加进去
 *   3. `~/.pop-agent/stt.json` 把 `provider` 改成它的 `id`
 * 表单字段用 `fields` 声明，将来做 UI 直接读它，不用再改前端。
 */
import { openaiCompatible } from "./openai.js";
import type { SttConfig, SttLogger, SttProvider, SttSession } from "./types.js";

const PROVIDERS: SttProvider[] = [openaiCompatible];

export function listSttProviders(): SttProvider[] {
	return [...PROVIDERS];
}

export function getSttProvider(id: string): SttProvider | null {
	return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** 按配置建一个会话；provider 不认识时抛错（调用方退回本地识别） */
export function createSttSession(config: SttConfig, log: SttLogger): SttSession {
	const provider = getSttProvider(config.provider);
	if (!provider) {
		throw new Error(
			`未知的 STT provider：${config.provider}（可用：${PROVIDERS.map((entry) => entry.id).join("、")}）`,
		);
	}
	return provider.create(config, log);
}

export type { SttConfig, SttSession };
