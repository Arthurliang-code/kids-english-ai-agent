# 儿童英语点读工具 技术设计 v1

> **2026-11-09：本文的架构决策已由 [kids-english-app-personal.md](kids-english-app-personal.md) 取代。** 实现时以个人版的范围为准。OCR 阈值、VLM 不取坐标框、资源从本地 `BASE_URL` 加载等实测仍然有效，见下文「置信度归一化」与仓库里的 `apps/web/vite.config.ts`、`apps/web/src/platform/web/vlm/client.ts`。CloudBase、Capacitor 双轨、三套环境和云端 ASR 不再作为实现依据。

日期：2026-11-05
依据：`kids-english-app-plan-v2.md`（下称"方案"）
定位：**可执行的技术设计**，开发人员照此实现，不需要再做大方向决策。

---

## 一、已定决策

| 项 | 决策 | 理由 |
|---|---|---|
| 交付形态 | **PWA + Capacitor 壳双轨** | 前期用 PWA 拿到"部署即生效"，能力抽象成接口；OCR/ASR 实测不达标时套壳接 Apple Vision，业务代码零改动 |
| 目标设备 | iPad Pro 11 寸（非 M4，M1/M2），Safari / 主屏幕 PWA | 方案第十九节 |
| 前端 | React 18 + TypeScript + Vite，PWA（Workbox） | 生态成熟，Capacitor 可复用同一套代码 |
| 数据层 | **本地优先 + 轻云同步**：IndexedDB 为唯一读源，CloudBase 只做同步与报告 | 断网可用、免注册可拍、隐私最小化 |
| 后端 | 腾讯云开发 CloudBase：云函数 + 文档数据库 + 存储 + 静态托管 + CDN | 方案第十五、十六节 |
| 端侧 OCR | Web：WASM OCR（PaddleOCR/RapidOCR 分档实测）；壳：Apple Vision | 方案第二十节结论 + 双轨回退 |
| 云端 OCR | 腾讯云 OCR，仅低置信复核，只收裁切文字区域 | 成本与合规 |
| TTS | 国内云端 TTS 预合成 + 哈希缓存；离线用系统语音兜底并明示 | 方案第六节 |
| 跟读打分 | 录音 → 云端 ASR 转录 → 字符级对齐打分；鼓励文案用模板 | 方案第十八节 |
| DeepSeek Flash | 只做离线批量内容生成 + OCR 文本纠错，不进实时关键路径 | 方案第十八节 |

### 方案中已失效的章节（实现时不要照做）

| 方案章节 | 失效内容 |
|---|---|
| 十四节 | Shorebird 热补丁、TestFlight、App Store 更新路径 → Web 端不存在 |
| 十五节 | Flutter + 端侧 PaddleOCR 客户端结论 → 仅后端架构仍有效 |
| 十六节 | 不变，仍然有效（后端清单） |
| 十九节 | Apple Vision 作为 MVP 端侧主力、AVSpeechSynthesizer、原生录音 → 降级为壳路线 |
| 十二节 | 三期路线需按本文第十五节重写 |
| 十八节成本 | 漏算 ASR 与真人录音，见本文第十三节修正 |

---

## 二、系统总览

```
┌────────────────────────── 客户端（同一套代码） ──────────────────────────┐
│  PWA (Safari / 主屏)              │  Capacitor 壳 (Phase 2，按需)        │
│  WebAdapter                       │  NativeAdapter                        │
│   getUserMedia / Canvas           │   Capacitor Camera                    │
│   WASM OCR                        │   VNRecognizeTextRequest              │
│   AudioWorklet → WAV 16k          │   AVAudioRecorder                     │
│   <audio> + 时间戳                 │   AVPlayer / AVSpeechSynthesizer       │
└──────────────┬────────────────────┴────────────────┬──────────────────────┘
               │ HTTPS（device token）                │
┌──────────────▼─────────────────────────────────────▼──────────────────────┐
│                        CloudBase 云函数（Node.js LTS）                     │
│  bootstrap │ auth │ progress-sync │ ocr-fallback │ ocr-correct            │
│  tts-cache │ asr-score │ report-weekly │ content-admin                    │
└───────┬──────────────────┬──────────────────┬─────────────────────────────┘
        │                  │                  │
   ┌────▼────┐      ┌──────▼──────┐    ┌─────▼──────┐
   │ 文档数据库│      │ 存储 + CDN   │    │ 外部服务    │
   │ words…   │      │ content-public│    │ 腾讯云 OCR │
   │ progress │      │ user-private  │    │ 腾讯云 TTS │
   │ usage    │      │ backup        │    │ 国内 ASR   │
   └──────────┘      └──────────────┘    │ DeepSeek   │
                                          └────────────┘
```

**数据流（点词主链路）**

```
拍照 → 端侧预处理 → 端侧 OCR → 置信度分流
  ├─ 高置信 + 词库内 → 词卡 + 音频（缓存命中直接播）
  ├─ 中置信 → 词典纠错 → 展示（带微提示）
  └─ 低置信 → 裁切区域上传 ocr-fallback → ocr-correct(Flash) → 候选点选 / 重拍
```

