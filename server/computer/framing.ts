/**
 * helper socket 的帧格式：`uint32 小端长度 + UTF-8 JSON`（与 agent-computer-turbo 的 framing.mjs 一致）。
 *
 * 长度为 0 或超过 8 MiB 都是协议错误，调用方必须关掉连接。
 */

/**
 * ⚠️ 线协议的 TS 实现：只有 `helper-client.ts`（= ASR + 面板 status 探测）在用。
 *
 * 必须与两处保持一致：helper 的 `Framing.swift`，以及 App 内 CLI 的帧编解码。
 * 改格式时三处一起改；Agent 侧的电脑控制已经不走这里了（见 cli.ts 的薄壳）。
 */

export const HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
		throw new Error(`frame size out of range: ${body.length}`);
	}
	const header = Buffer.alloc(HEADER_BYTES);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}

/** 增量解码：socket 的 data 事件可能切在任意位置，所以要攒着等够一帧。 */
export class FrameDecoder {
	private buffered: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
		const frames: unknown[] = [];
		while (this.buffered.length >= HEADER_BYTES) {
			const length = this.buffered.readUInt32LE(0);
			if (length === 0 || length > MAX_FRAME_BYTES) {
				throw new Error(`bad frame length ${length}`);
			}
			if (this.buffered.length < HEADER_BYTES + length) break;
			const text = this.buffered.subarray(HEADER_BYTES, HEADER_BYTES + length).toString("utf8");
			this.buffered = this.buffered.subarray(HEADER_BYTES + length);
			frames.push(JSON.parse(text));
		}
		return frames;
	}
}
