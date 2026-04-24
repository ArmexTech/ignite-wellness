# Remember that little idea we had?

So, the women's fitness app thing we were talking about — same vibe as Mad Muscles / BetterMe but women-specific, personalized quiz to a plan, subscription at $19.99 to $99.99. I actually built it. Wanted to show you where it's got to and get your honest take before I decide what to do next.

**Go have a play:** https://ignite-wellness-production.up.railway.app

---

## How to test it in 3 minutes

Easiest path is on your phone so the push notifications + "install as an app" bits make sense. Works fine on desktop too.

1. **Open the landing page** on your phone browser: https://ignite-wellness-production.up.railway.app
2. **Tap "Take the 60-sec quiz →"** and go through it. Pick anything — whatever fits you (or whoever you're pretending to be). It captures goals, body info, focus zones, equipment, lifestyle, height/weight, email.
3. **At the paywall**, pick any plan. Enter any password (8+ characters). You're not actually being charged — Stripe isn't wired in yet, so it drops you straight into the app as if you'd paid.
4. **You'll land on the dashboard.** Today's workout, weekly calendar, 12-week program ring, stats — all personalized from your quiz answers.
5. **Hit the play button on the workout card**. The exercise player opens — exercise-by-exercise with a timer for holds, rep counts for sets, form cues, pause / skip / previous buttons. Right now there's just an emoji where the video would go; the video infrastructure is built and ready — it just needs content.
6. **Go to the "You" tab** (bottom-right). Tap through all the settings — Cycle & hormones, Goal weight, Weekly schedule, Equipment, Notifications, Subscription. They all work and save to a real Postgres database.
7. **Notifications → Enable push.** Your phone will ask permission. Grant it. Now you're actually subscribed to push notifications from the server.
8. **To see a real push fire**, send me a text saying you're subscribed and I'll trigger one at you. You should get a native notification on your phone within seconds — same system that'll remind users to work out daily.

If you want to install it properly:
- **iPhone**: Safari → Share button → "Add to Home Screen." Opens like a real app from then on.
- **Android**: Chrome will prompt you in the URL bar. Or from the menu, "Install app."
- **Desktop Chrome**: install icon appears in the URL bar.

If you want to poke around as an engineer: the code is at `github.com/ArmexTech/ignite-wellness`. Happy to share access.

---

## What's actually built vs what's still to do

### Working right now, on live infrastructure:

- The full product flow — landing → quiz → paywall → personalized dashboard → workout player
- Real user accounts in a Postgres database — signup, sign-in, password reset, sign-out, all the auth plumbing a real app needs
- Settings that actually save (cycle tracking, goal weight, equipment, notification prefs, etc.)
- Installable as a phone app via PWA — home screen icon, launches standalone
- Push notifications working end-to-end — subscribed via the browser, delivered via a server on Railway
- A cron scheduler running on the server that fires daily workout reminders, streak nudges, and Monday weekly recaps automatically
- Legal pages (Terms, Privacy, Refund) — drafted to the structure lawyers look for, but needs a lawyer review pass
- Admin tooling for me to upload and manage exercise demos
- 20 exercises and 3 full workouts seeded (Glute Sculpt, Core Ignition, Full-body HIIT)
- Stripe checkout code is all written — endpoints, webhook handling, subscription activation, automatic welcome email — just waiting for me to plug in the API keys
- Transactional email templates are all written — welcome, password reset, workout reminders, streak nudges, weekly recap — waiting for the Resend API key
- The workout video player plays real video (MP4 or HLS) when I upload a URL for any exercise. Falls back to the emoji when there's no video yet.

### What's left before I can actually charge people:

- Plug in Stripe keys and create the three products in their dashboard (half a day, no cost)
- Plug in Resend email key (half a day, no cost)
- Get the Terms and Privacy reviewed by a lawyer (~$800, ~1 week)
- Make an actual logo instead of the 🔥 emoji and grab a real domain
- **The biggest thing: real exercise videos.** I can play any URL I plug in, but I haven't filmed anything yet. This is the main content-and-money decision.

Everything else is mostly paperwork.

---

## The money question

There are three realistic ways to do this. I'll tell you what I'd actually do, but here's the spread.

### Shoestring — ~$3-5k upfront, cheap to run

- Lawyer review on the legals: ~$800
- Basic logo + share image: ~$500
- Shoot 8-12 key exercises on a phone myself with a friend who lifts, restyle clips in AI to make them look cohesive: ~$500-1,500
- Domain + Google Workspace + buffer: ~$500
- Everything else is already built

Then just me doing organic marketing on Instagram, TikTok, Reddit, working with the quiz flow as the hook. Slow, but you'd see if anyone actually wants this before spending real money.

Runs at maybe $150-250/month once live (mostly Railway + email + video CDN).

### Standard — ~$12-18k upfront + ~$3-5k/month marketing

This is what I'd actually do.

- Hire a certified women's fitness trainer for half a day, shoot 30 exercises in a plain studio, restyle with AI to a consistent look: ~$3,500-5,000
- Proper brand identity (logo, palette, guidelines): ~$2,500
- Lawyer + LLC + basic business insurance: ~$2,000
- Seed with 3-5 micro-influencers on Instagram/TikTok for credibility: ~$2,500
- Buffer: ~$1,500

Then $3-5k/month across Meta ads + Google ads for 8-12 weeks to test what people actually click on.

Realistic outcome with that: 1,500-5,000 paying users in year one. You'd know inside 3 months whether the unit economics work and whether this is "keep bootstrapping" or "raise a proper round."

Ships in 5-7 weeks.

### Full send — ~$30-55k upfront + ~$10-25k/month marketing

Full agency brand identity, 3-day shoot with trainer + studio + cinematographer + editor doing 50+ exercises with variations, proper PR push, bigger influencer seeding, aggressive paid marketing. This is "day-one polish on par with BetterMe."

Only makes sense if the goal is explicitly "raise a seed round in 4-6 months based on strong early signal."

Ships in 8-12 weeks.

---

## The numbers, at a glance

- **Pricing built:** $19.99/mo, $39.99 quarterly, $99.99 yearly
- **Blended revenue per user** (assuming typical split): ~$12.60/mo
- **Gross margin** after Stripe fees and video streaming: ~95%
- **What 1,000 paying users would look like:** ~$12,600/mo revenue, about $600/mo in running costs, ~$12k/mo gross profit

### What $25k would actually buy

- ~$4k: content shoot + brand
- ~$3k: 3 months of running costs and buffer
- ~$18k: marketing test across Meta + Google + creators

At a $15-30 customer acquisition cost (normal for women's fitness), that's 600-1,200 paying subscribers in the door within 90 days. Roughly $7-15k MRR by month 3. Not profitable at that scale, but it gives you the real data on what acquisition and retention actually look like — which is the only thing that matters for deciding whether to put more in, raise, or slow down.

### What $50k would do

Same baseline plus a bigger content library and 3 months of more serious marketing. 1,500-3,000 subscribers, $18-30k MRR at month 3, enough cohort data to make a raise case or stay profitably bootstrapped.

---

## Honest bit

Not pretending this is a sure thing. Three things would scare me in my own shoes:

1. **Customer acquisition cost is the whole game.** The product is solid and the retention systems are built — but women's fitness is a crowded category and every dollar after launch goes into finding an angle that ads cheaply respond to. If we can't find that inside the first few marketing tests, the whole thing grinds.
2. **Retention in consumer fitness is genuinely brutal.** Industry-wide, 6-month retention for fitness apps is often below 20% — people start strong, fall off. I've built the personalization + reminder infrastructure specifically to push against that, but until we see real user cohorts it's still an assumption.
3. **BetterMe, Noom, and MyFitnessPal have actual billions of ad budget.** We survive by owning a distinct lane — women's-health-first, cycle-aware, postnatal-inclusive — not by trying to beat them head-on.

The positioning is there. The product is built. What decides the outcome is content quality and finding an acquisition channel that converts — both of which are what the money buys.

---

## What I'd love from you

Honest reaction after you've played with it. Questions, "this feels off," "have you thought about X" — all useful. And if you'd want in on a round, what level makes sense for you, and how involved you'd want to be.

No rush. Really appreciate you looking.