---

## 三、仓库与工程结构

单仓多包，pnpm workspace。

```
/
├─ apps/
│  ├─ web/                     # PWA 主应用
│  │  ├─ src/
│  │  │  ├─ app/               # 入口、路由、全局 Provider
│  │  │  ├─ features/          # capture / wordcard / reading / review / report / settings
│  │  │  ├─ platform/
│  │  │  │  ├─ core/           # PlatformAdapter 接口、能力探测、降级编排
│  │  │  │  ├─ web/            # Web 实现
│  │  │  │  └─ native/         # 预留入口，Phase 2 接入
│  │  │  ├─ domain/            # 词、纠错、复习调度（纯函数，可单测）
│  │  │  ├─ data/              # IndexedDB、同步队列、内容包加载
│  │  │  └─ ui/                # 设计系统、通用组件
│  │  └─ public/               # manifest.webmanifest、图标
│  ├─ cms/                     # 内容管理后台（React，静态托管）
│  └─ shell/                   # Capacitor 壳（Phase 2 创建）
├─ services/
│  ├─ functions/               # 云函数，一函数一目录
│  ├─ content-pipeline/        # 内容校验 / 打包 / 清单生成
│  └─ eval/                    # 测试集跑分脚本（OCR/TTS/ASR 验收）
├─ packages/
│  ├─ shared-types/            # API 契约、manifest schema（前后端共用）
│  ├─ lexicon/                 # 儿童词库、混淆规则表
│  └─ ui-tokens/               # 设计变量
├─ test-data/                  # 测试集索引（图片本体放对象存储，不进 git）
└─ .github/workflows/          # CI/CD
```

**硬约束**

- `domain/` 不允许 import `platform/`、`data/`，保持纯函数可测。
- `platform/core` 之外不允许直接调用 `getUserMedia` / `MediaRecorder` / `Audio`，CI 加 ESLint 规则拦截。
- 所有外部接口类型放 `packages/shared-types`，前后端只从这一处取。

---

## 四、平台适配层

这一层是双轨的关键：**只有这 5 个方法需要两套实现**。

```ts
// packages/shared-types 之外的运行时接口，放 apps/web/src/platform/core/types.ts
export type Capability = 'camera' | 'album' | 'onDeviceOcr' | 'recording' | 'offlinePack';

export interface PlatformAdapter {
  readonly kind: 'web' | 'native';
  supports(cap: Capability): boolean;

  capture(opts: CaptureOptions): Promise<RawImage>;
  ocr(image: RawImage, ctx: OcrContext): Promise<OcrResult>;
  record(opts: RecordOptions): Promise<AudioClip>;
  play(url: string, opts: PlayOptions): Promise<PlayHandle>;
  speakOffline(text: string, style: SpeakStyle): Promise<void>;
}
```

```ts
export interface CaptureOptions {
  source: 'camera' | 'album';
  maxEdge: number;        // 默认 2048，兼顾清晰度与内存
  quality: number;        // 0.9
}

export interface RawImage {
  blob: Blob;
  width: number;
  height: number;
  source: 'camera' | 'album';
  capturedAt: number;
}

export interface OcrWord {
  text: string;
  confidence: number;     // 统一归一化到 0–1
  quad: Quad;             // 4 点，归一化到 0–1，避免分辨率耦合
  lineId: string;
  indexInLine: number;
}

export interface OcrResult {
  words: OcrWord[];
  lines: OcrLine[];
  engine: 'wasm' | 'vision' | 'cloud';
  elapsedMs: number;
  rawText: string;
}

export interface AudioClip {
  blob: Blob;
  mimeType: string;       // 统一输出 audio/wav
  durationMs: number;
  sampleRate: 16000;
}
```

### 两种实现对照

| 能力 | Web 实现 | Native 实现（Phase 2） |
|---|---|---|
| capture | `getUserMedia` + `<video>` 截帧 / `<input type=file accept=image/*>` | Capacitor Camera，原始分辨率 |
| ocr | WASM OCR（懒加载模型） | `VNRecognizeTextRequest`，`.accurate` |
| record | AudioWorklet 采集 PCM → 重采样 16k → 编码 WAV | AVAudioRecorder，直接 16k PCM |
| play | `<audio>` + 预合成文件 | AVPlayer |
| speakOffline | `SpeechSynthesis`（英文音色，需预下载） | AVSpeechSynthesizer |

### 能力探测与降级编排

```ts
// platform/core/ocr.ts
async function recognize(image: RawImage, ctx: OcrContext): Promise<OcrResult> {
  if (adapter.supports('onDeviceOcr')) {
    const local = await adapter.ocr(image, ctx);
    if (needsCloudReview(local)) {
      return reviewWithCloud(image, local, ctx);   // 失败则返回 local，不阻塞
    }
    return local;
  }
  return reviewWithCloud(image, EMPTY_RESULT, ctx);
}
```

`needsCloudReview` 判据：存在任一低置信词，或平均置信度 < 0.75。云端失败**不报错**，回落本地结果 + 界面提示"部分词可能需要重拍"。

