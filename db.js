/**
 * Akira Piano Academy — Supabase client, anonymous visitor row, and events.
 *
 * Configuration (set before this script loads, e.g. in index.html):
 *   window.AKIRA_SUPABASE_URL = 'https://xxxx.supabase.co';
 *   window.AKIRA_SUPABASE_ANON_KEY = 'sb_publishable_...' OR legacy JWT anon key (both work in createClient).
 *
 * --- Run in Supabase SQL editor (adjust policies for production) ---
 *
 * create table if not exists public.users (
 *   id uuid primary key,
 *   created_at timestamptz not null default now(),
 *   last_seen_at timestamptz,
 *   is_anonymous boolean not null default true,
 *   auth_user_id uuid unique,
 *   locale text,
 *   xp_total integer not null default 0
 * );
 * comment on column public.users.auth_user_id is
 *   'auth.users.id after email login; use to merge anonymous stats later.';
 *
 * -- Ha a tábla már létezett xp_total nélkül:
 * alter table public.users add column if not exists xp_total integer not null default 0;
 *
 * create table if not exists public.events (
 *   id uuid primary key default gen_random_uuid(),
 *   created_at timestamptz not null default now(),
 *   user_id uuid not null references public.users(id) on delete cascade,
 *   event_type text not null,
 *   module_id text,
 *   metadata jsonb not null default '{}'::jsonb
 * );
 * create index if not exists events_user_id_idx on public.events(user_id);
 * create index if not exists events_created_at_idx on public.events(created_at desc);
 * create index if not exists events_type_module_idx on public.events(event_type, module_id);
 *
 * alter table public.users enable row level security;
 * alter table public.events enable row level security;
 *
 * -- MVP: tighten later (e.g. Edge Function + service role, or auth-based rules)
 * create policy "users_anon_insert" on public.users for insert to anon with check (true);
 * create policy "users_anon_update" on public.users for update to anon using (true) with check (true);
 * create policy "events_anon_insert" on public.events for insert to anon with check (true);
 *
 * Optional: Authentication → Sign In / Providers → Anonymous — then you can
 * call auth.signInAnonymously() and map auth.users.id → users.auth_user_id.
 *
 * Dev: localStorage.setItem('akira_is_admin','true') — skip insertEvent + syncXpTotal (no Supabase noise).
 */
