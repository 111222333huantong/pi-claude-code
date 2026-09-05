import assert from "node:assert/strict";
import test from "node:test";
import {
	PI_MASCOT_FRAME_COUNT,
	PI_MASCOT_ROW_COUNT,
	PI_MASCOT_WIDTH,
	piMascotFrame,
} from "../extensions/feature/shell/mascot.ts";

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const plain = { accent: (s: string) => s, muted: (s: string) => s };

test("13 帧，每帧 4 行等宽 11 列，全程无抖动", () => {
	assert.equal(PI_MASCOT_FRAME_COUNT, 13);
	for (let f = 0; f < PI_MASCOT_FRAME_COUNT; f++) {
		const rows = piMascotFrame(f, plain);
		assert.equal(rows.length, PI_MASCOT_ROW_COUNT);
		for (const row of rows) {
			assert.equal([...stripAnsi(row)].length, PI_MASCOT_WIDTH, `frame ${f} 等宽`);
		}
	}
});

test("首帧闭眼无 accent 调用，末帧整体 accent", () => {
	let accentCalls = 0;
	const counting = {
		accent: (s: string) => {
			accentCalls++;
			return s;
		},
		muted: (s: string) => s,
	};
	piMascotFrame(0, counting);
	assert.equal(accentCalls, 0);
	piMascotFrame(PI_MASCOT_FRAME_COUNT - 1, counting);
	assert.ok(accentCalls > 0);
});

test("帧索引回绕且首末不同", () => {
	const first = piMascotFrame(0, plain).join("\n");
	const last = piMascotFrame(PI_MASCOT_FRAME_COUNT - 1, plain).join("\n");
	assert.notEqual(first, last);
	assert.equal(piMascotFrame(PI_MASCOT_FRAME_COUNT, plain).join("\n"), first);
});