### 云端语义复核（VLM）与对齐层（2026-11-06 实测后新增）

**为什么加这一层**：端侧 OCR 的瓶颈不在精度而在召回。真实手机照片上，词库门控后的可信词精确率 95%、召回只有约 45%——大量正确词因为置信度低或词库缺变形被丢掉，而中文说明文字被拆成的拉丁垃圾又很难在词层面判掉。

**实测依据（9 张真实照片 + 1 张人工逐词标注页）**

| 指标 | 端侧 OCR | 云端 VLM |
|---|---|---|
| 词表精确率（6579 页） | 88.9% | **100%** |
| 词表召回（6579 页） | 72.7% | **100%** |
| 单页耗时 | 510 ms | 376 ms |
| 单页 token | — | 12.7k（不带坐标）/ 18.2k（带坐标） |

**关键否决项：VLM 的坐标不能用。** 九个页面上 VLM bbox 与 OCR 框的平均 IoU 为 0.00–0.02，IoU ≥ 0.5 的比例 0–4%。因此：

```
端侧 OCR  →  词 + 精确坐标 + 置信度   ← 点读的唯一坐标来源
云端 VLM  →  完整词表 + 纠错 + 教学取舍  ← 只买语义
对齐层    →  VLM 只改文本，坐标一律沿用 OCR 的
```

**对齐规则**（`apps/web/src/domain/align.ts`）

1. 精确匹配：OCR 文本与 VLM 词一致 → `exact`，坐标复用，多次出现合并计数。
2. 纠错匹配：OCR 词未命中词库或置信度低于 `CONFIDENCE_THRESHOLDS.high`、长度 ≥ 3，且与某个未被占用的 VLM 词首字母相同、编辑距离 ≤ `max(1, 0.34 × 长度)` → `corrected`，保留 `ocrText` 供人工核对。
3. 其余 VLM 词 → `vocabulary`，进「本页词表」，**没有坐标、不可点读**。

一对一只消费一次候选，避免多个垃圾词吸到同一个正确词上；高置信且命中词库的词不参与纠错，防止把本来就对的词改坏。

**能力边界（必须写进产品文案，不能糊弄）**：OCR 把 `played` 认成 `ga` 时，文本对不上就无法把框贴回去。所以 VLM 补出来的词只能进「本页词表」，**点读覆盖率仍然等于 OCR 认对的词**。混合方案提升的是词表完整性和教学取舍，不是点读覆盖率。

**接口契约**

```
POST /api/vlm-review
{ "image": "data:image/jpeg;base64,..." }        // 长边压到 1600，质量 0.85

200 { model, level, words:[{text,teach}], uncertain:[{guess,reason}], usage, latencyMs }
501 { error }   // 未配置密钥
502 { error }   // 上游失败 / 输出不是 JSON
```

- 提示词里**不要 bbox**：要了也没用，反而让单页 token 从 12.7k 涨到 18.2k。
- 本地开发由 Vite 中间件代转（`apps/web/vite.config.ts`），密钥只存在开发进程，不进前端产物；正式环境换成 CloudBase 云函数，App 端只认同源路径。
- 与端侧识别**并行**发起，云端失败只降级提示，绝不阻塞本地结果。

**尚未验证**：单页 token 成本折算、VLM 在低质量照片上的稳定性、privacy 合规（照片属未成年人作业，需在隐私政策中说明"上传整页缩略图用于语义复核"并提供关闭开关）。

### 置信度归一化（必须校准）

不同引擎置信尺度不同（Vision 偏高、Tesseract 偏低）。做法：

- 建 100 页标注集，对每个引擎统计置信度分桶与真实正确率的对应关系。
- 拟合映射表 `rawConfidence → calibratedConfidence`，写进 `packages/lexicon/calibration.ts`。
- 阈值只认校准后的值：`HIGH ≥ 0.85`、`MID 0.60–0.85`、`LOW < 0.60`。
- 2026-11-06 实测修正：Tesseract 未校准时把 HIGH 降到 0.70 更划算（可信词覆盖 75.6%→82.0%，精确率 97.0%→95.7%，6 张带文本层标注页）；接入 Vision 后须按校准结果重定。
- 换引擎必须重跑校准，写进验收清单。

---

## 五、核心链路

### 5.1 拍照与采集

**Web 端实现要点**

- 优先 `getUserMedia({ video: { facingMode: 'environment', width: { ideal: 2560 } } })`，从 video 流截帧到 canvas。
- iOS Safari 无可靠 ImageCapture API，不依赖 `ImageCapture.takePhoto()`。
- 相册入口用 `<input type="file" accept="image/*">`，读 EXIF 方向后重绘纠正。
- 取景引导：文字框检测用轻量边缘/梯度统计（不引模型），检测到"页面占比 < 40%"或"画面倾斜 > 8°"给提示。
- 拍摄质量门：拉普拉斯方差判断模糊、亮度直方图判断过暗/过曝；不达标直接提示重拍，不进入 OCR。
- 输出统一为长边 2048 的 JPEG（质量 0.9）。原图只在内存中，不落 IndexedDB。

**主屏 PWA 相机的已知限制**（Phase 0 验证项 E3）

