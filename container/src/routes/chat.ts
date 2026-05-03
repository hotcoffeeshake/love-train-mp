import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AppConfig } from '../config.js';
import { getUsage, incrementUsage } from '../db/quota.js';
import { decrementBonusAtomic, getOrCreateUser, incrementTotalUses } from '../db/users.js';
import { stripMarkdown } from '../llm/strip-markdown.js';
import type { ChatMessage, LLMProvider } from '../llm/types.js';
import { ocrImageBase64 } from '../ocr/tencent-ocr.js';
import { checkImage, checkText } from '../security/wechat-security.js';
import { downloadFileAsBase64 } from '../storage/cos.js';
import { SYSTEM_PROMPT } from '../system-prompt.js';
import { todayBeijing } from '../utils/date.js';

interface IncomingChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  fileIDs?: string[];
}

interface ChatBody {
  messages: IncomingChatMessage[];
  stream?: boolean;
}

function ndjson(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

async function buildLLMMessages(
  cfg: AppConfig,
  msgs: IncomingChatMessage[],
  openid: string,
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
): Promise<{ ok: true; messages: ChatMessage[] } | { ok: false; code: string; message: string }> {
  const t0 = Date.now();
  log.info({ openid: openid.slice(0, 8), msgCount: msgs.length }, '[chat] build start');

  // 内容安全：用户最新消息文本（仅最后一条 user）
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    const r = await checkText(cfg.cloudbaseEnvId, openid, lastUser.content);
    log.info({ ms: Date.now() - t0, ok: r.ok }, '[chat] text safe');
    if (!r.ok) return { ok: false, code: 'UNSAFE_CONTENT', message: '消息含敏感内容，换个说法试试' };
  }

  // 处理图片 → base64 → 内容安全 → 拼进 message content
  const out: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const m of msgs) {
    if (m.fileIDs && m.fileIDs.length > 0 && m.role === 'user') {
      const imageBlocks: string[] = [];
      let idx = 0;
      for (const fid of m.fileIDs.slice(0, 5)) {
        idx += 1;
        const tImg = Date.now();
        try {
          const dl = await downloadFileAsBase64(cfg.cloudbaseEnvId, fid);
          log.info({ ms: Date.now() - tImg, sizeKB: Math.round(dl.base64.length / 1024) }, '[chat] image downloaded');
          const safe = await checkImage(cfg.cloudbaseEnvId, openid, dl.base64);
          if (!safe.ok) {
            return { ok: false, code: 'UNSAFE_IMAGE', message: '图片不合规，请换一张' };
          }
          const tOcr = Date.now();
          const text = await ocrImageBase64(dl.base64);
          log.info({ ms: Date.now() - tOcr, chars: text.length }, '[chat] ocr done');
          if (text) {
            imageBlocks.push(`[图片${idx} OCR 文字]\n${text}`);
          } else {
            imageBlocks.push(`[图片${idx}：无可识别文字（可能是纯图、人脸或表情）]`);
          }
        } catch (err) {
          log.error({ err, fid: fid.slice(0, 60) }, '[chat] image processing failed');
          imageBlocks.push(`[图片${idx}：处理失败]`);
        }
      }
      const combined = m.content + (imageBlocks.length ? '\n\n' + imageBlocks.join('\n\n') : '');
      out.push({ role: 'user', content: combined });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  log.info({ totalMs: Date.now() - t0 }, '[chat] build done');
  return { ok: true, messages: out };
}

async function streamingHandler(
  reply: FastifyReply,
  llm: LLMProvider,
  messages: ChatMessage[],
  cfg: AppConfig,
  openid: string,
  beforeCommit: () => Promise<number>,
): Promise<void> {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });

  let full = '';
  const tLLM = Date.now();
  try {
    if (llm.chatStream) {
      // 全部攒齐再清 markdown 一次性发，避免跨 chunk 的 ** 标记切断
      full = await llm.chatStream(messages, () => {});
    } else {
      full = await llm.chat(messages);
    }
    full = stripMarkdown(full);
    reply.raw.write(ndjson({ type: 'delta', text: full }));
    console.log(`[chat] llm done ms=${Date.now() - tLLM} chars=${full.length}`);
  } catch (err) {
    console.error('[chat] llm failed', err);
    reply.raw.write(ndjson({ type: 'error', code: 'LLM_FAIL', message: 'AI 响应失败，请重试' }));
    reply.raw.end();
    return;
  }

  // AI 输出内容安全
  const safe = await checkText(cfg.cloudbaseEnvId, openid, full);
  if (!safe.ok) {
    reply.raw.write(ndjson({ type: 'warning', message: '此回复部分内容已被过滤' }));
  }

  const remainingUses = await beforeCommit();
  reply.raw.write(ndjson({ type: 'done', remainingUses }));
  reply.raw.end();
}

export const chatRoutes =
  (cfg: AppConfig, llm: LLMProvider): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: ChatBody }>('/chat', async (req, reply) => {
      const body = req.body;
      if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.code(400).send({ error: 'INVALID_BODY', message: 'messages required' });
      }

      const user = await getOrCreateUser(req.openid, req.unionid);
      const isPaid = !!(user.paid_until && user.paid_until.getTime() > Date.now());
      const limit = isPaid ? cfg.dailyLimit.paid : cfg.dailyLimit.free;

      const date = todayBeijing();
      const used = await getUsage(req.openid, date);
      const bonusAvail = (user.bonus_balance ?? 0) > 0;
      if (!bonusAvail && used >= limit) {
        return reply.code(429).send({
          error: 'RATE_LIMIT',
          message: `Daily quota ${limit} exceeded`,
          remainingUses: 0,
        });
      }

      req.log.info({ openid: req.openid.slice(0, 8), stream: body.stream !== false }, '[chat] req in');
      const built = await buildLLMMessages(cfg, body.messages, req.openid, req.log);
      if (!built.ok) {
        return reply.code(400).send({ error: built.code, message: built.message });
      }

      // commit returns the post-commit remainingUses (today's daily remaining only;
      // bonus_balance is rendered separately on the client via /auth/me).
      const commit = async (): Promise<number> => {
        let bonusConsumed = false;
        if (bonusAvail) bonusConsumed = await decrementBonusAtomic(req.openid);
        if (!bonusConsumed) await incrementUsage(req.openid, date);
        await incrementTotalUses(req.openid);
        const usedAfter = await getUsage(req.openid, date);
        return Math.max(0, limit - usedAfter);
      };

      if (body.stream === false) {
        let content: string;
        try {
          content = await llm.chat(built.messages);
        } catch (err) {
          req.log.error({ err, openid: req.openid.slice(0, 8) }, 'LLM failed');
          return reply.code(500).send({ error: 'LLM_FAIL', message: 'AI 响应失败，请重试' });
        }
        const safe = await checkText(cfg.cloudbaseEnvId, req.openid, content);
        if (!safe.ok) {
          content = '回复内容被审核拦截，请换个角度问问';
        }
        content = stripMarkdown(content);
        const remainingUses = await commit();
        return { content, remainingUses };
      }

      // stream=true 默认走流式
      await streamingHandler(reply, llm, built.messages, cfg, req.openid, commit);
    });
  };
