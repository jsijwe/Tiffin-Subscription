require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

const { router: authRouter, requireAuth } = require('./auth');
const customersRouter = require('./customers');
const { router: notificationsRouter, clockForOwner } = require('./notifications');

const app = express();

// ---- Security & platform middleware ------------------------------------
// helmet sets sane security headers (X-Frame-Options, CSP baseline, etc).
// script-src stays strict (no inline <script> blocks allowed at all —
// that's why every page's JS lives in its own /js/*.js file instead of an
// inline <script> tag) except for the Chart.js CDN script the dashboard
// loads. style-src allows 'unsafe-inline' because the frontend uses plain
// inline style="" attributes for layout throughout — those are far lower
// risk than inline script and not worth restructuring into a stylesheet
// for a project this size.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", 'https://cdnjs.cloudflare.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
      },
    },
  })
);
app.use(cors());
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Brute-force protection on auth endpoints only: 20 attempts / 15 min / IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many auth attempts, please try again later' },
});

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/customers', customersRouter);
app.use('/api/notifications', notificationsRouter);
// Assessment-friendly aliases: POST /clock then GET /outbox.
app.post('/clock', requireAuth, (req, res) => {
  try {
    const requestedDate = req.body && req.body.date;
    const date = requestedDate ? new Date(`${requestedDate}T00:00:00`) : new Date();
    if (Number.isNaN(date.getTime())) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    res.json(clockForOwner(req.user.userId, date));
  } catch (err) { res.status(500).json({ error: 'notification clock failed' }); }
});
app.get('/outbox', requireAuth, (req, res) => {
  const { date } = req.query;
  const conditions = ['o.owner_id = ?']; const params = [req.user.userId];
  if (date) { conditions.push('o.delivery_date = ?'); params.push(date); }
  const rows = require('./db').prepare(`SELECT o.id, o.customer_id AS customerId, c.name AS customerName, c.phone, o.delivery_date AS deliveryDate, o.channel, o.message, o.created_at AS createdAt FROM notification_outbox o JOIN customers c ON c.id = o.customer_id WHERE ${conditions.join(' AND ')} ORDER BY o.id DESC`).all(...params);
  res.json({ total: rows.length, outbox: rows });
});

// ---- API docs (Swagger UI) ----------------------------------------------
// Interactive documentation generated from openapi.yaml, served at /api-docs.
// This mirrors the endpoint table in README.md but lets you actually try
// each request from the browser (auth included, via the "Authorize" button).
try {
  const openapiPath = path.join(__dirname, '..', 'openapi.yaml');
  const openapiDocument = YAML.load(openapiPath);
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
} catch (err) {
  console.warn('Swagger docs unavailable (could not load openapi.yaml):', err.message);
}

app.get('/health', (req, res) => {
  const dbFile = path.join(__dirname, '..', 'tiffin.db');
  res.json({ ok: true, dbFileExists: fs.existsSync(dbFile) });
});

// ---- 404 for unmatched API routes ---------------------------------------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// ---- Centralized error handler -------------------------------------------
// Any route that calls next(err) (see the `wrap` helper in customers.js)
// or throws synchronously inside an Express handler lands here, so a bad
// query or unexpected DB error returns clean JSON instead of an HTML stack
// trace or a crashed process.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(err.status || 500).json({ error: 'internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tiffin service running: http://localhost:${PORT}`);
  console.log(`API docs:               http://localhost:${PORT}/api-docs`);
});
