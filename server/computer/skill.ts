/**
 * 电脑控制的 Skill：薄壳，装/卸都交给 App 里的 `agent-computer skill install|remove`。
 *
 * SKILL.md 的正文（以及里面 `{{CLI}}` 的替换）由 App 负责 —— 它才知道自己装在哪。
 * 这里只保留面板需要的三件事：
 *   - `skillEnabled()`：`~/.agents/skills/agent-computer/SKILL.md` 在不在（启用与否只看这个）；
 *   - `enableSkill()` / `disableSkill()`：转调 App 内 CLI；
 *   - `skillDir()` / `cliCommand()`：面板展示用（装在哪、命令长什么样）。
 *
 * 以前这里是「读模板、替换 CLI 路径、写文件」，模板与路径规则都跟着宿主走 ——
 * 现在 CLI 就在 .app 里，路径唯一的正确来源是 App 自己，宿主再算一遍只会算错。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appCliPath, helperDownloadUrl } from "./paths.js";

export const SKILL_ID = "agent-computer";
const SKILL_FILE = "SKILL.md";

export function skillDir(): string {
	return join(homedir(), ".agents", "skills", SKILL_ID);
}

export function skillEnabled(): boolean {
	return existsSync(join(skillDir(), SKILL_FILE));
}

/** 面板上展示的「Agent 会执行的那条命令」 */
export function cliCommand(): string {
	const cli = appCliPath();
	return cli === null ? "agent-computer" : shellQuote(cli);
}

function shellQuote(text: string): string {
	return /^[A-Za-z0-9_/.:@-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 转调 App 内 CLI；失败时把它吐回的那条 JSON 里的 message 抛出来（面板直接展示） */
function runSkillCommand(action: "install" | "remove"): void {
	const cli = appCliPath();
	if (!cli) {
		throw new Error(`没找到 Agent Computer.app（先装一个：${helperDownloadUrl()}）`);
	}
	const result = spawnSync(cli, ["skill", action], { encoding: "utf8" });
	if (result.error) throw new Error(`执行 ${cli} 失败：${result.error.message}`);
	if (result.status === 0) return;
	// CLI 的失败也是 `{"ok":false,"error":{"message":…}}`，把 message 拎出来给人看
	try {
		const parsed = JSON.parse((result.stdout ?? "").trim().split("\n").pop() ?? "") as {
			error?: { message?: string };
		};
		throw new Error(parsed.error?.message ?? `skill ${action} 失败`);
	} catch (error) {
		if (error instanceof Error && error.message !== "skill install 失败" && error.message !== "skill remove 失败") {
			throw error;
		}
		throw new Error(`skill ${action} 失败（退出码 ${result.status ?? "null"}）`);
	}
}

export function enableSkill(): void {
	runSkillCommand("install");
}

export function disableSkill(): void {
	runSkillCommand("remove");
}
