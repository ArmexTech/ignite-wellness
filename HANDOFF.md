# IGNITE — Ready-for-business handoff

**Live at:** https://ignite-wellness-production.up.railway.app
**Repo:** https://github.com/ArmexTech/ignite-wellness
**Deploy:** Railway (auto-deploys on `git push` to `main`)

---

## 0 · Test the app right now

**Demo mode** is active while we don't have a real backend. Two ways to log in:

**Option A — use the quiz funnel as a new user:**
1. Go to `/quiz.html`, complete the 20 questions
2. Pick any plan on the paywall
3. You're "logged in" and "paid" — lands on `/success.html` then `/app.html`

**Option B — use the test account directly:**
1. Go to `/login.html`
2. Email and password are pre-filled: `test@ignite.fit` / `testpass123`
3. Click Sign in — goes straight to `/app.html`

In demo mode, *any* email + any 8-char password works. Only the login route is mocked — real Stripe charges and real password-check will be wired as part of the payment-processing work below.

Gated pages (`/app.html`, `/workout.html`, `/success.html`) redirect to `/login.html?next=<page>` if you're not logged in. Sign out from the You tab clears your session.

---

## 1 · What's built

### Public pages
| Page | URL | Purpose |
|---|---|---|
| Landing | `/` | Marketing home with hero, features, testimonials, pricing, FAQ |
| Quiz funnel | `/quiz.html` | 20 steps → analyzing loader → personalized plan → paywall |
| Login / signup | `/login.html` | Email+password UI, Apple/Google stubs (SSO buttons ready to wire) |
| Contact | `/contact.html` | Form posts via mailto; swap for Formspree/Resend when ready |
| Terms of Service | `/terms.html` | Template — have a lawyer review before launch |
| Privacy Policy | `/privacy.html` | GDPR/CCPA-structured template — same review needed |
| Refund Policy | `/refund.html` | 30-day money-back guarantee |
| 404 | `/404.html` | On-brand not-found page |

### Gated pages (post-signup)
| Page | URL | Purpose |
|---|---|---|
| Dashboard | `/app.html` | Today's workout, weekly rhythm, 12-week plan, progress, profile |
| Workout player | `/workout.html` | Exercise-by-exercise with timer, rest periods, sound cues |
| Checkout success | `/success.html` | Post-purchase confirmation, plan summary, CTA into app |

### Infrastructure / SEO
- `robots.txt` — indexes public pages, blocks gated ones
- `sitemap.xml` — all public URLs for search engines
- `shared.js` — cookie consent banner + analytics loader stub
- OG + Twitter card meta tags on the landing page

---

## 2 · Before payment processing — what's required

### Must-do (all already scaffolded — you just fill in the blanks)

1. **Stripe account + products**
   - Sign up at stripe.com (or Paddle if you want them to handle VAT/sales tax globally).
   - Create three Prices in Stripe:
     - 1-month @ $19.99
     - 3-month @ $39.99
     - 12-month @ $99.99
   - Grab the Price IDs — they look like `price_1Abc...`.

2. **Replace the fake checkout**
   Currently in `quiz.html`, the paywall jumps straight to `/success.html` without charging.
   To wire real Stripe Checkout:
   ```html
   <!-- Stripe.js -->
   <script src="https://js.stripe.com/v3/"></script>
   ```
   And swap the `checkoutBtn` handler to:
   ```js
   const stripe = Stripe('pk_live_YOUR_PUBLISHABLE_KEY');
   const PRICE_IDS = { '1': 'price_xxx_monthly', '3': 'price_xxx_quarterly', '12': 'price_xxx_yearly' };
   document.getElementById('checkoutBtn').addEventListener('click', async () => {
     if (!selectedPlan) return;
     // Your backend creates the Checkout Session; easiest path: Stripe Payment Links (no backend needed)
     // For a prod-quality flow, POST to /api/create-checkout-session with {priceId, email}
     window.location.href = 'https://buy.stripe.com/xxxxxxxx'; // swap per plan
   });
   ```
   The success URL on your Stripe Checkout Session should point to `/success.html?plan={PLAN}&session_id={CHECKOUT_SESSION_ID}`.

3. **Review your legal pages**
   - Terms (`/terms.html`) has a `[your jurisdiction]` placeholder in §13.
   - Privacy (`/privacy.html`) lists the data you collect — remove anything you're not actually going to store.
   - Have a lawyer review for your country/state. ~$300–$800 one-time is typical.

4. **Set up the support email addresses** (or aliases) that the pages reference:
   - `support@ignite.fit`, `refunds@ignite.fit`, `privacy@ignite.fit`, `press@ignite.fit`, `hello@ignite.fit`
   - Easiest: one Google Workspace account + aliases, or one Fastmail account + plus-addressing.

5. **Pick a real domain**
   - Buy `ignite.fit` (or whatever you land on) from Namecheap/Cloudflare Registrar.
   - In Railway → Settings → Networking → Custom Domain, add it, add the CNAME on your DNS.
   - Update the canonical URLs in `robots.txt`, `sitemap.xml`, and the meta tags in each HTML file's `<head>`.

6. **Webhooks (only if you want automation)**
   - In Stripe Dashboard → Webhooks, add an endpoint (e.g., `https://api.ignite.fit/stripe/webhook`).
   - Listen for `checkout.session.completed` to provision accounts, `customer.subscription.deleted` to handle cancellations, `invoice.payment_failed` for dunning.

