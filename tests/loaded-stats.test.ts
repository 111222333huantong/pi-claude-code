import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	collectLoadedStats,
	renderLoadedMessage,
	resetLoadedStatsCache,
	type LoadedStats,
} from "../extensions/feature/shell/loaded-stats.ts";

const stubLoader = () => ({
	reload: async () => {},
	getSkills: () => ({
		skills: [
			{ name: "a", sourceInfo: { scope: "user" } },
			{ name: "b", sourceInfo: { scope: "project" } },
		],
	}),
	getPrompts: () => ({ prompts: [{ name: "p", sourceInfo: { scope: "user" } }] }),
	getExtensions: () => ({
		extensions: [{ path: "/x/npm-foo", sourceInfo: { scope: "project", source: "npm:foo" } }],
	}),
	getThemes: () => ({ themes: [] }),
});

test("stub loader 计数按 global/project 分桶", async () => {
	resetLoadedStatsCache();
	const stats = await collectLoadedStats("/none", "/none", false, { loaderFactory: stubLoader });
	assert.deepEqual(stats.skills, { user: 1, project: 1 });
	assert.deepEqual(stats.prompts, { user: 1, project: 0 });
	assert.deepEqual(stats.extensions, { user: 0, project: 1 });
	assert.equal(stats.mcpServers, 0);
	resetLoadedStatsCache();
});

test("无 adapter 时 MCP 整段省略", async () => {
	resetLoadedStatsCache();
	const stats = await collectLoadedStats("/none", "/none", false, { loaderFactory: stubLoader });
	const text = renderLoadedMessage(stats);
	assert.ok(text.includes("Skills (2 · 1 global / 1 project)"));
	assert.ok(text.includes("global:  a"));
	assert.ok(!text.includes("MCP"));
	resetLoadedStatsCache();
});

test("MCP 按四源 + imports 计数（adapter 已装）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-mcp-"));
	try {
		writeFileSync(join(dir, "proj-mcp.json"), JSON.stringify({ mcpServers: { s1: {}, s2: {} } }));
		writeFileSync(join(dir, "glob-mcp.json"), JSON.stringify({ mcpServers: { s2: {}, s3: {} } }));
		resetLoadedStatsCache();
		const stats = await collectLoadedStats("/none", "/none", true, {
			loaderFactory: stubLoader,
			mcpPaths: {
				sharedGlobal: join(dir, "glob-mcp.json"),
				sharedProject: join(dir, "proj-mcp.json"),
				piProject: join(dir, "missing.json"),
			},
		});
		// s2 全局/项目重名 → 项目胜出；总数 3
		assert.equal(stats.mcpServers, 3);
		assert.deepEqual(stats.detail.mcp.project, ["s1", "s2"]);
		assert.deepEqual(stats.detail.mcp.global, ["s3"]);
		const text = renderLoadedMessage(stats);
		assert.ok(text.includes("MCP servers (3)"));
	} finally {
		resetLoadedStatsCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("失败清缓存可重试", async () => {
	resetLoadedStatsCache();
	let calls = 0;
	const flaky = () => ({
		reload: async () => {
			calls++;
			if (calls === 1) throw new Error("boom");
		},
		getSkills: () => ({ skills: [] }),
		getPrompts: () => ({ prompts: [] }),
		getExtensions: () => ({ extensions: [] }),
		getThemes: () => ({ themes: [] }),
	});
	await assert.rejects(collectLoadedStats("/none", "/none", false, { loaderFactory: flaky }));
	const stats: LoadedStats = await collectLoadedStats("/none", "/none", false, {
		loaderFactory: stubLoader,
	});
	assert.equal(stats.skills.user + stats.skills.project, 2);
	resetLoadedStatsCache();
});