(function () {
  'use strict';

  var LS_ANON_ID = 'akira_anon_user_id';
  var LS_LEGACY_VISITOR = 'akira_visitor_id';
  var LS_ADMIN = 'akira_is_admin';

  /** Admin / QA: ne küldjön events és xp_total frissítést a Supabase-nek. */
  function isAdminSupabaseBypass() {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(LS_ADMIN) === 'true';
    } catch (e) {
      return false;
    }
  }

  var TABLES = { USERS: 'users', EVENTS: 'events' };

  var EVENT_TYPES = {
    /** Reserved for future analytics (e.g. router hooks). */
    PAGE_VIEW: 'page_view',
    MODULE_CARD_CLICK: 'module_card_click'
  };

  function getConfig() {
    var url = (typeof window !== 'undefined' && window.AKIRA_SUPABASE_URL) || '';
    var key = (typeof window !== 'undefined' && window.AKIRA_SUPABASE_ANON_KEY) || '';
    return { url: String(url).trim(), key: String(key).trim() };
  }

  var _client = null;

  function getSupabase() {
    if (_client) return _client;
    var cfg = getConfig();
    if (!cfg.url || !cfg.key) return null;
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) return null;
    _client = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return _client;
  }

  function getOrCreateAnonymousId() {
    var id = null;
    try {
      id = localStorage.getItem(LS_ANON_ID);
      if (!id) {
        var leg = localStorage.getItem(LS_LEGACY_VISITOR);
        if (leg) {
          id = leg;
          localStorage.setItem(LS_ANON_ID, id);
        }
      }
      if (!id) {
        id =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : String(Date.now()) + '-' + Math.random().toString(36).slice(2, 12);
        localStorage.setItem(LS_ANON_ID, id);
      }
    } catch (e) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 'anon-' + String(Date.now());
    }
    return id;
  }

  /**
   * Ensures a row exists in public.users for this browser visitor.
   * @returns {Promise<string|null>} anonymous user id or null if Supabase off / error
   */
  function ensureAnonymousUserRow() {
    var sb = getSupabase();
    if (!sb) return Promise.resolve(null);
    var anonId = getOrCreateAnonymousId();
    var lang = (document.documentElement && document.documentElement.lang) || 'hu';
    var now = new Date().toISOString();
    return sb
      .from(TABLES.USERS)
      .update({ last_seen_at: now, locale: lang })
      .eq('id', anonId)
      .select('id')
      .maybeSingle()
      .then(function (res) {
        if (res.error) {
          console.warn('[AkiraDb] users update', res.error.message);
          return anonId;
        }
        if (res.data && res.data.id) return anonId;
        return sb
          .from(TABLES.USERS)
          .insert({
            id: anonId,
            is_anonymous: true,
            last_seen_at: now,
            locale: lang,
            auth_user_id: null,
            xp_total: 0
          })
          .then(function (ins) {
            if (ins.error) {
              var dup = ins.error.code === '23505' || /duplicate key/i.test(String(ins.error.message || ''));
              if (dup) {
                return sb
                  .from(TABLES.USERS)
                  .update({ last_seen_at: now, locale: lang })
                  .eq('id', anonId)
                  .then(function () {
                    return anonId;
                  });
              }
              console.warn('[AkiraDb] users insert', ins.error.message);
            }
            return anonId;
          });
      })
      .catch(function (e) {
        console.warn('[AkiraDb] ensureAnonymousUserRow', e);
        return anonId;
      });
  }

  function insertEvent(eventType, fields) {
    if (isAdminSupabaseBypass()) return Promise.resolve();
    var sb = getSupabase();
    if (!sb) return Promise.resolve();
    var userId = getOrCreateAnonymousId();
    var row = {
      user_id: userId,
      event_type: eventType,
      module_id: fields.module_id != null ? fields.module_id : null,
      metadata: fields.metadata && typeof fields.metadata === 'object' ? fields.metadata : {}
    };
    return sb
      .from(TABLES.EVENTS)
      .insert(row)
      .then(function (res) {
        if (res.error) console.warn('[AkiraDb] events insert', res.error.message);
      })
      .catch(function (e) {
        console.warn('[AkiraDb] insertEvent', e);
      });
  }

  /**
   * Logs Sense / Sight (and any module) card opens. module_id matches MODS[].id in index.html.
   * @param {string} moduleId e.g. hallasfejleszto | kottaolvasas
   */
  function trackModuleCardClick(moduleId) {
    var lang = (document.documentElement && document.documentElement.lang) || 'hu';
    return ensureAnonymousUserRow().then(function () {
      return insertEvent(EVENT_TYPES.MODULE_CARD_CLICK, {
        module_id: moduleId,
        metadata: { lang: lang, surface: 'index_card' }
      });
    });
  }

  /**
   * Persists total XP for the current browser user row (users.id = anon id).
   * @param {number} xpValue non-negative integer
   */
  function syncXpTotal(xpValue) {
    if (isAdminSupabaseBypass()) return Promise.resolve();
    var sb = getSupabase();
    if (!sb) return Promise.resolve();
    var v = Math.max(0, Math.floor(Number(xpValue) || 0));
    return ensureAnonymousUserRow().then(function () {
      var uid = getOrCreateAnonymousId();
      return sb
        .from(TABLES.USERS)
        .update({ xp_total: v })
        .eq('id', uid)
        .then(function (res) {
          if (res.error) console.warn('[AkiraDb] syncXpTotal', res.error.message);
        });
    });
  }

  /**
   * @returns {Promise<number|null>} xp_total from DB, or null if off / no row / error
   */
  function fetchXpTotal() {
    var sb = getSupabase();
    if (!sb) return Promise.resolve(null);
    var uid = getOrCreateAnonymousId();
    return sb
      .from(TABLES.USERS)
      .select('xp_total')
      .eq('id', uid)
      .maybeSingle()
      .then(function (res) {
        if (res.error) {
          console.warn('[AkiraDb] fetchXpTotal', res.error.message);
          return null;
        }
        if (res.data && res.data.xp_total != null) return Math.max(0, Math.floor(Number(res.data.xp_total)));
        return null;
      })
      .catch(function (e) {
        console.warn('[AkiraDb] fetchXpTotal', e);
        return null;
      });
  }

  /**
   * Regisztráció / profil létrehozás: névtelen sor xp_total := max(meglévő, helyi XP).
   * @param {number} localXp XP a böngészőben (pl. localStorage) összegyűjtve
   */
  function mergeLocalXpOnRegister(localXp) {
    var sb = getSupabase();
    if (!sb) return Promise.resolve();
    var v = Math.max(0, Math.floor(Number(localXp) || 0));
    return ensureAnonymousUserRow().then(function () {
      var anonId = getOrCreateAnonymousId();
      return sb
        .from(TABLES.USERS)
        .select('xp_total')
        .eq('id', anonId)
        .maybeSingle()
        .then(function (sel) {
          var cur = 0;
          if (!sel.error && sel.data && sel.data.xp_total != null) cur = Math.max(0, Math.floor(Number(sel.data.xp_total)));
          var merged = Math.max(cur, v);
          return sb.from(TABLES.USERS).update({ xp_total: merged }).eq('id', anonId);
        })
        .then(function (up) {
          if (up.error) console.warn('[AkiraDb] mergeLocalXpOnRegister', up.error.message);
        });
    });
  }

  function init() {
    return ensureAnonymousUserRow();
  }

  function signOut() {
    var sb = getSupabase();
    if (!sb || !sb.auth) return Promise.resolve();
    return sb.auth.signOut().catch(function (e) {
      console.warn('[AkiraDb] signOut', e);
    });
  }

  function getCurrentAuthUserId() {
    var sb = getSupabase();
    if (!sb) return Promise.resolve(null);
    return sb.auth.getUser().then(function (_ref) {
      var data = _ref.data;
      return data && data.user ? data.user.id : null;
    });
  }

  /**
   * After Supabase Auth sign-up / link: same users row (anon id), auth_user_id set.
   * @param {string} authUserId from Supabase Auth
   * @param {number} [localXp] optional client XP to merge with DB (max)
   */
  function linkRegisteredProfile(authUserId, localXp) {
    var sb = getSupabase();
    if (!sb || !authUserId) return Promise.resolve();
    var anonId = getOrCreateAnonymousId();
    var loc = typeof localXp === 'number' && localXp >= 0 ? Math.floor(localXp) : null;
    return sb
      .from(TABLES.USERS)
      .select('xp_total')
      .eq('id', anonId)
      .maybeSingle()
      .then(function (sel) {
        var cur = 0;
        if (!sel.error && sel.data && sel.data.xp_total != null) cur = Math.max(0, Math.floor(Number(sel.data.xp_total)));
        var mergedXp = loc != null ? Math.max(cur, loc) : cur;
        var payload = { auth_user_id: authUserId, is_anonymous: false, xp_total: mergedXp };
        return sb.from(TABLES.USERS).update(payload).eq('id', anonId);
      })
      .then(function (res) {
        if (res.error) console.warn('[AkiraDb] linkRegisteredProfile', res.error.message);
      })
      .catch(function (e) {
        console.warn('[AkiraDb] linkRegisteredProfile', e);
      });
  }

  window.AkiraDb = {
    TABLES: TABLES,
    EVENT_TYPES: EVENT_TYPES,
    getConfig: getConfig,
    getSupabase: getSupabase,
    getOrCreateAnonymousId: getOrCreateAnonymousId,
    visitorId: getOrCreateAnonymousId,
    ensureAnonymousUserRow: ensureAnonymousUserRow,
    init: init,
    insertEvent: insertEvent,
    trackModuleCardClick: trackModuleCardClick,
    signOut: signOut,
    getCurrentAuthUserId: getCurrentAuthUserId,
    linkRegisteredProfile: linkRegisteredProfile,
    syncXpTotal: syncXpTotal,
    fetchXpTotal: fetchXpTotal,
    mergeLocalXpOnRegister: mergeLocalXpOnRegister
  };

  window.AkiraAuth = window.AkiraDb;
})();
