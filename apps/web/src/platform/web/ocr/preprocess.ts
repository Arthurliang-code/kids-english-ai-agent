export interface PreprocessConfig {
  /** 识别输入图的长边上限 */
  maxEdge: number;
  grayscale: boolean;
}

export interface PreprocessOutput {
  canvas: HTMLCanvasElement;
  imageBytes?: Uint8Array;
  width: number;
  height: number;
  /** 输出图相对原图的比例 */
  scale: number;
  elapsedMs: number;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
}

function canvasToJpegBytes(canvas: HTMLCanvasElement, quality = 0.88): Promise<Uint8Array | undefined> {
  if (typeof canvas.toBlob !== 'function') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(undefined);
          return;
        }
        void blob
          .arrayBuffer()
          .then((buffer) => resolve(new Uint8Array(buffer)))
          .catch(() => resolve(undefined));
      },
      'image/jpeg',
      quality,
    );
  });
}

export async function preprocess(
  img: HTMLImageElement,
  config: PreprocessConfig,
): Promise<PreprocessOutput> {
  const started = performance.now();
  const naturalWidth = img.naturalWidth;
  const naturalHeight = img.naturalHeight;

  if (naturalWidth === 0 || naturalHeight === 0) {
    throw new Error('图片尺寸为 0，无法识别');
  }

  const scale = Math.min(1, config.maxEdge / Math.max(naturalWidth, naturalHeight));
  const width = Math.round(naturalWidth * scale);
  const height = Math.round(naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: config.grayscale });
  if (!ctx) throw new Error('无法创建 canvas 绘图上下文');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  let usedGpuGrayscale = false;
  if (config.grayscale && 'filter' in ctx) {
    ctx.filter = 'grayscale(1)';
    usedGpuGrayscale = ctx.filter === 'grayscale(1)';
  }

  ctx.drawImage(img, 0, 0, width, height);

  if (config.grayscale && !usedGpuGrayscale) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = (pixels[i]! * 77 + pixels[i + 1]! * 150 + pixels[i + 2]! * 29) >> 8;
      pixels[i] = gray;
      pixels[i + 1] = gray;
      pixels[i + 2] = gray;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  const imageBytes = await canvasToJpegBytes(canvas, 0.88);

  return {
    canvas,
    imageBytes,
    width,
    height,
    scale,
    elapsedMs: performance.now() - started,
  };
}

/** 给云端复核用的整页 JPEG（彩色、限长边、有损压缩），避免把原图原样上传 */
export function toJpegDataUrl(img: HTMLImageElement, maxEdge: number, quality = 0.85): string {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 绘图上下文');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL('image/jpeg', quality);
}
