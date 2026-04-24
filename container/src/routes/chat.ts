import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { getUsage, incrementUsage } from '../db/quota.js';
import { getOrCreateUser, incrementTotalUses } from '../db/users.js';
import type { ChatMessage, LLMProvider } from '../llm/types.js';
import { SYSTEM_PROMPT } from '../system-prompt.js';
import { todayBeijing } from '../utils/date.js';

interface ChatBody {
  messages: ChatMessage[];
  stream?: boolean;
}

export const chatRoutes =
  (cfg: AppConfig, llm: LLMProvider): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: ChatBody }>('/chat', async (req, reply) => {
      const body = req.body;

      if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.code(400).send({ error: 'INVALID_BODY', message: 'messages required' });
      }

      await getOrCreateUser(req.openid, req.unionid);

      const date = todayBeijing();
      const used = await getUsage(req.openid, date);
      if (used >= cfg.dailyQuota) {
        return reply.code(429).send({
          error: 'RATE_LIMIT',
          message: `Daily quota ${cfg.dailyQuota} exceeded`,
          remainingUses: 0,
        });
      }

      const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...body.messages];

      let content: string;
      try {
        content = await llm.chat(messages);
      } catch (err) {
        req.log.error({ err, openid: req.openid.slice(0, 8) }, 'LLM failed');
        return reply.code(500).send({ error: 'LLM_FAIL', message: 'AI 响应失败，请重试' });
      }

      await incrementUsage(req.openid, date);
      await incrementTotalUses(req.openid);

      return { content, remainingUses: Math.max(0, cfg.dailyQuota - used - 1) };
    });
  };
