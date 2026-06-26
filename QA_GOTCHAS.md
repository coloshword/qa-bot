## General — 2026-06-11
- Login As Member in admin does NOT work for SNES login — redirect/cookie does not transfer. Instead: go directly to the SNES login page (/login) and log in with email + password. Use the SHA2 password trick to set a known password first if needed.

## PR-18826 / EN-16277 — 2026-06-11
- This is allurial-only; series commitment derived-box logic guarded by config.whitelabelTheme === allurial
- Branch: en-15222-preserve-series-on-clear
- BoxDb.get() derives series items from account_book_commitment, no box table row stored
- add_commitment_books_to_box cron is DELETED — do not try to run it
- getPurchasedUnshippedCommitmentProductIds requires abc.status='Purchased' AND ah.status='Settled' — 'Committed' members do NOT get the book in their box yet
- ship_cycle = sch.cycle_id + schb.ship_cycle_offset (e.g. homepage cycle 136 + offset 3 = ship cycle 139). Must advance store cycle to >= ship_cycle for the book to appear. Use admin "Edit cycle" → combobox → "Change Current Cycle" button → confirm dialog
- Admin "Edit cycle" and SNES login are on different domains (admin.bookofthemoment.com vs bookofthemoment.com) — navigating to admin drops the SNES session cookie; re-login after any admin cycle change
- Password set via admin account page "Password:" field + Save — no DB trick needed on this ephemeral

## PR-18826 / EN-16277 — 2026-06-12
- admin surfaces (ports 20050/20051) render blank white pages on local allurial stacks — React app not rendering; use SQL for preconditions instead
- refundPreorder admin API (POST /admin/transaction/:ahId/refund-preorder) requires Rippling/Okta JWT — unavailable locally; test via SQL status flip on account_book_commitment.status and account_history.status
- derived series items appear in SNES box under 'YOUR ALLURIAL SERIES' section as 'Pre-paid'; they have no Remove button (cannot be removed)
- SNES login uses #account-submit-login button id; there are multiple submit buttons on the page — use exact id to avoid strict-mode violation
- SNES box password set via SQL: UPDATE account SET password_hash = SHA2(CONCAT('<pw>', password_salt), 224) WHERE id = <id>

## PR-18831 / EN-16277 — 2026-06-12
- Category cache is in-memory with no HTTP flush endpoint accessible without admin auth (Okta/Rippling); to force flush: kill core PID and restart with envScript env vars (source .env.allurial-local.xavier from XAVIER_SOURCE + slot overrides)
- Core POLL_INTERVAL env var not set on local stacks = no auto-flush via pollDb; manual restart is required to pick up DB changes in category_children
- All Hardcovers page URL is /all-hardcovers (not /books/all-hardcovers or /books)
- category API is GET /api/category?list=<slug> (under /api prefix); mobileAuth does not block unauthenticated requests
- current-features = bomFeatureData[0] from pdp_featured; june-2026 (CMS) = categoryData from allv2(); after PR merge order flip, CMS wins slug collisions
- series commitment book pdp_id: pdp 81 = The Exquisite Torment of Loving Your Enemy (product_id 81, commitment_book id 2)

