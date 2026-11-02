// SplitApp — config defaults & shared constants (ported from splitapp.html).
// Runtime config (names, currency, gemini key) is loaded from the Sheets Config tab +
// localStorage at boot (see api.js, M2). These are the structural defaults + UI constants.

// APP CHANGELOG — React rebuild (migration #128). Bump APP_VERSION here (single source; shown in Settings).
// v3.25.1 (2026-08-31) — #169 telemetry fix: OCR log `gs` field was reading `config.gs_version` (undefined — the client
//                        maps it to `config.gsVersion`), so backend version logged blank. Now reads `config.gsVersion`.
// v3.25.0 (2026-08-31) — #173 refresh button polish: the bare faint double-arrow icon on the balance card is now a
//                        soft translucent pill combining "N bills" + a single circular-arrow icon (spins while syncing).
//                        Home.jsx + styles.css (.hero-refresh-pill replaces .hero-count-i/.hero-refresh). Client-only.
// v3.24.0 (2026-08-31) — #172 cancellable scan: a red "Cancel" (top-right of the scan overlay) + elapsed timer lets
//                        the user abort a slow OCR scan. AbortController stops the in-flight Gemini call; the retry loop
//                        bails on cancel (no fallback-model attempts); cancel is treated as a cancel (no error alert) and
//                        logged to OCR_Fail as status 'cancelled' with elapsed seconds (the wait-before-giving-up signal).
//                        Client-only (uses the #169 logOcrFail / GS 1.11.0 already deployed). ocr.js + NewBillFlow.jsx.
// v3.23.0 (2026-08-31) — #171 backfill: Settings "Auto-categorize bills" action runs the #170 AI categorizer over
//                        EXISTING uncategorized bills (empty or 'other'), batched (~1.2s gap, free-tier friendly),
//                        background-patching each via editBill; shows N-to-do + live done/total progress. `catDesc`
//                        moved to ocr.js (shared by NewBillFlow + Settings). Client-only.
// v3.22.0 (2026-08-31) — #170 AI auto-categorize itemized/manual bills: extend #148 beyond the quick flow. A new
//                        itemized bill the user left uncategorized (untouched + empty/'other') now gets background AI
//                        categorization after save (fire-and-forget, patches via editBill) using place + item names
//                        (e.g. "Sushiro — Udon, Sushi, Chawanmushi"); also fills scanned bills where OCR gave no category.
//                        New categoryTouched flag prevents overriding a deliberate pick. Client-only.
// v3.21.0 (2026-08-31) — #169 OCR telemetry (collection-only, no behaviour change): each scan records model, timings
//                        (end-to-end / model-discovery / Gemini call), token counts incl. thoughtsTokenCount, attempt
//                        sequence + retries, image KB/WxH/mime, receipt complexity, discovery pick, status, app+GS ver,
//                        person. Successes ride addBill into a new Bills `ocr_meta` column; hard fails (no bill) go to a
//                        new OCR_Fail tab via fire-and-forget logOcrFail. Baseline data before tuning Gemini speed.
//                        Needs backend GS 1.11.0. ocr.js/api.js/NewBillFlow.jsx + appsscript.gs.
// v3.20.0 (2026-08-31) — #168 split items shown per person: in Bill detail, an item split by qty/ratio/amount
//                        (e.g. "40B Sushi ×7 (4/3)") is now listed under each person with their own portion
//                        (Powpow "40B Sushi ×4 ฿160", Pat "×3 ฿120") instead of one lumped line in the Shared
//                        group; plain 50/50 shared items stay in "+ Shared portion". Display-only (calc.js untouched);
//                        per-person totals unchanged (verified 325/285 on the Sushiro bill). Client-only.
// v3.19.1 (2026-08-30) — #167 fix iOS focus zoom: `.inp` font-size 15px -> 16px so tapping a form field no longer
//                        auto-zooms Safari (which left the page zoomed/scrolled after saving); also scroll-to-top when a
//                        save lands on Home. Client-only.
// v3.19.0 (2026-08-30) — #166 auto-update check: on load and when the app regains focus it fetches index.html fresh
//                        (no-store) and compares the deployed entry-bundle hash to the running one; on a mismatch a
//                        tappable "New version available — reload" banner appears. Ends the stale-version/cache lag with
//                        no service worker and no manual version file. Client-only (`src/version-check.js`).
// v3.18.0 (2026-08-30) — #165 save confirmation: saving a bill now shows a non-blocking "Bill saved ✓" toast (auto-
//                        dismiss, no OK tap) and new bills land on Home (running balance + the #164 dot confirm the save);
//                        edits show "Bill updated ✓". store toast/showToast + App-shell render. Client-only.
// v3.17.0 (2026-08-30) — #164 unsynced marker: a small amber dot shows on a bill (Home + History) until its write is
//                        confirmed saved to the Sheet, so you can tell a local-only entry from a stored one. Reuses the
//                        #162 pendingIds/outbox; the dot clears automatically on confirm. Client-only.
// v3.16.0 (2026-08-30) — #163 sync feedback: restored the hero balance-card ↺ refresh icon (spins while pulling from
//                        Sheets, like the pre-revamp app) and gave the Settings "Sync & refresh" (dim + spinner then a
//                        full reload that also busts a stale app cache) and "Clear cache" (dim + spinner) rows visible
//                        feedback — they were wired but silent, so they looked like dead buttons. Client-only.
// v3.15.0 (2026-08-30) — #162 (A) confirmable writes + retry outbox: POST is now a readable simple-request
//                        (api.js post() returns { ok }, no CORS preflight — pairs with backend GS 1.10.0 which
//                        makes addBill an idempotent upsert). store.jsx queues every add/edit/delete in a
//                        persistent localStorage outbox that retries on load / after each write / after refresh
//                        until the server confirms it; idempotent upsert means retries never duplicate. Closes
//                        the manual-entry loss and extends the (B) guarantee to edits + cross-device. Requires
//                        backend GS 1.10.0 deployed; verify live POST-read + upsert on device.
// v3.14.1 (2026-08-30) — #162 (B) manual entries no longer silently lost: refresh() now MERGES instead of
//                        blind-replacing — bills added locally but not yet confirmed in a Sheet pull are kept
//                        (tracked as pendingIds, persisted in the state blob), so a failed/racing write can't be
//                        wiped by a later pull; a pending id seen remotely clears, a remotely-deleted bill is not
//                        resurrected. Client-only (no backend). Part 2 (A: confirmable write + retry) to follow.
// v3.14.0 (2026-07-24) — #102 raw OCR JSON now persisted: NewBillFlow stashes the full Gemini scan response,
//                        api.js sends it as `ocr_json` and reads it back, round-tripping through a new Bills
//                        column M. Preserved across edits; null for manual/quick bills. Needs backend GS 1.9.0.
// v3.13.5 (2026-07-24) — #63 History date filter: All / Week / Month / 3 mo / Year chip row (defaults All),
//                        reusing the timezone-safe `filterBills` shared with Summary; bills stay month-grouped.
// v3.13.4 (2026-07-24) — #161 Home hero card red now matches the original softer terracotta #E07575 (was the
//                        vivid --red #E05454 used for delete/errors).
// v3.13.3 (2026-07-24) — #160 PWA "app feel": added apple-mobile-web-app-capable + status-bar/title/theme-color
//                        meta + apple-touch-icon to index.html so the home-screen shortcut launches standalone
//                        (no Safari URL bar). icon.png moved to public/ (deployed to /split-app/icon.png); update.sh
//                        now syncs public/. Re-add to Home Screen from …/split-app/ to pick it up.
// v3.13.2 (2026-07-23) — tax-stage tag now always shows on discounts: shared = tappable stage picker; personal
//                        (A/B) = static "Before tax" label (personal discounts are always pre-tax) so it no
//                        longer vanishes when you assign a discount to a person.
// v3.13.1 (2026-07-23) — #152 follow-up: bigger assign chip + ▾ tap target (font 13, larger padding) and larger
//                        reassign dropdown (min 200px, 15px rows) — the previous size still felt small.
// v3.13.0 (2026-07-23) — #149 minimize-to-basket: "Keep ⌄" on the new-bill screen parks the draft (kept mounted
//                        so state survives) and shows a floating basket bottom-right; tap it (or the + FAB) to
//                        resume where you left off; Cancel discards. Session-only, one draft, both flows;
//                        edit-existing stays Cancel-only (no Keep button).
// v3.12.1 (2026-07-23) — #154 in "Both" active mode a shared discount now exposes its share ▾ (Both/Prop/Custom%/
//                        Fixed) next to the check circle, so you can customize the split without deselecting the
//                        name — fixes the "discount feels unselectable in Both mode" gap. Mirrors items' behaviour.
// v3.12.0 (2026-07-23) — #143 custom item split now offers %/Qty/฿ (was % only): the inline Custom editor is a
//                        3-tab picker — % (percentage), Qty (units per person of a qty>1 item), ฿ (fixed amount
//                        each). Sets assignment custom/qty/amt (recalc already supported these); chip shows the
//                        result (e.g. 6/4 or ฿70/฿30). Verified qty/amt math vs recalc.
// v3.11.0 (2026-07-23) — #148 background AI categorization: quick-split bills save with an empty category, then a
//                        fire-and-forget Gemini text call classifies from the description and writes it back
//                        (empty on failure — safe, catMeta falls back to 'other'). Bill detail gains a Category
//                        selector to set/fix it manually (esp. for quick bills whose edit form has no category).
// v3.10.0 (2026-07-23) — #144 "Match receipt": OCR scanned total carried onto the draft; shown under the entry
//                        Total + review grand total as "Receipt: ฿X ✓/⚠"; when computed > receipt, a "Match
//                        receipt" link adds a shared "Rounding" discount for the difference. Persisted in charges.
// v3.9.1 (2026-07-23) — #145 "+ discount" on the Assign person boxes: add an A-only/B-only discount inline
//                       (amount + optional label) right there; it reduces that person's total and also shows in
//                       the merged discount list (assigned to them). Reuses the personal-discount recalc path.
// v3.9.0 (2026-07-23) — #158 Bill detail rebuilt to the original grouped breakdown (ported 1:1): BILL BREAKDOWN
//                       card = Shared section (shared items + shared vouchers) + per-person sections (own items +
//                       personal discounts + "+ Shared portion" + Subtotal) + totals footer (item subtotal /
//                       total discount / SC / VAT / grand total); PAYMENT card (paid by · shares · who-owes-whom).
//                       2-dp money; qty/amt/custom item splits handled; quick-split bills keep the simple breakdown.
// v3.8.1 (2026-07-23) — #151 OCR discount on the entry CHARGES card now uses the same chips as the Assign page:
//                       OCR badge + colored tax-stage chip + rotating AssignChip (who/share ▾) + × remove +
//                       pct/fixed inline editors. Hoisted the discount helpers to component scope so entry + Assign
//                       reuse one implementation (no duplication); entry CHARGES card set to overflow:visible.
// v3.8.0 (2026-07-23) — quick-win cluster: #152 assign/reassign dropdown widened (min-width 176px, bigger
//                       14px rows + shadow) for comfortable tap targets; #157 avatar initials configurable via
//                       DB (Config tab person_a_initials/person_b_initials, e.g. CJ/PP) — `initials(name, override)`
//                       + store mapping + applied to all avatar sites (Home/assign bar/who-paid/Settings/Summary).
// v3.7.2 (2026-07-23) — #156 Summary person filter chips use each person's colour when selected (Powpow → --avA,
//                       Pat → --avB; Both → accent) instead of the generic green. Donut segments unchanged.
// v3.7.1 (2026-07-23) — #155 Assign item amount legibility (Option A): amount is now 13px/weight-500/secondary
//                       color (was an 11px muted caption); name stays the primary scan target.
// v3.7.0 (2026-07-23) — #150 refactor: extracted shared <AssignChip> (rotating chip + share ▾ dropdown) and
//                       <AssignCircle> (active-mode check circle) — items and discounts now render assignment
//                       through ONE code path instead of duplicated JSX. Behaviour-preserving; JSX-verified.
// v3.6.7 (2026-07-23) — items now use the same 3-mode chip as discounts: tap cycles A → B → Shared; ▾ shows only
//                       in Shared mode to pick Both (50/50) / Custom %. Item & discount assignment fully consistent.
// v3.6.6 (2026-07-23) — #142 discount chip matches the original 3-mode model: tap cycles A → B → Shared; the ▾
//                       dropdown appears ONLY in Shared mode to customize how to share (Both 50/50 / Proportional
//                       / Custom % / Fixed ฿). Personal (A/B) discounts show no ▾. (was a flat 6-option dropdown.)
// v3.6.5 (2026-07-23) — Match original OCR page: Service charge / VAT are now iOS-style on/off toggle SWITCHES
//                       (was green pill buttons); WHO PAID buttons use the original outline style (teal border +
//                       tint + "✓ selected" when chosen) instead of a solid green fill.
// v3.6.4 (2026-07-23) — #142 assign-list polish: (1) fix reassign dropdown clipping behind the person boxes
//                       (assign items card overflow:visible); (2) unify wording to "Both" everywhere (was
//                       Shared vs Both); (3) tax stage now a colored, tappable chip BEFORE the discount name
//                       (blue = before tax, grey = after) instead of a plain tag after the amount.
// v3.6.3 (2026-07-23) — OCR-verify CHARGES card reordered: discounts + "add voucher/discount" now sit ABOVE the
//                       Service charge / VAT toggles (discount is the more important field), then Total.
// v3.6.2 (2026-07-23) — #142 fix: in active-name (tap items) mode, discounts now render like items — a colored
//                       check circle + tap-to-assign to the active name — instead of keeping their chip. Full
//                       consistency between item and discount assignment in both modes.
// v3.6.1 (2026-07-23) — #147 polish: declutter the quick-split form — the "= ฿…" sum shows only when the field
//                       holds an actual expression (plain numbers/empty show nothing); dropped the repeated
//                       "empty → just shares the rest" hints for a subtle "· optional" tag on the personal fields.
// v3.6.0 (2026-07-23) — #142 discounts join the Assign list. Each discount is a line in the same items card
//                       (−amount + amber OCR badge) with the SAME rotating assign-chip + ▾ dropdown as items
//                       (Powpow/Pat/Both(50-50)/Custom%/Proportional/Fixed฿ → assignTo a/b/split/pct/prop/fixed)
//                       and joins active-name tap-to-assign. Non-personal discounts also show a tappable tax-stage
//                       tag (Before/After SC&VAT + advanced, #137). A discount to one person reduces only their
//                       total. No calc changes (recalc already supports every mode).
// v3.5.0 (2026-07-23) — #147 quick-split Manual-entry flow. `src/expr.js` safe arithmetic evaluator (+ - * / (),
//                       no eval). Manual tab is now a distinct quick form: Date · Description · Paid-by dropdown ·
//                       Bill Total · {A} only · {B} only, all amount fields accept live-summed expressions; empty
//                       personal = shares only; live preview (shares · who-owes · new balance); save direct with
//                       mode:'quick' + raw exprs (persisted inside charges_json). OCR now stays on the itemized
//                       verify view (no longer flips to the Manual tab). BillDetail/edit handle quick bills.
// v3.4.0 (2026-07-23) — #141 Review & Assign full parity with old app: bill summary card (place · date · paid by),
//                       step strip (① Pick a name → ② Tap items), active-name assign bar (avatars + Both) with
//                       tooltip, tap-to-assign item rows w/ colored check circles, "Shared ▾" cycling chip +
//                       reassign dropdown (A/B/Shared/Custom, inline % editor), per-person total boxes. Assign CSS
//                       ported to styles.css. (Charges stay on entry per #139.)
// v3.3.1 (2026-07-23) — #140 restore post-OCR "Who paid?" popup (matches old app): after a scan, a top-anchored
//                       modal "{merchant} — who paid?" with two payer buttons (avatar + name) sets paidBy and
//                       dismisses; shows before the discount-timing prompt.
// v3.3.0 (2026-07-23) — #139 restructure entry step to match old app: DATE / PLACE-DESCRIPTION (+OCR "tap to
//                       verify" note) / CATEGORY above ITEMS (bordered card); CHARGES block (SC/VAT toggles +
//                       collapsible discount editor + OCR badge rows + live Total) moved from Review onto entry;
//                       WHO PAID buttons show "✓ selected". Review step is now assignment-only. No calc change.
// v3.2.2 (2026-07-22) — #138 port OCR scan overlay 1:1 (spinner, cycling status, blinking "keep page open", Gemini badge).
// v3.2.1 (2026-07-22) — #137 UX: discount prompt shows amount + Before/After only, rare stages behind
//                       "More options"; manual editor Before/After toggle + advanced reveal.
// v3.2.0 (2026-07-22) — #137 discount tax stage: SC & VAT handled independently (pre / preVat / preSc / post).
//                       recalc reduces SC and VAT bases separately; auto-detect tries all 4 stages vs receipt
//                       total; manual stage selector; legacy beforeTax→pre/post. Harness TC1.23–26.
// v3.1.0 (2026-07-22) — #136 discount before/after VAT+SC: recalc `beforeTax` on shared discounts;
//                       OCR auto-detects timing by matching the receipt total, asks only if ambiguous;
//                       manual before/after toggle. Harness TC1.23–26.
// v3.0.5 (2026-07-22) — #135 drop `capture` on receipt input so phone can pick from Photo Library (not camera-only).
// v3.0.4 (2026-07-22) — #133 re-skin Settings (grouped member/prefs/account/about/connection cards; rename,
//                       currency cycle, sync/clear-cache, open sheet) + #134 re-skin Bill detail (cards + Edit/Delete).
// v3.0.3 (2026-07-22) — #132 re-skin New-bill flow: Upload/Manual pill tabs, camera dropzone + OCR checklist,
//                       classed entry/assign/confirm cards.
// v3.0.2 (2026-07-22) — #131 re-skin Summary: Week/Month/3mo/Year chips, category donut + person filter,
//                       monthly per-person bar chart, cost-breakdown cards. dates.js gains week filter.
// v3.0.1 (2026-07-22) — #130 startup Sheets sync (default URL + auto-refresh + config→bills ordering);
//                       #129 re-skin: styles.css + nav (centered FAB, fixed icons) + Home + History.
// v3.0.0 (2026-07-22) — initial React scaffold through M5 (feature-complete: CRUD, custom split,
//                       discounts incl %, edit, date filters, OCR, Google auth).
export const APP_VERSION = '3.25.1';

