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

async function seedContent(){
  const seedPath = path.join(__dirname, 'content', 'seed.json');
  if (!fs.existsSync(seedPath)) { console.log('No seed.json found, skipping seed.'); return; }
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  // Upsert exercises
  for (const e of (seed.exercises || [])) {
    await pool.query(
      `INSERT INTO exercises (slug, name, emoji, description, form_cues, muscle_groups, difficulty, equipment, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, emoji = EXCLUDED.emoji, description = EXCLUDED.description,
         form_cues = EXCLUDED.form_cues, muscle_groups = EXCLUDED.muscle_groups,
         difficulty = EXCLUDED.difficulty, equipment = EXCLUDED.equipment, updated_at = NOW()`,
      [e.slug, e.name, e.emoji || null, e.description || null,
       e.form_cues || null, e.muscle_groups || null, e.difficulty || null, e.equipment || null]);
  }
  // Upsert workouts + their exercise refs
  for (const w of (seed.workouts || [])) {
    const { rows } = await pool.query(
      `INSERT INTO workouts (slug, name, focus, duration_minutes, difficulty, description, rest_seconds, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, focus = EXCLUDED.focus, duration_minutes = EXCLUDED.duration_minutes,
         difficulty = EXCLUDED.difficulty, description = EXCLUDED.description,
         rest_seconds = EXCLUDED.rest_seconds, updated_at = NOW()
       RETURNING id`,
      [w.slug, w.name, w.focus || null, w.duration_minutes || null,
       w.difficulty || null, w.description || null, w.rest_seconds || 20]);
    const workoutId = rows[0].id;
    await pool.query(`DELETE FROM workout_exercises WHERE workout_id = $1`, [workoutId]);
    let pos = 1;
    for (const we of (w.exercises || [])) {
      const er = await pool.query(`SELECT id FROM exercises WHERE slug = $1`, [we.slug]);
      if (!er.rows.length) { console.warn('seed: missing exercise', we.slug); continue; }
      await pool.query(
        `INSERT INTO workout_exercises (workout_id, position, exercise_id, mode, sets, reps, duration_seconds, rest_seconds, tip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [workoutId, pos++, er.rows[0].id, we.mode || 'reps', we.sets || null,
         we.reps || null, we.duration_seconds || null, we.rest_seconds || null, we.tip || null]);
    }
  }
  console.log(`Seeded ${seed.exercises?.length || 0} exercises, ${seed.workouts?.length || 0} workouts.`);
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
//  WORKOUT / EXERCISE CONTENT
// =================================================================

function streamUrlFromVideo(v){
  if (!v) return null;
  if (v.provider === 'mux' && v.playback_id) return `https://stream.mux.com/${v.playback_id}.m3u8`;
  if (v.provider === 'bunny' && v.playback_id) return `https://iframe.mediadelivery.net/embed/${v.playback_id}`;
  return v.video_url || null;
}
function thumbUrlFromVideo(v){
  if (!v) return null;
  if (v.thumbnail_url) return v.thumbnail_url;
  if (v.provider === 'mux' && v.playback_id) return `https://image.mux.com/${v.playback_id}/thumbnail.webp?width=640&height=360&fit_mode=smartcrop`;
  return null;
}

app.get('/api/workouts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT slug, name, focus, duration_minutes, difficulty, description FROM workouts ORDER BY name`);
    res.json({ workouts: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/workouts/:slug', async (req, res) => {
  try {
    const { rows: wrows } = await pool.query(
      `SELECT * FROM workouts WHERE slug = $1 LIMIT 1`, [req.params.slug]);
    if (!wrows.length) return res.status(404).json({ error: 'not_found' });
    const w = wrows[0];
    const { rows: exs } = await pool.query(`
      SELECT we.position, we.mode, we.sets, we.reps, we.duration_seconds, we.rest_seconds, we.tip,
             e.slug, e.name, e.emoji, e.description, e.form_cues, e.muscle_groups, e.difficulty, e.equipment
        FROM workout_exercises we
        JOIN exercises e ON e.id = we.exercise_id
       WHERE we.workout_id = $1
       ORDER BY we.position
    `, [w.id]);
    // Fetch videos for all exercises at once
    const slugs = exs.map(x => x.slug);
    const { rows: videos } = slugs.length ? await pool.query(`
      SELECT e.slug, v.variation, v.provider, v.video_url, v.playback_id, v.thumbnail_url, v.duration_seconds
        FROM exercise_videos v
        JOIN exercises e ON e.id = v.exercise_id
       WHERE e.slug = ANY($1::text[])
    `, [slugs]) : { rows: [] };
    const videosBySlug = {};
    for (const v of videos) {
      (videosBySlug[v.slug] ||= {})[v.variation] = {
        provider: v.provider,
        streamUrl: streamUrlFromVideo(v),
        thumbnailUrl: thumbUrlFromVideo(v),
        duration: v.duration_seconds,
      };
    }
    res.json({
      slug: w.slug, name: w.name, focus: w.focus,
      durationMinutes: w.duration_minutes, difficulty: w.difficulty,
      description: w.description, restSeconds: w.rest_seconds,
      exercises: exs.map(x => ({
        ...x,
        videos: videosBySlug[x.slug] || {},
      })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/workouts/today/for-me', requireAuth, async (req, res) => {
  // Simple personalization: pick by user's primary focus; fall back to glute-sculpt
  try {
    const { rows: qrows } = await pool.query(
      `SELECT focus FROM quiz_responses WHERE user_id = $1`, [req.userId]);
    const focus = qrows[0]?.focus?.[0];
    const focusToSlug = { butt: 'glute-sculpt', belly: 'core-ignition', legs: 'full-body-hiit' };
    const slug = focusToSlug[focus] || 'glute-sculpt';
    res.json({ slug });
  } catch (e) { console.error(e); res.json({ slug: 'glute-sculpt' }); }
});

// ---------- Admin: manage content (ADMIN_TOKEN required) ----------
function requireAdmin(req, res, next){
  const t = req.headers['x-admin-token'];
  if (!t || !process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

app.get('/api/admin/exercises', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.*, (
      SELECT COUNT(*)::int FROM exercise_videos v WHERE v.exercise_id = e.id
    ) AS video_count
    FROM exercises e ORDER BY e.name`);
  res.json({ exercises: rows });
});

app.post('/api/admin/exercises', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.slug || !b.name) return res.status(400).json({ error: 'slug_and_name_required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO exercises (slug, name, emoji, description, form_cues, muscle_groups, difficulty, equipment, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, emoji = EXCLUDED.emoji, description = EXCLUDED.description,
         form_cues = EXCLUDED.form_cues, muscle_groups = EXCLUDED.muscle_groups,
         difficulty = EXCLUDED.difficulty, equipment = EXCLUDED.equipment, updated_at = NOW()
       RETURNING id, slug`,
      [b.slug, b.name, b.emoji || null, b.description || null,
       Array.isArray(b.form_cues) ? b.form_cues : null,
       Array.isArray(b.muscle_groups) ? b.muscle_groups : null,
       b.difficulty || null,
       Array.isArray(b.equipment) ? b.equipment : null]);
    res.json({ ok: true, exercise: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/admin/exercise-videos', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.exercise_slug) return res.status(400).json({ error: 'exercise_slug_required' });
  if (!b.video_url && !b.playback_id) return res.status(400).json({ error: 'url_or_playback_id_required' });
  try {
    const er = await pool.query(`SELECT id FROM exercises WHERE slug = $1`, [b.exercise_slug]);
    if (!er.rows.length) return res.status(404).json({ error: 'exercise_not_found' });
    const exerciseId = er.rows[0].id;
    const variation = b.variation || 'default';
    const { rows } = await pool.query(
      `INSERT INTO exercise_videos (exercise_id, variation, provider, video_url, playback_id, thumbnail_url, duration_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (exercise_id, variation) DO UPDATE SET
         provider = EXCLUDED.provider, video_url = EXCLUDED.video_url, playback_id = EXCLUDED.playback_id,
         thumbnail_url = EXCLUDED.thumbnail_url, duration_seconds = EXCLUDED.duration_seconds
       RETURNING *`,
      [exerciseId, variation, b.provider || 'url', b.video_url || null,
       b.playback_id || null, b.thumbnail_url || null, b.duration_seconds || null]);
    res.json({ ok: true, video: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/admin/exercise-videos', requireAdmin, async (req, res) => {
  const { exercise_slug, variation = 'default' } = req.body || {};
  if (!exercise_slug) return res.status(400).json({ error: 'exercise_slug_required' });
  try {
    await pool.query(`
      DELETE FROM exercise_videos v USING exercises e
       WHERE v.exercise_id = e.id AND e.slug = $1 AND v.variation = $2
    `, [exercise_slug, variation]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/admin/reseed', requireAdmin, async (req, res) => {
  try { await seedContent(); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// =================================================================
//  WAITLIST (pre-launch — referral + position tracking)
// =================================================================

// Generate a referral code: 8 chars, uppercase, avoids confusables
function makeReferralCode(){
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let out = '';
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

app.get('/api/waitlist/count', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS total FROM waitlist`);
    const total = rows[0].total;
    res.json({ total, remainingFirst500: Math.max(0, 500 - total) });
  } catch (e) { res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/waitlist/join', async (req, res) => {
  const schema = z.object({
    email: z.string().email().max(200),
    referral_code: z.string().regex(/^[A-Z0-9]{6,16}$/).optional(),
    source: z.string().max(64).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const email = sanitizeEmail(parsed.data.email);
  const refByRaw = parsed.data.referral_code?.toUpperCase();

  try {
    // Already on list? Just return their status
    const existing = await pool.query(
      `SELECT position, referral_code, referrals_count FROM waitlist WHERE LOWER(email) = $1`, [email]);
    if (existing.rows.length) {
      const r = existing.rows[0];
      const { rows: c } = await pool.query(`SELECT COUNT(*)::int AS total FROM waitlist`);
      return res.json({
        already: true, position: Number(r.position), referral_code: r.referral_code,
        referrals_count: r.referrals_count, total: c[0].total,
      });
    }

    // Validate referral code (if provided) is real
    let referredByCode = null;
    if (refByRaw) {
      const ref = await pool.query(`SELECT referral_code FROM waitlist WHERE referral_code = $1`, [refByRaw]);
      if (ref.rows.length) referredByCode = refByRaw;
    }

    // Generate a unique code (retry on rare collision)
    let code = makeReferralCode();
    for (let i = 0; i < 5; i++) {
      const clash = await pool.query(`SELECT 1 FROM waitlist WHERE referral_code = $1`, [code]);
      if (!clash.rows.length) break;
      code = makeReferralCode();
    }

    const ins = await pool.query(
      `INSERT INTO waitlist (email, referral_code, referred_by_code, source)
       VALUES ($1, $2, $3, $4)
       RETURNING position, referral_code, referrals_count`,
      [email, code, referredByCode, parsed.data.source || null]);

    // Bump the referrer's count
    if (referredByCode) {
      await pool.query(
        `UPDATE waitlist SET referrals_count = referrals_count + 1 WHERE referral_code = $1`,
        [referredByCode]);
    }

    const { rows: c } = await pool.query(`SELECT COUNT(*)::int AS total FROM waitlist`);

    // Fire-and-forget welcome email (no-op if Resend not configured)
    sendEmail(email, 'waitlist_welcome', {
      position: Number(ins.rows[0].position),
      referral_code: ins.rows[0].referral_code,
      total: c[0].total,
    }).catch(err => console.error('waitlist welcome email', err.message));

    res.json({
      already: false,
      position: Number(ins.rows[0].position),
      referral_code: ins.rows[0].referral_code,
      referrals_count: 0,
      total: c[0].total,
    });
  } catch (e) { console.error('waitlist/join', e); res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/waitlist/status', async (req, res) => {
  const code = String(req.query.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });
  try {
    const { rows } = await pool.query(
      `SELECT email, position, referral_code, referrals_count, created_at
         FROM waitlist WHERE referral_code = $1`, [code]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const { rows: c } = await pool.query(`SELECT COUNT(*)::int AS total FROM waitlist`);
    const r = rows[0];
    res.json({
      email: r.email, position: Number(r.position), referral_code: r.referral_code,
      referrals_count: r.referrals_count, created_at: r.created_at, total: c[0].total,
    });
  } catch (e) { console.error('waitlist/status', e); res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/admin/waitlist', requireAdmin, async (req, res) => {
  try {
    const { rows: stats } = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last_7d,
             COUNT(DISTINCT referred_by_code) FILTER (WHERE referred_by_code IS NOT NULL)::int AS active_referrers
        FROM waitlist`);
    const { rows: top } = await pool.query(`
      SELECT email, referral_code, referrals_count, position FROM waitlist
       WHERE referrals_count > 0 ORDER BY referrals_count DESC LIMIT 20`);
    const { rows: recent } = await pool.query(`
      SELECT email, position, referral_code, referred_by_code, referrals_count, source, created_at
        FROM waitlist ORDER BY created_at DESC LIMIT 100`);
    const { rows: sources } = await pool.query(`
      SELECT COALESCE(source,'organic') AS source, COUNT(*)::int AS n
        FROM waitlist GROUP BY 1 ORDER BY n DESC`);
    res.json({ stats: stats[0], top, recent, sources });
  } catch (e) { console.error('admin/waitlist', e); res.status(500).json({ error: 'server_error' }); }
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
//  WEB PUSH (phase 5)
// =================================================================
let webpush = null;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:ops@ignite.fit';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('Web Push enabled');
  } catch (e) { console.log('web-push not installed yet'); }
}

// Expose public VAPID key so the client can subscribe
app.get('/api/push/public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
    res.json({ ok: true });
  } catch (e) { console.error('push subscribe', e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'invalid_input' });
  try {
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, req.userId]);
    res.json({ ok: true });
  } catch (e) { console.error('push unsub', e); res.status(500).json({ error: 'server_error' }); }
});

// Send a push notification to every subscription for a user.
// Gone/expired endpoints are cleaned up automatically.
async function sendPushToUser(userId, payload){
  if (!webpush) return { skipped: 'no_vapid' };
  const { rows } = await pool.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId]);
  let sent = 0, gone = 0;
  for (const r of rows) {
    try {
      await webpush.sendNotification({
        endpoint: r.endpoint,
        keys: { p256dh: r.p256dh, auth: r.auth },
      }, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [r.endpoint]).catch(()=>{});
        gone++;
      } else {
        console.error('push send error', err.statusCode, err.body);
      }
    }
  }
  return { sent, gone };
}

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
    waitlist_welcome: () => ({
      subject: `You're on the list — spot #${data.position} 🔥`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#111">
        <h1 style="font-size:28px;letter-spacing:-.02em">You're in. 🔥</h1>
        <p>You're <strong>#${data.position}</strong> on the IGNITE early-access list. <strong>The first 500 get 50% off their first year</strong> — move up the queue by sharing your referral link:</p>
        <p style="background:#f5f5ff;padding:14px;border-radius:10px;font-family:monospace;word-break:break-all">${APP_URL}/?r=${data.referral_code}</p>
        <p>Every friend who joins from your link bumps you up. Top sharers get first pick of coach-assigned plans at launch.</p>
        <p>Thanks for being early.<br/>— The IGNITE team</p>
      </div>`,
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

// =================================================================
//  SCHEDULED REMINDERS (phase 5)
//  Runs in-process with node-cron. If you scale to multiple replicas,
//  add a Postgres advisory lock around each job or run them from a
//  dedicated Railway Cron service instead.
// =================================================================
const cron = (() => { try { return require('node-cron'); } catch { return null; } })();

async function jobWorkoutReminder(){
  // Users who haven't trained today, with workout_reminder notifications on
  const { rows } = await pool.query(`
    SELECT u.id, u.email,
           COALESCE(s.data->'notifications'->>'workout','true')::bool AS wants_push,
           COALESCE(s.data->'notifications'->>'email','true')::bool AS wants_email
      FROM users u
      JOIN subscriptions sub ON sub.user_id = u.id
      LEFT JOIN user_settings s ON s.user_id = u.id
     WHERE sub.status IN ('active','trialing')
       AND NOT EXISTS (
         SELECT 1 FROM workout_logs wl
          WHERE wl.user_id = u.id
            AND wl.completed_at > NOW() - INTERVAL '20 hours'
       )
  `);
  let pushed = 0, emailed = 0;
  for (const u of rows) {
    if (u.wants_push) { try { const r = await sendPushToUser(u.id, {
      title: '🔥 Time to train',
      body: "Today's workout is ready. 15 minutes, that's all it takes.",
      url: '/app.html',
      tag: 'workout-reminder',
    }); if (r.sent) pushed++; } catch(e){} }
    if (u.wants_email) { try { await sendEmail(u.email, 'workout_reminder', {}); emailed++; } catch(e){} }
  }
  console.log(`[cron] workout reminder: push=${pushed} email=${emailed} candidates=${rows.length}`);
}

async function jobStreakNudge(){
  // Users with a 2+ day streak who haven't trained today; nudge them in the evening
  const { rows } = await pool.query(`
    WITH streaks AS (
      SELECT wl.user_id,
             COUNT(DISTINCT DATE(wl.completed_at)) FILTER (WHERE wl.completed_at > NOW() - INTERVAL '7 days') AS days_this_week
        FROM workout_logs wl
       GROUP BY wl.user_id
    )
    SELECT u.id, u.email, st.days_this_week
      FROM users u
      JOIN subscriptions sub ON sub.user_id = u.id
      JOIN streaks st ON st.user_id = u.id
      LEFT JOIN user_settings s ON s.user_id = u.id
     WHERE sub.status IN ('active','trialing')
       AND st.days_this_week >= 2
       AND NOT EXISTS (
         SELECT 1 FROM workout_logs wl
          WHERE wl.user_id = u.id AND wl.completed_at::date = CURRENT_DATE
       )
       AND COALESCE(s.data->'notifications'->>'streak','true')::bool = true
  `);
  for (const u of rows) {
    try { await sendPushToUser(u.id, {
      title: `Don't lose your ${u.days_this_week}-day streak 🔥`,
      body: 'One workout left today to keep the chain alive.',
      url: '/workout.html',
      tag: 'streak-nudge',
    }); } catch(e){}
    try { await sendEmail(u.email, 'streak_nudge', { days: u.days_this_week }); } catch(e){}
  }
  console.log(`[cron] streak nudge: ${rows.length} candidates`);
}

async function jobWeeklyRecap(){
  const { rows } = await pool.query(`
    SELECT u.id, u.email,
           (SELECT COUNT(*) FROM workout_logs wl WHERE wl.user_id = u.id AND wl.completed_at > NOW() - INTERVAL '7 days') AS completed,
           (SELECT COALESCE(SUM(duration_seconds),0)/60 FROM workout_logs wl WHERE wl.user_id = u.id AND wl.completed_at > NOW() - INTERVAL '7 days') AS minutes
      FROM users u
      JOIN subscriptions sub ON sub.user_id = u.id
      LEFT JOIN user_settings s ON s.user_id = u.id
     WHERE sub.status IN ('active','trialing')
       AND COALESCE(s.data->'notifications'->>'weekly','true')::bool = true
  `);
  for (const u of rows) {
    try { await sendEmail(u.email, 'weekly_recap', {
      completed: u.completed, minutes: u.minutes, streak: u.completed,
    }); } catch(e){}
  }
  console.log(`[cron] weekly recap: ${rows.length} sent`);
}

// Expose for manual trigger / testing (admin token)
app.post('/api/admin/run-job', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN || !process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const kind = req.body?.kind;
  const map = { workout_reminder: jobWorkoutReminder, streak_nudge: jobStreakNudge, weekly_recap: jobWeeklyRecap };
  if (!map[kind]) return res.status(400).json({ error: 'unknown_kind' });
  try { await map[kind](); res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

function scheduleJobs(){
  if (!cron) { console.log('node-cron not installed; skipping schedule'); return; }
  // 10 AM UTC every day → workout reminder for those who haven't trained
  cron.schedule('0 10 * * *', () => jobWorkoutReminder().catch(e=>console.error(e)));
  // 7 PM UTC every day → streak nudge
  cron.schedule('0 19 * * *', () => jobStreakNudge().catch(e=>console.error(e)));
  // Monday 9 AM UTC → weekly recap
  cron.schedule('0 9 * * 1', () => jobWeeklyRecap().catch(e=>console.error(e)));
  console.log('Scheduled jobs registered (10:00 UTC workout, 19:00 UTC streak, Mon 09:00 UTC recap).');
}

// ---------- Boot ----------
(async () => {
  try {
    await runMigrations();
    try { await seedContent(); } catch (e) { console.error('Seed failed (non-fatal):', e.message); }
    scheduleJobs();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`IGNITE server listening on :${PORT}`);
      console.log(`APP_URL=${APP_URL}  IS_PROD=${IS_PROD}`);
    });
  } catch (e) {
    console.error('Boot failed:', e);
    process.exit(1);
  }
})();
