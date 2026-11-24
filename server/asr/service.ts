/**
 * 本地语音识别（macOS 原生 SFSpeechRecognizer，离线）的服务端这一半。
 *
 * 2026-11 合并：原先这里会自己 bind 一个 unix socket、再用
 * `open -n -a ASRBridge.app` 拉起一支独立的桥进程。识别能力现在搬进了
 * Agent Computer helper（`helper/agent-computer`），走它已有的 JSON-RPC：
 *
 *   asr.status → { authorized, locale, onDevice, message }
 *   asr.start  → 触发系统授权 + 建识别器 + 开一句
 *   asr.feed   → 送一块 base64 的 PCM16，返回当前 partial
 *   asr.end    → 结束这句，等 final 落地（超时就用已有结果）
 *   asr.cancel → 丢弃当前这句
 *
 * 对外的 7 个方法（current / latestText / ensureStarted / startUtterance /
 * pushAudio / endUtterance / dispose）和状态机都保持原样 —— 路由层和前端
 * 不需要跟着改语义，只是 `missing` 的含义从「ASRBridge.app 没装」变成
 * 「Agent Computer 没装/没在跑」。
 */
import { existsSync } from "node:fs";
import { HelperClient } from "../computer/helper-client.js";
import { helperBinaryPath, helperTransport, socketPath } from "../computer/paths.js";
import { readSttConfig } from "../stt/config.js";
import { createSttSession } from "../stt/index.js";
import type { SttConfig, SttSession } from "../stt/types.js";

export type AsrState = "missing" | "idle" | "starting" | "authorizing" | "ready" | "error";

export type AsrStatus = {
	state: AsrState;
	/** 给人看的一句话（missing / error 时必填；authorizing 时说明要等什么） */
	message?: string;
	locale?: string;
	onDevice?: boolean;
};

type Logger = { warn: (message: string, ctx?: Record<string, unknown>) => void };

/** 一次听写最多攒多久的音频（兜底，正常一句话远小于这个数） */
const MAX_UTTERANCE_BYTES = 16 * 1024 * 1024;

const CONNECT_TIMEOUT_MS = 3000;
/** `asr.start` 可能弹系统授权框，用户不点就一直等（helper 侧 60s 兜底） */
const START_TIMEOUT_MS = 90_000;
const FEED_TIMEOUT_MS = 15_000;
const CONTROL_TIMEOUT_MS = 5000;
const CLIENT_NAME = "pop-agent-asr";

export class AsrService {
	private readonly log: Logger;
	private client: HelperClient | null = null;
	private status: AsrStatus = { state: "idle" };
	private text = "";
	private audioBytes = 0;
	private connecting = false;
	/**
	 * feed 串行：浏览器每 ~300ms 发一块、不等响应，乱序会让 partial 倒退。
	 * cancel / end 也排在这条链上，保证「上一句收尾」一定发生在「下一句喂音频」之前。
	 */
	private chain: Promise<unknown> = Promise.resolve();
	/** 云端 STT 配置：配了就不碰本地 helper，直接转发厂商 API（见 server/stt/） */
	private readonly cloudConfig: SttConfig | null;
	private cloudSession: SttSession | null = null;

	constructor(options: { log: Logger; dataDir?: string }) {
		this.log = options.log;
		const read = readSttConfig(options.dataDir);
		this.cloudConfig = read.config;
		if (read.config) {
			// 不打印 apiKey
			this.log.warn("云端语音识别已启用", {
				provider: read.config.provider,
				endpoint: read.config.endpoint,
				model: read.config.model ?? "(默认)",
				source: read.source,
			});
		}
		if (read.error) this.log.warn("云端 STT 配置读不懂，按未配置处理", { error: read.error });
	}

	/** helper 在不在（内嵌二进制，或用户自己装的那份 app 的 socket） */
	private helperAvailable(): boolean {
		const binary = helperBinaryPath();
		if (binary && existsSync(binary)) return true;
		return existsSync(socketPath());
	}

	current(): AsrStatus {
		// 云端模式：不需要 helper、也不需要本地授权，直接算就绪
		if (this.cloudConfig) {
			return { state: "ready", locale: this.cloudConfig.language ?? "zh-CN", onDevice: false };
		}
		if (this.status.state !== "idle") return this.status;
		// 一次都没启动过、helper 也不在：如实说「没装」，别让面板显示「就绪」
		if (this.helperAvailable()) return this.status;
		return {
			state: "missing",
			message: "本地识别已经并进 Agent Computer：先在「电脑控制」里安装并打开它，再回来试",
		};
	}

	/** 当前这句到目前为止的文字（partial 也在内） */
	latestText(): string {
		return this.text;
	}

	/**
	 * 确保 helper 连上并准备好识别器：没连就（异步）启动，然后立刻返回当前状态。
	 * **不要 await 到 ready**：首次授权要等用户在系统弹框里点一下，可能几十秒，
	 * HTTP 请求不该挂在那儿 —— 前端轮询状态即可。
	 */
	ensureStarted(): AsrStatus {
		if (this.cloudConfig) return this.current();
		if (this.client) return this.status;
		if (this.connecting) return this.status;
		this.connecting = true;
		this.status = { state: "starting" };
		void this.connect();
		return this.status;
	}

