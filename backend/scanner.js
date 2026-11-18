/**
 * scanner.js  –  Multi-page intelligent website analyser
 *
 * HOW IT WORKS:
 *  1. Puppeteer crawls up to 8 pages of the target site
 *  2. Merges signals from all pages (H1s, nav, CTAs, forms, body text, JSON-LD)
 *  3. Sends merged site signals + full EVENT_LIBRARY_EXAMPLES to AI as few-shot reference
 *  4. AI reads real site content, learns from library patterns, generates 45-50 CUSTOM events
 *  5. Returns deeply site-specific events — not a fixed list, not a copy of examples
 */

const puppeteer = require('puppeteer');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');

const MAX_PAGES         = 8;
const PAGE_TIMEOUT      = 18000;
const JS_SETTLE_MS      = 1800;
const SCAN_TIMEOUT_MS   = 180000;  // hard cap on a full scan (3 min)
const CACHE_TTL_MS      = 24 * 60 * 60 * 1000;  // 24h
const CACHE_MAX_ENTRIES = 50;

// Module-level scan-result cache, keyed by normalised origin+path.
const scanCache = new Map();

function cacheKeyFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

function cacheGet(url) {
  const key = cacheKeyFor(url);
  const hit = scanCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    scanCache.delete(key);
    return null;
  }
  return hit.result;
}

function cacheSet(url, result) {
  const key = cacheKeyFor(url);
  scanCache.set(key, { at: Date.now(), result });
  // Cheap LRU-ish eviction: drop oldest insertion when over capacity.
  if (scanCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = scanCache.keys().next().value;
    if (oldestKey) scanCache.delete(oldestKey);
  }
}

// ─── Chrome path detection ────────────────────────────────────────────────────
function findChromePath() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { console.log(`[Scanner] Chrome: ${p}`); return p; } }
    catch (_) {}
  }
  console.warn('[Scanner] No system Chrome — using bundled Chromium.');
  return null;
}

function getLaunchOptions() {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--window-size=1280,900', '--disable-extensions',
    '--disable-background-networking', '--mute-audio', '--no-first-run',
  ];
  const opts = { headless: 'new', args, ignoreHTTPSErrors: true };
  const chrome = process.env.CHROME_PATH || findChromePath();
  if (chrome) opts.executablePath = chrome;
  return opts;
}

// ─── Page goto with fallback strategies ──────────────────────────────────────
async function gotoSafe(page, url) {
  const strategies = [
    { waitUntil: 'networkidle2',     timeout: PAGE_TIMEOUT },
    { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT },
    { waitUntil: 'load',             timeout: PAGE_TIMEOUT },
  ];
  for (const s of strategies) {
    try {
      const resp   = await page.goto(url, s);
      const status = resp ? resp.status() : 0;
      if (status < 500) return true;
    } catch (_) {}
  }
  return false;
}

// ─── Apply stealth headers ────────────────────────────────────────────────────
async function applyStealth(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  page.on('console', () => {});
  page.on('pageerror', () => {});
}

// ─── Page type classifier ─────────────────────────────────────────────────────
function classifyUrl(url) {
  const u = url.toLowerCase();
  if (/\/checkout|\/payment|\/order\/new/.test(u))                        return 'checkout';
  if (/\/login|\/signin|\/sign-in/.test(u))                               return 'login';
  if (/\/signup|\/register|\/join|\/create-account/.test(u))              return 'signup';
  if (/\/search|\?q=|\?query=|\?s=/.test(u))                              return 'search';
  if (/\/product\/|\/item\/|\/p\/|\/dp\/|\/pd\/|productid=/.test(u))      return 'product';
  if (/\/category\/|\/collection\/|\/catalog\/|\/browse\/|\/dept\//.test(u)) return 'category';
  if (/\/contact|\/support|\/help|\/faq/.test(u))                         return 'support';
  if (/\/about|\/team|\/company/.test(u))                                 return 'about';
  if (/\/pricing|\/plans|\/subscription/.test(u))                         return 'pricing';
  if (/\/blog|\/news|\/article|\/post/.test(u))                           return 'blog';
  if (/\/account|\/profile|\/dashboard|\/my-/.test(u))                   return 'account';
  if (/\/order|\/track/.test(u))                                          return 'orders';
  return 'other';
}

// ─── Discover internal links ──────────────────────────────────────────────────
async function discoverLinks(page, baseHostname) {
  return page.evaluate((hostname) => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => {
        try {
          const u = new URL(a.href);
          if (u.hostname !== hostname) return null;
          if (u.pathname === '/') return null;
          if (/\.(pdf|jpg|png|gif|zip|exe|js|css|xml|json)$/i.test(u.pathname)) return null;
          return u.href.split('#')[0];
        } catch { return null; }
      })
      .filter(Boolean);
  }, baseHostname);
}

// ─── Extract signals from a single loaded page ───────────────────────────────
async function extractSignals(page, pageType) {
  await new Promise(r => setTimeout(r, JS_SETTLE_MS));
  const data = await page.evaluate((ptype) => {
    const getText = (sel, n) =>
      Array.from(document.querySelectorAll(sel))
        .map(el => (el.innerText || el.textContent || '').trim())
        .filter(Boolean).slice(0, n);

    const navLinks = Array.from(document.querySelectorAll('nav a, header a, [role="navigation"] a'))
      .map(a => ({ text: a.innerText.trim().slice(0, 60), href: a.href }))
      .filter(l => l.text).slice(0, 30);

    const ctaTexts = Array.from(document.querySelectorAll(
      'button, a.btn, [class*="button"], [class*="cta"], input[type="submit"], [role="button"]'
    )).map(el => (el.innerText || el.textContent || el.value || '').trim())
      .filter(t => t && t.length < 80).slice(0, 40);

    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.action || '',
      id: f.id || '',
      fields: Array.from(f.querySelectorAll('input,textarea,select'))
        .map(i => i.name || i.placeholder || i.type || '').filter(Boolean).slice(0, 6),
    })).slice(0, 8);

    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
      .filter(Boolean).slice(0, 2);

    return {
      pageType:   ptype,
      url:        window.location.href,
      pageTitle:  document.title,
      metaDesc:   document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      ogType:     document.querySelector('meta[property="og:type"]')?.getAttribute('content') || '',
      ogSiteName: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '',
      h1s:        getText('h1', 4),
      h2s:        getText('h2', 8),
      navLinks,
      ctaTexts,
      forms,
      jsonLd,
      bodyText:   (document.body?.innerText || '').slice(0, 1500),
    };
  }, pageType);
  return data;
}

// ─── Select best pages to crawl ───────────────────────────────────────────────
// Most types want one sample; product/category want a few so the model sees
// variation in attributes, brand, and price points.
function selectPages(links) {
  const PRIORITY = [
    'product', 'checkout', 'login', 'signup',
    'search', 'category', 'pricing', 'orders',
    'support', 'account', 'blog', 'about', 'other',
  ];
  const QUOTA_PER_TYPE = { product: 3, category: 2 };

  const byType = {};
  for (const link of links) {
    const type = classifyUrl(link);
    const quota = QUOTA_PER_TYPE[type] || 1;
    if (!byType[type]) byType[type] = [];
    if (byType[type].length < quota && !byType[type].includes(link)) {
      byType[type].push(link);
    }
  }

  const selected = [];
  const limit = MAX_PAGES - 1;
  for (const type of PRIORITY) {
    for (const url of byType[type] || []) {
      if (selected.length >= limit) break;
      selected.push({ url, type });
    }
    if (selected.length >= limit) break;
  }
  return selected;
}