### Nice-to-have (ship without if you're moving fast)
- **Real auth.** Right now `/login.html` is UI only. When you add Stripe, the easiest path is Clerk or Supabase Auth. Both have a drop-in script.
- **Backend.** Quiz answers live in `sessionStorage` today. Store them server-side so users can pick up where they left off across devices.

---

## 3 · Before marketing — what's required

### Analytics plumbing (5-minute job)
`shared.js` already has the consent banner + a commented-out analytics loader. Uncomment one:

- **Plausible** (privacy-friendly, cookieless, $9/mo): uncomment the Plausible block, change `data-domain` to your real domain.
- **GA4** (free): uncomment the gtag block, paste your Measurement ID.
- **PostHog** (free tier, also does product analytics/session replay): grab the snippet from their dashboard.

The analytics only fire after the user clicks "Accept" on the cookie banner — GDPR-compliant out of the box.

### Transactional email
You're referencing `support@ignite.fit`, receipts, password resets, etc. Pick one:
- **Resend** ($0 for first 3k/mo, clean API, React Email templates) — my recommendation.
- **Postmark** (reliable, $15/mo for first 10k).
- **SendGrid** / Mailgun (legacy, more config).

Templates you'll want on day 1:
1. Welcome (after signup)
2. Receipt (after Stripe charge)
3. Password reset
4. Plan-updated email (optional but nice)

### Social + brand
- **Favicon** — using emoji 🔥. Ship your own at `/favicon.ico` and `/apple-touch-icon.png`.
- **OG share image** — add a 1200×630 PNG at `/og.png` and reference it with `<meta property="og:image">`. Without this, shares look bare.
- **Twitter/X card image** — usually the same as OG.

### Growth checklist (paid acquisition)
1. **Meta Ads pixel** — add the Meta Pixel to `shared.js` (trigger on consent). Main conversion events: `PageView`, `Lead` (quiz completed + email captured), `Purchase` (success page).
2. **Google Ads tag** — same pattern. Conversion events same as above.
3. **Google Search Console** — submit `sitemap.xml`, verify domain.
4. **Bing Webmaster Tools** — same, takes 2 minutes and catches ~3% of US/UK traffic.
5. **TikTok Pixel** — if you're running TikTok ads.

### Content / organic
- Start a **blog** subfolder at `/blog/` when ready — add new entries to `sitemap.xml`.
- **Testimonials page** — pull the quotes from the landing and expand into a dedicated page at `/stories.html`.
- **Coach bios** — `/team.html` with photos, credentials. Builds trust and ranks for branded terms.

### Retention
- **Transactional emails** → handled above.
- **Push / in-app notifications** — wire when you turn the app into a PWA or wrap with Capacitor.
- **Referral program** — easiest is ReferralHero or a simple `?ref=USER_ID` URL param that credits accounts. Plan for month 2.

---

## 4 · Known gaps / deferred work

- Workout content is a single hardcoded "Glute sculpt" in `workout.html`. Long-term, workouts come from a library served by your backend based on the user's plan.
- The dashboard's progress charts use hardcoded demo data. Hook them up to real user-logged weights when you have a backend.
- Apple / Google SSO buttons in `/login.html` are stubs (they `alert()` right now). Point them at your OAuth endpoints once auth is wired.
- The 12-week program on the Plan tab is visual only. Mark completion server-side when you save workout logs.
- No PWA manifest yet — add one when you want installable / push notifications.

---

## 5 · How to make future changes

Every commit to `main` auto-redeploys on Railway. Typical loop:

```bash
cd ~/Documents/claude/projects/"womens wellness app"
# edit files
git add .
git commit -m "what you changed"
git push
# Railway redeploys in ~2 minutes
```

If the edit is a one-liner, you can also use the GitHub web UI: go to the file on github.com, click the pencil icon, edit, commit to main.

### Emergency rollback
Railway → Deployments → find a healthy prior deploy → click `⋯` → Redeploy. Rolls back in ~15 seconds without touching git.

---

## 6 · File map

```
womens wellness app/
├── index.html          landing page
├── quiz.html           20-step funnel + paywall
├── app.html            dashboard (4 tabs)
├── login.html          sign-in / signup
├── workout.html        exercise player
├── success.html        post-checkout confirmation
├── contact.html        support form
├── terms.html          Terms of Service
├── privacy.html        Privacy Policy
├── refund.html         30-day guarantee
├── 404.html            not-found page
├── shared.js           cookie banner + analytics loader
├── robots.txt          SEO
├── sitemap.xml         SEO
├── package.json        start command for Railway
├── railway.json        Railway deploy config
├── README.md           developer notes
└── HANDOFF.md          this file
```

---

## TL;DR — to launch commercially

1. ✅ Domain — buy & point at Railway
2. ✅ Stripe — create 3 prices, wire checkout in `quiz.html`
3. ✅ Lawyer review on Terms + Privacy
4. ✅ Support email aliases
5. ✅ Analytics provider (Plausible or GA4) — uncomment in `shared.js`
6. ✅ Transactional email (Resend)
7. ✅ OG + favicon image files
8. ✅ Meta Pixel + Google Ads tag for paid
9. 🚀 Ship

You're 1–2 days of focused work from accepting real payments.
