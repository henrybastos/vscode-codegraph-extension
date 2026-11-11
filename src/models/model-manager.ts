import * as fs from 'node:fs';
import * as path from 'node:path';

export const MODEL_FILENAME = 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf';
export const MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf';
export const EXPECTED_MIN_SIZE_BYTES = 350 * 1024 * 1024; // > 350 MB indicates fully downloaded

export interface ModelProgressInfo {
  pct: number;
  loadedMb: number;
  totalMb: number;
}

export class LocalGGUFModelManager {
  public static getModelDir(globalStoragePath: string): string {
    const dir = path.join(globalStoragePath, 'models');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  public static getModelPath(globalStoragePath: string): string {
    return path.join(this.getModelDir(globalStoragePath), MODEL_FILENAME);
  }

  public static isModelDownloaded(globalStoragePath: string): boolean {
    const target = this.getModelPath(globalStoragePath);
    if (!fs.existsSync(target)) return false;
    try {
      const stat = fs.statSync(target);
      return stat.size >= EXPECTED_MIN_SIZE_BYTES;
    } catch {
      return false;
    }
  }

  public static getModelSizeMb(globalStoragePath: string): number {
    const target = this.getModelPath(globalStoragePath);
    if (!fs.existsSync(target)) return 0;
    try {
      const stat = fs.statSync(target);
      return Math.round((stat.size / (1024 * 1024)) * 10) / 10;
    } catch {
      return 0;
    }
  }

  public static async deleteModel(globalStoragePath: string): Promise<boolean> {
    const target = this.getModelPath(globalStoragePath);
    const tempTarget = target + '.part';
    let deleted = false;
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        deleted = true;
      }
      if (fs.existsSync(tempTarget)) {
        fs.unlinkSync(tempTarget);
        deleted = true;
      }
    } catch (err) {
      console.error('[LocalGGUFModelManager] Error deleting model:', err);
      throw err;
    }
    return deleted;
  }

  public static async downloadModel(
    globalStoragePath: string,
    onProgress?: (info: ModelProgressInfo) => void,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const targetPath = this.getModelPath(globalStoragePath);
    if (this.isModelDownloaded(globalStoragePath)) {
      return targetPath;
    }

    const tempPath = targetPath + '.part';
    const response = await fetch(MODEL_URL, {
      signal: abortSignal,
      headers: {
        'User-Agent': 'VSCode-CodeGraph-Extension/1.0'
      }
    });

    if (!response.ok || !response.body) {
      throw new Error(`Failed to download model: HTTP ${response.status} ${response.statusText}`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 397800000;
    let receivedBytes = 0;

    const fileStream = fs.createWriteStream(tempPath);
    const reader = response.body.getReader();

    try {
      while (true) {
        if (abortSignal?.aborted) {
          fileStream.close();
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          throw new Error('Download aborted by user');
        }

        const { done, value } = await reader.read();
        if (done) break;

        receivedBytes += value.length;
        fileStream.write(Buffer.from(value));

        if (onProgress) {
          const pct = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
          const loadedMb = Math.round((receivedBytes / (1024 * 1024)) * 10) / 10;
          const totalMb = Math.round((totalBytes / (1024 * 1024)) * 10) / 10;
          onProgress({ pct, loadedMb, totalMb });
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end(() => resolve());
        fileStream.on('error', reject);
      });

      // Atomic rename once fully written
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      fs.renameSync(tempPath, targetPath);

      return targetPath;
    } catch (err) {
      fileStream.close();
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
      throw err;
    }
  }
}
