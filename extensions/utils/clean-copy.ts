/**
 * fullscreen 选区复制清洗：把渲染层加的装饰从粘贴内容里剥掉，只留正文。
 *
 * 处理三类装饰（都是本 fork / Pi 渲染时加的，不属于内容）：
 * 1. 工具卡树线：`├ `、`└ `、缩进后的续行 `│ `、`↳ `；
 * 2. 代码框：`╭── lang ──╮` / `│ code │` / `╰──╯` 只留代码本身；
 * 3. 省略提示：`… N more lines`、`… (N earlier lines)`、`click to render all`
 *    这类纯提示行，以及行尾的 ` · click to show more` 后缀。
 *
 * 保守边界：**不改**行首列 0 的 `│ `（Markdown 引用块靠它表意），也**不改**
 * 缩进、`+`/`-` diff 标记和其余正文空白。只在缩进后的树线前缀上动手。
 */

/** 树线前缀：可选缩进 + 一个引导符 + 一个可选空格。 */
const TREE_GUIDE_RE = /^([ \t]*)(?:│|├|└)[ \t]?/;

/** 行尾展开/收起提示：`… · click to show more`、`ctrl+o to collapse`。 */
const HINT_SUFFIX_RE =
	/[ \t]*(?:·[ \t]*)?(?:(?:click|ctrl\+[a-z0-9+/]+|alt\+[a-z0-9+/]+)[ \t]+to[ \t]+(?:show more|render all|collapse))[ \t]*$/i;

/** 纯提示行（剥掉后缀后整行只剩提示时丢弃）。 */
const HINT_ONLY_RES: RegExp[] = [
	/^(?:…[ \t]*)?\+?\d+[ \t]+more[ \t]+(?:diff[ \t]+)?lines?(?:[ \t]*·.*)?$/,
	/^…[ \t]*\(\d+[ \t]+earlier[ \t]+lines?\)$/,
	/^…[ \t]*\d+[ \t]+earlier[ \t]+(?:calls?|lines?)$/,
	/^…[ \t]*\+\d+[ \t]*more[ \t]+lines?$/,
	/^(?:↑[ \t]*)?click[ \t]+to[ \t]+(?:show more|render all|collapse)$/i,
	/^(?:↑[ \t]*)?collapse$/i,
];

/** 代码框顶/底边：`╭…╮` / `╰…╯`（允许两侧空白）。 */
const BOX_TOP_RE = /^[ \t]*╭.*╮[ \t]*$/;
const BOX_BOTTOM_RE = /^[ \t]*╰.*╯[ \t]*$/;

function trimEnd(line: string): string {
	return line.replace(/[ \t]+$/, "");
}

function isHintOnly(line: string): boolean {
	const text = line.trim();
	return HINT_ONLY_RES.some((re) => re.test(text));
}

/**
 * 剥掉行首的树线/箭头。`│ ` 只有在有缩进时才剥：
 * 列 0 的 `│ ` 是 Markdown 引用块，属于内容。
 */
export function stripTreeGuides(line: string): string {
	let rest = line;
	let stripped = false;
	for (;;) {
		const match = TREE_GUIDE_RE.exec(rest);
		if (!match) break;
		const indent = match[1] ?? "";
		if (rest[indent.length] === "│" && indent.length === 0) break;
		rest = rest.slice(match[0].length);
		stripped = true;
	}
	// 树行在引导符后还留一格状态图标前的间距：一并收掉，正文不左漂。
	if (stripped) rest = rest.replace(/^[ \t]/, "");
	return rest.replace(/^[ \t]*↳[ \t]?/, "");
}

/** 代码框内的一行：去掉左右 `│` 和框内填充，保留下层代码缩进。 */
function unwrapBoxLine(line: string): string {
	return trimEnd(
		trimEnd(line)
			.replace(/^[ \t]*│[ \t]?/, "")
			.replace(/[ \t]*│$/, ""),
	);
}

/**
 * 清洗一次 fullscreen 选区文本。输入应已去掉 ANSI（上游 `getActiveSelectionText`
 * 就是这么给的）；这里只按纯文本处理。
 */
export function cleanCopiedText(text: string): string {
	const out: string[] = [];
	let inBox = false;
	for (const raw of text.split("\n")) {
		const line = trimEnd(raw);
		if (BOX_TOP_RE.test(line)) {
			inBox = true;
			continue;
		}
		if (BOX_BOTTOM_RE.test(line)) {
			inBox = false;
			continue;
		}
		if (inBox) {
			out.push(unwrapBoxLine(line));
			continue;
		}
		const stripped = stripTreeGuides(line).replace(HINT_SUFFIX_RE, "");
		if (isHintOnly(stripped)) continue;
		out.push(trimEnd(stripped));
	}
	return out.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}