- 添加到主屏幕后 `getUserMedia` 需 HTTPS，且首次必须由用户手势触发。
- 无法像原生一样指定对焦/曝光；只能靠用户构图。
- 拿不到系统相机的高动态范围与多帧合成，弱光下质量明显不如原生相机。
- 兜底：始终保留"从相册选"入口，并引导家长"手机拍好 → 隔空投送 → iPad 相册导入"。

### 5.2 图像预处理（端侧，Canvas / WASM）

顺序固定，每步都有开关便于 A/B：

1. 转灰度（加权 `0.299R + 0.587G + 0.114B`）。
2. 缩放到长边 1600（OCR 输入尺寸），保留一份 2048 用于界面显示与词框渲染。
3. 自适应二值化（Sauvola），彩色绘本背景在此步弱化为白底。
4. 轻量去噪（3×3 中值）。
5. 倾斜校正：基于文本行估计主方向，旋转 ±8° 以内。

透视纠偏（书页弯曲）**MVP 不做**，改成拍摄引导 + 允许用户手动拖四角裁切。原因：端侧文档展平模型体积与算力开销大，收益不如引导。

> 注意：词框坐标必须做与预处理一致的逆变换，否则点词会错位。实现上把"预处理变换矩阵"随 `RawImage` 一起传递，OCR 输出的 quad 在进入 UI 前统一逆变换回原图坐标。

### 5.3 OCR 与置信度分流

**三档引擎**

| 档 | 触发条件 | 说明 |
|---|---|---|
| 端侧 | 永远先跑 | Web：WASM OCR；壳：Vision |
| 云端复核 | 低置信词存在 / 平均置信 < 0.75 | 腾讯云 OCR，只传裁切文字区域，单张 ≤ 1MB |
| Flash 兜底 | 云端 OCR 仍低置信 | 仅做文本纠错，不产出坐标 |

**分流规则（实现为纯函数 `classifyWord`）**

| 置信度 | 词库校验 | 展示 | 发音 |
|---|---|---|---|
| HIGH | 在词库 | 直接展示 | 直接发音 |
| HIGH | 不在词库 | **强制降级为 MID** | 禁止发音（零容忍项） |
| MID | 纠错后命中词库 | 展示 + 角标 | 发音 |
| MID | 仍不命中 | 候选 Top3 | 不发音 |
| LOW | 任意 | 候选 Top3 + "重拍"按钮 | 不发音 |

**后处理纠错（`domain/correct.ts`）**

1. 混淆对替换表：`l↔I↔1`、`O↔0`、`rn↔m`、`cl↔d`、`vv↔w`、`ii↔u`。命中即生成候选。
2. 词典编辑距离：距离 ≤ 1 直接接受；距离 = 2 时只在词长 ≥ 6 时接受。
3. 句子级纠错（可选，低置信批量走）：整页 `rawText` 一次调用 `ocr-correct`，输出必须限定为词库内词，服务端二次校验，非法结果丢弃。
4. 版式还原：跨行连字符合并、词首尾标点剥离、全角转半角、大小写按句首规则还原。

**缓存**：`ocr-correct` 的缓存键 = `sha256(rawText + lexiconVersion)`，命中直接返回，不重复计费。

### 5.4 点词命中

- 坐标全程使用归一化 quad，渲染时乘容器尺寸。
- 命中判定顺序：① 点在四边形内（交叉数法）→ ② 多个命中取中心距离最近 → ③ 仍未命中，取距离 < 24pt 的最近词。
- 触控热区：向四周扩展至最小 48×48pt，但**不越过相邻词的中点线**，避免串词。
- 命中即预加载该词音频（`<link rel=preload>` 或 `fetch` 进 Cache Storage），点击到出声目标 < 150ms。

### 5.5 词卡与解释分层

- 低年级（3–6）：图片 + 一句话中文 + 一个生活例句 + 发音按钮（直径 ≥ 88pt）。
- 高年级（6–10）：追加词性、变形、近反义词。
- 例句与释义来自内容包，**不在端上实时生成**。DeepSeek 生成的草稿经人工审校后才入包。

### 5.6 TTS 播放与词级高亮

**播放策略**

| 场景 | 音源 | 说明 |
|---|---|---|
| 核心词 | 真人录音（预合成包） | 3000 核心词一次录完，随内容包下发 |
| 例句 | 预合成 TTS，按句子哈希缓存 | 高频句全部预生成 |
| 新拍句子 | 实时合成 / 流式 | 仅首次，之后命中缓存 |
| 离线且未缓存 | 系统语音兜底 | 界面明确标注"离线语音" |

**词级时间戳**

优先级：

1. TTS 供应商返回词级边界（需在供应商选型时验证是否提供）。
2. 不提供时，离线批量跑强制对齐生成时间戳 JSON，随音频一起公布。
3. 实时合成场景，按字符比例预估 + 播放中由 `timeupdate` 微调，漂移容忍 200ms。

**播放实现**