	private async connect(): Promise<void> {
		const binary = helperBinaryPath();
		const client = new HelperClient({
			socketPath: socketPath(),
			binaryPath: binary,
			transport: helperTransport(process.env, binary),
			clientName: CLIENT_NAME,
			session: { sessionId: `asr-${process.pid}`, turnId: null },
		});
		try {
			await client.connect(CONNECT_TIMEOUT_MS);
		} catch (error) {
			client.close();
			this.connecting = false;
			this.status = {
				state: "missing",
				message: "本地识别已经并进 Agent Computer：先在「电脑控制」里安装并打开它，再回来试",
			};
			this.log.warn("ASR：连不上 Agent Computer helper", {
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		this.client = client;
		// 建识别器 + 开一句：首次会弹系统授权（麦克风 / 语音识别）
		try {
			const result = (await client.request("asr.start", {}, START_TIMEOUT_MS)) as {
				authorized?: boolean;
				locale?: string;
				onDevice?: boolean;
			};
			this.status = { state: "ready", locale: result?.locale, onDevice: result?.onDevice === true };
		} catch (error) {
			// 授权被拒 / 该语言不支持离线：照实报，别假装就绪
			this.status = { state: "error", message: error instanceof Error ? error.message : String(error) };
			this.log.warn("ASR：helper 拒绝启动识别", { message: this.status.message });
		} finally {
			this.connecting = false;
		}
	}

	/** 连接断了（helper 被关掉 / 崩了）：回到可重试的状态 */
	private fail(error: unknown): void {
		this.client?.close();
		this.client = null;
		this.status = {
			state: "error",
			message: "本地识别连接断了（Agent Computer 可能被关掉了），重新开始听写会自动重连",
		};
		this.log.warn("ASR：helper 请求失败", {
			message: error instanceof Error ? error.message : String(error),
		});
	}

	/** 开一段新的听写（清掉上一句的残留文字，并让 helper 丢弃上一句） */
	startUtterance(): void {
		this.text = "";
		this.audioBytes = 0;
		if (this.cloudConfig) {
			this.cloudSession?.cancel();
			this.cloudSession = null;
			return;
		}
		const client = this.client;
		if (!client) return;
		this.chain = this.chain
			.catch(() => undefined)
			.then(() => client.request("asr.cancel", {}, CONTROL_TIMEOUT_MS));
		this.chain.catch(() => undefined);
	}

	/** 送一段 16k 单声道 int16 PCM；返回当前 partial（到这块为止识别出的文字） */
	async pushAudio(pcm: Buffer): Promise<string> {
		if (this.cloudConfig) {
			if (this.audioBytes + pcm.length > MAX_UTTERANCE_BYTES) return this.text;
			this.audioBytes += pcm.length;
			this.cloudSession ??= createSttSession(this.cloudConfig, this.log);
			this.cloudSession.push(pcm);
			// 整段识别的 provider 在 end() 之前拿不到文字，所以这里一直是空串
			return this.cloudSession.text;
		}
		const client = this.client;
		if (!client || pcm.length === 0) return this.text;
		if (this.audioBytes + pcm.length > MAX_UTTERANCE_BYTES) return this.text; // 兜底：别把进程喂爆
		this.audioBytes += pcm.length;

		const audio = pcm.toString("base64");
		this.chain = this.chain.catch(() => undefined).then(async () => {
			const result = (await client.request("asr.feed", { audio }, FEED_TIMEOUT_MS)) as { text?: string };
			if (typeof result?.text === "string") this.text = result.text;
		});
		try {
			await this.chain;
		} catch (error) {
			this.fail(error);
		}
		return this.text;
	}

	/** 说完：让 helper `endAudio()`，等 final（超时就用已经识别到的部分） */
	async endUtterance(timeoutMs = 8000): Promise<string> {
		if (this.cloudConfig) {
			const session = this.cloudSession;
			this.cloudSession = null;
			if (!session) return this.text;
			try {
				this.text = await session.end();
			} catch (error) {
				// 云端挂了不该把整条语音路径弄死：这一句没结果，下一句照旧试
				this.log.warn("云端识别失败", { message: error instanceof Error ? error.message : String(error) });
			}
			return this.text;
		}
		const client = this.client;
		if (!client) return this.text;
		try {
			await this.chain.catch(() => undefined); // 先把音频送完
			const result = (await client.request(
				"asr.end",
				{ timeoutSeconds: timeoutMs / 1000 },
				timeoutMs + CONTROL_TIMEOUT_MS,
			)) as { text?: string };
			if (typeof result?.text === "string") this.text = result.text;
		} catch (error) {
			this.fail(error);
		}
		return this.text;
	}

	/** 服务端退出时收摊：只断开连接 —— helper 常驻与否由它自己的菜单栏决定，不归我们管 */
	dispose(): void {
		this.cloudSession?.cancel();
		this.cloudSession = null;
		this.client?.close();
		this.client = null;
		if (this.status.state === "ready" || this.status.state === "authorizing") {
			this.status = { state: "idle" };
		}
	}
}