## PR-18835 / EN-14656 Post Ship Survey — 2026-06-13
- Post Ship Survey feature is Active in app_features (id=135, status=Active)
- Survey IDs: 50=ScaleSurvey (style=scale), 51=YesNoSurvey (style=yesNo); message IDs: 69=ScaleSurvey, 70=YesNoSurvey
- Survey questions sorted by id (ascending): scale has IDs 7743-7747 (1-5), yesNo has 7748=Yes, 7749=No
- Survey only shows if account has active account_message (active=1, seen_cycle_id=NULL) for msg_id 69 or 70
- Test accounts (pw=testpass123): charlotte.calderwood@bookofthemonth.com (id=7793690, scale msg), Ava.meisel@bookofthemonth.com (id=7793673, yesno msg), alexandra.kent@bookofthemonth.com (id=7794164, no msg), dana.allen@bookofthemonth.com (id=5286615, seen msg)
- getPostShipSurveyData is called server-side on box page; fetches accountMessages then surveys via API
- Scale survey Submit button id=button-scale-survey-submit; Dismiss link id=link-scale-survey-dismiss
- Box page URL for botm SNES is /en-US/box NOT /en/box — SUPPORTED_LOCALES=['en-US','en-CA']; /en/box gets rewritten to /en-US/en/box which 404s
- account_message table (singular) uses column message_id (not msg_id); account_messages plural does not exist in xavier DB
- /api/account_history/loyaltyStats route is botm-theme-only (guarded by if(core.config.whitelabelTheme==='botm')); returns 404 with allurial theme — core restart with botm theme required if previous run used allurial
- Core can be running with wrong whitelabel theme after a previous QA slot reuse; check core.log for XAVIER_WHITELABEL_THEME before testing box page; restart with `qa-stack start core` if needed
- Session switching between accounts: /api/logout does NOT clear the jwt cookie; clearing browser cookies via JS misses httpOnly jwt. Fastest method: POST /api/account/fastLogin?action=login with email+password to get a JWT, then inject it via browser_run_code_unsafe addCookies({ name:'jwt', domain:'localhost', httpOnly:true, ... }). Playwright's fill_form on the login page can appear to work but leaves Ava's session if the jwt cookie wasn't cleared first.
- dana.allen account_message for message_id 69: active=0, seen_cycle_id=138 — survey correctly NOT shown (API returns no msg_id 69 or 70 for this account in active=1 state)
- PostShipSurveyCard (snes): Dismiss link only appears AFTER submission (ScaleSurvey.tsx hasSubmitted branch). There is no pre-submit dismiss UI. handleDismiss omits markMessageAsSeen but this is harmless since dismiss is only reachable post-submit when message is already marked seen via handleSubmit onSuccess.

## PR-18835 / EN-14656 Post Ship Survey — 2026-06-12 (run 2)
- Box page URL is /en-US/box (not /en/box — en/box 404s due to locale routing)
- Scale survey Dismiss link (id=link-scale-survey-dismiss) only appears AFTER submission — no pre-submit dismiss on SNES
- YesNo survey Dismiss link id=link-yesno-survey-dismiss; Yes/No link ids: link-yesno-survey-option-Yes, link-yesno-survey-option-No
- DB reset via qa-stack up clears account_message rows — re-INSERT for scale (msg_id=69) and yesno (msg_id=70) after each reset
- hasMessage() in AccountMessageDb has no active filter — stale Friend popup rows (active=0) permanently exclude member from survey assignment (bug)
- Core may restart with wrong whitelabel after slot reuse — check theme before testing, restart core with botm if needed
- JWT injection (addCookies) is reliable for account switching when /api/logout fails to clear httpOnly cookie
Allurial box page URL is /box (no locale prefix like /en-US/), while login page is also /login (no locale prefix). The en-US prefix leads to 404 on allurial whitelabel.
- Allurial logout: Navigate directly to http://localhost:202XX/api/account/logout (GET, returns "OK") — the httpOnly session cookie cannot be cleared via JS document.cookie; this is the only reliable way to logout between test accounts in lane reuse scenarios. Port = 20000 + (slot-1)*100 + 82.
- Allurial account_summary.policy_id type='Lead' = non-member; type='Member' = active subscriber. Accounts with credits=0 but Lead policy still can't access /box.
- isFreeBox in BoxWrapperNonBOTM.tsx: `memberBox?.[boxShowing]?.totals?.total === "Free"` — "Free" string match. To test non-free: set account_summary.credits=0 for an account with paid book items in box.
- Free add-on items (e.g. "Free Enemies to Lovers Hat") count as "Free" in totals even with 0 credits — need actual paid books in box to get non-free total.

