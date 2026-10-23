import { performance } from "node:perf_hooks";

import {
	extractProviderThinkingTitles,
	splitThinkingChunkBuffer,
	summarizeThinkingChunk,
} from "../extensions/feature/thinking-summary.ts";
import { ThinkingSummaryStream } from "../extensions/feature/thinking-summary-stream.ts";

function makeThinking(sections: number) {
	return Array.from(
		{ length: sections },
		(_, index) =>
			`**Inspecting renderer ${index}**\n\n` +
			`I need to inspect src/module-${index}.ts and verify the renderer path before editing. ` +
			`The spinner should keep moving without stalls.`,
	).join("\n\n");
}

function time(label: string, fn: () => void) {
	const start = performance.now();
	fn();
	const ms = performance.now() - start;
	console.log(`${label.padEnd(34)} ${ms.toFixed(2)} ms`);
	return ms;
}

function streamPass(text: string, step: number) {
	const stream = new ThinkingSummaryStream({ liveSummary: true, useProviderTitles: true });
	let lastDeltaAt = 0;
	for (let end = step; end < text.length; end += step) {
		lastDeltaAt = end;
		stream.update(text.slice(0, end), {
			active: true,
			now: end,
			lastDeltaAt,
			providerTitleInHeading: true,
		});
	}
	return stream.close(text.length);
}

for (const sections of [200, 800, 2000]) {
	const text = makeThinking(sections);
	console.log(`\nthinking: ${sections} sections, ${(text.length / 1024).toFixed(0)} KiB`);
	time("provider titles (full scan)", () => extractProviderThinkingTitles(text));
	time("chunk split + summarize (all)", () => {
		const { closed } = splitThinkingChunkBuffer(text, true);
		for (const chunk of closed) summarizeThinkingChunk(chunk);
	});
	time("streaming pass (64 char steps)", () => streamPass(text, 64));
}
