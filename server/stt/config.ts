/**
 * 云端 STT 的配置读取。
 *
 * 两种来源，环境变量优先（方便临时切换 / 容器里注入）：
 *   1. `~/.pop-agent/stt.json`（或 `POP_AGENT_STT_CONFIG` 指定的文件）
 *   2. `POP_AGENT_STT_PROVIDER` / `_ENDPOINT` / `_KEY` / `_MODEL` / `_LANGUAGE`
 *
 * 没配（或缺 provider/endpoint）= 继续用本地识别，不报错 —— 这是默认状态。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SttConfig } from "./types.js";

const FILE_NAME = "stt.json";

export function sttConfigPath(dataDir?: string): string {
	const override = process.env.POP_AGENT_STT_CONFIG?.trim();
	if (override) return override;
	return join(dataDir ?? join(homedir(), ".pop-agent"), FILE_NAME);
}

function envOverrides(): Partial<SttConfig> {
	const pick = (name: string) => process.env[name]?.trim() || undefined;
	const overrides: Partial<SttConfig> = {
		provider: pick("POP_AGENT_STT_PROVIDER"),
		endpoint: pick("POP_AGENT_STT_ENDPOINT"),
		apiKey: pick("POP_AGENT_STT_KEY"),
		model: pick("POP_AGENT_STT_MODEL"),
		language: pick("POP_AGENT_STT_LANGUAGE"),
	};
	// 把 undefined 的键去掉，免得覆盖掉文件里的值
	for (const key of Object.keys(overrides) as Array<keyof SttConfig>) {
		if (overrides[key] === undefined) delete overrides[key];
	}
	return overrides;
}

export type SttConfigRead = {
	/** 配好了才有值；null = 用本地识别 */
	config: SttConfig | null;
	/** 实际读的是哪个文件（日志里说清楚，免得用户改了别的文件） */
	source: string;
	/** 文件存在但读不懂时的原因（不致命，按"没配"处理） */
	error?: string;
};

export function readSttConfig(dataDir?: string): SttConfigRead {
	const source = sttConfigPath(dataDir);
	let fromFile: Partial<SttConfig> = {};
	let error: string | undefined;

	if (existsSync(source)) {
		try {
			const parsed = JSON.parse(readFileSync(source, "utf8")) as unknown;
			if (parsed && typeof parsed === "object") fromFile = parsed as Partial<SttConfig>;
			else error = `${source} 的内容不是 JSON 对象`;
		} catch (cause) {
			error = `${source} 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	const merged = { ...fromFile, ...envOverrides() } as SttConfig;
	if (!merged.provider || !merged.endpoint) {
		return { config: null, source, error };
	}
	return { config: merged, source, error };
}