- 慢速用 TTS 合成参数（`rate` 在合成时生效），**禁止用 `playbackRate` 变速**（会变调）。
- 单例播放器：上一个音频未结束时新点词，淡出 120ms 后切换，避免叠音。
- 音量上限：Web Audio `GainNode` 限制峰值 0.9，防爆音。

### 5.7 跟读与打分

**录音链路（这是最容易踩坑的一环）**

```
AudioWorklet 采集 Float32 PCM (48k)
  → 线性重采样到 16k 单声道
  → 编码 16-bit PCM WAV（44 字节头）
  → 上传 asr-score
```

不用 `MediaRecorder`，因为 iOS Safari 只输出 `audio/mp4`(AAC)，服务端还要 ffmpeg 转码，而 CloudBase Node 云函数默认不带 ffmpeg。端侧直接出 WAV 可省掉整个转码环节。

- 时长上限 5 秒，超时自动截断。
- WAV 体积：16k × 16bit × 5s ≈ 160KB，可接受。
- 录音前必须已获麦克风权限，权限被拒时给图文引导，不弹二次系统框。

**打分规则（儿童宽容）**

| 维度 | 算法 | 权重 |
|---|---|---|
| 完整性 | 目标词音节数 vs ASR 转录音节数覆盖率 | 0.5 |
| 相似度 | 目标词与转录的归一化编辑距离 → 相似度 | 0.5 |
| 重音/语调 | **MVP 不做**，无可靠低成本方案 | 0 |

- 综合 ≥ 0.85 → 3 星；≥ 0.65 → 2 星；其余 → 1 星 + "再听一遍试试"。
- **任何结果不给 0 星、不给"错误"字样**，只给正向措辞。
- 服务端不落库音频，评完即删；只回传分数与转录文本。

**成本控制**

- 每日每设备跟读上传上限 60 次，超出后只做本地录音回放，不打分。
- 同一 `(wordId, audioHash)` 不重复评分。
- 端侧粗评（WASM ASR）列为 Phase 2 可选项，MVP 不做：小模型体积大、精度低，反而不如直接云端。

### 5.8 生词本与复习调度

**调度规则（`domain/scheduler.ts`，纯函数 + 单测覆盖）**

- 每词维护 `stage ∈ [0,5]`，间隔表：`[0, 1, 3, 7, 16, 35]` 天。
- 正确：`stage + 1`（上限 5），下次复习 = 今天 + 间隔。
- 错误：`stage - 1`（下限 0），当天追加一次重测。
- 每日上限：复习 20 词、新词 10 个、总时长约 3 分钟。
- 排序优先级：到期日 > stage 低 > 最近错误多。
- 交叉校验：复习必须"换题型"（听音选图 / 配对 / 跟读），同一个词连续两次同题型不算通过。

---

## 六、数据层

### 6.1 本地 IndexedDB

库名 `kea`，版本 1。

| store | key | 主要字段 | 说明 |
|---|---|---|---|
| `words` | `wordId` | word, phonetic, meaningZh, exampleEn, exampleZh, level, audioWord, audioExample, image, contentVersion | 内容缓存，只读 |
| `progress` | `wordId` | stage, dueAt, lastReviewedAt, correctCount, wrongCount, firstSeenAt, sourceBookId, updatedAt, deleted | **用户数据权威源** |
| `pages` | `pageId` | imageHash, bookId, ocrResult, createdAt | OCR 缓存，键用图片哈希 |
| `books` | `bookId` | title, pageCount, lastOpenedAt | 拍摄历史 |
| `reviewLog` | 自增 | wordId, at, result, mode | 报告用，保留 90 天 |
| `kv` | key | deviceId, deviceToken, syncCursor, settings, packVersions | 杂项 |
| `outbox` | 自增 | op, payload, createdAt, retryCount | 同步队列 |

**写入约定**：任何写 `progress` 的代码必须同时写 `outbox`，同一事务内完成，避免漏同步。

**存储治理**

- 总预算 300MB，音频 LRU 淘汰，图片缓存上限 60MB。
- `navigator.storage.persist()` 启动时申请，失败也要继续（不能阻塞使用）。
- 主屏 PWA 一般不受 Safari 7 天清理限制，但**不视为保证**——这正是需要云同步的原因。

### 6.2 云端集合

| 集合 | 用途 | 关键字段 |
|---|---|---|
| `words` | 词条内容 | word, phonetic, meaning, example, level, packs[], audioWord, audioExample, version |
| `sentences` | 例句与故事句 | text, translation, level, audio, timestamps[] |
| `books` | 教材 / 绘本元数据 | title, grade, publisher, pageCount |
| `content_versions` | 清单快照 | version, manifest, status, publishedAt |
| `devices` | 设备 | deviceId, parentUserId, createdAt, lastSeenAt |
| `user_progress` | 进度（同步副本） | userId, wordId, stage, dueAt, metrics, updatedAt, deleted |
| `feedback_words` | 错词回流 | pageHash, wrongText, correctedText, engine, status |
| `usage_daily` | 用量与成本 | date, deviceId, ocrCalls, ttsChars, asrCalls |
| `parents` | 家长账号 | phoneHash, createdAt, deletedAt |

内容数据与用户数据**分集合、分权限规则**，内容集合只读。

