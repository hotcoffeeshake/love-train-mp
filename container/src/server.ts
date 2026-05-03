import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyRequest } from 'fastify';
import { loadConfig } from './config.js';
import { connectCloudBase, connectMongo } from './db/mongo.js';
import { createProvider } from './llm/index.js';
import { openidPlugin } from './middleware/openid.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { debugRoutes } from './routes/debug.js';
import { healthRoutes } from './routes/health.js';
import { inviteRoutes } from './routes/invite.js';
import { userRoutes } from './routes/user.js';

async function main() {
  const cfg = loadConfig();
  const app = Fastify({
    logger: {
      level: cfg.nodeEnv === 'production' ? 'info' : 'debug',
      transport: cfg.nodeEnv !== 'production' ? { target: 'pino-pretty' } : undefined,
    },
    bodyLimit: 5 * 1024 * 1024,
  });

  if (cfg.cloudbaseEnvId) {
    connectCloudBase(cfg.cloudbaseEnvId);
    app.log.info(`DB: CloudBase NoSQL (env=${cfg.cloudbaseEnvId})`);
  } else {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('Either CLOUDBASE_ENV_ID or MONGODB_URI must be set');
    }
    await connectMongo(mongoUri, process.env.MONGODB_DB ?? 'love-train-mp');
    app.log.info(`DB: MongoDB (${mongoUri})`);
  }

  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => (req.headers['x-wx-openid'] as string) || req.ip,
  });
  await app.register(openidPlugin);

  const llm = createProvider(cfg);

  await app.register(healthRoutes);
  await app.register(authRoutes(cfg));
  await app.register(userRoutes(cfg));
  await app.register(chatRoutes(cfg, llm));
  await app.register(inviteRoutes(cfg));
  await app.register(debugRoutes(cfg));

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  app.log.info(`love-train-mp listening on ${cfg.port}, provider=${cfg.llm.provider}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
