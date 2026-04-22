-- IGNITE database schema (idempotent)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS quiz_responses (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  goal TEXT,
  body_now TEXT,
  body_goal TEXT,
  focus TEXT[],
  age TEXT,
  level TEXT,
  place TEXT,
  time_per INT,
  lifestyle TEXT[],
  height NUMERIC,
  height_unit TEXT,
  weight NUMERIC,
  weight_unit TEXT,
  target_weight NUMERIC,
  event TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  current_period_end TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workout_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workout_name TEXT,
  duration_seconds INT,
  exercises_completed INT,
  felt_how TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workout_logs_user_idx ON workout_logs (user_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta JSONB
);
CREATE INDEX IF NOT EXISTS email_events_user_idx ON email_events (user_id, sent_at DESC);

-- =================================================================
-- Exercise & workout content
-- =================================================================

CREATE TABLE IF NOT EXISTS exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT,
  description TEXT,
  form_cues TEXT[],
  muscle_groups TEXT[],
  difficulty TEXT,                 -- 'beginner' | 'intermediate' | 'advanced'
  equipment TEXT[],                -- ['none'] or ['dumbbells','bench']
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exercise_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  variation TEXT NOT NULL DEFAULT 'default',  -- 'default' | 'modified' | 'advanced'
  provider TEXT NOT NULL DEFAULT 'url',       -- 'url' | 'mux' | 'youtube' | 'bunny'
  video_url TEXT,                             -- MP4/HLS URL (provider=url) or full HLS
  playback_id TEXT,                           -- Mux/Bunny playback ID
  thumbnail_url TEXT,
  duration_seconds INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(exercise_id, variation)
);

CREATE TABLE IF NOT EXISTS workouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  focus TEXT,                     -- 'glutes' | 'core' | 'hiit' | ...
  duration_minutes INT,
  difficulty TEXT,
  description TEXT,
  rest_seconds INT NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workout_exercises (
  workout_id UUID NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  position INT NOT NULL,
  exercise_id UUID NOT NULL REFERENCES exercises(id),
  mode TEXT NOT NULL DEFAULT 'reps',   -- 'reps' | 'time'
  sets INT,
  reps TEXT,
  duration_seconds INT,
  rest_seconds INT,
  tip TEXT,
  PRIMARY KEY (workout_id, position)
);
CREATE INDEX IF NOT EXISTS workout_exercises_workout_idx ON workout_exercises (workout_id, position);
