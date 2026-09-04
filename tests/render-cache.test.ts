import assert from "node:assert/strict";
import test from "node:test";
import {
	ExpandedToolIoView,
	ExpandedToolResultText,
	formatToolInputArgs,
	SHOW_MORE_LABEL,
} from "../extensions/renderer/index.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

function expectedExpandedLines(text: string, prefix: string, width: number): string[] {
	const normalized = text.replace(/\t/g, "   ").replace(/\n+$/, "");
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	return wrapTextWithAnsi(normalized, contentWidth).map((line) =>
		truncateToWidth(prefix + line, width, ""),
	);
}

test("ExpandedToolResultText preserves lines while caching one width", () => {
	const text = "\x1b[31mfirst\tline with enough content to wrap\nsecond\n\n";
	const prefix = "\x1b[31m  │ \x1b[0m";
	const component = new ExpandedToolResultText(text, prefix);

	const wide = component.render(24);
	assert.deepEqual(wide, expectedExpandedLines(text, prefix, 24));
	assert.strictEqual(component.render(24), wide);

	const narrow = component.render(12);
	assert.deepEqual(narrow, expectedExpandedLines(text, prefix, 12));
	assert.notStrictEqual(narrow, wide);

	const wideAgain = component.render(24);
	assert.deepEqual(wideAgain, expectedExpandedLines(text, prefix, 24));
	assert.notStrictEqual(wideAgain, wide, "only the most recent width is cached");

	component.invalidate();
	const afterInvalidate = component.render(24);
	assert.deepEqual(afterInvalidate, expectedExpandedLines(text, prefix, 24));
	assert.notStrictEqual(afterInvalidate, wideAgain);

	const changedText = "updated\tcontent\n";
	component.setText(changedText);
	assert.deepEqual(component.render(24), expectedExpandedLines(changedText, prefix, 24));
});

test("formatToolInputArgs pretty-prints object fields and multiline values", () => {
	assert.equal(formatToolInputArgs(null), "");
	assert.equal(formatToolInputArgs({ path: "a.ts", limit: 10 }), "path: a.ts\nlimit: 10");
	assert.equal(
		formatToolInputArgs({ command: "echo hi\necho bye" }),
		"command:\n  echo hi\n  echo bye",
	);
	assert.match(formatToolInputArgs({ nested: { a: 1 } }), /nested:/);
});

test("ExpandedToolIoView labels Input and Output sections", () => {
	const styled: Array<[string, string]> = [];
	const theme = {
		fg(color: string, text: string) {
			styled.push([color, text]);
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const view = new ExpandedToolIoView(theme, "path: src/a.ts", "line one\nline two", false, 4000);
	const lines = view.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.ok(lines.some((line) => /^ ├ Input/.test(line)));
	assert.ok(lines.some((line) => /^ └ Output/.test(line)));
	assert.ok(lines.some((line) => line.includes("path: src/a.ts")));
	assert.ok(styled.some(([color, text]) => color === "muted" && text === "src/a.ts"));
	assert.ok(!styled.some(([color, text]) => color === "text" && text === "src/a.ts"));
	assert.ok(lines.some((line) => line.includes("line one")));
	assert.ok(lines.some((line) => line.includes("line two")));
	assert.ok(
		lines
			.filter((line) => line.includes("line one") || line.includes("line two"))
			.every((line) => !line.includes("│")),
		"output body stops the inner tree rail",
	);
	// Tree rail between sections.
	assert.ok(lines.some((line) => line.trim() === "│"));
	// Short bodies stay fully visible — no show-more affordance.
	assert.ok(!lines.some((line) => line.includes(SHOW_MORE_LABEL)));

	// Reuse path updates content without changing identity.
	view.setContent("path: b.ts", "only", false, 4000);
	const updated = view.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.ok(updated.some((line) => line.includes("path: b.ts")));
	assert.ok(updated.some((line) => line.includes("only")));
	assert.ok(!updated.some((line) => line.includes("line one")));
});

test("ExpandedToolIoView wraps Input/Output at 80% of the viewport", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const body = "x".repeat(79);
	const view = new ExpandedToolIoView(theme, `command: ${body}`, body, false, 1, 1);
	const lines = view.render(100);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	assert.ok(
		lines.some((line) => line.includes("more lines") && line.includes(SHOW_MORE_LABEL)),
		"truncation footer carries show more",
	);
	assert.ok(!lines.find((line) => line.includes("Input"))?.includes(SHOW_MORE_LABEL));
	assert.ok(!lines.find((line) => line.includes("Output"))?.includes(SHOW_MORE_LABEL));
});

test("ExpandedToolIoView shows click to show more when Input/Output exceed the line cap", () => {
	const theme = {
		fg(color: string, text: string) {
			if (color === "text") return `\x1b[37m${text}\x1b[39m`;
			if (color === "dim") return `\x1b[90m${text}\x1b[39m`;
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const longOutput = Array.from({ length: 20 }, (_, i) => `out line ${i}`).join("\n");
	const longInput = Array.from({ length: 20 }, (_, i) => `field${i}: value${i}`).join("\n");
	const view = new ExpandedToolIoView(theme, longInput, longOutput, false, 5, 5);
	const rawLines = view.render(80);
	const lines = rawLines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	const inputFooter = lines.find((line) => line.includes("│") && line.includes("more lines"));
	const outputFooter = lines.find(
		(line) => !line.includes("│") && line.includes("more lines") && line.includes(SHOW_MORE_LABEL),
	);
	assert.ok(inputFooter?.includes(SHOW_MORE_LABEL), "Input truncation footer shows show more");
	assert.ok(outputFooter?.includes(SHOW_MORE_LABEL), "Output truncation footer shows show more");
	assert.equal(view.matchShowMoreLine(inputFooter!), "input");
	assert.equal(view.matchShowMoreLine(outputFooter!), "output");
	assert.ok(!lines.find((line) => line.includes("Input"))?.includes(SHOW_MORE_LABEL));
	view.setHoveredSection("input");
	const hoveredInput = view
		.render(80)
		.find((line) => line.includes("│") && line.includes("more lines"));
	const hoveredOutput = view
		.render(80)
		.find((line) => !line.includes("│") && line.includes("more lines"));
	assert.ok(
		hoveredInput?.includes(`\x1b[90m •\x1b[39m\x1b[37m click to show more\x1b[39m`),
		"hover keeps the bullet dim and highlights only the text",
	);
	assert.ok(hoveredOutput?.includes(`\x1b[90m •\x1b[39m\x1b[90m click to show more\x1b[39m`));
});

test("ExpandedToolIoView records exact show-more header rows, not body text", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	// Body text that would false-positive a whole-buffer Input/show-more scan.
	const decoy = `note Input ${SHOW_MORE_LABEL}\n${Array.from({ length: 12 }, (_, i) => `out ${i}`).join("\n")}`;
	const view = new ExpandedToolIoView(theme, "", decoy, false, 3, 3);
	const lines = view.render(80);
	const headers = view.showMoreHeaderLineIndexes();
	assert.equal(headers.length, 1);
	assert.equal(headers[0]?.section, "output");
	assert.ok(
		(headers[0]?.line ?? -1) > 0,
		"show-more sits on the truncation footer, not the header",
	);
	const decoyRow = lines.findIndex(
		(line, index) => index > 0 && line.includes("Input") && line.includes(SHOW_MORE_LABEL),
	);
	assert.ok(decoyRow > 0, "body still paints the decoy text");
	assert.ok(!headers.some((h) => h.line === decoyRow));
});
