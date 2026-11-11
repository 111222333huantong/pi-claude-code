import assert from "node:assert/strict";
import test from "node:test";
import { createTokenSmoother } from "../extensions/utils/token-smoothing.ts";

test("first sample snaps to the real value instead of climbing from zero", () => {
	const smoother = createTokenSmoother();
	assert.equal(smoother.next(25, 1_000), 25);
});

test("a provider chunk raises the visible count gradually, not all at once", () => {
	const smoother = createTokenSmoother();
	smoother.next(25, 1_000);

	// Next provider chunk jumps the target by 20 tokens.
	const first = smoother.next(45, 1_016);
	assert.ok(first > 25, "the counter must move on the first frame");
	assert.ok(first < 45, "the counter must not jump the whole chunk");

	const second = smoother.next(45, 1_032);
	assert.ok(second > first, "the counter keeps rising while the target holds");
	assert.ok(second <= 45);
});

test("the visible count catches up with a held target", () => {
	const smoother = createTokenSmoother();
	smoother.next(10, 0);

	let now = 0;
	let value = 10;
	for (let i = 0; i < 100; i++) {
		now += 16;
		value = smoother.next(60, now);
	}
	assert.equal(value, 60);
});

test("never decreases while the target holds, and never overshoots", () => {
	const smoother = createTokenSmoother();
	smoother.next(10, 0);
	let previous = 10;
	let now = 0;
	for (let i = 0; i < 50; i++) {
		now += 16;
		const value = smoother.next(40, now);
		assert.ok(value >= previous, "monotonic while rising");
		assert.ok(value <= 40, "never above the target");
		previous = value;
	}
});

test("a reset target returns to zero and the next value snaps again", () => {
	const smoother = createTokenSmoother();
	smoother.next(100, 0);
	assert.equal(smoother.next(0, 16), 0);
	assert.equal(smoother.next(5, 32), 5);
});

test("a mid-turn correction holds the count instead of rewinding", () => {
	const smoother = createTokenSmoother();
	smoother.next(120, 0);
	// A provider correction reports fewer tokens mid-turn; the chip must not
	// drop back and climb again.
	assert.equal(smoother.next(90, 16), 120);
	assert.equal(smoother.next(100, 32), 120);
	// It resumes rising once the target passes the held value.
	assert.ok(smoother.next(140, 48) > 120);
});
