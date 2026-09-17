const express = require('express');
const db = require('./db');
const { computeBill, countWeekdaysInRange, isWeekday, computeTransferSplit } = require('./billing');
const { requireAuth } = require('./auth');
const { validateCustomerInput, validateDateInput, validateBillQuery } = require('./validate');

const router = express.Router();
router.use(requireAuth);

const wrap = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) { next(err); }
};

function getOwnedCustomer(id, ownerId) {
  return db.prepare('SELECT * FROM customers WHERE id = ? AND owner_id = ?').get(id, ownerId);
}

function getPausePeriods(customerId) {
  return db.prepare('SELECT paused_from, resumed_on FROM pause_periods WHERE customer_id = ? ORDER BY paused_from').all(customerId);
}

function getTransferForFrom(customerId, ownerId) {
  return db.prepare(`
    SELECT t.*, c2.name AS new_customer_name, c2.phone AS new_customer_phone
    FROM subscription_transfers t
    JOIN customers c2 ON c2.id = t.to_customer_id
    WHERE t.from_customer_id = ? AND t.owner_id = ?
    ORDER BY t.effective_on DESC LIMIT 1
  `).get(customerId, ownerId);
}

function getTransferForTo(customerId, ownerId) {
  return db.prepare(`
    SELECT t.*, c1.name AS old_customer_name, c1.phone AS old_customer_phone
    FROM subscription_transfers t
    JOIN customers c1 ON c1.id = t.from_customer_id
    WHERE t.to_customer_id = ? AND t.owner_id = ?
    ORDER BY t.effective_on DESC LIMIT 1
  `).get(customerId, ownerId);
}

function billForCustomer(customer, year, month, today) {
  const pauses = getPausePeriods(customer.id);
  const transfer = getTransferForFrom(customer.id, customer.owner_id) || getTransferForTo(customer.id, customer.owner_id);
  if (!transfer) return { ...computeBill(customer.plan_price, pauses, year, month, today), transfer: null };

  const start = new Date(year, month - 1, 1); start.setHours(0, 0, 0, 0);
  const end = new Date(year, month, 0); end.setHours(0, 0, 0, 0);
  const effective = new Date(`${transfer.effective_on}T00:00:00`);
  const totalWeekdays = countWeekdaysInRange(start, end);
  if (Number.isNaN(effective.getTime())) return { ...computeBill(customer.plan_price, pauses, year, month, today), transfer };
  const isNewIdentity = customer.id === transfer.to_customer_id;
  if (effective > end && isNewIdentity) return { totalWeekdays, pausedWeekdays: totalWeekdays, deliveredDays: 0, amount: 0, transfer };
  if (effective < start) return { ...computeBill(customer.plan_price, pauses, year, month, today), transfer };
  if (effective > end) return { totalWeekdays, pausedWeekdays: 0, deliveredDays: totalWeekdays, amount: customer.plan_price, transfer };

  const split = computeTransferSplit(
    customer.plan_price,
    getPausePeriods(transfer.from_customer_id),
    getPausePeriods(transfer.to_customer_id),
    year, month, transfer.effective_on, today
  );
  const isOld = customer.id === transfer.from_customer_id;
  const deliveredDays = isOld ? split.oldDeliveredDays : split.newDeliveredDays;
  const amount = isOld ? split.oldAmount : split.newAmount;
  return {
    totalWeekdays: split.totalWeekdays,
    pausedWeekdays: Math.max(0, split.totalWeekdays - split.oldDeliveredDays - split.newDeliveredDays),
    deliveredDays,
    amount,
    transfer: { ...transfer, oldDeliveredDays: split.oldDeliveredDays, newDeliveredDays: split.newDeliveredDays },
  };
}

// Subscribe a new customer.
router.post('/', wrap((req, res) => {
  const { name, phone, planPrice } = req.body || {};
  const { valid, errors } = validateCustomerInput({ name, phone, planPrice });
  if (!valid) return res.status(400).json({ error: errors.join('; ') });
  try {
    const cycleStart = new Date().toISOString().slice(0, 10);
    const info = db.prepare('INSERT INTO customers (owner_id, name, phone, plan_price, status, cycle_start) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.userId, name.trim(), phone.trim(), Number(planPrice), 'active', cycleStart);
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'you already have a customer with this phone number' });
    throw err;
  }
}));

