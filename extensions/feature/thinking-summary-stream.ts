import {
	parseProviderThinkingTitleLine,
	splitThinkingChunkBuffer,
	summarizeThinkingChunk,
	THINKING_CHUNK_IDLE_MS,
} from "./thinking-summary.ts";

export type ThinkingSummaryStreamOptions = {
	/** 关闭时 update() 返回 undefined，完全走旧 preview。 */
	liveSummary: boolean;
	/** provider 的 `**Section title**` 优先于本地抽句。 */
	useProviderTitles: boolean;
	/** 单个 run 内最多保留的摘要历史。 */
	historyLimit?: number;
};

export type ThinkingSummaryStreamUpdate = {
	active: boolean;
	now: number;
	lastDeltaAt: number;
	/** 当前 provider 标题已经显示在 heading 时，列表只放已完成的 section。 */
	providerTitleInHeading?: boolean;
};

const DEFAULT_HISTORY_LIMIT = 200;

/**
 * 按 run 维护 thinking 摘要流。
 * 纯状态机 + 注入 now/lastDeltaAt：2 秒空闲收块、provider 标题增量扫描都能单测，
 * 不依赖 compact-thinking 的动画计时器。
 */
export class ThinkingSummaryStream {
	private text = "";
	private buffer = "";
	private summaries: string[] = [];
	private providerTitles: string[] = [];
	private providerCarry = "";
	private providerInFence = false;
	private lastDeltaAt = 0;
	private readonly historyLimit: number;
	private readonly options: ThinkingSummaryStreamOptions;
	private useProviderTitles: boolean;

	constructor(options: ThinkingSummaryStreamOptions) {
		this.options = options;
		this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
		this.useProviderTitles = options.useProviderTitles;
	}

	/** 配置面板切换 provider 标题模式时重建，避免沿用旧扫描状态。 */
	setUseProviderTitles(enabled: boolean) {
		if (this.useProviderTitles === enabled) return;
		this.useProviderTitles = enabled;
		this.reset();
	}

	/** 消息收尾时强制收掉当前 buffer；没有增量也安全。 */
	close(now: number): string[] | undefined {
		return this.update(this.text, {
			active: false,
			now,
			lastDeltaAt: 0,
		});
	}

	update(text: string, update: ThinkingSummaryStreamUpdate): string[] | undefined {
		if (!this.options.liveSummary) return undefined;
		if (!this.isAppendOnly(text)) this.reset();

		const delta = text.slice(this.text.length);
		if (delta) this.buffer += delta;
		this.text = text;

		// provider 标题按新增行增量扫描，避免每 90ms 从整段 reasoning 头部重扫。
		if (this.useProviderTitles && delta) this.scanProviderTitles(delta);
		if (!update.active && this.providerCarry) {
			this.scanProviderLine(this.providerCarry);
			this.providerCarry = "";
		}

		if (update.active && update.lastDeltaAt > 0) this.lastDeltaAt = update.lastDeltaAt;
		if (this.providerTitles.length > 0) {
			this.buffer = "";
			return update.active && update.providerTitleInHeading
				? this.providerTitles.slice(0, -1)
				: this.providerTitles;
		}

		const forceClose = !update.active;
		const idle =
			update.active &&
			this.lastDeltaAt > 0 &&
			update.now - this.lastDeltaAt >= THINKING_CHUNK_IDLE_MS;
		if (!delta && !forceClose && !idle) return this.summaries;

		const { closed, rest } = splitThinkingChunkBuffer(this.buffer, forceClose || idle);
		this.buffer = rest;
		this.pushSummaries(closed);
		return this.summaries;
	}

	/**
	 * 流式 thinking 只会追加。不要每帧 text.startsWith(previous)，
	 * 那会把整段旧文本重新比较一遍，长 reasoning 下变成 O(n²)。
	 * 用 64 字符头尾样本判断；长度相等时才做完整比较。
	 */
	private isAppendOnly(text: string): boolean {
		if (text.length < this.text.length) return false;
		if (text.length === this.text.length) return text === this.text;
		const sampleLength = Math.min(64, this.text.length);
		if (sampleLength === 0) return true;
		return (
			text.slice(0, sampleLength) === this.text.slice(0, sampleLength) &&
			text.slice(this.text.length - sampleLength, this.text.length) ===
				this.text.slice(-sampleLength)
		);
	}

	private reset() {
		this.text = "";
		this.buffer = "";
		this.summaries = [];
		this.providerTitles = [];
		this.providerCarry = "";
		this.providerInFence = false;
		this.lastDeltaAt = 0;
	}

	private scanProviderTitles(delta: string) {
		const combined = this.providerCarry + delta.replace(/\r\n?/g, "\n");
		const lines = combined.split("\n");
		this.providerCarry = lines.pop() ?? "";
		for (const line of lines) this.scanProviderLine(line);
	}

	private scanProviderLine(line: string) {
		const trimmed = line.trim();
		if (/^```/.test(trimmed)) {
			this.providerInFence = !this.providerInFence;
			return;
		}
		if (this.providerInFence) return;
		const title = parseProviderThinkingTitleLine(trimmed);
		if (!title) return;
		const key = title.toLowerCase();
		if (this.providerTitles.some((existing) => existing.toLowerCase() === key)) return;
		this.providerTitles.push(title);
	}

	private pushSummaries(closed: string[]) {
		for (const chunk of closed) {
			const summary = summarizeThinkingChunk(chunk);
			if (!summary) continue;
			const previous = this.summaries.at(-1);
			if (previous && previous.toLocaleLowerCase() === summary.toLocaleLowerCase()) continue;
			this.summaries.push(summary);
		}
		if (this.summaries.length > this.historyLimit) {
			this.summaries.splice(0, this.summaries.length - this.historyLimit);
		}
	}
}
