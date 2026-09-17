const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { validateAuthInput } = require('./validate');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

router.post('/register', (req, res) => {
  const { email, password } = req.body || {};
  const { valid, errors } = validateAuthInput({ email, password });
  if (!valid) return res.status(400).json({ error: errors.join('; ') });

  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(normalizedEmail, hash);
  const token = jwt.sign({ userId: info.lastInsertRowid, email: normalizedEmail }, JWT_SECRET, {
    expiresIn: '7d',
  });
  res.status(201).json({ token, email: normalizedEmail });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  const token = jwt.sign({ userId: user.id, email: normalizedEmail }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, email: normalizedEmail });
});

// Middleware: requires a valid `Authorization: Bearer <token>` header
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing auth token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

module.exports = { router, requireAuth };
