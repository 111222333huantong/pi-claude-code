# 发布流程（pi-claude-code）

> 包：`pi-claude-code` · 仓库：`111222333huantong/pi-claude-code`（fork 自 `minuque/pi-cc-extensions`）
> npm 账号：`huantong` · 远端：`origin` = fork，`upstream` = minuque 上游

## 0. 版本号规则

- patch（0.9.x）：修 bug，不加功能。
- minor（0.x.0）：加功能（如状态栏、打点、❯）。
- major（1.0.0）：大版本里程碑，另定范围。

## 1. 发版前检查（必做）

```powershell
npm run typecheck   # tsc --noEmit，必须 0 错
npm run lint        # biome check .，必须 0 错（全仓已 format 过，有错先修）
npm test            # 全量用例，必须全绿
```

## 2. 改版本号

- 手改 `package.json` + `package-lock.json` 的 `version`（两处：顶层 + `packages[""]`），
  **不要**直接跑 `npm version`（它的 preversion 钩子会跑全套，慢且可能误触）。

## 3. 提交 + 推 fork

```powershell
git add -A -- . ":!themes/cc-dark.bak.json"   # bak 备份文件永不提交
git commit -m "chore: 升版 x.y.z"              # 或 feat/fix，按实际内容
git push origin main
```

## 4. 打 tag 并推

```powershell
git tag vX.Y.Z
git push origin vX.Y.Z
```

## 5. 发 npm（需本机登录态）

前置（只需做一次）：`npm login` 登 `huantong` 账号。
本机已配好发包 token（`~/.npmrc` 的 `_authToken`，bypass 2FA），直接发：

```powershell
npm pack --dry-run   # 先看进包文件清单，确认新文件在内
npm publish --access public
npm view pi-claude-code version   # 核验 registry 已更新
```

### 发包失败对照表

| 报错 | 原因 | 解法 |
|---|---|---|
| `ENEEDAUTH` | 本机登录过期 | 重跑 `npm login` |
| `403 2FA/token required` | token 失效或被删 | 网页重建 Granular/Automation token（Read and write + Bypass 2FA），重配 `_authToken` |
| `403 Forbidden PUT` | 包名无权限 | 确认包名是 `pi-claude-code` 且登录的是 `huantong` |
| `EOTP 需要一次性密码` | 非交互终端走浏览器流失败 | 用已配好的 token 方式重发，不要 `--otp` |

## 6. 发完验证

1. `npm view pi-claude-code version` 显示新版。
2. 干净环境试装：`pi install npm:pi-claude-code@x.y.z` → `/reload` → 功能冒烟。
3. GitHub Releases 页可手动把 tag 记一笔（可选）。

## 7. 铁律

- 同扩展**禁止双版本同载**（本地路径 + npm 版），补丁互踩，问题难查。测本地用 test.bat，测 npm 版先 `pi remove` 本地。
- `themes/cc-dark.bak.json` 是本地备份，不提交、不进包（要彻底可删文件，暂留）。
- `preversion` 钩子（format+lint+typecheck+test+docs）发版时**不要整跑**，手动分步做；`npm version` 命令一律不用。
- 发版 token 只放本机 `~/.npmrc`，不进仓库、不截图外传；泄漏了去网页 Revoke 后重建。