- Admin UI (qa-stack start admin) requires ADMIN_HOST env override per slot (e.g. http://localhost:20151 for slot 2); the default seed .env.local.xavier sets ADMIN_HOST=http://localhost:5001 which breaks browser auth. Fix: add ADMIN_HOST to slotEnv() in bin/qa-stack.mjs.
- Admin webpack may fail with "Cannot find module 'dayjs'" or 'formik' because shared_components/node_modules is not installed. Fix: npm install shared_components dependencies in admin/node_modules (npm install dayjs formik ... --no-save inside Xavier/admin). Do NOT install node_modules inside Xavier/shared_components — it causes webpack to pick up conflicting react-router-dom versions.
- After modifying shared_components source or adding node_modules, touch a shared_components/src file (e.g. Form.tsx) to force webpack watch rebuild.
XAVIER_CONFIG must be set to ../config/test.json when running jest in Xavier/core, otherwise config.ts falls back to local.json which doesn't exist in stack slots. Use: XAVIER_CONFIG=../config/test.json npx jest --config jest.json ...

## passive_skips script: must set SLACK_XAVIER_OPS_HOOK when running directly
When running `build/scripts/mcduck/passive_skips.js` outside of qa-stack (or inside qa-stack run-script which reads the env file), SLACK_XAVIER_OPS_HOOK must be set to a valid URL. If unset, slackMessage() throws "TypeError: Failed to parse URL from undefined" at line 30 before any rows are processed. Use a mock HTTP server: `node -e "require('http').createServer((_,r)=>r.end('ok')).listen(9999)"` and set `SLACK_XAVIER_OPS_HOOK=http://localhost:9999`. When using qa-stack run-script, also set SLACK_XAVIER_OPS_ALERTS_HOOK — both vars are unset in the local .env file.
Direct navigation to /en-US/cancel/monthly-offer?fromPage=saveOffer3MCC works without needing to go through the cancel flow first. Claimed account (three_m_commit_offer_status='Claimed') gets an 'Oops! Looks like something went wrong.' error page instead of the 3M plan offer — no 'Claim offer and save' button visible. API confirms upgradePlanOptions is [] for Claimed vs 1 plan for Unclaimed.

## 3M commit offer API bypass (EN-16311)
- `claimMustRenewSaveOfferRoute` (PUT /api/account/claimMustRenewSaveOffer) has NO guard on threeMCommitOfferStatus. A Claimed member can call it directly to re-obtain the 3M commit plan (policy 100→134, plan at $12.99).
- `updatePlanAndPolicyRoute` (PUT /api/account/policy-and-renewal-change) rejects (401) for Claimed members trying to switch to the 3M plan, but this is due to planSet eligibility (plan not in current policy's planSet), NOT a threeMCommitOfferStatus check.
- IPlan type uses camelCase: policyId (not policy_id), mustRenewCycles (not must_renew_cycles).

## EN-16310 — 2026-06-23
- Migration snapshot conflict: DB snapshot has newer migrations not on branch — manually DELETE stale records from db_migrations_tracking before running migrations (stale: 2026_06_05_16_30_00/01, 2026_06_18_09_48_03-06)
- Docker daemon must be running before qa-stack up — run: open -a Docker && wait for 'Docker ready' before retrying stack bring-up
- Lane 2 migration fix: docker exec qa-db-slot2 mysql -u xavier_write -pxavier_dev -t xavier (use correct user xavier_write not xavier)
- After claiming 3M commit offer, re-visiting /en-US/cancel/monthly-offer?fromPage=saveOffer3MCC shows 'Oops! Looks like something went wrong.' error page — offer is not re-shown to Claimed accounts (confirmed case 2).
- Core API auth: JWT must be sent as `Cookie: jwt=<token>` not `Authorization: Bearer <token>` — mobileAuth middleware tries to look up Bearer tokens in auth_token table (mobile tokens), not as JWTs; cookie path uses jwtVerifier correctly.
- EN-16310 migration not auto-run on local stacks: must manually run `ALTER TABLE account_summary ADD COLUMN three_m_commit_offer_status ENUM('Unclaimed', 'Claimed') NOT NULL DEFAULT 'Unclaimed' AFTER wait_and_save_offer_status` before testing; the AccountSummaryDb.update() and .get() queries both reference this column.
- Browser fetch to core (port 20182) from snes page (port 20130): cookies are NOT sent cross-port without `credentials: 'include'`; use curl with `-H "Cookie: jwt=..."` for reliable API calls.
- EN-16310: After claiming 3M commit offer, re-visiting /en-US/cancel/monthly-offer?fromPage=saveOffer3MCC shows 'Oops! Looks like something went wrong.' — verified both cancel-flow and updatePlanAndPolicy routes update DB column and emit Klaviyo updateAttribute (success logged in core)
Cross-origin fetch from snes (port 20130) to core (port 20182) WORKS with credentials:include — @koa/cors reflects origin with credentials:true by default; PUT /api/account/policy-and-renewal-change accepts overridePlans:true to bypass planSet eligibility check.
httpOnly JWT cookie persists after JS cookie clear — must navigate to /api/account/logout to clear session before login as different account
- On botm whitelabel, Klaviyo track payload is not logged in core logs (just 'Klaviyo track queued for consumer'); verify 3MCommitClaimed by reading KlaviyoListener.ts + confirming DB state of three_m_commit_offer_status at rejoin time

## EN-16310 — 2026-06-23
- qa-stack checkout now falls back to local origin/<branch> cache on fetch failure (branch deleted from remote after PR merge) — see bin/qa-stack.mjs checkout()
- qa-stack migrate now auto-deletes stale migration records whose files are missing from disk (snapshot has newer migrations) — no manual DELETE needed
- When en-16310 branch was deleted after merge: fetch by SHA works: git fetch origin <SHA>; then update-ref refs/remotes/origin/<branch> <SHA> to make qa-stack up reuse it
- botm whitelabel does NOT log full Klaviyo payload — only 'Klaviyo track queued for consumer'; verify 3MCommitClaimed by confirming DB threeMCommitOfferStatus at rejoin time
- PR 18876 local checkout was at 5dbca361 (missing last commit 4ff07537 that adds 3MCommitClaimed to KlaviyoListener enroll event); fix: git fetch origin <SHA> + update-ref + qa-stack up
- Account password is stored as SHA2(CONCAT(plaintext_password, password_salt), 224) NOT bcrypt. Use SQL: UPDATE account SET password_hash = SHA2(CONCAT('Test1234!', password_salt), 224) WHERE id=<id>
- Older swag products (id < 200) may not appear in /en-US/shop even if product_type='swag' and deleted_at IS NULL — use newer product IDs (2355+) that are already displayed in the shop for loyalty tier testing
# PR-18921 / EN-15091 — swag-shop loyalty tier filtering
- password_hash in xavier uses SHA2(CONCAT(password, password_salt), 224) — NOT bcrypt. Set both password_salt and password_hash together.
- swag-shop category cache is pre-built at core startup into tier variants: swag-shop-entry/friend/bff. DB changes to min_loyalty_tier require core restart to take effect.
- The /loaded endpoint returns HTTP 200 body "OK" when caches ready (not body "loaded"); qa-stack waitHttp checks for HTTP 200 status, not body text.
- To restart core on slot N: kill -9 -<pid> then cd to slot<N>/Xavier/core and start with env vars from .env.local.xavier + slot overrides.
- account_summary.id IS the account_id (same field, no account_id column).
- Only products in the swag-shop category (via category_children) appear in the shop. Product type='swag' alone is not sufficient — the PDP must be linked to the swag-shop category.

# EN-15091 Swap Shop Loyalty Tier Filtering
- SNES /en-US/shop uses a Redis-backed Next.js cache handler (@neshca/cache-handler). DB changes to min_loyalty_tier require BOTH a core restart AND a Redis FLUSHALL (on slot's near-redis port e.g. 20079) to propagate to the shop grid. Restarting SNES or deleting .next/cache is NOT sufficient.
- product_pdp_lookup joins product to pdp; min_loyalty_tier lives on the product table, used by PdpDb.getThumbnails() which populates ThumbnailCache on core startup.
- The Book Person Hat (product_id=pdp_id=2355) is in category 140 (swag-shop); Classic Tote (id=134) is NOT in that category.
- account_summary.id IS the account_id (no separate account_id column).
- Password must be set via SHA2(CONCAT('<pw>', password_salt), 224) — bcrypt hashes in test briefs may not be valid.

## PR-18921 — 2026-06-26
- SNES Next.js uses Redis-backed cache handler (@neshca/cache-handler). DB changes to min_loyalty_tier require core restart AND Redis FLUSHALL to propagate — deleting .next/cache alone is insufficient.
- Xavier password hash is SHA2(CONCAT(password, password_salt), 224) not bcrypt — set with: UPDATE account SET password_hash = SHA2(CONCAT("Test1234!", password_salt), 224) WHERE id=<id>.
- swag-shop tier-filtered caches (swag-shop-entry/friend/bff) are built at core startup; DB changes to min_loyalty_tier require core restart to take effect.
- Product must be in swag-shop category via category_children to appear in /en-US/shop; product_type=swag alone is insufficient. Use product IDs 2355+ (older IDs like 134 are not in category).
- account_summary.id IS the account_id — no separate account_id column in account_summary.

## PR #18921 — Categories API loyalty tier filter
- Mobile auth: use `authorization: <token>` header from auth_token table + `x-botm-platform: ios` to bypass recaptcha on /api/account/fastLogin; mobileAuth middleware accepts it directly
- Categories route: GET /api/category?list=<slug> (not /categories, not /api/categories); registered at /api/category in RoutesNew.ts:74
- isAppVersionDeprecated with placeholder 'X.Y.Z' → [NaN,NaN,NaN] → all comparisons false → always returns false; this breaks any feature gated on that placeholder
- SNES thumbnail data is `cache: "force-cache"` (snes/app/serverActions/pdp/server.ts:getThumbnails). Changing product min_loyalty_tier in DB is NOT reflected until SNES is restarted; kill pid from `qa-stack status` and relaunch `.next/standalone/server.js`.
- Shop page.tsx:50 uses raw category children count (pre-filter) to decide showProducts; MerchShopGrid then filters by loyalty tier. Result: active member with tier < all product minLoyaltyTiers gets default copy + empty grid with no explanation.
- The jwt cookie is HttpOnly (not visible via document.cookie). To verify which loyaltyTier was issued, check `node "$QA_STACK_BIN" logs core 50 --slot N | grep "JWT newToken"`.
- When switching between test accounts, always hit `http://localhost:20282/api/account/logout` first before navigating to login — otherwise the old HttpOnly jwt cookie may persist and the login page login button silently keeps the old session.
- Categories API endpoint is /api/category?list=<slug> (not /api/categories).
- isAppVersionDeprecated with any non-numeric placeholder (X.Y.Z, x.z.z, x.x.z) always returns false — all parts parse to NaN via .map(Number), and NaN < NaN / NaN == NaN are both false. Replace placeholder with a real semantic version (e.g. 8.5.0) for the gate to work.
- SNES getThumbnails uses force-cache — DB min_loyalty_tier changes require SNES restart to reflect.
- Xavier /api/account/logout URL clears HttpOnly jwt cookie; always navigate there before switching test accounts in browser.

## PR-18924 / EN-16433 — 2026-06-26
- june-add-ons category (id=308) current children: [2727, 2728, 2749, 2722, 2724, 2725, 2723, 2721, 2726, 2702]
- Experiment 239 ("Add ons Merchandising: Logged In") exp_key=17593, 100% in variant 1 (bucket 0-65536), active=1
- Mobile auth for category API: authorization: <token from auth_token table> + x-botm-platform: ios header
- Platform detected via x-botm-platform header; accountId from mobileAuth middleware via auth_token table
- ADD_ONS_MERCHANDISING_PDP_ORDER = [2749, 2751, 2728, 2753, 2727, 2750, 2752]; expected reorder of current data: [2749, 2728, 2727, 2722, 2724, 2725, 2723, 2721, 2726, 2702]

## PR #18924 / EN-16433 — 2026-06-26
- Category children ordering: positions in category_children table are swappable but the old core process (from earlier qa-stack up) may still be serving the port. Use `lsof -i :<port> | grep LISTEN` to find the actual PID serving the port — kill it directly with kill -9 before running `qa-stack start core`.
- Multiple core processes can accumulate on a Mac (one per qa-stack up or restart). Always check `lsof -i :PORT | grep LISTEN` to confirm which pid is actually serving before testing, especially after DB changes.
- mobileAuth middleware sets accountId from the `authorization: <token>` header, but only if a valid jwt cookie isn't already set. For most API tests, use cookie-based JWT auth via fastLogin (`POST /api/account/fastLogin` → get jwt HttpOnly cookie → pass as `-b "jwt=..."` in curl).
- /api/account/login returns 404; use /api/account/fastLogin instead.
- The v2 single-category route GET /v2/botm/category/:slug returned 404 for june-add-ons in test env (categoryCache.get returning null for that slug in v2 context). This may be a pre-existing env limitation.
- resortAddOnsMerchandising only implements logged-in experiment (239), not logged-out (240) per EN-16433 ticket spec. The !accountId early-return blocks all logged-out paths.
