const express = require('express');
const db = require('./db');
const { isWeekday } = require('./billing');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

function localDate(value = new Date()) {
  const d = new Date(value);
  return d.toISOString().slice(0, 10);
}

function clockForOwner(ownerId, date = new Date()) {
  const deliveryDate = localDate(date);
  const day = new Date(`${deliveryDate}T00:00:00`);
  if (!isWeekday(day)) return { date: deliveryDate, weekday: false, queued: 0, messages: [] };

  const customers = db.prepare(`
    SELECT id, name, phone FROM customers
    WHERE owner_id = ? AND status = 'active' AND transfer_to_customer_id IS NULL
  `).all(ownerId);

  const messages = [];
  for (const customer of customers) {
    // A customer with an open pause is not due even if the status was accidentally left active.
    const openPause = db.prepare(`
      SELECT 1 FROM pause_periods
      WHERE customer_id = ? AND paused_from <= ? AND (resumed_on IS NULL OR resumed_on > ?)
      LIMIT 1
    `).get(customer.id, deliveryDate, deliveryDate);
    if (openPause) continue;

    const exists = db.prepare('SELECT id FROM notification_outbox WHERE owner_id = ? AND customer_id = ? AND delivery_date = ?').get(ownerId, customer.id, deliveryDate);
    if (exists) continue;

    const message = `Tiffin delivery reminder for ${deliveryDate}: ${customer.name}, your tiffin is scheduled for delivery today.`;
    const info = db.prepare(`
      INSERT INTO notification_outbox (owner_id, customer_id, delivery_date, channel, message)
      VALUES (?, ?, ?, 'sms', ?)
    `).run(ownerId, customer.id, deliveryDate, message);
    messages.push({ id: Number(info.lastInsertRowid), customerId: customer.id, phone: customer.phone, message });
  }

  return { date: deliveryDate, weekday: true, queued: messages.length, messages };
}

// POST /clock is the deterministic scheduler hook used by the assessment.
router.post('/clock', (req, res) => {
  try {
    const requestedDate = req.body && req.body.date;
    const date = requestedDate ? new Date(`${requestedDate}T00:00:00`) : new Date();
    if (Number.isNaN(date.getTime())) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    res.json(clockForOwner(req.user.userId, date));
  } catch (err) { res.status(500).json({ error: 'notification clock failed' }); }
});

router.get('/outbox', (req, res) => {
  try {
    const { date, page = 1, pageSize = 50 } = req.query;
    const limit = Math.max(1, Math.min(100, Number(pageSize) || 50));
    const pageNum = Math.max(1, Number(page) || 1);
    const conditions = ['owner_id = ?']; const params = [req.user.userId];
    if (date) { conditions.push('delivery_date = ?'); params.push(date); }
    const where = conditions.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS count FROM notification_outbox WHERE ${where}`).get(...params).count;
    const rows = db.prepare(`SELECT o.id, o.customer_id AS customerId, c.name AS customerName, c.phone, o.delivery_date AS deliveryDate, o.channel, o.message, o.created_at AS createdAt
      FROM notification_outbox o JOIN customers c ON c.id = o.customer_id WHERE ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...params, limit, (pageNum - 1) * limit);
    res.json({ total, page: pageNum, pageSize: limit, outbox: rows });
  } catch (err) { res.status(500).json({ error: 'could not read notification outbox' }); }
});

module.exports = { router, clockForOwner };
