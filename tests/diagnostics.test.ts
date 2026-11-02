import assert from "node:assert/strict";
import test from "node:test";

test("formatDiagnostics reports versions, patch chain, config and compat history", async () => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/tmp/pi-cc-diag-test";
	const { reportCompatIssue, drainCompatIssues } = await import(
		"../extensions/compat/pi-internals.ts"
	);
	const { installStreamThrottle } = await import("../extensions/renderer/stream-throttle.ts");
	const { formatDiagnostics } = await import("../extensions/config/diagnostics.ts");
	try {
		const throttle = installStreamThrottle();
		try {
			reportCompatIssue("tool-execution", "prototype.render");
			drainCompatIssues();
			const text = formatDiagnostics();
			assert.match(text, /# ccstyle diag/);
			assert.match(text, /pi-claude-code: \d+\.\d+\.\d+/);
			assert.match(text, /pi-coding-agent: /);
			assert.match(text, /assistant patch chain: stream-throttle → native/);
			assert.match(text, /streamThrottleMs: \d+/);
			assert.match(text, /tool-execution: missing prototype\.render/);
			assert.match(text, /stream throttle: installed/);
		} finally {
			throttle.dispose();
		}
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	}
});