// Search + filter + sort + pagination. By default, transferred-out identities are hidden from the active roster.
router.get('/', wrap((req, res) => {
  const { search = '', status, sortBy = 'name', order = 'asc', page = 1, pageSize = 10, includeHistory = 'false' } = req.query;
  const allowedSort = ['name', 'phone', 'plan_price', 'status', 'created_at'];
  const sortCol = allowedSort.includes(sortBy) ? sortBy : 'name';
  const sortOrder = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const conditions = ['owner_id = ?']; const params = [req.user.userId];
  if (includeHistory !== 'true') conditions.push('transfer_to_customer_id IS NULL');
  if (search) { conditions.push('(name LIKE ? OR phone LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status === 'active' || status === 'paused') { conditions.push('status = ?'); params.push(status); }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) as count FROM customers ${where}`).get(...params).count;
  const limit = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const pageNum = Math.max(1, Number(page) || 1);
  const rows = db.prepare(`SELECT * FROM customers ${where} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`).all(...params, limit, (pageNum - 1) * limit);
  res.json({ total, page: pageNum, pageSize: limit, customers: rows });
}));

router.get('/stats/summary', wrap((req, res) => {
  const ownerId = req.user.userId; const now = new Date(); const year = now.getFullYear(); const month = now.getMonth() + 1;
  const totals = db.prepare(`SELECT COUNT(*) as total,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
    SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused
    FROM customers WHERE owner_id = ? AND transfer_to_customer_id IS NULL`).get(ownerId);
  const customers = db.prepare('SELECT * FROM customers WHERE owner_id = ? AND transfer_to_customer_id IS NULL').all(ownerId);
  const estimatedRevenue = customers.reduce((sum, c) => sum + billForCustomer(c, year, month, now).amount, 0);
  res.json({ total: totals.total || 0, active: totals.active || 0, paused: totals.paused || 0, year, month, estimatedRevenue: Math.round(estimatedRevenue * 100) / 100 });
}));

router.get('/export.csv', wrap((req, res) => {
  const { valid, errors } = validateBillQuery(req.query); if (!valid) return res.status(400).json({ error: errors.join('; ') });
  const now = new Date(); const year = Number(req.query.year) || now.getFullYear(); const month = Number(req.query.month) || now.getMonth() + 1;
  const customers = db.prepare('SELECT * FROM customers WHERE owner_id = ? AND transfer_to_customer_id IS NULL ORDER BY name ASC').all(req.user.userId);
  const rows = [['Name', 'Phone', 'Status', 'Plan Price', 'Weekdays in Month', 'Delivered Days', 'Amount Due']];
  for (const c of customers) { const bill = billForCustomer(c, year, month, now); rows.push([c.name, c.phone, c.status, c.plan_price.toFixed(2), bill.totalWeekdays, bill.deliveredDays, bill.amount.toFixed(2)]); }
  const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', `attachment; filename="bills-${year}-${String(month).padStart(2, '0')}.csv"`); res.send(csv);
}));

// Messy customer import: cleans common headers/date formats, deduplicates phone numbers, and reports rejected rows.
function normalizeImportDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const iso = /^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)$/.exec(raw);
  if (iso) {
    const y = Number(iso[1]); const m = Number(iso[2]); const d = Number(iso[3]);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const parts = raw.split(/[\/.\-]/).map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite) && parts[0] < 1000) {
    const day = parts[0]; const month = parts[1]; const year = parts[2] < 100 ? 2000 + parts[2] : parts[2];
    const dt = new Date(year, month - 1, day);
    if (dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function parseImportRows(req) {
  const body = req.body;
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.rows)) return body.rows;
  const csv = typeof body === 'string' ? body : (body && typeof body.csv === 'string' ? body.csv : '');
  if (!csv.trim()) return [];
  const lines = csv.split(/\r?\n/).filter(line => line.trim());
  const parseLine = line => {
    const out = []; let cur = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim()); return out;
  };
  const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  return lines.slice(1).map(line => {
    const values = parseLine(line); const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}

function normalizeImportRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row || {})) normalized[String(key).toLowerCase().replace(/[^a-z0-9]+/g, '')] = value;
  const get = (...keys) => { for (const key of keys) if (normalized[key] !== undefined) return normalized[key]; return ''; };
  let phone = String(get('phone', 'mobile', 'mobileno', 'phonenumber')).trim();
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) phone = digits;
  else if (digits.length === 12 && digits.startsWith('91')) phone = digits.slice(2);
  return {
    name: String(get('name', 'customername', 'fullname')).trim(),
    phone,
    planPrice: get('planprice', 'price', 'monthlyprice', 'amount'),
    cycleStart: normalizeImportDate(get('cyclestart', 'startdate', 'subscriptionstart', 'subscribedon', 'joindate', 'date')),
  };
}

