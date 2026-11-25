import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createApiRouter } from './src/server/routes.ts';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Hardened HTTP security headers (preserves AI Studio iframe embedding & Google Sign-In popups)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
    }

    // Strict CORS: allow same-origin / configured APP_URL only, never wildcard '*'
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host || '';
      const appUrlOrigin = (() => {
        try {
          return process.env.APP_URL ? new URL(process.env.APP_URL).origin : '';
        } catch {
          return '';
        }
      })();
      const isSameOrigin =
        origin === `https://${host}` ||
        origin === `http://${host}` ||
        (appUrlOrigin && origin === appUrlOrigin);
      if (isSameOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type,Authorization,x-restaurant-id,x-qr-session,x-idempotency-key,x-order-auth-token',
        );
      }
      if (req.method === 'OPTIONS') {
        return res.status(isSameOrigin ? 204 : 403).end();
      }
    }

    next();
  });

  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createApiRouter());
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Safe global error handler: never expose stack traces or SQL internals
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request payload exceeds 1MB limit' });
      }
      if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({ error: 'Malformed JSON request body' });
      }
      console.error('[Unhandled Express Error]', err?.message || err);
      if (!res.headersSent) {
        res.status(err?.status || 500).json({
          error:
            err?.status && err.status < 500
              ? err.message
              : 'An unexpected server error occurred',
        });
      }
    },
  );

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DineFlow server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();

