# IGNITE — Women's Wellness App

A personalized women's fitness app prototype, built in the style of Mad Muscles. Bold and energetic brand, quiz-driven onboarding, and an in-app dashboard mockup.

## Files

| File | What it is |
|---|---|
| `index.html` | Marketing landing page — hero, features, social proof, pricing, FAQ, footer |
| `quiz.html` | 20-step onboarding quiz + analyzing loader + personalized plan result + paywall with 3 pricing tiers |
| `app.html` | In-app dashboard — today's workout, weekly rhythm, 12-week plan, progress charts, profile |
| `ignite.html` | Identical earlier copy of the quiz (safe to delete) |

## End-to-end flow

```
index.html  →  quiz.html  →  app.html
  (landing)    (funnel+pay)    (dashboard)
```

- **Landing** — every CTA ("Take the quiz", "Sign in", pricing tiles) routes into the funnel.
- **Quiz** — 20 screens, progress bar, auto-advance on single-selects, manual advance on multi-selects. Ends with an analyzing loader, a personalized plan with a dynamic SVG projection chart, and a paywall. Quiz answers are stashed in `sessionStorage` as `ignite_profile` so the dashboard can personalize.
- **App** — reads `sessionStorage.ignite_profile` on load and personalizes the greeting, workout title, focus zones, session length, weekly rhythm, and profile settings. Four tabs: Today / Plan / Progress / You.

## Deploy in 2 minutes

### Option A — Netlify Drop (easiest)
1. Open <https://app.netlify.com/drop>
2. Drag the whole `Womens Wellness App` folder onto the page
3. You get a live URL instantly

### Option B — Vercel
```bash
npm i -g vercel
cd "Womens Wellness App"
vercel
```
Accept defaults; Vercel auto-detects static HTML.

### Option C — GitHub Pages
```bash
git init && git add . && git commit -m "IGNITE v1"
# push to a repo, then Settings → Pages → Deploy from main / root
```

### Option D — Open locally
Just double-click `index.html`. Because it's pure HTML/CSS/JS with no build step, it works on `file://` — the only caveat is that `sessionStorage` won't persist across separate file opens the same way it does on a real domain.

## Tech notes

- **Zero dependencies.** Pure HTML, CSS, vanilla JS. No framework, no build tool.
- **Mobile-first.** Quiz and app cap at `520px` wide for a native-app feel; landing is fully responsive.
- **Brand palette:** hot pink `#FF2E7E`, orange `#FF7A3D`, yellow `#FFD23F`, mint `#00F0B5` on deep navy `#0B0B1F`.
- **No tracking, no analytics.** Add your own (GA4, Plausible, PostHog) when you go live.

## How to rebrand

Every file uses the placeholder name **IGNITE**. To rebrand, find-and-replace:
- `IGNITE` (logo, copy)
- The favicon emoji 🔥 in the `<link rel="icon">` data URL
- Gradient colors in the `:root` CSS variable block of each file

## What's faked vs. real

| Feature | Real | Faked |
|---|---|---|
| Quiz flow and state | ✅ All 20 steps work | — |
| Personalized plan output | ✅ Computes from answers | — |
| Paywall screen | ✅ Plan selection works | 💰 Checkout doesn't charge — wire to Stripe/Paddle |
| In-app dashboard | ✅ Reads quiz answers | 🏋️ Workout videos are placeholders |
| Weekly calendar | ✅ Renders real dates | — |
| Progress charts | ✅ SVG renders | 📊 Data is hardcoded demo data |
| Workout player | ✅ Opens a modal | ▶️ "Start" shows an alert instead of video |

## Turning it into a real product (next steps)

1. **Payments.** Swap the `checkoutBtn` click in `quiz.html` for a Stripe Checkout or Paddle redirect. Both have one-line snippets.
2. **Accounts.** Add Supabase or Clerk for sign-in. Store the quiz answers on the user row instead of `sessionStorage`.
3. **Backend.** Move the plan computation server-side (Node/Python) so logic isn't client-exposed. Tiny: `/api/generate-plan` that takes quiz answers and returns the plan.
4. **Content.** Shoot the workout videos (or license a library — e.g., Workouts Hub, VideoBlocks). Store on Bunny.net or Mux.
5. **Mobile.** Wrap with Capacitor to ship to iOS/Android App Stores without rewriting.
6. **Growth.** Swap the placeholder logos row on the landing page with real press (Forbes, etc.) once you have them; add retargeting pixels; A/B test the quiz headline and CTA.

## License

Your project, your call. The code is yours.
