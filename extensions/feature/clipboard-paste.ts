/**
 * Windows Ctrl+V 双通道粘贴（OpenCode 同款行为）。
 *
 * 背景：Windows Terminal 默认把 Ctrl+V 拦截为"终端粘贴"，图片没有文本形态，
 * 按下后应用侧要么什么都收不到，要么只收到一个空 bracketed-paste。
 * OpenCode 的解法是按键到达应用时自己读剪贴板（有图挂图、有字贴字），
 * 本模块把同一套搬到 Pi 扩展 API 上：
 *
 * 1. `Ctrl+V` 快捷键直达应用 → 先读图（pi-paster 的 PowerShell 链路），
 *    无图再读文字（CRLF→LF），空剪贴板给提示；
 * 2. 空 bracketed-paste（`\x1b[200~\x1b[201~`）→ 静默走同一流程（不提示，
 *    避免无关空粘贴刷屏），覆盖终端吞键但透出空壳的情况；
 * 3. 图片走"占位标记 + input 钩子挂附件"（pi-image-tools 验证过的模式），
 *    文字走 `pasteToEditor` 光标处插入。
 *
 * 两路共用 800ms 防抖：同一按键同时触发快捷键和空粘贴时只执行一次。
 * 仅 Windows 生效；不碰 editor 工厂，与 image-paster / working-row 无冲突。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readClipboardImage } from "pi-paster";
import { config } from "../config/config.ts";

/** 占位标记 `[Image N]`：按入队顺序编号，会话内递增。 */
export const clipboardImageMarker = (n: number): string => `[Image ${n}]`;

/** 匹配占位标记，捕获编号。 */
export const IMAGE_MARKER_RE = /\[Image (\d+)\]/g;

/** 空粘贴壳：图片无文本形态时终端送出的空 bracketed-paste。 */
export const EMPTY_BRACKETED_PASTE = "\x1b[200~\x1b[201~";

/** 两路触发的去重窗口（毫秒）。 */
export const PASTE_DEBOUNCE_MS = 800;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

type PendingImage = { type: "image"; data: string; mimeType: string };

export type ClipboardPasteDeps = {
	enabled?: boolean;
	platform?: string;
	now?: () => number;
	readImage?: () => ReturnType<typeof readClipboardImage>;
	readText?: () => string | undefined;
};

/** Windows 剪贴板文字（CRLF→LF）。失败/无文字返回 undefined。 */
export function readClipboardText(): string | undefined {
	try {
		const result = spawnSync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
			{ timeout: 5000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
		);
		if (result.status !== 0) return undefined;
		const text = (result.stdout || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

/** 纯扩展名判定（大小写不敏感）；存在性由调用方确认。 */
export function isImageFilePath(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === "" || /\n/.test(trimmed)) return false;
	const lower = trimmed.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return false;
	return IMAGE_EXTENSIONS.has(lower.slice(dot));
}

/** 文本里出现的占位编号（按首次出现顺序，去重）。 */
export function findMarkerNumbers(text: string): number[] {
	const seen = new Set<number>();
	IMAGE_MARKER_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = IMAGE_MARKER_RE.exec(text)) !== null) {
		seen.add(Number(match[1]));
	}
	return [...seen];
}

