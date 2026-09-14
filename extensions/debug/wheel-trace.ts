import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSgrMousePackets } from "../renderer/mouse/packets.ts";

/**
 * 临时诊断：定位"滚轮轻拨就跳顶"。
 * PI_CC_DEBUG_WHEEL=1 时记录：滚轮包突发计数、主 ScrollView 每次位移前后 +
 * 调用栈、ScrollView 实例更替（remount 会丢 offset 回 0）。
 * 默认关闭，生产路径仅多一次 env 读取。
 */

export const WHEEL_TRACE_LOG = join(tmpdir(), "pi-cc-wheel.log");

function enabled(): boolean {
	return process.env.PI_CC_DEBUG_WHEEL === "1";
}

function log(line: string): void {
	try {
		appendFileSync(WHEEL_TRACE_LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// 日志写失败不影响正常渲染。
	}
}

function callerLabel(): string {
	const frames = new Error().stack?.split("\n").slice(2, 6) ?? [];
	return frames
		.map((frame) => frame.trim().replace(/\\/g, "/").split("/").slice(-2).join("/"))
		.join(" <- ")
		.slice(0, 320);
}

function isSgrWheel(packet: any): "up" | "down" | null {
	if (packet?.final !== "M") return null;
	const base = (packet.code ?? 0) & ~(4 | 8 | 16 | 32);
	if (base === 64) return "up";
	if (base === 65) return "down";
	return null;
}

/** 兼容非 SGR（X10 `\x1b[M Cb Cx Cy`）滚轮包计数。 */
function countLegacyWheel(data: string): { up: number; down: number } {
	let up = 0;
	let down = 0;
	let index = data.indexOf("[M");
	while (index >= 0 && index + 3 < data.length) {
		const button = data.charCodeAt(index + 3) - 32;
		if (button & 64) {
			if ((button & 3) === 0) up++;
			else if ((button & 3) === 1) down++;
		}
		index = data.indexOf("[M", index + 1);
	}
	return { up, down };
}

let windowStart = 0;
let windowCount = 0;

/**
 * 记录一次输入中的滚轮包。返回包数（调用方据此决定是否 hook ScrollView，
 * remount 后的新实例恰好在滚轮输入时被捕获）。
 */
export function traceWheelInput(data: string): number {
	if (!enabled() || typeof data !== "string") return 0;
	let packets: any[] = [];
	try {
		packets = parseSgrMousePackets(data) ?? [];
	} catch {
		packets = [];
	}
	const dirs: string[] = [];
	for (const packet of packets) {
		const dir = isSgrWheel(packet);
		if (dir) dirs.push(dir);
	}
	const legacy = countLegacyWheel(data);
	for (let i = 0; i < legacy.up; i++) dirs.push("up");
	for (let i = 0; i < legacy.down; i++) dirs.push("down");
	if (dirs.length === 0) return 0;
	const now = Date.now();
	if (now - windowStart > 200) {
		windowStart = now;
		windowCount = 0;
	}
	windowCount += dirs.length;
	const up = dirs.filter((dir) => dir === "up").length;
	const down = dirs.length - up;
	log(
		`wheel packets=${dirs.length} up=${up} down=${down} window200ms=${windowCount} raw=${JSON.stringify(data).slice(0, 160)}`,
	);
	return dirs.length;
}

const tracedIds = new WeakMap<object, number>();
let nextId = 1;

const SCROLL_METHODS = ["scrollBy", "scrollTo", "scrollToStart", "scrollToEnd"] as const;

/** hook 主 ScrollView：每次位移记前后 offset + 调用栈；实例更替单独记一行。 */
export function tracePrimaryScrollView(tui: any): void {
	if (!enabled()) return;
	let view: any = null;
	try {
		view = tui?.getPrimaryScrollView?.();
	} catch {
		return;
	}
	if (!view || typeof view !== "object") return;
	let id = tracedIds.get(view);
	if (id === undefined) {
		id = nextId++;
		tracedIds.set(view, id);
		let state = "";
		try {
			state = `top=${view.scrollTop} following=${view.isFollowingEnd}`;
		} catch {
			// 读状态失败只记实例更替。
		}
		log(`primary ScrollView #${id} (new instance) ${state}`);
		for (const name of SCROLL_METHODS) {
			const original = view[name];
			if (typeof original !== "function") continue;
			view[name] = function (...args: any[]) {
				let before = "";
				try {
					before = `top=${view.scrollTop} following=${view.isFollowingEnd}`;
				} catch {
					// 读状态失败只记调用。
				}
				const result = original.apply(view, args);
				let after = "";
				try {
					after = `top=${view.scrollTop} following=${view.isFollowingEnd}`;
				} catch {
					// 读状态失败只记调用。
				}
				log(`${name}(${args.join(",")}) [sv#${id}] ${before} -> ${after} via ${callerLabel()}`);
				return result;
			};
		}
	}
}