router.post('/import', wrap((req, res) => {
  const rows = parseImportRows(req).map(normalizeImportRow);
  if (!rows.length) return res.status(400).json({ error: 'no import rows found' });
  const seen = new Set(); const imported = []; const deduped = []; const rejected = [];
  const findExisting = db.prepare('SELECT id FROM customers WHERE owner_id = ? AND phone = ?');
  const insert = db.prepare('INSERT INTO customers (owner_id, name, phone, plan_price, status, cycle_start) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; const line = i + 2; const price = Number(row.planPrice);
    if (!row.name || !row.phone || !Number.isFinite(price) || price <= 0 || price > 1000000) { rejected.push({ row: line, reason: 'name, phone and a positive plan price are required' }); continue; }
    if (seen.has(row.phone) || findExisting.get(req.user.userId, row.phone)) { deduped.push({ row: line, phone: row.phone, reason: 'duplicate phone number' }); continue; }
    seen.add(row.phone);
    try {
      const cycleStart = row.cycleStart || new Date().toISOString().slice(0, 10);
      const info = insert.run(req.user.userId, row.name, row.phone, price, 'active', cycleStart);
      imported.push({ row: line, id: Number(info.lastInsertRowid), name: row.name, phone: row.phone, cycleStart });
    } catch (err) {
      if (String(err).includes('UNIQUE')) deduped.push({ row: line, phone: row.phone, reason: 'duplicate phone number' });
      else rejected.push({ row: line, reason: 'database insert failed' });
    }
  }
  res.status(201).json({ imported: imported.length, deduped: deduped.length, rejected: rejected.length, details: { imported, deduped, rejected } });
}));

router.get('/phone/:phone', wrap((req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE phone = ? AND owner_id = ? AND transfer_to_customer_id IS NULL').get(req.params.phone, req.user.userId);
  if (!customer) return res.status(404).json({ error: 'no customer with that phone number' });
  res.json(customer);
}));

// Transfer an active subscription to a new customer identity. The plan price/cycle are copied and billing splits at effective_on.
router.post('/:id/transfer', wrap((req, res) => {
  const from = getOwnedCustomer(req.params.id, req.user.userId);
  if (!from) return res.status(404).json({ error: 'source customer not found' });
  if (from.transfer_to_customer_id) return res.status(409).json({ error: 'subscription has already been transferred' });
  if (from.status !== 'active') return res.status(409).json({ error: 'only an active subscription can be transferred' });
  const { name, phone, effectiveOn } = req.body || {};
  const dateCheck = validateDateInput(effectiveOn, 'effectiveOn'); if (!dateCheck.valid) return res.status(400).json({ error: dateCheck.errors.join('; ') });
  const effective = effectiveOn || new Date().toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const input = validateCustomerInput({ name, phone, planPrice: from.plan_price }); if (!input.valid) return res.status(400).json({ error: input.errors.join('; ') });

  db.exec('BEGIN');
  try {
    const info = db.prepare('INSERT INTO customers (owner_id, name, phone, plan_price, status, cycle_start) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.userId, name.trim(), phone.trim(), from.plan_price, 'active', from.cycle_start || new Date().toISOString().slice(0, 10));
    const newId = Number(info.lastInsertRowid);
    db.prepare('UPDATE customers SET transfer_to_customer_id = ? WHERE id = ?').run(newId, from.id);
    db.prepare('INSERT INTO subscription_transfers (owner_id, from_customer_id, to_customer_id, effective_on, plan_price) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.userId, from.id, newId, effective, from.plan_price);
    db.exec('COMMIT');
    res.status(201).json({ from: getOwnedCustomer(from.id, req.user.userId), to: getOwnedCustomer(newId, req.user.userId), effectiveOn: effective, planPrice: from.plan_price });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'you already have a customer with this phone number' });
    throw err;
  }
}));