// ─── Merge signals from all crawled pages ────────────────────────────────────
function mergeSignals(allPageData) {
  const merged = {
    pagesScanned:   allPageData.length,
    pagesSummary:   allPageData.map(p => `[${p.pageType}] ${p.pageTitle} — ${p.url}`),
    siteName:       allPageData[0]?.ogSiteName || '',
    homeTitle:      allPageData[0]?.pageTitle  || '',
    homeMetaDesc:   allPageData[0]?.metaDesc   || '',
    allH1s:         [],
    allH2s:         [],
    allNavLinks:    [],
    allCtaTexts:    [],
    allForms:       [],
    allJsonLd:      [],
    bodyTextByPage: [],
    pageTypes:      [],
  };

  for (const p of allPageData) {
    merged.allH1s.push(...(p.h1s || []));
    merged.allH2s.push(...(p.h2s || []));
    merged.allNavLinks.push(...(p.navLinks || []).map(l => l.text));
    merged.allCtaTexts.push(...(p.ctaTexts || []));
    merged.allForms.push(...(p.forms || []));
    merged.allJsonLd.push(...(p.jsonLd || []));
    merged.bodyTextByPage.push(`[${p.pageType} page] ${p.bodyText?.slice(0, 600) || ''}`);
    merged.pageTypes.push(p.pageType);
  }

  merged.allH1s      = [...new Set(merged.allH1s)].slice(0, 15);
  merged.allH2s      = [...new Set(merged.allH2s)].slice(0, 20);
  merged.allNavLinks = [...new Set(merged.allNavLinks)].slice(0, 30);
  merged.allCtaTexts = [...new Set(merged.allCtaTexts)].slice(0, 50);
  merged.pageTypes   = [...new Set(merged.pageTypes)];

  return merged;
}

