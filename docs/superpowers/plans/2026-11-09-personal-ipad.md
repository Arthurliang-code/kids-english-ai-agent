# 个人版 iPad 实现计划

> **For agentic workers:** 本文只锁定顺序和验收，不包含代码改动。开工某一期时，另写该期的实现步骤，再用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐项做。

**Goal:** 让一个孩子在一台 iPad 上完成拍照识词、点读、看释义和复习，家长用 git 推送更新，上课时不依赖电脑开机。

**Architecture:** 静态站点由 GitHub Actions 构建、Cloudflare Pages 托管，iPad 主屏幕打开。识别、词库、系统语音、生词与复习都在本机完成。生产环境默认不调用云端。决策依据是 [kids-english-app-personal.md](../../../kids-english-app-personal.md)。

**Tech Stack:** 现有 npm workspace、React、Vite、TypeScript、Tesseract.js、Safari `speechSynthesis`、IndexedDB。托管用 GitHub Actions 与 Cloudflare Pages。

## Global Constraints

- 使用范围是一个孩子、一台 iPad，Safari 添加到主屏幕。
- 词库未命中的词不发音。判定沿用 `isTrusted`（只看 `lexiconHit`）。
- 释义只来自 `content/words.json`。没有条目时词卡写「还没有释义」。
- 系统语音用 `speechSynthesis` 的 `rate` 放慢，同一时间只读一个词。
- `domain/` 不引用 `platform/`。
- 生产构建不包含 DeepSeek 密钥，不包含 `/api/vlm-review`。
- OCR 资源从 `import.meta.env.BASE_URL` 加载。
- 高置信阈值保持 `0.70`，见 `CONFIDENCE_THRESHOLDS`。
- 云端复核若存在，图的长边为 `1600`，提示词不要求坐标框。
- 每一期单独做完就能在 iPad 上验收。

---

### P1：iPad 不连电脑也能打开识别台

**Files:**

- Modify: [apps/web/src/features/ocr-lab/OcrLab.tsx](../../../apps/web/src/features/ocr-lab/OcrLab.tsx)（`reviewEnabled` 现为 `true`，生产构建改为默认关闭）
- Modify: [apps/web/index.html](../../../apps/web/index.html)（已有 `apple-mobile-web-app-capable`，补主屏幕名称与清单链接）
- Create: `apps/web/public/manifest.webmanifest`
- Create: 主屏幕图标（放在 `apps/web/public/`）
- Create: 服务工作者与「点一下更新」提示（构建时生成，更新由用户确认后生效）
- Create: `.github/workflows/` 下的构建工作流，仓库根目录执行 `npm run build`
- Modify: [apps/web/public/tesseract](../../../apps/web/public/tesseract)（在 iPad 上确认实际加载的那一套 WASM 之后，站点只保留该套与 `tessdata/eng.traineddata.gz`）
- 托管：Cloudflare Pages 发布 `apps/web/dist`。`vite.config.ts` 的 VLM 中间件已经是 `apply: 'serve'`，生产包不会带上密钥。

**验收:**

- 家长的电脑关机。iPad 从主屏幕打开站点，能拍照或打开示例页并完成识别。
- 生产页面的「云端语义复核」默认关闭。关闭时页面不请求 `/api/vlm-review`。
- 再推送一次提交后，主屏幕里出现更新提示；点一下之后，页面换成新版本。
- 首次打开下载的 OCR 资源只包含 iPad 实际使用的那一套 WASM 和英文 `traineddata`，不是 `public/tesseract` 里约 54MB 的全部变体。

### P2：点词出声

**Files:**

- Modify: [apps/web/src/features/ocr-lab/OcrLab.tsx](../../../apps/web/src/features/ocr-lab/OcrLab.tsx)、[apps/web/src/features/ocr-lab/ImageStage.tsx](../../../apps/web/src/features/ocr-lab/ImageStage.tsx)、[apps/web/src/features/ocr-lab/SidePanel.tsx](../../../apps/web/src/features/ocr-lab/SidePanel.tsx)
- Create: 一个只负责 `speechSynthesis` 的模块（英文语音、`rate` 放慢、新的朗读取消上一次）
- 发音是否可用，调用现有 `isTrusted`

**验收:**

- 示例页上点一个词库内的词，能听到放慢的英文。
- 点一个词库外的噪声词，没有发音按钮，也没有声音。
- 连续点两个可信词时，只听到后一个。

### P3：词卡

**Files:**

- Create: `content/words.json`，每条含 `word`、`meaning`、`example`
- Create: 按词查询该文件的纯函数，放在 `apps/web/src/domain/`
- Modify: 点词后面板，命中则显示中文和例句

**验收:**

- 词库命中且 JSON 有条目：词卡显示家长写过的中文和例句。
- 词库命中但 JSON 没有条目：词卡写「还没有释义」，该词仍可发音。
- 改一条 JSON 并推送后，iPad 按 P1 的方式更新，该词的词卡变成新内容。

### P4：生词本、复习与导出

**Files:**

- Create: IndexedDB 读写（生词、`stage`、下次复习日）
- Create: `apps/web/src/domain/` 里的复习调度纯函数。`stage` 为 0 到 5，间隔 `[0, 1, 3, 7, 16, 35]` 天，每天最多 20 个
- Create: 导出 JSON 与从 JSON 导回
- Create: 跟读界面：播放示范、录下孩子的声音、再播放这段录音。录音只留在本机

**验收:**

- 把一个词收入生词本后，关掉页面再打开，词还在。
- 断开网络，仍能复习已经保存在本机的词。
- 导出的 JSON 可以在另一天导回，复习进度与导出前一致。
- 跟读能听到刚才录下的声音。页面不上传这段音频。

### P5：可选的云端复核

**Files:**

- Create: Cloudflare Worker，接收与现在 `/api/vlm-review` 相同形状的请求，转发 DeepSeek。提示词继续不要求坐标框，图片长边 1600
- Modify: 生产构建里的复核开关，默认关闭。打开时请求 Worker 地址（用 `VITE_VLM_ENDPOINT` 这一类构建时配置，值为 Worker 的 URL）
- 密钥只放在 Worker 环境变量

**验收:**

- 开关关闭时，识别一页不产生发往 Worker 或 DeepSeek 的请求。
- 开关打开后，一页难页能返回词表，并走现有 [apps/web/src/domain/align.ts](../../../apps/web/src/domain/align.ts) 的对齐。
- 仓库、`apps/web/dist` 和 iPad 加载的脚本里都搜不到 `DEEPSEEK_API_KEY`。