### 6.3 同步协议

- 单向推送 + 拉取，接口 `progress-sync`：
  - `push`: `{ ops: [{ wordId, stage, dueAt, metrics, updatedAt, deleted }] }`，批量 ≤ 100。
  - `pull`: `{ cursor, limit }`，按 `updatedAt` 升序返回。
- 冲突策略：`wordId` 维度 **last-write-wins**，比较 `updatedAt`（客户端用单调时钟 + 首次启动时与服务器校时）。
- 删除用 tombstone（`deleted: true`），保留 30 天后物理清理。
- 触发时机：启动、回到前台、完成一次复习后、每 5 分钟。失败退避 `[2s, 8s, 30s, 120s]`，不弹错误提示。
- 未登录家长：只写本地，`outbox` 保留最近 30 天，登录后一次性补推。

---

## 七、接口契约

统一前缀 `/api`，全部 HTTPS + `Authorization: Bearer <deviceToken>`。

| 函数 | 方法 | 入参（要点） | 出参（要点） | 计费类 |
|---|---|---|---|---|
| `bootstrap` | GET | appVersion, packVersions | manifest, flags, minVersion | 否 |
| `auth` | POST | `{mode:'device'}` / `{mode:'sms', phone, code}` | deviceToken / 家长 token | 否 |
| `progress-sync` | POST | ops[] / cursor | appliedCount, items[], nextCursor | 否 |
| `ocr-fallback` | POST | imageBase64(裁切区), hints | words[]（含 quad、confidence） | **是** |
| `ocr-correct` | POST | rawText, lexiconVersion | corrections[] | **是（低）** |
| `tts-cache` | POST | text, voice, style | `{url, cached, timestamps[]}` | **是** |
| `asr-score` | POST | wavBase64, targetWord | `{score, stars, transcript, tips}` | **是** |
| `report-weekly` | GET | weekStart | 聚合数据 | 否 |
| `content-admin` | POST | 后台 token | 写入内容 | 否 |

### 鉴权与防刷（方案里缺的一环，必须做）

- 首次启动调 `auth` 换 **匿名 deviceToken**（JWT，7 天有效，可静默续期），所有请求必须带。
- 计费类接口**按设备 + 按 IP 双维度配额**：

| 接口 | 单设备/日 | 单 IP/小时 | 超限行为 |
|---|---|---|---|
| `ocr-fallback` | 100 | 300 | 回落端侧结果 + 提示重拍 |
| `asr-score` | 60 | 200 | 仅本地回放，不打分 |
| `tts-cache` | 200 条 | 600 | 只返回已缓存音频 |
| `ocr-correct` | 200 | 600 | 跳过纠错 |

- **日成本熔断**：`usage_daily` 累计超过预算阈值（默认 100 元/日）后，所有实时合成只走缓存，返回 `degraded: true`，客户端降级展示。
- 请求体大小限制：图片 ≤ 1MB、音频 ≤ 400KB、文本 ≤ 8KB。
- 云函数密钥（腾讯云 OCR/TTS/DeepSeek）只放环境变量，前端永不接触。

---

## 八、内容体系

### 8.1 清单结构 `manifest.json`

```json
{
  "schemaVersion": 1,
  "contentVersion": "2026.11.05-1",
  "minAppVersion": "0.3.0",
  "publishedAt": "2026-11-05T08:00:00Z",
  "rollout": { "default": 1.0, "canary": 0.05 },
  "packs": [
    { "id": "words-core", "type": "words", "version": "3", "url": "https://cdn/…/words-core.3.json", "sha256": "…", "bytes": 184320 },
    { "id": "audio-g1", "type": "audio", "version": "7", "url": "…", "sha256": "…", "bytes": 52428800 },
    { "id": "ocr-lexicon", "type": "lexicon", "version": "2", "url": "…", "sha256": "…", "bytes": 960000 }
  ],
  "flags": { "enableSentenceMode": true, "enableArtifactFont": false }
}
```

### 8.2 发布与灰度

1. 内容仓改动 → CI 校验（必填字段、音频文件存在、词在词库内、无脏词）→ 生成带哈希文件 → 上传存储。
2. 生成新清单，`rollout.canary = 0.05`，写 `content_versions`。
3. 设备按 `hash(deviceId) % 100 < canary*100` 命中灰度。
4. 观察 1 天：无错误率上升、无"无声词"告警 → 全量。
5. 回滚：把清单指针指回上一版 `content_versions` 记录，10 分钟内完成。

### 8.3 CDN 缓存

| 资源 | 缓存头 |
|---|---|
| `manifest.json` | `max-age=60, stale-while-revalidate=300` |
| 带哈希内容文件 | `max-age=31536000, immutable` |
| 音频 / 图片 | `max-age=31536000, immutable` |

回滚靠换清单，**不清 CDN**。

---

## 九、PWA 缓存与离线

