/**
 * IGNITE server — Express + Postgres + JWT auth.
 * Serves all static HTML files AND provides /api/* endpoints.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { z } = require('zod');

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_DAYS = Number(process.env.SESSION_DURATION_DAYS) || 30;
const IS_PROD = process.env.NODE_ENV === 'production';

if (!DATABASE_URL) { console.error('FATAL: DATABASE_URL is not set'); process.exit(1); }
if (!JWT_SECRET)   { console.error('FATAL: JWT_SECRET is not set');   process.exit(1); }

// ---------- Database ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: IS_PROD ? { rejectUnauthorized: false } : false,
  max: 10,
});
pool.on('error', err => console.error('pg pool error:', err));

async function runMigrations(){
  const sql = fs.readFileSync(path.join(__dirname, 'migrations.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migrations applied.');
}

// ---------- Express ----------
const app = express();
app.disable('x-powered-by');
app.use(cookieParser());

// Stripe webhook needs raw body; plain JSON elsewhere
app.use((req, res, next) => {
  if (req.path === '/api/webhook/stripe') return next();
  express.json({ limit: '512kb' })(req, res, next);
});

// ---------- Helpers ----------
function signToken(userId){
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}
function setSession(res, userId){
  const token = signToken(userId);
  res.cookie('ignite_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}
function clearSession(res){
  res.clearCookie('ignite_session', { path: '/' });
}
function getUserIdFromReq(req){
  const t = req.cookies && req.cookies.ignite_session;
  if (!t) return null;
  try { return jwt.verify(t, JWT_SECRET).sub; } catch { return null; }
}
async function loadUser(id){
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
            s.plan, s.status AS sub_status, s.current_period_end
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.id = $1 LIMIT 1`, [id]);
  return rows[0] || null;
}
function requireAuth(req, res, next){
  const id = getUserIdFromReq(req);
  if (!id) return res.status(401).json({ error: 'auth_required' });
  req.userId = id;
  next();
}
function sanitizeEmail(e){ return String(e||'').trim().toLowerCase(); }
function randomToken(n=32){ return crypto.randomBytes(n).toString('base64url'); }

// ---------- Rate limit (naive in-memory) ----------
const rl = new Map();
function limited(key, maxPerMin=10){
  const now = Date.now();
  const cutoff = now - 60_000;
  const arr = (rl.get(key) || []).filter(t => t > cutoff);
  arr.push(now);
  rl.set(key, arr);
  return arr.length > maxPerMin;
}
function rateLimit(req, res, next){
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const key = `${ip}:${req.path}`;
  if (limited(key, 30)) return res.status(429).json({ error: 'rate_limited' });
  next();
}
app.use('/api/', rateLimit);

// ---------- Validation ----------
const EmailPwd = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});
const QuizSchema = z.object({
  goal: z.string().optional(),
  bodyNow: z.string().optional(),
  bodyGoal: z.string().optional(),
  focus: z.array(z.string()).optional(),
  age: z.string().optional(),
  level: z.string().optional(),
  place: z.string().optional(),
  time: z.coerce.number().int().optional(),
  lifestyle: z.array(z.string()).optional(),
  height: z.coerce.number().optional(),
  heightUnit: z.string().optional(),
  weight: z.coerce.number().optional(),
  weightUnit: z.string().optional(),
  target: z.coerce.number().optional(),
  event: z.string().optional(),
}).partial();

// =================================================================
//  AUTH ROUTES
// =================================================================

app.post('/api/auth/signup', async (req, res) => {
  const parsed = EmailPwd.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const email = sanitizeEmail(parsed.data.email);
  try {
    const exists = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'email_taken' });

    const hash = await bcrypt.hash(parsed.data.password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, last_login_at) VALUES ($1, $2, NOW()) RETURNING id`,
      [email, hash]);
    const userId = rows[0].id;
    await pool.query(`INSERT INTO subscriptions (user_id, status) VALUES ($1, 'inactive') ON CONFLICT DO NOTHING`, [userId]);
    await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    setSession(res, userId);
    res.json({ ok: true, userId });
  } catch (e) {
    console.error('signup', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  const parsed = EmailPwd.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const email = sanitizeEmail(parsed.data.email);
  try {
    const { rows } = await pool.query(
      `SELECT id, password_hash FROM users WHERE LOWER(email) = $1`, [email]);
    if (!rows.length) return res.status(401).json({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(parsed.data.password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [rows[0].id]);
    setSession(res, rows[0].id);
    res.json({ ok: true });
  } catch (e) {
    console.error('signin', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/signout', (req, res) => { clearSession(res); res.json({ ok: true }); });

app.get('/api/me', async (req, res) => {
  const id = getUserIdFromReq(req);
  if (!id) return res.json({ user: null });
  try {
    const user = await loadUser(id);
    if (!user) return res.json({ user: null });
    const { rows: qrows } = await pool.query(`SELECT * FROM quiz_responses WHERE user_id = $1`, [id]);
    const { rows: srows } = await pool.query(`SELECT data FROM user_settings WHERE user_id = $1`, [id]);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.created_at,
        plan: user.plan,
        subscriptionStatus: user.sub_status,
        periodEnd: user.current_period_end,
        authenticated: true,
        paid: user.sub_status === 'active' || user.sub_status === 'trialing',
      },
      quiz: qrows[0] || null,
      settings: srows[0]?.data || {},
    });
  } catch (e) {
    console.error('me', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------- Password reset ----------
app.post('/api/auth/reset-request', async (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'invalid_input' });
  try {
    const { rows } = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email]);
    if (rows.length) {
      const token = randomToken(32);
      await pool.query(
        `INSERT INTO password_reset_tokens (token, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour')`, [token, rows[0].id]);
      const url = `${APP_URL}/reset.html?token=${encodeURIComponent(token)}`;
      try { await sendEmail(email, 'password_reset', { url }); } catch(e){ console.error('send reset email', e.message); }
    }
    // Always respond with ok — do not leak whether email exists
    res.json({ ok: true });
  } catch (e) {
    console.error('reset-request', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/reset-confirm', async (req, res) => {
  const schema = z.object({
    token: z.string().min(16),
    password: z.string().min(8).max(200),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  try {
    const { rows } = await pool.query(
      `SELECT user_id FROM password_reset_tokens
        WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`, [parsed.data.token]);
    if (!rows.length) return res.status(400).json({ error: 'invalid_or_expired' });
    const hash = await bcrypt.hash(parsed.data.password, 12);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, rows[0].user_id]);
    await pool.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE token = $1`, [parsed.data.token]);
    setSession(res, rows[0].user_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('reset-confirm', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// =================================================================
//  QUIZ / SETTINGS / WORKOUTS
// =================================================================

app.post('/api/quiz', requireAuth, async (req, res) => {
  const parsed = QuizSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const q = parsed.data;
  try {
    await pool.query(`
      INSERT INTO quiz_responses (
        user_id, goal, body_now, body_goal, focus, age, level, place, time_per,
        lifestyle, height, height_unit, weight, weight_unit, target_weight, event, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        goal=$2, body_now=$3, body_goal=$4, focus=$5, age=$6, level=$7, place=$8, time_per=$9,
        lifestyle=$10, height=$11, height_unit=$12, weight=$13, weight_unit=$14, target_weight=$15, event=$16, updated_at=NOW()`,
      [req.userId, q.goal||null, q.bodyNow||null, q.bodyGoal||null, q.focus||null, q.age||null,
       q.level||null, q.place||null, q.time||null, q.lifestyle||null, q.height||null, q.heightUnit||null,
       q.weight||null, q.weightUnit||null, q.target||null, q.event||null]);
    res.json({ ok: true });
  } catch (e) { console.error('quiz', e); res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/settings', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT data FROM user_settings WHERE user_id = $1`, [req.userId]);
  res.json({ settings: rows[0]?.data || {} });
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const data = req.body?.settings;
  if (typeof data !== 'object' || data === null) return res.status(400).json({ error: 'invalid_input' });
  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, data, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [req.userId, data]);
    res.json({ ok: true });
  } catch (e) { console.error('settings', e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/workouts/complete', requireAuth, async (req, res) => {
  const schema = z.object({
    workoutName: z.string().max(200).optional(),
    durationSeconds: z.coerce.number().int().min(0).max(60*60*3).optional(),
    exercisesCompleted: z.coerce.number().int().min(0).max(200).optional(),
    feltHow: z.string().max(50).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  try {
    await pool.query(
      `INSERT INTO workout_logs (user_id, workout_name, duration_seconds, exercises_completed, felt_how)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.userId, parsed.data.workoutName||null, parsed.data.durationSeconds||null,
       parsed.data.exercisesCompleted||null, parsed.data.feltHow||null]);
    res.json({ ok: true });
  } catch (e) { console.error('complete', e); res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/progress', requireAuth, async (req, res) => {
  try {
    const { rows: recent } = await pool.query(
      `SELECT workout_name, duration_seconds, completed_at FROM workout_logs
        WHERE user_id = $1 ORDER BY completed_at DESC LIMIT 30`, [req.userId]);
    const { rows: counts } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE completed_at >= DATE_TRUNC('week', NOW()))::int AS this_week
         FROM workout_logs WHERE user_id = $1`, [req.userId]);
    res.json({ recent, ...counts[0] });
  } catch (e) { console.error('progress', e); res.status(500).json({ error: 'server_error' }); }
});

// =================================================================
//  STRIPE (phase 3 — stubbed until keys are set)
// =================================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); } catch(e){ console.log('stripe not installed yet'); }
}
const PRICE_MAP = {
  '1':  process.env.STRIPE_PRICE_1M  || null,
  '3':  process.env.STRIPE_PRICE_3M  || null,
  '12': process.env.STRIPE_PRICE_12M || null,
};

app.post('/api/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
  const plan = String(req.body?.plan || '3');
  const price = PRICE_MAP[plan];
  if (!price) return res.status(400).json({ error: 'invalid_plan' });
  try {
    const user = await loadUser(req.userId);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email,
      client_reference_id: req.userId,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { metadata: { user_id: req.userId, plan } },
      success_url: `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `${APP_URL}/quiz.html`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (e) { console.error('checkout', e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(503).end();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
    } catch (err) {
      console.error('stripe webhook sig verify failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const s = event.data.object;
          const userId = s.client_reference_id || s.metadata?.user_id;
          const subId = s.subscription;
          const customerId = s.customer;
          if (userId && subId) {
            const sub = await stripe.subscriptions.retrieve(subId);
            await pool.query(
              `INSERT INTO subscriptions (user_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, updated_at)
               VALUES ($1,$2,$3,$4,$5, TO_TIMESTAMP($6), NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 plan = EXCLUDED.plan, status = EXCLUDED.status,
                 stripe_customer_id = EXCLUDED.stripe_customer_id,
                 stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                 current_period_end = EXCLUDED.current_period_end, updated_at = NOW()`,
              [userId, sub.metadata?.plan || null, sub.status, customerId, subId, sub.current_period_end]);
            try {
              const { rows: urows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
              if (urows[0]) await sendEmail(urows[0].email, 'welcome', {});
            } catch(e){ console.error('send welcome', e.message); }
          }
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          await pool.query(
            `UPDATE subscriptions SET status = $1, current_period_end = TO_TIMESTAMP($2), updated_at = NOW()
              WHERE stripe_subscription_id = $3`,
            [sub.status, sub.current_period_end, sub.id]);
          break;
        }
        case 'invoice.payment_failed': {
          const inv = event.data.object;
          if (inv.customer_email) {
            try { await sendEmail(inv.customer_email, 'payment_failed', {}); } catch(e){}
          }
          break;
        }
      }
      res.json({ received: true });
    } catch (e) { console.error('webhook handler', e); res.status(500).end(); }
  });

// =================================================================
//  EMAIL (phase 4 — stubbed until Resend key is set)
// =================================================================
async function sendEmail(to, kind, data){
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'IGNITE <hello@ignite.fit>';
  if (!key) { console.log(`[email-stub] ${kind} → ${to}`, data); return; }

  const templates = {
    welcome: () => ({
      subject: 'Welcome to IGNITE 🔥 Your plan is ready',
      html: `<h1>You're in.</h1><p>Your personalized IGNITE plan is ready. Log in any time at <a href="${APP_URL}/app.html">${APP_URL}/app.html</a>.</p><p>— The IGNITE team</p>`,
    }),
    password_reset: () => ({
      subject: 'Reset your IGNITE password',
      html: `<h1>Reset your password</h1><p>Click below to reset. The link expires in 1 hour.</p><p><a href="${data.url}">Reset password</a></p>`,
    }),
    workout_reminder: () => ({
      subject: '💪 Your IGNITE workout is waiting',
      html: `<h1>It's workout time.</h1><p>${data.workoutName || 'Today\'s session'} is ready. 15–30 minutes, let's go.</p><p><a href="${APP_URL}/app.html">Open my plan</a></p>`,
    }),
    streak_nudge: () => ({
      subject: `Keep your ${data.days}-day streak alive 🔥`,
      html: `<h1>One workout to keep the streak.</h1><p>You're on a ${data.days}-day streak. Don't lose it.</p><p><a href="${APP_URL}/app.html">Train now</a></p>`,
    }),
    weekly_recap: () => ({
      subject: 'Your IGNITE week · recap',
      html: `<h1>Week wrap-up</h1><p>${data.completed} workouts · ${data.minutes} minutes · streak: ${data.streak}</p>`,
    }),
    payment_failed: () => ({
      subject: 'IGNITE — payment issue',
      html: `<h1>Your payment didn't go through</h1><p>No stress — update your card any time in <a href="${APP_URL}/app.html">Profile → Billing</a>.</p>`,
    }),
  };
  const tpl = templates[kind]?.();
  if (!tpl) throw new Error('unknown_template: ' + kind);

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: tpl.subject, html: tpl.html }),
  });
  if (!resp.ok) throw new Error(`resend ${resp.status}: ${await resp.text()}`);
  await pool.query(`INSERT INTO email_events (kind, meta) VALUES ($1, $2)`, [kind, { to }]);
}

// =================================================================
//  STATIC FILES (serves all existing HTML)
// =================================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Clean-url mapping: /foo → /foo.html when the file exists
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  if (/\.[a-z0-9]+$/i.test(req.path)) return next(); // already has extension
  const candidate = path.join(__dirname, req.path + '.html');
  if (fs.existsSync(candidate)) return res.sendFile(candidate);
  next();
});

app.use(express.static(__dirname, {
  index: ['index.html'],
  extensions: ['html'],
  maxAge: IS_PROD ? '5m' : 0,
}));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// ---------- Boot ----------
(async () => {
  try {
    await runMigrations();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`IGNITE server listening on :${PORT}`);
      console.log(`APP_URL=${APP_URL}  IS_PROD=${IS_PROD}`);
    });
  } catch (e) {
    console.error('Boot failed:', e);
    process.exit(1);
  }
})();
