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
  ocrText?: string;
}

interface ChatBody {
  messages: IncomingChatMessage[];
  stream?: boolean;
  guest?: boolean;
}

function ndjson(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function isTimeoutError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'ESOCKETTIMEDOUT' || (e?.message ?? '').toLowerCase().includes('timeout');
}

async function buildLLMMessages(
  cfg: AppConfig,
  msgs: IncomingChatMessage[],
  openid: string,
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
): Promise<
  | { ok: true; messages: ChatMessage[]; lastUserOcr?: string }
  | { ok: false; code: string; message: string }
> {
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
  // 历史消息若已带 ocrText 则直接复用，不重复 OCR；只有当前轮新上传的 fileIDs 才会触发 OCR。
  const out: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  let lastUserOcr: string | undefined;
  for (const m of msgs) {
    if (m.role === 'user' && m.fileIDs && m.fileIDs.length > 0 && !m.ocrText) {
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
      const ocrText = imageBlocks.length ? imageBlocks.join('\n\n') : '';
      if (ocrText) lastUserOcr = ocrText;
      const combined = m.content + (ocrText ? '\n\n' + ocrText : '');
      out.push({ role: 'user', content: combined });
    } else if (m.role === 'user' && m.ocrText) {
      // 历史消息：用前端持久化的 OCR 文本，免重复 OCR
      out.push({ role: 'user', content: m.content + '\n\n' + m.ocrText });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  log.info({ totalMs: Date.now() - t0 }, '[chat] build done');
  return { ok: true, messages: out, lastUserOcr };
}

async function streamingHandler(
  reply: FastifyReply,
  llm: LLMProvider,
  buildMessages: () => Promise<
    | { ok: true; messages: ChatMessage[]; lastUserOcr?: string }
    | { ok: false; code: string; message: string }
  >,
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

  // 真流式：边收边发 ndjson delta，避免 HTTP 静默 → 微信网关 idle 超时（102002）。
  // markdown 跨 chunk 风险：保留 30 字尾巴在 buffer，下一轮再尝试 flush。
  let full = '';
  let pending = '';
  const safeWrite = (line: string): boolean => {
    try {
      reply.raw.write(line);
      return true;
    } catch {
      return false;
    }
  };

  safeWrite(ndjson({ type: 'ping' }));

  const built = await buildMessages();
  if (!built.ok) {
    safeWrite(ndjson({ type: 'error', code: built.code, message: built.message }));
    reply.raw.end();
    return;
  }
  const messages = built.messages;
  // 把当前轮 OCR 文本回吐前端，让前端持久化到 userMsg，下一轮即可免重 OCR。
  if (built.lastUserOcr) {
    safeWrite(ndjson({ type: 'ocr', text: built.lastUserOcr }));
  }

  const flushPending = (force: boolean) => {
    if (!pending) return;
    let cutAt = pending.lastIndexOf('\n');
    if (cutAt < 0) {
      if (!force && pending.length <= 30) return;
      cutAt = force ? pending.length - 1 : pending.length - 30 - 1;
    }
    const prefix = pending.slice(0, cutAt + 1);
    pending = pending.slice(cutAt + 1);
    const text = stripMarkdown(prefix);
    if (text) safeWrite(ndjson({ type: 'delta', text }));
  };

  // 心跳：万一首 token 来得慢，每 8s 发一个 ping 防止网关掐连接
  let firstChunkAt = 0;
  const tLLM = Date.now();
  const heartbeat = setInterval(() => {
    if (firstChunkAt === 0) safeWrite(ndjson({ type: 'ping' }));
  }, 8000);

  try {
    if (llm.chatStream) {
      full = await llm.chatStream(messages, (chunk) => {
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        pending += chunk;
        flushPending(false);
      });
    } else {
      full = await llm.chat(messages);
      pending = full;
    }
    flushPending(true);
    clearInterval(heartbeat);
    console.log(
      `[chat] llm done ms=${Date.now() - tLLM} chars=${full.length} firstMs=${firstChunkAt ? firstChunkAt - tLLM : -1}`,
    );
  } catch (err) {
    clearInterval(heartbeat);
    console.error('[chat] llm failed', err);
    safeWrite(ndjson({ type: 'error', code: 'LLM_FAIL', message: 'AI 响应失败，请重试' }));
    reply.raw.end();
    return;
  }

  // AI 输出内容安全（对全文做一次）
  const safe = await checkText(cfg.cloudbaseEnvId, openid, full);
  if (!safe.ok) {
    safeWrite(ndjson({ type: 'warning', message: '此回复部分内容已被过滤' }));
  }

  const remainingUses = await beforeCommit();
  safeWrite(ndjson({ type: 'done', remainingUses }));
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

      const isGuest = body.guest === true;
      const user = isGuest ? null : await getOrCreateUser(req.openid, req.unionid);
      const isPaid = !!(user?.paid_until && user.paid_until.getTime() > Date.now());
      const limit = isPaid ? cfg.dailyLimit.paid : cfg.dailyLimit.free;

      const date = todayBeijing();
      const bonusAvail = (user?.bonus_balance ?? 0) > 0;
      if (!isGuest) {
        const used = await getUsage(req.openid, date);
        if (!bonusAvail && used >= limit) {
          return reply.code(429).send({
            error: 'RATE_LIMIT',
            message: `Daily quota ${limit} exceeded`,
            remainingUses: 0,
          });
        }
      }

      req.log.info({ openid: req.openid.slice(0, 8), stream: body.stream !== false, guest: isGuest }, '[chat] req in');
      // Use today's quota first. Invite rewards are a one-time extra balance and
      // should only be consumed after the daily free/paid quota is exhausted.
      const commit = async (): Promise<number> => {
        if (isGuest) return -1;
        const usedNow = await getUsage(req.openid, date);
        if (usedNow < limit) {
          await incrementUsage(req.openid, date);
        } else if (bonusAvail) {
          await decrementBonusAtomic(req.openid);
        }
        await incrementTotalUses(req.openid);
        const usedAfter = await getUsage(req.openid, date);
        return Math.max(0, limit - usedAfter);
      };

      if (body.stream === false) {
        const built = await buildLLMMessages(cfg, body.messages, req.openid, req.log);
        if (!built.ok) {
          return reply.code(400).send({ error: built.code, message: built.message });
        }
        let content: string;
        const tLLM = Date.now();
        try {
          content = await llm.chat(built.messages);
          req.log.info({ ms: Date.now() - tLLM, chars: content.length }, '[chat] nonstream llm done');
        } catch (err) {
          if (llm.chatStream && isTimeoutError(err)) {
            req.log.warn({ err, openid: req.openid.slice(0, 8) }, 'LLM nonstream timed out, retrying with stream');
            try {
              content = await llm.chatStream(built.messages, () => undefined);
              req.log.info({ ms: Date.now() - tLLM, chars: content.length }, '[chat] stream fallback llm done');
            } catch (fallbackErr) {
              req.log.error({ err: fallbackErr, openid: req.openid.slice(0, 8) }, 'LLM stream fallback failed');
              return reply.code(500).send({ error: 'LLM_FAIL', message: 'AI 响应失败，请重试' });
            }
          } else {
            req.log.error({ err, openid: req.openid.slice(0, 8) }, 'LLM failed');
            return reply.code(500).send({ error: 'LLM_FAIL', message: 'AI 响应失败，请重试' });
          }
        }
        if (!content) {
          req.log.error({ openid: req.openid.slice(0, 8) }, 'LLM returned empty content');
          return reply.code(500).send({ error: 'LLM_FAIL', message: 'AI 响应失败，请重试' });
        }
        const safe = await checkText(cfg.cloudbaseEnvId, req.openid, content);
        if (!safe.ok) {
          content = '回复内容被审核拦截，请换个角度问问';
        }
        content = stripMarkdown(content);
        const remainingUses = await commit();
        req.log.info({ chars: content.length, remainingUses }, '[chat] nonstream response ready');
        return built.lastUserOcr
          ? { content, remainingUses, ocrText: built.lastUserOcr }
          : { content, remainingUses };
      }

      // stream=true 默认走流式
      await streamingHandler(
        reply,
        llm,
        () => buildLLMMessages(cfg, body.messages, req.openid, req.log),
        cfg,
        req.openid,
        commit,
      );
    });
  };
