/**
 * IGNITE — shared client-side utilities
 *  - Cookie consent banner (GDPR/CCPA)
 *  - Analytics stub (wire GA4 / PostHog / Plausible here)
 *  - Version pinging for detecting stale tabs
 *
 * Load at the BOTTOM of each page: <script defer src="shared.js"></script>
 */
(function(){
  // ---------- Cookie consent ----------
  function consentChoice(){ try { return localStorage.getItem('ignite_cookie_choice'); } catch(e){ return null; } }
  function setConsent(v){ try { localStorage.setItem('ignite_cookie_choice', v); } catch(e){} }

  function mountBanner(){
    if (consentChoice()) return;
    const css = `
      #cc{position:fixed;bottom:12px;left:12px;right:12px;max-width:560px;margin:0 auto;
          background:#14142E;border:1px solid #2B2B52;border-radius:16px;padding:14px 18px;
          z-index:99;box-shadow:0 10px 40px rgba(0,0,0,.4);font-size:13px;color:#D4D4E6;
          font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
      #cc .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
      #cc .msg{flex:1;min-width:220px;line-height:1.5}
      #cc a{color:#FF2E7E}
      #cc .btns{display:flex;gap:8px}
      #cc button{font:inherit;cursor:pointer;border:0;font-weight:700}
      #cc .d{padding:8px 14px;border:1px solid #2B2B52;border-radius:10px;background:#1A1A3A;color:#fff;font-size:13px}
      #cc .a{padding:8px 14px;border-radius:10px;background:linear-gradient(135deg,#FF2E7E,#FF7A3D 70%,#FFD23F);color:#0B0B1F;font-weight:800;font-size:13px}`;
    const style = document.createElement('style'); style.textContent = css;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.id = 'cc';
    el.innerHTML = `<div class="row">
      <div class="msg">🍪 We use cookies to keep you signed in and improve IGNITE. See our <a href="privacy.html">Privacy Policy</a>.</div>
      <div class="btns">
        <button class="d" id="cc-decline">Decline</button>
        <button class="a" id="cc-accept">Accept</button>
      </div>
    </div>`;
    document.body.appendChild(el);
    document.getElementById('cc-decline').addEventListener('click', () => { setConsent('decline'); el.remove(); });
    document.getElementById('cc-accept').addEventListener('click', () => { setConsent('accept'); el.remove(); window.IGNITE_loadAnalytics && window.IGNITE_loadAnalytics(); });
  }

  // ---------- Analytics stub ----------
  // Replace this with real loader for your provider.
  // Only fires after user accepts cookies.
  window.IGNITE_loadAnalytics = function(){
    // Example: Plausible (privacy-friendly, cookieless). Activate by uncommenting.
    // const s = document.createElement('script');
    // s.defer = true;
    // s.setAttribute('data-domain', 'ignite.fit');
    // s.src = 'https://plausible.io/js/script.js';
    // document.head.appendChild(s);

    // Example: GA4. Uncomment and replace G-XXXXXXXXXX with your measurement ID.
    // const g = document.createElement('script'); g.async = true;
    // g.src = 'https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX';
    // document.head.appendChild(g);
    // window.dataLayer = window.dataLayer || [];
    // function gtag(){dataLayer.push(arguments);}
    // gtag('js', new Date()); gtag('config', 'G-XXXXXXXXXX');
  };

  // If user previously accepted, auto-load analytics
  if (consentChoice() === 'accept') {
    try { window.IGNITE_loadAnalytics(); } catch(e){}
  }

  // ---------- Boot ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBanner);
  } else {
    mountBanner();
  }
})();
