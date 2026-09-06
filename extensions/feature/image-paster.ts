/**
 * 图片粘贴（image paster）：粘贴/拖拽的图片路径变为第一等图片附件。
 *
 * 底层能力来自 pi-paster（MIT, beowulf11），与 cc-my-pi 的接入经验对齐：
 * 本文件只是"填好配置再启动它"的薄 wrapper，不抄上游源码，上游更新只需升版本号。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPaster, type PasterConfig } from "pi-paster";
import { config } from "../config/config.ts";

export type PasterFactory = typeof createPaster;

/**
 * 固定配置（cc-my-pi 验证过的组合）：
 * - collapsible：历史里的提交预览只画折叠帧，比 full-res kitty 逐帧重绘便宜。
 * - includeImagePathsInPrompt：占位→本地路径映射附进 prompt，agent 可操作源文件。
 * - showImagePreview: false：光标悬停预览每次移动都重编码 kitty 图形，粘贴即卡。
 * - deletePlaceholderAsBlock：Backspace 删整个占位，防删剩半个 `[#image N]`。
 */
export const IMAGE_PASTER_OPTIONS: PasterConfig = {
	submittedPreviewStyle: "collapsible",
	includeImagePathsInPrompt: true,
	customEditor: {
		enabled: true,
		showImagePreview: false,
		deletePlaceholderAsBlock: true,
	},
};

/** 注册 paster；factory 可注入，测试时传 fake。返回是否实际启用。 */
export function registerImagePaster(
	pi: ExtensionAPI,
	enabled: boolean,
	factory: PasterFactory = createPaster,
): boolean {
	if (!enabled) return false;
	factory(IMAGE_PASTER_OPTIONS)(pi);
	return true;
}

export default function (pi: ExtensionAPI): void {
	registerImagePaster(pi, config.enableImagePaster);
}