// ─── EVENT LIBRARY — full reference sent to AI as design examples ─────────────
//
// NOT a fixed output list. The AI receives all examples below as few-shot
// design patterns and uses them to learn schema, naming, priority, and property
// conventions — then generates 45-50 NEW events tailored to the actual website.
//
// Multi-vertical library — each example tagged with `vert`. The prompt asks
// the AI to classify the site's vertical first, then generate events ONLY in
// that vertical's vocabulary (plus the universal set).
const EVENT_LIBRARY_EXAMPLES = [
  // ── UNIVERSAL (applies to almost every website) ────────────────────────────
  { vert: 'universal',     category: 'Acquisition', priority: 'must-have',    eventName: 'Page Viewed',                triggerDescription: 'Every page or screen load', suggestedProperties: ['page_url','page_title','referrer','utm_source','utm_medium','utm_campaign','device_type'] },
  { vert: 'universal',     category: 'Acquisition', priority: 'recommended',  eventName: 'CTA Clicked',                triggerDescription: 'User clicks a primary call-to-action on any page', suggestedProperties: ['cta_text','cta_location','page_url','plan_context'] },
  { vert: 'universal',     category: 'Acquisition', priority: 'recommended',  eventName: 'Banner Clicked',             triggerDescription: 'User clicks a hero or promotional banner', suggestedProperties: ['banner_id','banner_name','destination_url','position','campaign_name'] },
  { vert: 'universal',     category: 'Activation',  priority: 'must-have',    eventName: 'Account Created',            triggerDescription: 'User completes registration and creates an account', suggestedProperties: ['signup_method','referral_source','email','phone','device_type'] },
  { vert: 'universal',     category: 'Activation',  priority: 'must-have',    eventName: 'Login Completed',            triggerDescription: 'User successfully logs into their account', suggestedProperties: ['login_method','device_type','is_returning_user','days_since_last_login','mfa_used'] },
  { vert: 'universal',     category: 'Activation',  priority: 'recommended',  eventName: 'Email Subscribed',           triggerDescription: 'User subscribes to newsletter or marketing emails', suggestedProperties: ['subscription_source','email','preferences','incentive_used'] },
  { vert: 'universal',     category: 'Retention',   priority: 'must-have',    eventName: 'Session Started',            triggerDescription: 'User begins a new web session', suggestedProperties: ['days_since_last_session','device_type','entry_page','referrer'] },
  { vert: 'universal',     category: 'Retention',   priority: 'recommended',  eventName: 'Notification Clicked',       triggerDescription: 'User clicks a push, web push, or in-page notification', suggestedProperties: ['notification_type','content_id','campaign_id','cta_text'] },
  { vert: 'universal',     category: 'Referral',    priority: 'must-have',    eventName: 'Referral Link Shared',       triggerDescription: 'User shares their referral or invite link', suggestedProperties: ['share_channel','referral_code','incentive_type','source_page'] },

  // ── SOCIAL (Twitter, Reddit, Pinterest web, photo communities) ─────────────
  { vert: 'social',        category: 'Retention',   priority: 'must-have',    eventName: 'Post Viewed',                triggerDescription: 'A post is displayed in feed or detail view', suggestedProperties: ['post_id','author_id','post_type','source_page','dwell_time_secs'] },
  { vert: 'social',        category: 'Retention',   priority: 'must-have',    eventName: 'Post Liked',                 triggerDescription: 'User likes or reacts to a post', suggestedProperties: ['post_id','author_id','reaction_type','source_page'] },
  { vert: 'social',        category: 'Retention',   priority: 'recommended',  eventName: 'Comment Posted',             triggerDescription: 'User submits a comment on a post', suggestedProperties: ['post_id','comment_length','has_mention','has_emoji'] },
  { vert: 'social',        category: 'Activation',  priority: 'recommended',  eventName: 'Follow Tapped',              triggerDescription: 'User follows another account', suggestedProperties: ['target_user_id','source_page','is_recommended'] },
  { vert: 'social',        category: 'Referral',    priority: 'recommended',  eventName: 'Content Shared',             triggerDescription: 'User shares a post to another network or chat', suggestedProperties: ['content_id','share_channel','content_type'] },

  // ── CONTENT / STREAMING / NEWS (Netflix, YouTube, Spotify, news, blogs) ────
  { vert: 'content',       category: 'Retention',   priority: 'must-have',    eventName: 'Content Played',             triggerDescription: 'User starts playing a video, audio, or opens an article', suggestedProperties: ['content_id','content_type','title','category','duration_secs','source_page'] },
  { vert: 'content',       category: 'Retention',   priority: 'must-have',    eventName: 'Content Completed',          triggerDescription: 'User reaches the end of a piece of content', suggestedProperties: ['content_id','watch_time_secs','completion_pct','was_resumed'] },
  { vert: 'content',       category: 'Retention',   priority: 'recommended',  eventName: 'Content Bookmarked',         triggerDescription: 'User saves content for later', suggestedProperties: ['content_id','content_type','source_page','collection_id'] },
  { vert: 'content',       category: 'Revenue',     priority: 'must-have',    eventName: 'Subscription Started',       triggerDescription: 'User subscribes to a paid plan', suggestedProperties: ['plan_name','plan_price','billing_cycle','trial_used'] },

  // ── MESSAGING (WhatsApp Web, Slack, Discord web) ──────────────────────────
  { vert: 'messaging',     category: 'Retention',   priority: 'must-have',    eventName: 'Message Sent',               triggerDescription: 'User sends a message in a chat or channel', suggestedProperties: ['chat_type','message_type','recipient_count','has_media'] },
  { vert: 'messaging',     category: 'Activation',  priority: 'recommended',  eventName: 'Channel Created',            triggerDescription: 'User creates a new channel, group, or workspace', suggestedProperties: ['channel_type','member_count','is_private'] },

  // ── ECOMMERCE (Amazon, Myntra, Etsy, D2C, marketplaces) ───────────────────
  { vert: 'ecommerce',     category: 'Retention',   priority: 'must-have',    eventName: 'Product Viewed',             triggerDescription: 'User views a product detail page', suggestedProperties: ['product_id','product_name','category','price','brand','in_stock','rating','source'] },
  { vert: 'ecommerce',     category: 'Retention',   priority: 'must-have',    eventName: 'Category Browsed',           triggerDescription: 'User visits a category or collection listing page', suggestedProperties: ['category_name','subcategory','products_shown','sort_applied'] },
  { vert: 'ecommerce',     category: 'Retention',   priority: 'recommended',  eventName: 'Filter Applied',             triggerDescription: 'User applies a filter on a listing or search results page', suggestedProperties: ['filter_type','filter_value','category','results_count'] },
  { vert: 'ecommerce',     category: 'Revenue',     priority: 'must-have',    eventName: 'Charged',                    triggerDescription: 'CleverTap reserved event for every completed transaction — unlocks built-in revenue analytics and LTV', suggestedProperties: ['Amount','Payment Mode','Charged ID','Items','coupon_used','is_first_purchase','delivery_type'] },
  { vert: 'ecommerce',     category: 'Revenue',     priority: 'must-have',    eventName: 'Checkout Started',           triggerDescription: 'User proceeds from cart to the checkout flow', suggestedProperties: ['cart_total','items_count','has_coupon','is_guest_checkout'] },
  { vert: 'ecommerce',     category: 'Revenue',     priority: 'recommended',  eventName: 'Coupon Applied',             triggerDescription: 'User applies a promo or coupon code at checkout', suggestedProperties: ['coupon_code','discount_amount','discount_pct','cart_total'] },
  { vert: 'ecommerce',     category: 'Retention',   priority: 'recommended',  eventName: 'Order Tracked',              triggerDescription: 'User checks the live status of their order or delivery', suggestedProperties: ['order_id','order_status','estimated_delivery','items_count'] },

  // ── FOOD DELIVERY (Swiggy/Zomato web, restaurant sites) ───────────────────
  { vert: 'food',          category: 'Retention',   priority: 'must-have',    eventName: 'Restaurant Viewed',          triggerDescription: 'User opens a restaurant detail page', suggestedProperties: ['restaurant_id','cuisine','rating','distance_km','avg_delivery_mins'] },
  { vert: 'food',          category: 'Revenue',     priority: 'must-have',    eventName: 'Order Placed',               triggerDescription: 'User confirms a food order', suggestedProperties: ['order_total','items_count','restaurant_id','delivery_type','payment_method'] },
  { vert: 'food',          category: 'Retention',   priority: 'recommended',  eventName: 'Delivery Tracked',           triggerDescription: 'User opens live order tracking', suggestedProperties: ['order_id','order_status','estimated_mins'] },

  // ── FINTECH (banking, investment, crypto, wallet sites) ───────────────────
  { vert: 'fintech',       category: 'Retention',   priority: 'must-have',    eventName: 'Balance Checked',            triggerDescription: 'User views account, wallet, or portfolio balance', suggestedProperties: ['account_type','balance_bucket','source_page'] },
  { vert: 'fintech',       category: 'Revenue',     priority: 'must-have',    eventName: 'Money Sent',                 triggerDescription: 'User completes a transfer or payment', suggestedProperties: ['amount','recipient_type','rail','is_first_send'] },
  { vert: 'fintech',       category: 'Activation',  priority: 'must-have',    eventName: 'KYC Completed',              triggerDescription: 'User finishes identity verification', suggestedProperties: ['kyc_type','attempts','time_to_complete_mins'] },

  // ── FITNESS / HEALTH-TRACKING (Strava web, fitness platforms) ─────────────
  { vert: 'fitness',       category: 'Retention',   priority: 'must-have',    eventName: 'Workout Logged',             triggerDescription: 'User logs or starts a tracked workout', suggestedProperties: ['activity_type','source','duration_mins','calories'] },
  { vert: 'fitness',       category: 'Activation',  priority: 'recommended',  eventName: 'Goal Set',                   triggerDescription: 'User sets a fitness or health goal', suggestedProperties: ['goal_type','target_value','timeframe_days'] },

  // ── EDU / LEARNING (Coursera, Khan Academy, Duolingo web, MOOCs) ──────────
  { vert: 'edu',           category: 'Retention',   priority: 'must-have',    eventName: 'Lesson Started',             triggerDescription: 'User begins a lesson, course, or learning unit', suggestedProperties: ['course_id','lesson_id','difficulty','source_page'] },
  { vert: 'edu',           category: 'Retention',   priority: 'must-have',    eventName: 'Lesson Completed',           triggerDescription: 'User finishes a lesson successfully', suggestedProperties: ['course_id','lesson_id','score','time_spent_mins','streak_continued'] },
  { vert: 'edu',           category: 'Retention',   priority: 'recommended',  eventName: 'Quiz Submitted',             triggerDescription: 'User submits a quiz, test, or assessment', suggestedProperties: ['quiz_id','score','time_taken_mins','questions_correct'] },
  { vert: 'edu',           category: 'Revenue',     priority: 'recommended',  eventName: 'Course Enrolled',            triggerDescription: 'User enrols in a paid or free course', suggestedProperties: ['course_id','course_price','category','is_first_course'] },

  // ── TRAVEL (MakeMyTrip, Airbnb, Booking.com, Expedia) ─────────────────────
  { vert: 'travel',        category: 'Retention',   priority: 'must-have',    eventName: 'Destination Searched',       triggerDescription: 'User searches for a destination, route, or stay', suggestedProperties: ['origin','destination','travel_dates','guests','category'] },
  { vert: 'travel',        category: 'Revenue',     priority: 'must-have',    eventName: 'Booking Completed',          triggerDescription: 'User confirms a trip, flight, or stay booking', suggestedProperties: ['booking_type','total_value','duration_days','destination'] },
  { vert: 'travel',        category: 'Retention',   priority: 'recommended',  eventName: 'Itinerary Viewed',           triggerDescription: 'User opens their trip itinerary or booking summary', suggestedProperties: ['booking_id','days_until_trip','destination'] },

  // ── GAMING (browser games, gaming portals) ────────────────────────────────
  { vert: 'gaming',        category: 'Retention',   priority: 'must-have',    eventName: 'Game Started',               triggerDescription: 'Player begins a game session', suggestedProperties: ['game_id','game_type','source','difficulty'] },
  { vert: 'gaming',        category: 'Revenue',     priority: 'recommended',  eventName: 'In-Game Purchase Made',      triggerDescription: 'Player buys in-game currency or items', suggestedProperties: ['sku','price','currency_type','game_id'] },

  // ── PRODUCTIVITY / SAAS (Notion, Figma, Slack, Calendly, Linear) ──────────
  { vert: 'saas',          category: 'Acquisition', priority: 'recommended',  eventName: 'Pricing Page Viewed',        triggerDescription: 'User visits the pricing or plans page', suggestedProperties: ['plan_highlighted','referrer','time_on_page_secs','cta_clicked'] },
  { vert: 'saas',          category: 'Acquisition', priority: 'recommended',  eventName: 'Demo Requested',             triggerDescription: 'User submits a demo or contact-sales form', suggestedProperties: ['company_name','team_size','use_case','source','email'] },
  { vert: 'saas',          category: 'Activation',  priority: 'must-have',    eventName: 'Onboarding Completed',       triggerDescription: 'User finishes all onboarding steps', suggestedProperties: ['steps_completed','skipped_steps','time_to_complete_mins','plan'] },
  { vert: 'saas',          category: 'Retention',   priority: 'must-have',    eventName: 'Feature Used',               triggerDescription: 'User engages with a core product feature', suggestedProperties: ['feature_name','feature_category','plan','usage_count_today'] },
  { vert: 'saas',          category: 'Activation',  priority: 'recommended',  eventName: 'Team Member Invited',        triggerDescription: 'User invites a colleague to the workspace', suggestedProperties: ['invitee_email','role_assigned','team_size_after'] },
  { vert: 'saas',          category: 'Revenue',     priority: 'must-have',    eventName: 'Trial Started',              triggerDescription: 'User begins a free trial period', suggestedProperties: ['plan_name','trial_days','source','credit_card_required'] },
  { vert: 'saas',          category: 'Revenue',     priority: 'must-have',    eventName: 'Trial Converted',            triggerDescription: 'Trial user upgrades to a paid subscription', suggestedProperties: ['plan_selected','trial_duration_used','features_used_count'] },
  { vert: 'saas',          category: 'Revenue',     priority: 'recommended',  eventName: 'Plan Upgraded',              triggerDescription: 'User upgrades to a higher-tier plan', suggestedProperties: ['from_plan','to_plan','trigger_source','mrr_change'] },

  // ── PRODUCTIVITY (Notion-like docs / tasks — distinct from broader SaaS) ──
  { vert: 'productivity',  category: 'Retention',   priority: 'must-have',    eventName: 'Document Created',           triggerDescription: 'User creates a new document, board, or workspace item', suggestedProperties: ['document_type','template_used','workspace_id','source'] },
  { vert: 'productivity',  category: 'Activation',  priority: 'recommended',  eventName: 'Collaborator Invited',       triggerDescription: 'User invites another person to a workspace or doc', suggestedProperties: ['workspace_id','role_assigned','invitee_count'] },

  // ── DATING (web profiles) ─────────────────────────────────────────────────
  { vert: 'dating',        category: 'Retention',   priority: 'must-have',    eventName: 'Profile Viewed',             triggerDescription: 'User views another member\'s profile', suggestedProperties: ['target_profile_id','source_page','distance_km'] },
  { vert: 'dating',        category: 'Retention',   priority: 'must-have',    eventName: 'Match Made',                 triggerDescription: 'A two-sided match or mutual like is created', suggestedProperties: ['match_id','time_to_match_mins'] },

  // ── HEALTH / MEDICAL (1mg, Practo, telemedicine) ──────────────────────────
  { vert: 'health',        category: 'Retention',   priority: 'must-have',    eventName: 'Appointment Booked',         triggerDescription: 'User books a doctor or service appointment', suggestedProperties: ['doctor_id','specialty','consult_type','slot_time'] },
  { vert: 'health',        category: 'Revenue',     priority: 'must-have',    eventName: 'Prescription Ordered',       triggerDescription: 'User places an order for prescription items', suggestedProperties: ['order_total','items_count','has_prescription','delivery_type'] },

  // ── UTILITY / TOOLS (calculators, weather, free-tier tools) ───────────────
  { vert: 'utility',       category: 'Retention',   priority: 'must-have',    eventName: 'Tool Used',                  triggerDescription: 'User invokes the core tool action (calc, lookup, convert)', suggestedProperties: ['tool_name','input_type','result_type','source_page'] },
  { vert: 'utility',       category: 'Retention',   priority: 'recommended',  eventName: 'Setting Changed',            triggerDescription: 'User modifies a preference or setting', suggestedProperties: ['setting_name','old_value','new_value','category'] },
];

