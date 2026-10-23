import assert from "node:assert/strict";
import test from "node:test";

import { splitThinkingChunkBuffer } from "../extensions/feature/thinking-summary.ts";
import { ThinkingSummaryStream } from "../extensions/feature/thinking-summary-stream.ts";

function stream(options?: { useProviderTitles?: boolean }) {
	return new ThinkingSummaryStream({
		liveSummary: true,
		useProviderTitles: options?.useProviderTitles ?? true,
	});
}

test("summary stream closes on section boundaries and idle, then keeps history", () => {
	const s = stream();
	assert.deepEqual(
		s.update("I need to inspect the renderer.", {
			active: true,
			now: 0,
			lastDeltaAt: 0,
		}),
		[],
		"an unterminated sentence stays open",
	);
	assert.deepEqual(
		s.update("I need to inspect the renderer.\n", {
			active: true,
			now: 100,
			lastDeltaAt: 100,
		}),
		["Inspect the renderer"],
		"a sentence-ending newline flushes one summary",
	);
	assert.deepEqual(
		s.update("I need to inspect the renderer.\nThen I will verify the spinner.", {
			active: true,
			now: 1_000,
			lastDeltaAt: 1_000,
		}),
		["Inspect the renderer"],
		"a new token does not flush until a boundary or idle",
	);
	assert.deepEqual(
		s.update("I need to inspect the renderer.\nThen I will verify the spinner.", {
			active: true,
			now: 3_001,
			lastDeltaAt: 1_000,
		}),
		["Inspect the renderer", "Verify the spinner"],
		"2s without tokens force-closes the open section",
	);
	assert.deepEqual(
		s.update("I need to inspect the renderer.\nThen I will verify the spinner.", {
			active: false,
			now: 3_100,
			lastDeltaAt: 0,
		}),
		["Inspect the renderer", "Verify the spinner"],
		"completion is idempotent",
	);
});

test("summary stream scans provider titles incrementally and hides the current heading title", () => {
	const s = stream();
	assert.deepEqual(
		s.update("**Inspecting renderer**", {
			active: true,
			now: 0,
			lastDeltaAt: 0,
		}),
		[],
		"a title without a newline stays in the carry buffer",
	);
	assert.deepEqual(
		s.update("**Inspecting renderer**\n\nbody", {
			active: true,
			now: 100,
			lastDeltaAt: 100,
		}),
		["Inspecting renderer"],
		"a completed title becomes the first summary",
	);
	assert.deepEqual(
		s.update("**Inspecting renderer**\n\nbody\n\n**Verifying spinner**\n", {
			active: true,
			now: 200,
			lastDeltaAt: 200,
			providerTitleInHeading: true,
		}),
		["Inspecting renderer"],
		"the current section title stays in the heading, not the list",
	);
	assert.deepEqual(
		s.update("**Inspecting renderer**\n\nbody\n\n**Verifying spinner**\n", {
			active: true,
			now: 300,
			lastDeltaAt: 300,
			providerTitleInHeading: false,
		}),
		["Inspecting renderer", "Verifying spinner"],
		"non-OpenAI headings keep every provider title in the list",
	);
	assert.deepEqual(
		s.close(400),
		["Inspecting renderer", "Verifying spinner"],
		"closing flushes a title without a trailing newline",
	);
});

test("toggling provider title mode rebuilds from the full text", () => {
	const s = stream();
	const text = "**Section heading for renderer**\n\nbody\n";
	assert.deepEqual(s.update(text, { active: true, now: 0, lastDeltaAt: 0 }), [
		"Section heading for renderer",
	]);
	s.setUseProviderTitles(false);
	assert.deepEqual(
		s.update(text, { active: true, now: 100, lastDeltaAt: 100 }),
		["Section heading for renderer"],
		"local summarization still sees the title text as a section",
	);
});

test("summary stream ignores provider titles inside fenced code", () => {
	const s = stream();
	assert.deepEqual(
		s.update("**Real section**\n\n```md\n**Not a section**\n```\n", {
			active: true,
			now: 0,
			lastDeltaAt: 0,
			providerTitleInHeading: false,
		}),
		["Real section"],
	);
});

test("summary stream resets when thinking text is replaced instead of appended", () => {
	const s = stream();
	assert.deepEqual(
		s.update("Alpha renderer section.\n", { active: true, now: 0, lastDeltaAt: 0 }),
		["Alpha renderer section"],
	);
	assert.deepEqual(
		s.update("Replacement renderer section.\n", { active: true, now: 100, lastDeltaAt: 100 }),
		["Replacement renderer section"],
		"stale summaries from the previous text are dropped",
	);
});

test("chunk splitter uses visible width so CJK does not become 1000 columns", () => {
	const cjk = "中".repeat(300);
	const { closed, rest } = splitThinkingChunkBuffer(cjk, false);
	assert.equal(closed.length, 1);
	assert.equal(closed[0]?.length, 250, "500 display columns = 250 CJK characters");
	assert.equal(rest.length, 50);
});
