/**
 * pi 类型兼容垫片：上游引入的 MarkdownMessageType / MarkdownTransformerOptions
 * 在 pi 1.5.2 的类型声明里未导出（运行时 `messageTypes` 选项其实已支持
 * custom/summary，只是类型未跟进）。本文件提供本地别名，供渲染器与测试复用。
 */
export type MarkdownMessageType =
	| "user"
	| "assistant"
	| "assistant-thinking"
	| "custom"
	| "summary"
	| "changelog";

/** registerMarkdownTransformer 第二参的类型（pi ≥1.5.x 支持，类型声明未导出）。 */
export type MarkdownTransformerOptions = {
	messageTypes?: readonly string[];
};