const VERTICAL_IDS = [
  'social', 'content', 'messaging', 'ecommerce', 'food', 'fintech',
  'fitness', 'edu', 'travel', 'gaming', 'saas', 'productivity',
  'dating', 'health', 'utility',
];

// ─── Derive vertical hints from crawled website signals ──────────────────────
// Heuristic-only — gives the LLM a starting point plus a monetization flag so
// the prompt can require/forbid commerce events conditionally. The LLM still
// makes the final classification (it can override these hints).
function deriveVerticalHintsWeb(originalUrl, merged) {
  const allText = [
    originalUrl,
    merged.siteName || '',
    merged.homeTitle || '',
    merged.homeMetaDesc || '',
    ...(merged.allNavLinks || []),
    ...(merged.allCtaTexts || []),
    ...(merged.allH1s || []),
    ...(merged.allH2s || []),
    ...(merged.bodyTextByPage || []),
    JSON.stringify(merged.allJsonLd || []),
    ...(merged.pageTypes || []),
  ].join(' ').toLowerCase();
  const has = (kw) => allText.includes(kw);

  const paymentTerms      = /\b(stripe|paypal|razorpay|paytm|checkout|payment|buy now|add to cart|pay now)\b/;
  const subscriptionTerms = /\b(subscribe|subscription|pricing|free trial|upgrade plan|billing|monthly|annually)\b/;
  const hasDirectMonetization = paymentTerms.test(allText) || subscriptionTerms.test(allText);

  const hints = [];
  hints.push(hasDirectMonetization
    ? 'Monetization signals detected (payment, cart, checkout, subscription, or pricing keywords present)'
    : 'No direct payment or pricing keywords detected — likely free, ad-supported, or purely informational');

  const verticalHits = [];
  if (has('feed') || has(' post ') || has('story') || has('follower') || has('hashtag')) verticalHits.push('social');
  if (has('article') || has('podcast') || has('episode') || has('stream') || has('watch') || has('news')) verticalHits.push('content');
  if (has('chat') || has('message') || has('inbox') || has('conversation')) verticalHits.push('messaging');
  if (has('cart') || has('checkout') || has('add to cart') || has('product') || has('shop') || has('store') || has('catalog')) verticalHits.push('ecommerce');
  if (has('restaurant') || has('cuisine') || has('menu') || has('order food') || has('delivery')) verticalHits.push('food');
  if (has('bank') || has('wallet') || has('upi') || has('invest') || has('portfolio') || has('crypto') || has('mutual fund')) verticalHits.push('fintech');
  if (has('workout') || has('fitness') || has('calorie') || has('exercise') || has('training plan')) verticalHits.push('fitness');
  if (has('course') || has('lesson') || has('quiz') || has('tutor') || has('learn') || has('curriculum') || has('syllabus')) verticalHits.push('edu');
  if (has('flight') || has('hotel') || has('booking') || has('trip') || has('itinerary') || has('destination')) verticalHits.push('travel');
  if (has('doctor') || has('appointment') || has('pharmacy') || has('prescription') || has('clinic')) verticalHits.push('health');
  if (has('document') || has('workspace') || has('collab') || has('task') || has('board') || has('integration')) verticalHits.push('productivity');
  if (has('free trial') || has('pricing') || has('plan') || has('demo') || has('saas') || has('platform') || has('api') || has('sdk') || has('integration')) verticalHits.push('saas');
  if (has('match') || has('swipe') || has('date')) verticalHits.push('dating');
  if (has('play game') || has('level') || has('achievement') || has('leaderboard')) verticalHits.push('gaming');
  if (has('calculator') || has('converter') || has('weather') || has('lookup') || has('generator')) verticalHits.push('utility');

  if (verticalHits.length) {
    hints.push(`Possible verticals from site text/JSON-LD/nav: ${[...new Set(verticalHits)].join(', ')}`);
  } else {
    hints.push('No strong vertical signal from site text — make best inference from URL, page title, and meta description');
  }

  return { hints, hasDirectMonetization };
}