router.get('/:id', wrap((req, res) => {
  const customer = getOwnedCustomer(req.params.id, req.user.userId); if (!customer) return res.status(404).json({ error: 'not found' });
  const pausePeriods = db.prepare('SELECT * FROM pause_periods WHERE customer_id = ? ORDER BY paused_from DESC').all(req.params.id);
  const outgoing = getTransferForFrom(customer.id, req.user.userId); const incoming = getTransferForTo(customer.id, req.user.userId);
  res.json({ ...customer, pausePeriods, transfer: outgoing || incoming || null });
}));

router.post('/:id/pause', wrap((req, res) => {
  const customer = getOwnedCustomer(req.params.id, req.user.userId); if (!customer) return res.status(404).json({ error: 'not found' });
  if (customer.status === 'paused') return res.status(409).json({ error: 'customer is already paused' });
  if (customer.transfer_to_customer_id) return res.status(409).json({ error: 'transferred subscriptions cannot be paused' });
  const dateCheck = validateDateInput(req.body && req.body.from, 'from'); if (!dateCheck.valid) return res.status(400).json({ error: dateCheck.errors.join('; ') });
  const from = (req.body && req.body.from) || new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO pause_periods (customer_id, paused_from, resumed_on) VALUES (?, ?, NULL)').run(customer.id, from);
  db.prepare("UPDATE customers SET status = 'paused' WHERE id = ?").run(customer.id);
  res.json({ ...customer, status: 'paused' });
}));

router.post('/:id/resume', wrap((req, res) => {
  const customer = getOwnedCustomer(req.params.id, req.user.userId); if (!customer) return res.status(404).json({ error: 'not found' });
  if (customer.status !== 'paused') return res.status(409).json({ error: 'customer is not currently paused' });
  const dateCheck = validateDateInput(req.body && req.body.to, 'to'); if (!dateCheck.valid) return res.status(400).json({ error: dateCheck.errors.join('; ') });
  const to = (req.body && req.body.to) || new Date().toISOString().slice(0, 10);
  const open = db.prepare('SELECT * FROM pause_periods WHERE customer_id = ? AND resumed_on IS NULL ORDER BY paused_from DESC LIMIT 1').get(customer.id);
  if (open && to < open.paused_from) return res.status(400).json({ error: 'resume date cannot be before pause date' });
  db.prepare('UPDATE pause_periods SET resumed_on = ? WHERE customer_id = ? AND resumed_on IS NULL').run(to, customer.id);
  db.prepare("UPDATE customers SET status = 'active' WHERE id = ?").run(customer.id);
  res.json({ ...customer, status: 'active' });
}));

router.get('/:id/bill', wrap((req, res) => {
  const customer = getOwnedCustomer(req.params.id, req.user.userId); if (!customer) return res.status(404).json({ error: 'not found' });
  const { valid, errors } = validateBillQuery(req.query); if (!valid) return res.status(400).json({ error: errors.join('; ') });
  const now = new Date(); const year = Number(req.query.year) || now.getFullYear(); const month = Number(req.query.month) || now.getMonth() + 1;
  const bill = billForCustomer(customer, year, month, now);
  res.json({ customer: { id: customer.id, name: customer.name, phone: customer.phone }, year, month, planPrice: customer.plan_price, ...bill });
}));

module.exports = router;
