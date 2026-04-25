import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { ocrDebug, ocrImageBase64 } from '../ocr/tencent-ocr.js';
import { downloadFileAsBase64 } from '../storage/cos.js';

interface DebugBody {
  fileID: string;
}

export const debugRoutes = (cfg: AppConfig): FastifyPluginAsync => async (app) => {
  app.get('/debug/env', async () => ({
    hasTencentSecretId:
      Boolean(process.env.TENCENTCLOUD_SECRETID || process.env.TENCENT_SECRET_ID),
    hasTencentSecretKey:
      Boolean(process.env.TENCENTCLOUD_SECRETKEY || process.env.TENCENT_SECRET_KEY),
    hasSessionToken:
      Boolean(process.env.TENCENTCLOUD_SESSIONTOKEN || process.env.TENCENT_SESSION_TOKEN),
    cloudbaseEnvId: cfg.cloudbaseEnvId,
    llmProvider: cfg.llm.provider,
    llmModel: cfg.llm.model,
  }));

  app.post<{ Body: DebugBody }>('/debug/ocr-raw', async (req, reply) => {
    if (!req.body?.fileID) return reply.code(400).send({ error: 'fileID required' });
    try {
      const dl = await downloadFileAsBase64(cfg.cloudbaseEnvId, req.body.fileID);
      const debug = await ocrDebug(dl.base64);
      return { sizeKB: Math.round(dl.base64.length / 1024), ...debug };
    } catch (err) {
      return reply.code(500).send({ error: 'fail', message: (err as Error)?.message });
    }
  });

  app.post<{ Body: DebugBody }>('/debug/ocr', async (req, reply) => {
    if (!req.body?.fileID) {
      return reply.code(400).send({ error: 'fileID required' });
    }
    const t0 = Date.now();
    try {
      const dl = await downloadFileAsBase64(cfg.cloudbaseEnvId, req.body.fileID);
      const tDl = Date.now() - t0;
      const t1 = Date.now();
      const text = await ocrImageBase64(dl.base64);
      const tOcr = Date.now() - t1;
      return {
        ok: true,
        downloadMs: tDl,
        ocrMs: tOcr,
        sizeKB: Math.round(dl.base64.length / 1024),
        textLength: text.length,
        textPreview: text.slice(0, 500),
      };
    } catch (err) {
      return reply.code(500).send({
        error: 'DEBUG_FAIL',
        message: (err as Error)?.message ?? String(err),
        stack: (err as Error)?.stack?.split('\n').slice(0, 5),
      });
    }
  });
};