// ─── Build the AI prompt ──────────────────────────────────────────────────────
// Returns { full, cacheable, dynamic }:
//   - full       → single concatenated string (Groq / Gemini)
//   - cacheable  → stable preamble + library + rules (Anthropic cache_control)
//   - dynamic    → website-specific data + final task (Anthropic user message)
// Scale prompt counts to a user-picked target. Same shape as apkscanner.
function deriveCounts(N) {
  const acq = Math.max(2, Math.round(N * 0.13));
  const act = Math.max(2, Math.round(N * 0.15));
  const ret = Math.max(3, Math.round(N * 0.34));
  const ref = Math.max(1, Math.round(N * 0.09));
  const rev = Math.max(0, Math.round(N * 0.17));
  const mustHave    = [Math.max(1, Math.round(N * 0.17)), Math.max(2, Math.round(N * 0.25))];
  const recommended = [Math.max(1, Math.round(N * 0.38)), Math.max(2, Math.round(N * 0.50))];
  const niceToHave  = [Math.max(0, Math.round(N * 0.30)), Math.max(0, Math.round(N * 0.42))];
  const minN = Math.max(1, Math.floor(N * 0.95));
  const maxN = Math.max(minN + 2, Math.ceil(N * 1.05));
  return { N, minN, maxN, acq, act, ret, ref, rev, mustHave, recommended, niceToHave };
}

function maxTokensFor(N) {
  const base = N * 110 + 700;   // website events tend to be a touch wordier than APK events
  return Math.min(10000, Math.max(800, base));
}