export const CONFIG_DEFAULTS = {
  personA: '',
  personB: '',
  personAEmails: [],
  personBEmails: [],
  initialsA: '', // #157 — optional DB override (Config tab person_a_initials), e.g. "CJ"
  initialsB: '', // e.g. "PP"
  currency: 'THB',
  currencySymbol: '฿',
  // Secrets/URLs are injected at runtime (kept out of source):
  geminiApiKey: '',
  googleSheetUrl: 'https://script.google.com/macros/s/AKfycbz_rQoPkoHaqa0nT5RIjHRfjMN34VRvwL-VKXvJsTaBqz5cSVN14N-fAJh98ATGNUqpaA/exec',
  googleSheetEditUrl: 'https://docs.google.com/spreadsheets/d/1lwtr9H-Gg1QaDUTpxW7uiT_3nmaXlEQ6ExJa2Sg5b2c/edit',
  googleClientId: '1095947409464-uf5j6j4q1jkdcsj7cksst7r1j8da09ii.apps.googleusercontent.com',
};

export const CURRENCIES = [
  { code: 'THB', sym: '฿',  label: 'Thai Baht' },
  { code: 'USD', sym: '$',  label: 'US Dollar' },
  { code: 'EUR', sym: '€',  label: 'Euro' },
  { code: 'SGD', sym: 'S$', label: 'Singapore Dollar' },
  { code: 'JPY', sym: '¥',  label: 'Japanese Yen' },
  { code: 'GBP', sym: '£',  label: 'British Pound' },
];

// Category metadata — single source of truth (replaces the scattered maps in splitapp.html).
// NOTE: #61 (rename "cafe" → "dessert and cafe") to be applied here during migration.
export const CATEGORIES = {
  food:      { emoji: '🍜', label: 'Food & drink', color: '#63A39B' },
  shop:      { emoji: '🛒', label: 'Shopping',     color: '#5B8FD4' },
  cafe:      { emoji: '☕', label: 'Café',         color: '#9B7BC4' },
  transport: { emoji: '🚗', label: 'Transport',    color: '#6AAF8A' },
  other:     { emoji: '📋', label: 'Other',        color: '#888888' },
};
export const catMeta = (key) => CATEGORIES[key] || CATEGORIES.other;

// Person / chart colours.
export const COLORS = {
  avatarA: '#2E3250',
  avatarB: '#5B8FD4',
  accent:  '#63A39B',
  red:     '#E07575',
  green:   '#2a9d5c',
};

// Payer is persisted as a stable 'a'|'b' key (fixes #120) — translate to a display name
// only at the edges (UI, email). Sheets/JSON always carry the key, never the name.
export const payerName = (key, cfg) => (key === 'a' ? (cfg.personA || 'A') : (cfg.personB || 'B'));
