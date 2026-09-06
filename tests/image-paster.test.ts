import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_PASTER_OPTIONS, registerImagePaster } from "../extensions/feature/image-paster.ts";

function fakeFactory(calls: { count: number; options: unknown }) {
	return ((options: unknown) => {
		calls.count++;
		calls.options = options;
		return () => {};
	}) as any;
}

test("enabled: factory called once with the pinned options", () => {
	const calls = { count: 0, options: undefined as unknown };
	const ok = registerImagePaster({} as any, true, fakeFactory(calls));
	assert.equal(ok, true);
	assert.equal(calls.count, 1);
	assert.deepEqual(calls.options, IMAGE_PASTER_OPTIONS);
});

test("disabled: factory never called", () => {
	const calls = { count: 0, options: undefined as unknown };
	const ok = registerImagePaster({} as any, false, fakeFactory(calls));
	assert.equal(ok, false);
	assert.equal(calls.count, 0);
});

test("pinned options match the validated set (collapsible, no hover preview)", () => {
	assert.deepEqual(IMAGE_PASTER_OPTIONS, {
		submittedPreviewStyle: "collapsible",
		includeImagePathsInPrompt: true,
		customEditor: {
			enabled: true,
			showImagePreview: false,
			deletePlaceholderAsBlock: true,
		},
	});
});