function buildPrompt(originalUrl, merged, targetCount = 47) {
  const plan = deriveCounts(targetCount);
  // Compact the full library — one line per event, including the vertical tag
  const examplesCompact = EVENT_LIBRARY_EXAMPLES.map(e =>
    `{"vert":"${e.vert}","cat":"${e.category}","pri":"${e.priority}","name":"${e.eventName}","trigger":"${e.triggerDescription}","props":${JSON.stringify(e.suggestedProperties)}}`
  ).join(',\n');

  const jsonLdLine = summariseJsonLd(merged.allJsonLd);
  const { hints: verticalHints, hasDirectMonetization } = deriveVerticalHintsWeb(originalUrl, merged);

  const siteContext = [
    `URL: ${originalUrl}`,
    `Site name: ${merged.siteName || merged.homeTitle}`,
    `Meta description: ${merged.homeMetaDesc.slice(0, 300)}`,
    `Pages crawled: ${merged.pageTypes.join(', ')}`,
    `H1 headings: ${merged.allH1s.slice(0, 12).join(' | ')}`,
    `H2 headings: ${merged.allH2s.slice(0, 15).join(' | ')}`,
    `Navigation items: ${merged.allNavLinks.slice(0, 30).join(', ')}`,
    `CTA buttons: ${merged.allCtaTexts.slice(0, 25).join(', ')}`,
    `Forms (field names): ${merged.allForms.map(f => `[${f.fields.join(',')}]`).join('; ')}`,
    jsonLdLine ? `Structured data (JSON-LD): ${jsonLdLine}` : '',
    ``,
    `--- PAGE CONTENT SAMPLES ---`,
    ...merged.bodyTextByPage.map(t => t.slice(0, 600)),
    ``,
    `VERTICAL HINTS (derived locally — you may override):`,
    verticalHints.map(h => `• ${h}`).join('\n'),
  ].filter(Boolean).join('\n');

  const monetizationGuidance = hasDirectMonetization
    ? `LOCAL SIGNAL: monetization detected on this site. If you classify the vertical as monetized, you MUST include exactly one "Charged" event (Revenue, must-have) plus revenue events appropriate for that vertical.`
    : `LOCAL SIGNAL: no direct payment or pricing keywords detected. Unless you classify the vertical as monetized for a non-keyword reason (e.g. content/edu subscriptions detected via JSON-LD), do NOT include "Charged" or transaction events.`;

  const cacheable = `You are a world-class CleverTap analytics architect. Analyse a real website and generate a comprehensive, deeply customised event tracking plan.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EVENT DESIGN REFERENCE — MULTI-VERTICAL LIBRARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The library below contains ${EVENT_LIBRARY_EXAMPLES.length} examples spanning multiple website verticals. Each entry is tagged with a "vert" field. Treat the library as a PATTERN reference: every vertical has its own event vocabulary.

Verticals you may pick from:
${VERTICAL_IDS.join(' | ')}

(There is also a "universal" tag for events that apply to almost every website — Page Viewed, Account Created, Login Completed, Session Started, Email Subscribed, etc.)

Schema for every event you generate:
• category: Acquisition | Activation | Retention | Revenue | Referral
• priority: must-have | recommended | nice-to-have
• eventName: Title Case verb+noun, using THIS site's actual vocabulary
• triggerDescription: ONE precise sentence
• suggestedProperties: 4–8 snake_case keys
• reason: 1 sentence on why this event matters for THIS business

REFERENCE LIBRARY:
[${examplesCompact}]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR TASK — TWO STEPS, ONE JSON RESPONSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — CLASSIFY THE VERTICAL (do this first, internally):
Pick exactly ONE primary vertical from the list above based on the URL, page title, meta description, nav, CTAs, body text, JSON-LD, and the local hints. Tiebreaker: pick the vertical that drives the site's core revenue or core retention loop. A photo-sharing site is "social", not "utility". A bank site with a referral feature is "fintech", not "utility".

STEP 2 — GENERATE ${plan.minN}–${plan.maxN} EVENTS APPROPRIATE FOR THAT VERTICAL:

HARD REQUIREMENTS:

① COUNT: Between ${plan.minN} and ${plan.maxN} events. Fewer than ${plan.minN} = failure.

② VERTICAL DISCIPLINE — THIS IS THE MOST IMPORTANT RULE:
   Once you have classified the vertical, the events you generate MUST belong to that vertical's vocabulary plus the "universal" set. DO NOT mix in events from unrelated verticals.

   Examples of what this means:
   • If vertical = social/messaging/content/productivity/utility/dating/edu/fitness:
     → FORBIDDEN: "Charged", "Checkout Started", "Order Placed", "Order Tracked", "Reorder Clicked", "Return Initiated", "Payment Method Selected", "Coupon Applied", "Wallet Viewed", "Wallet Balance Checked", "Loyalty Points Redeemed", "Product Viewed", "Category Browsed", any "Cart" or "Add to Cart" variant.
     → Use that vertical's actual vocabulary: Post Viewed, Article Read, Video Played, Message Sent, Workout Logged, Lesson Started, Document Created, Profile Viewed, etc.
   • If vertical = ecommerce/food/travel/fintech/health, or content/saas/edu with paid subscriptions:
     → "Charged" (Revenue, must-have) is required IF this site has direct monetization (see local signal in WEBSITE DATA).
     → Use revenue events appropriate for the vertical: "Order Placed" for food, "Booking Completed" for travel, "Money Sent" for fintech, "Trial Converted"/"Plan Upgraded" for SaaS, "Course Enrolled" for edu, etc.

③ CATEGORY MINIMUMS (scaled to target count of ${plan.N}):
   Acquisition → ≥ ${plan.acq}
   Activation  → ≥ ${plan.act}
   Retention   → ≥ ${plan.ret}
   Referral    → ≥ ${plan.ref}
   Revenue     → ≥ ${plan.rev} if monetized vertical, otherwise ≥ 0 (use subscription/upgrade events only if applicable)

④ PRIORITY DISTRIBUTION (scaled to target count of ${plan.N}):
   must-have    → ${plan.mustHave[0]} to ${plan.mustHave[1]}
   recommended  → ${plan.recommended[0]} to ${plan.recommended[1]}
   nice-to-have → ${plan.niceToHave[0]} to ${plan.niceToHave[1]}

⑤ SITE-SPECIFIC LANGUAGE: Use THIS site's actual words from the crawled nav, H1s, CTAs, JSON-LD, and body text in the WEBSITE DATA block. If nav says "Jewellery" use "Jewellery Viewed" not "Product Viewed". If a CTA says "Book a Demo" create "Demo Requested". Do NOT invent events for features absent from the crawled content.

⑥ UNIQUE EVENTS: At least 6 events must be for features unique to this site (things found in the crawled content, not in the reference library).

⑦ FULL FUNNEL: Cover the lifecycle stages relevant for THIS vertical — first visit → discovery → registration → first action → repeat use → referral. Include revenue events only if vertical is monetized.

⑧ PROPERTIES: 4–8 snake_case keys per event.

⑨ STRICT EXCLUSIONS (regardless of vertical):
   Do NOT generate events for: Add to Cart, Cart Updated, Item Added to Cart, Wishlist Added/Updated, Saved for Later.
   Do NOT generate generic placeholder events like "Try At Home Requested" or "Wallet Viewed" unless the crawled signals literally contain those features.`;

  const dynamic = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEBSITE DATA (crawled live)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${siteContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MONETIZATION RULE FOR THIS SCAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${monetizationGuidance}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR TASK: GENERATE 45–50 CUSTOM EVENTS FOR THE SITE ABOVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Classify the vertical first, then generate events appropriate for THAT vertical. Apply all hard requirements from the EVENT DESIGN REFERENCE section.

Respond with ONLY a raw JSON object. No markdown, no backticks, no preamble, no trailing text.

{
  "detectedVertical": "one of: ${VERTICAL_IDS.join(' | ')}",
  "verticalReasoning": "1 sentence explaining which signals drove the classification",
  "businessVertical": "human-readable label e.g. 'Fine Jewellery E-commerce' or 'D2C SaaS Productivity Tool'",
  "businessDescription": "2-3 sentences about this site and its users",
  "websiteType": "specific type",
  "analyticsInsight": "2-3 sentences of CleverTap strategy insight tailored to the detected vertical",
  "recommendedEvents": [
    {
      "eventName": "...",
      "priority": "must-have",
      "category": "Retention",
      "reason": "Why this event matters for this specific business",
      "triggerDescription": "Exactly when a developer fires this event",
      "suggestedProperties": ["prop_one","prop_two","prop_three","prop_four","prop_five"]
    }
  ]
}

Output ONLY valid JSON. Start with { end with }. No other text.`;

  return {
    full:      `${cacheable}\n\n${dynamic}`,
    cacheable,
    dynamic,
  };
}

// ─── Generic HTTPS POST ───────────────────────────────────────────────────────
function httpsPost({ hostname, path, headers, body, timeout = 90000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

// ─── Generic GET (http/https) with redirect + size cap ───────────────────────
function httpGet(targetUrl, { timeout = 8000, maxRedirects = 3, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let redirectsLeft = maxRedirects;
    const visit = (urlStr) => {
      let parsed;
      try { parsed = new URL(urlStr); }
      catch (err) { return reject(err); }
      const lib = parsed.protocol === 'http:' ? http : https;
      const req = lib.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; CleverTapScanner/1.0)' },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          redirectsLeft--;
          res.resume();
          return visit(new URL(res.headers.location, parsed).toString());
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            return reject(new Error('Response too large'));
          }
          data += chunk;
        });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.end();
    };
    visit(targetUrl);
  });
}

// ─── Sitemap discovery — fast alternative to crawling anchor links ───────────
async function fetchSitemapUrls(originalUrl) {
  const base = new URL(originalUrl);
  const candidates = [
    `${base.protocol}//${base.host}/sitemap.xml`,
    `${base.protocol}//${base.host}/sitemap_index.xml`,
    `${base.protocol}//${base.host}/sitemap-index.xml`,
  ];
  const parseLocs = (xml) =>
    [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
      .map(m => m[1].trim())
      .filter(u => u.startsWith('http'));

  for (const sitemapUrl of candidates) {
    try {
      const xml = await httpGet(sitemapUrl, { timeout: 6000 });
      const locs = parseLocs(xml);
      if (locs.length === 0) continue;

      // Sitemap-index → fetch first child sitemap and merge.
      const looksLikeIndex = /<sitemapindex/i.test(xml) || locs.every(u => u.endsWith('.xml'));
      if (looksLikeIndex) {
        const child = locs[0];
        try {
          const childXml = await httpGet(child, { timeout: 6000 });
          const childLocs = parseLocs(childXml).filter(u => !u.endsWith('.xml'));
          if (childLocs.length > 0) {
            console.log(`[Scanner] Sitemap index → ${child} (${childLocs.length} URLs)`);
            return childLocs;
          }
        } catch (_) { /* fall through */ }
        continue;
      }

      console.log(`[Scanner] Found sitemap at ${sitemapUrl} (${locs.length} URLs)`);
      return locs;
    } catch (_) {
      // try next candidate
    }
  }
  return [];
}

// ─── Summarise JSON-LD into a terse line for the prompt ──────────────────────
function summariseJsonLd(jsonLdArray) {
  if (!Array.isArray(jsonLdArray) || jsonLdArray.length === 0) return '';
  const summaries = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object' || summaries.length >= 10) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node['@graph']) { visit(node['@graph']); return; }

    const t = node['@type'];
    if (!t) return;
    const typeStr = Array.isArray(t) ? t.join('/') : String(t);
    const parts = [typeStr];
    if (node.name)        parts.push(`name="${String(node.name).slice(0, 60)}"`);
    const brand = node.brand?.name ?? (typeof node.brand === 'string' ? node.brand : null);
    if (brand)            parts.push(`brand="${String(brand).slice(0, 40)}"`);
    if (node.category)    parts.push(`category="${String(node.category).slice(0, 40)}"`);
    const currency = node.offers?.priceCurrency ?? node.priceCurrency;
    if (currency)         parts.push(`currency=${currency}`);
    summaries.push(parts.join(' '));
  };
  jsonLdArray.forEach(visit);
  return summaries.slice(0, 10).join(' | ');
}