- **App Shell**：Workbox precache，版本号与构建绑定，新 SW 安装后 `skipWaiting` + 提示刷新。
- **OCR WASM 模型**：进入拍照页才懒加载，约 15–30MB，Cache Storage 长缓存；加载失败时直接走云端 OCR。
- **音频包**：按年级按需下载，不预缓存全部；首次下载显示进度与体积。
- **离线能力边界**（要在界面上写清楚）：
  - 可离线：已下载词的发音、整句朗读（已缓存）、复习、生词本。
  - 不可离线：新拍照的云端复核、新句子实时合成、跟读打分。
- **更新检查时机**：启动、`visibilitychange` 回到前台。iOS 无 Background Sync，不做后台静默更新。
- **存储配额**：iOS 约 1GB 上限，超出前浏览器会询问；我们主动控制在 300MB 内并做 LRU。

---

## 十、安全与合规

| 项 | 措施 |
|---|---|
| 传输 | 全站 HTTPS，HSTS，禁用混合内容 |
| 前端 | CSP（禁 `unsafe-eval`，WASM 需 `wasm-unsafe-eval`），依赖 SRI 校验 |
| 密钥 | 只存云函数环境变量；构建产物扫描禁止出现 `sk-` / `SecretKey` |
| 图片 | 默认本地处理，不落盘持久化；上传仅裁切文字区域，≤1MB |
| 录音 | 仅上传跟读片段，评完即删，不存对象存储 |
| 儿童数据 | 免注册可用；上传类功能需家长明示同意并记录同意时间；不采姓名/学校/位置 |
| 账号注销 | 家长模式内提供"删除账号与数据"，7 天内物理删除 `user_progress`、`devices` |
| 家长模式 | 长按 3 秒 + 两道两位数算术题进入；退出需 4 位 PIN |
| 儿童模式 | 无广告、无外链、无陌生人入口；引导家长开启 iPad 引导式访问 |
| 备案 | 自定义域名 ICP 备案；隐私政策页静态托管在 CMS 内 |

---

## 十一、部署与流水线

### 环境

| 环境 | CloudBase | 用途 | 数据 |
|---|---|---|---|
| dev | 免费体验版 | 开发联调 | 假数据，可清空 |
| staging | 个人版（独立桶） | 灰度前验证 | 脱敏数据 |
| prod | 个人版 | 正式 | 真实 |

三套环境的 OCR/TTS/DeepSeek 密钥、桶名、CDN 域名全部独立，**不允许共用数据库**。

### CI/CD

```
PR → 类型检查 + 单测 + 内容 JSON 校验 + 依赖审计
合并 main → 构建 web（产物体积门禁：首屏 JS < 300KB gzip）
        → 部署静态托管
        → 部署云函数（每个函数独立版本号）
        → 内容打包上传 + 生成灰度清单
        → 冒烟测试（Playwright：拍一页 → 点词 → 出声 → 跟读 → 复习）
```

**冒烟测试失败自动回滚清单**，不自动回滚云函数（避免误伤）。

### 回滚演练（上线前必做一次）

清单回滚 → 函数指回上一版 → Service Worker 强制更新，三步合计 ≤ 10 分钟。

---

## 十二、监控

| 指标 | 采集方式 | 告警阈值 |
|---|---|---|
| 云函数调用量 / 错误率 | CloudBase 监控 | 错误率 > 2% |
| OCR 云端调用量 | `usage_daily` | 日环比 > 2 倍 |
| TTS 合成字符数 | `usage_daily` | 日环比 > 2 倍 |
| ASR 调用次数 | `usage_daily` | 超预算 80% |
| 无声词 | 端侧埋点（点击但无音频） | 单日 > 10 次 |
| 前端错误 | Sentry（或自建上报） | 新增错误类型 |
| 首屏加载 | Web Vitals | LCP > 2.5s |

备份：数据库每日导出到 `backup` 桶；清单每次发布留快照；保留 30 天。

---

## 十三、成本模型（修正方案第十八节）

**方案漏算了 ASR 和真人录音，这两项会改变结论。**

假设：月活 1000 名孩子、每人每月 10 次拍照（合计 1 万次）、每人每天 20 次跟读。

| 项 | 量 | 单价（估算，需以官方价为准） | 月成本 |
|---|---|---|---|
| 云端 OCR | 2000 次（端侧承担 80%） | 0.15 元/次 | 300 元 |
| Flash 纠错 | 约 500 页 | 千分之几元/页 | ≈ 2 元 |
| TTS 新增合成 | 约 20 万字符 | 3.5 元/万字符 | 70 元 |
| **ASR 跟读** | **60 万次** | **≈ 0.003 元/次** | **≈ 1800 元** |
| CDN 流量 | 50GB | ≈ 0.2 元/GB | 10 元 |
| CloudBase 个人版 | 1 | — | 20 元 |
| **合计** | | | **≈ 2200 元/月** |

**结论：ASR 占 78%，是成本主战场，不是 OCR。**

压制手段，按性价比排序：

1. 每日每设备跟读上限 60 次（已在接口层实现）。
2. 端侧先做能量/VAD 检查，静音或过短不上传。
3. `(wordId, audioHash)` 去重评分。
4. 限制单次音频 5 秒，超长截断。
5. 评分结果本地缓存，同一词同一天不重复打分。
6. 鼓励文案用模板，不调 Flash。