export function stripMarkers(text: string): string {
	return text
		.replace(IMAGE_MARKER_RE, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function registerClipboardPaste(pi: ExtensionAPI, deps: ClipboardPasteDeps = {}): boolean {
	const enabled = deps.enabled ?? true;
	const platform = deps.platform ?? process.platform;
	if (!enabled || platform !== "win32") return false;
	const now = deps.now ?? Date.now;
	const readImage = deps.readImage ?? readClipboardImage;
	const readText = deps.readText ?? readClipboardText;
	const pending = new Map<number, PendingImage>();
	let nextMarkerNumber = 1;
	let lastTrigger = 0;

	const insertMarker = (ctx: any): void => {
		const marker = clipboardImageMarker(nextMarkerNumber++);
		if (typeof ctx.ui?.pasteToEditor === "function") {
			ctx.ui.pasteToEditor(`${marker} `);
			return;
		}
		const current = typeof ctx.ui?.getEditorText === "function" ? ctx.ui.getEditorText() : "";
		ctx.ui?.setEditorText?.(current ? `${current} ${marker}` : marker);
	};

	/** 两路共用的粘贴流程。announceEmpty 只用于快捷键直按（空粘贴壳走静默）。 */
	const pasteFromClipboard = async (ctx: any, announceEmpty: boolean): Promise<void> => {
		if (!ctx?.hasUI || !ctx?.ui) return;
		try {
			const image = readImage();
			if (image.ok) {
				pending.set(nextMarkerNumber, {
					type: "image",
					data: image.image.data,
					mimeType: image.image.mimeType,
				});
				insertMarker(ctx);
				ctx.ui.notify?.("Image attached from clipboard.", "info");
				return;
			}
		} catch {
			/* 读图失败则继续尝试文字，与 OpenCode 的降级顺序一致。 */
		}
		let raw: string | undefined;
		try {
			raw = readText();
		} catch {
			raw = undefined;
		}
		// CRLF→LF（Windows 剪贴板常见 CRLF，OpenCode 同款归一）。
		const text = (raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const content = text.trim();
		if (content === "") {
			if (announceEmpty) ctx.ui.notify?.("Clipboard is empty.", "info");
			return;
		}
		// 粘贴的是图片文件路径 → 直接读文件挂附件（OpenCode 同款分支）。
		if (isImageFilePath(content) && existsSync(content)) {
			try {
				const data = readFileSync(content).toString("base64");
				pending.set(nextMarkerNumber, { type: "image", data, mimeType: "image/png" });
				insertMarker(ctx);
				return;
			} catch {
				/* 读失败则按普通文字插入。 */
			}
		}
		if (typeof ctx.ui?.pasteToEditor === "function") ctx.ui.pasteToEditor(text ?? "");
		else ctx.ui?.setEditorText?.(text ?? "");
	};

	const attemptPaste = (ctx: any, announceEmpty: boolean): void => {
		const at = now();
		if (at - lastTrigger < PASTE_DEBOUNCE_MS) return;
		lastTrigger = at;
		void pasteFromClipboard(ctx, announceEmpty);
	};

	pi.registerShortcut("ctrl+v", {
		description: "Paste clipboard image or text (Windows)",
		handler: async (ctx) => {
			attemptPaste(ctx, true);
		},
	});

	pi.on("input", async (event) => {
		if ((event as any)?.source === "extension") return { action: "continue" as const };
		if (pending.size === 0) return { action: "continue" as const };
		const numbers = findMarkerNumbers((event as any)?.text ?? "");
		if (numbers.length === 0) {
			// 标记被删光 = 用户放弃，丢弃全部 pending。
			pending.clear();
			return { action: "continue" as const };
		}
		const images: PendingImage[] = [];
		for (const n of numbers) {
			const image = pending.get(n);
			if (image) {
				images.push(image);
				pending.delete(n);
			}
		}
		if (images.length === 0) return { action: "continue" as const };
		return {
			action: "transform" as const,
			text: stripMarkers((event as any).text),
			images: [...((event as any).images ?? []), ...images],
		};
	});

	let unsubscribeTerminalInput: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (!ctx?.hasUI || typeof (ctx as any)?.ui?.onTerminalInput !== "function") return;
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = (ctx as any).ui.onTerminalInput((data: string) => {
			if (typeof data === "string" && data.includes(EMPTY_BRACKETED_PASTE)) {
				attemptPaste(ctx, false);
			}
		});
	});
	pi.on("session_shutdown", () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		pending.clear();
		nextMarkerNumber = 1;
	});

	return true;
}

export default function (pi: ExtensionAPI): void {
	registerClipboardPaste(pi, { enabled: config.enableClipboardPaste });
}