// ─── AI provider router ───────────────────────────────────────────────────────
// Accepts either a structured promptParts object ({ full, cacheable, dynamic })
// produced by buildPrompt, or a plain string (used by retry-repair flow).
async function callAI(promptParts, maxTokensHint = 6000) {
  const isStructured = promptParts && typeof promptParts === 'object' && typeof promptParts.full === 'string';
  const fullText  = isStructured ? promptParts.full      : String(promptParts);
  const cacheable = isStructured ? promptParts.cacheable : null;
  const dynamic   = isStructured ? promptParts.dynamic   : String(promptParts);

  if (process.env.GROQ_API_KEY) {
    // Free-tier safe ceiling; bump GROQ_MAX_TOKENS on paid plans.
    const safeCeiling = parseInt(process.env.GROQ_MAX_TOKENS || '5000', 10);
    // Groq's free/on-demand tier caps input + output tokens per minute (TPM).
    // Size the output so prompt + completion stays under GROQ_TPM_BUDGET.
    const tpmBudget = parseInt(process.env.GROQ_TPM_BUDGET || '7500', 10);
    const estInput  = Math.ceil(fullText.length / 4);
    const maxTokens = Math.min(safeCeiling, Math.max(800, maxTokensHint), Math.max(1200, tpmBudget - estInput));
    console.log(`[AI] Using Groq (gpt-oss-120b, max_tokens=${maxTokens})`);
    const raw = await httpsPost({
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      headers:  { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model:       process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
        max_tokens:  maxTokens,
        temperature: 0.4,
        ...((process.env.GROQ_MODEL || 'openai/gpt-oss-120b').includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        response_format: { type: 'json_object' },
        messages:    [{ role: 'user', content: fullText }],
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Groq error: ${parsed.error.message}`);
    return parsed.choices?.[0]?.message?.content || '';
  }

  if (process.env.GEMINI_API_KEY) {
    const maxTokens = Math.min(16000, Math.max(800, maxTokensHint));
    console.log(`[AI] Using Gemini 2.0 Flash (maxOutputTokens=${maxTokens})`);
    const raw = await httpsPost({
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      headers:  { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents:         [{ parts: [{ text: fullText }] }],
        generationConfig: {
          maxOutputTokens:  maxTokens,
          temperature:      0.4,
          responseMimeType: 'application/json',
        },
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Gemini error: ${parsed.error.message}`);
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const maxTokens = Math.min(16000, Math.max(800, maxTokensHint));
    console.log(`[AI] Using Anthropic Claude (max_tokens=${maxTokens})`);
    // Split prompt so the stable preamble + library + rules block can be cached.
    const body = cacheable
      ? {
          model:      'claude-sonnet-4-20250514',
          max_tokens: maxTokens,
          system: [
            { type: 'text', text: cacheable, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: dynamic }],
        }
      : {
          model:      'claude-sonnet-4-20250514',
          max_tokens: maxTokens,
          messages:   [{ role: 'user', content: fullText }],
        };
    const raw = await httpsPost({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      headers:  {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Anthropic error: ${parsed.error.message}`);
    return parsed.content?.[0]?.text || '';
  }

  throw new Error('No AI API key found. Set GROQ_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY in your .env file.');
}

// ─── Try-parse the AI reply without falling back to the stub ─────────────────
// Returns { ok: true, parsed } or { ok: false, error }. parseAIResponse is the
// stub-returning safety net; this is used by the retry path so we can decide
// whether a retry is worth issuing.
function tryParseAI(rawReply) {
  try {
    const cleaned = String(rawReply || '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, error: 'no JSON object in reply' };
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.recommendedEvents)) {
      return { ok: false, error: 'recommendedEvents is not an array' };
    }
    return { ok: true, parsed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── callAI with one repair retry on parse failure or short output ───────────
// If the first reply is unparseable OR yields fewer than RETRY_THRESHOLD events,
// re-issues the call once with a short repair instruction appended.
async function callAIWithRetry(promptParts, targetCount = 47, maxTokensHint = 6000) {
  const RETRY_THRESHOLD = Math.max(5, Math.floor(targetCount * 0.6));
  const firstReply = await callAI(promptParts, maxTokensHint);
  const firstAttempt = tryParseAI(firstReply);

  const needsRetry =
    !firstAttempt.ok ||
    (firstAttempt.parsed.recommendedEvents?.length || 0) < RETRY_THRESHOLD;

  if (!needsRetry) return firstReply;

  const reason = firstAttempt.ok
    ? `incomplete (${firstAttempt.parsed.recommendedEvents.length} events, target ~${targetCount})`
    : `invalid JSON (${firstAttempt.error})`;
  console.warn(`[Scanner] First AI reply was ${reason}; retrying once.`);

  const repairSuffix = `\n\n━━━━━━━━━━━━\nIMPORTANT: Your previous reply was ${reason}. Return ONLY a single valid JSON object with approximately ${targetCount} events, matching the schema above. No markdown, no preamble.`;
  const retryParts = {
    full:      `${promptParts.full}${repairSuffix}`,
    cacheable: promptParts.cacheable,
    dynamic:   `${promptParts.dynamic}${repairSuffix}`,
  };

  try {
    const secondReply = await callAI(retryParts, maxTokensHint);
    const secondAttempt = tryParseAI(secondReply);
    if (secondAttempt.ok &&
        (secondAttempt.parsed.recommendedEvents?.length || 0) >
        (firstAttempt.ok ? firstAttempt.parsed.recommendedEvents.length : 0)) {
      return secondReply;
    }
    console.warn('[Scanner] Retry did not improve output; using first reply.');
    return firstReply;
  } catch (err) {
    console.warn(`[Scanner] Retry call failed: ${err.message}`);
    return firstReply;
  }
}

// ─── Parse and validate AI response ──────────────────────────────────────────
function parseAIResponse(rawReply, homeTitle) {
  try {
    const cleaned = rawReply
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in AI response');

    const parsed = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(parsed.recommendedEvents)) {
      throw new Error('recommendedEvents is not an array');
    }

    parsed.detectedVertical = VERTICAL_IDS.includes(parsed.detectedVertical)
      ? parsed.detectedVertical
      : 'utility';
    parsed.verticalReasoning = typeof parsed.verticalReasoning === 'string'
      ? parsed.verticalReasoning
      : '';

    parsed.recommendedEvents = parsed.recommendedEvents.map(e => ({
      eventName:           e.eventName           || 'Unknown Event',
      priority:            ['must-have','recommended','nice-to-have'].includes(e.priority) ? e.priority : 'recommended',
      category:            ['Acquisition','Activation','Retention','Revenue','Referral'].includes(e.category) ? e.category : 'Retention',
      reason:              e.reason              || `Tracks ${(e.eventName || '').toLowerCase()} for analytics.`,
      triggerDescription:  e.triggerDescription  || 'Fire when this action occurs.',
      suggestedProperties: Array.isArray(e.suggestedProperties) ? e.suggestedProperties : ['Date'],
    }));

    console.log(`[Scanner] Parsed ${parsed.recommendedEvents.length} events for vertical "${parsed.detectedVertical}"`);
    return parsed;

  } catch (err) {
    console.warn('[Scanner] AI response parse failed:', err.message);
    console.warn('[Scanner] Raw reply (first 600 chars):', rawReply.slice(0, 600));

    return {
      detectedVertical:    'utility',
      verticalReasoning:   'Fallback — AI response could not be parsed.',
      businessVertical:    'General Website',
      businessDescription: `${homeTitle} — an online platform.`,
      websiteType:         'Website',
      analyticsInsight:    'Track user behaviour across the full funnel to understand discovery, engagement, and conversion.',
      recommendedEvents: [
        { eventName: 'Page Viewed',     priority: 'must-have', category: 'Acquisition', reason: 'Baseline page tracking.',   triggerDescription: 'Every page load.',             suggestedProperties: ['page_url','page_title','referrer','utm_source'] },
        { eventName: 'Account Created', priority: 'must-have', category: 'Activation',  reason: 'Tracks new registrations.', triggerDescription: 'User completes registration.', suggestedProperties: ['signup_method','referral_source','device_type'] },
        { eventName: 'Session Started', priority: 'must-have', category: 'Retention',   reason: 'Tracks return visits.',     triggerDescription: 'New web session begins.',      suggestedProperties: ['days_since_last_session','device_type','entry_page'] },
      ],
    };
  }
}

// ─── Main exported scan function ─────────────────────────────────────────────
async function _runScan(originalUrl, opts = {}) {
  const targetCount = Math.max(10, Math.min(80, parseInt(opts.targetCount, 10) || 47));
  let browser;
  const allPageData = [];

  try {
    browser = await puppeteer.launch(getLaunchOptions());
    const baseHostname = new URL(originalUrl).hostname;

    console.log(`[Scanner] Step 1/3 — Loading homepage: ${originalUrl}`);
    const homePage = await browser.newPage();
    await applyStealth(homePage);
    const homeLoaded = await gotoSafe(homePage, originalUrl);
    if (!homeLoaded) throw new Error('Could not load homepage');

    const homeSignals = await extractSignals(homePage, 'homepage');
    allPageData.push(homeSignals);
    console.log(`[Scanner] Homepage loaded: "${homeSignals.pageTitle}"`);

    console.log(`[Scanner] Step 2/3 — Discovering internal links...`);
    // Prefer sitemap.xml (one cheap fetch, broader coverage). Fall back to
    // anchor-link discovery if sitemap is missing or empty.
    let candidateLinks = [];
    try {
      const sitemapUrls = await fetchSitemapUrls(originalUrl);
      candidateLinks = sitemapUrls.filter(u => {
        try { return new URL(u).hostname === baseHostname; }
        catch { return false; }
      });
    } catch (err) {
      console.warn(`[Scanner] Sitemap lookup failed: ${err.message}`);
    }
    if (candidateLinks.length === 0) {
      candidateLinks = await discoverLinks(homePage, baseHostname);
      console.log(`[Scanner] Using anchor-link discovery (${candidateLinks.length} links)`);
    } else {
      console.log(`[Scanner] Using sitemap URLs (${candidateLinks.length} links)`);
    }

    const uniqueLinks  = [...new Set(candidateLinks)];
    const pagesToCrawl = selectPages(uniqueLinks);
    console.log(`[Scanner] Will crawl: ${pagesToCrawl.map(p => p.type).join(', ')}`);
    await homePage.close();

    console.log(`[Scanner] Step 3/3 — Crawling ${pagesToCrawl.length} pages in parallel...`);
    const BATCH_SIZE = 3;
    for (let i = 0; i < pagesToCrawl.length; i += BATCH_SIZE) {
      const batch = pagesToCrawl.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async ({ url, type }) => {
        const page = await browser.newPage();
        try {
          await applyStealth(page);
          const ok = await gotoSafe(page, url);
          if (ok) {
            const signals = await extractSignals(page, type);
            allPageData.push(signals);
            console.log(`[Scanner]  ✓ [${type}] ${signals.pageTitle}`);
          }
        } catch (err) {
          console.warn(`[Scanner]  ✗ [${type}]: ${err.message}`);
        } finally {
          await page.close().catch(() => {});
        }
      }));
    }

    const merged = mergeSignals(allPageData);
    console.log(`[Scanner] Merged signals from ${allPageData.length} pages`);

    const maxTokens = maxTokensFor(targetCount);
    console.log(`[Scanner] Sending to AI — requesting ~${targetCount} custom events (max_tokens=${maxTokens})`);
    const promptParts = buildPrompt(originalUrl, merged, targetCount);
    const rawReply    = await callAIWithRetry(promptParts, targetCount, maxTokens);

    const aiResult = parseAIResponse(rawReply, homeSignals.pageTitle);
    console.log(`[Scanner] ✓ ${aiResult.recommendedEvents.length} events generated for "${aiResult.businessVertical}"`);

    const recommendedEvents = aiResult.recommendedEvents;

    return {
      url:                 homeSignals.url,
      pageTitle:           homeSignals.pageTitle,
      pagesScanned:        allPageData.length,
      pageTypes:           merged.pageTypes,
      detectedVertical:    aiResult.detectedVertical,
      verticalReasoning:   aiResult.verticalReasoning,
      businessVertical:    aiResult.businessVertical,
      businessDescription: aiResult.businessDescription,
      websiteType:         aiResult.websiteType,
      recommendedEvents,
      analyticsInsight:    aiResult.analyticsInsight,
      scanSummary: {
        totalEventsRecommended: recommendedEvents.length,
        mustHave:    recommendedEvents.filter(e => e.priority === 'must-have').length,
        recommended: recommendedEvents.filter(e => e.priority === 'recommended').length,
        niceToHave:  recommendedEvents.filter(e => e.priority === 'nice-to-have').length,
        pagesScanned: allPageData.length,
      },
    };

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Public entry point: result cache + overall timeout wrapper around _runScan.
// opts.targetCount selects how many events the AI should generate (clamped
// 10..80). Cache key folds targetCount in so a 25-event scan doesn't return
// a 50-event cached result.
async function scanWebsite(originalUrl, opts = {}) {
  const targetCount = Math.max(10, Math.min(80, parseInt(opts.targetCount, 10) || 47));
  const cacheKey = `${originalUrl}::n=${targetCount}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[Scanner] Cache hit for ${originalUrl} (n=${targetCount}) — returning cached result`);
    return cached;
  }

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Scan timed out after ${SCAN_TIMEOUT_MS / 1000}s`)),
      SCAN_TIMEOUT_MS,
    );
  });

  try {
    const result = await Promise.race([_runScan(originalUrl, { targetCount }), timeoutPromise]);
    cacheSet(cacheKey, result);
    return result;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

module.exports = { scanWebsite };