**真人录音成本单列**（方案未提）：3000 核心词 × 母语者录制 + 审校 + 版权买断，属于一次性内容生产成本，量级远高于上述月度 API 费用，需单独排预算与排期。

---

## 十四、Phase 0 技术验证门（开发前必须完成）

**目的：用真实数据决定"继续 PWA"还是"提前上壳"。不通过就不写业务代码。**

测试集：30 页真实课本照片（正常光 10 / 斜拍 10 / 反光与弱光 10），逐词标注文本与 quad。

| 编号 | 实验 | 通过线 | 不通过的处理 |
|---|---|---|---|
| E1 | WASM OCR 准确率（PaddleOCR-WASM / RapidOCR / Tesseract.js 三者横评） | 印刷体单词准确率 ≥ 95%，点词命中率 ≥ 95% | 换引擎或调预处理；仍不达标 → 提前上壳 |
| E2 | 端侧延迟（iPad Pro 11 Safari） | 单页识别 ≤ 2s；模型加载后二次进入 ≤ 0.5s | 降输入分辨率 / 换模型；仍不达标 → 上壳 |
| E3 | 主屏 PWA 相机可用性 | 能稳定拿到长边 ≥ 1920 的清晰图，文字肉眼可辨 | 保留相册导入，并在规划中标注"拍摄体验受限" |
| E4 | 录音链路 | AudioWorklet → 16k WAV 可被目标 ASR 正确识别；3 秒片段端到端 ≤ 2.5s | 改回 MediaRecorder + 服务端容器化转码 |
| E5 | TTS 盲听（2–3 候选音色，20 句） | 自然度、清晰度、孩子跟读三项平均 ≥ 4/5；无"听不懂"句 | 换供应商 / 换音色 |
| E6 | 离线可用性 | 已下载内容断网后点读有声率 100% | 调整预缓存策略 |

**决策门**

```
E1 ≥ 95% 且 E2 ≤ 2s  →  PWA 路线继续，进入 M1
E1 < 95% 或 E2 > 2s  →  立即启动 Capacitor 壳（M5 提前），业务代码复用
```

E3/E4/E5/E6 任一不通过，不得进入对应功能的开发。

**产出**：`services/eval/` 下的跑分脚本 + 一份带原始数据的验证报告，写入 `docs/phase0-report.md`。

---

## 十五、里程碑与范围边界

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| M0 | Phase 0 验证 | 六项实验有数据，决策门有结论 |
| M1 | 工程骨架 + 适配层 + 拍照 + 端侧 OCR + 点词 | 真机 iPad 上能拍一页并点出 10 个词 |
| M2 | 词卡 + 音频播放 + 词级高亮 + 内容清单与缓存 | 断网可点读已下载词 |
| M3 | 生词本 + 复习调度 + 本地持久化 | 3 分钟复习流程闭环 |
| M4 | 跟读 + 云端 ASR + 轻云同步 + 家长报告 + CMS | 全链路冒烟通过 |
| M5 | 灰度发布 + 监控告警 + 回滚演练 | 上线检查表全绿 |
| M5' | Capacitor 壳（按 E1/E2 结果决定是否提前） | Vision OCR 达标并回归通过 |

**MVP 明确不做**

- 透视展平 / 书页弯曲校正（用拍摄引导替代）
- 端侧 ASR 粗评
- 重音与语调评分
- 艺术字 / 花体字专项（单独统计，不承诺准确率）
- 家长自建词包、教材同步包（M2 之后再排）
- 安卓适配（单独测试集）
- Web Push（iOS 限制，不做）

---

## 十六、风险登记

| 风险 | 影响 | 概率 | 应对 |
|---|---|---|---|
| WASM OCR 达不到 95% | 核心体验崩塌 | 中高 | Phase 0 早验；不达标即上壳 |
| 主屏 PWA 相机受限 | 拍摄质量差、准确率连带下降 | 中 | 保留相册导入；引导手机拍再导入 |
| ASR 成本超预期 | 单用户成本失控 | 中 | 配额 + 去重 + VAD；必要时降为"每周评分一次" |
| iOS 存储被清理 | 用户数据丢失 | 低中 | 本地优先但强制云同步 + 导出备份 |
| 教材内容版权 | 下架 / 索赔 | 中 | 优先用自编内容与公版绘本，教材包后置并做法务确认 |
| 真人录音排期长 | 拖慢 M2 | 中 | 先用 TTS 顶上，录音到位后按词替换，不阻塞开发 |
| 儿童信息合规 | 无法上架 | 低 | 免注册可用、照片本地处理、录音即删、单独同意 |
| 云函数被刷 | 账单异常 | 中 | device token + 双维度配额 + 日熔断 |

---

## 十七、待确认事项（不阻塞开发，但需在 M4 前定）

1. TTS 供应商是否返回**词级时间戳**（决定高亮方案走供应商回调还是离线强制对齐）。
2. 目标 ASR 供应商的单次调用计价方式与免费额度。
3. 真人录音的执行方（自录 / 外包 / 版权买断方式）。
4. 教材与绘本内容的版权来源与授权范围。
