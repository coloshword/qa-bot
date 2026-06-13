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
gabriela.voll (id=16673) has policyType=Rejoin/Re-Enroll — box page redirects her to /rejoin, YesNo survey can't render for her. Used Ava.meisel (id=7793673) for case 6 instead (reset account_message 24546403 to active=1 before test, survey submitted back to active=0 after).
SNES login via form does NOT update the Core (port 20082) session cookie in the browser — the Core jwt cookie is set by a client-side fastLogin fetch call to Core, which goes directly through the browser. SNES SSR reads jwt from the Next.js cookie store (forwarded from the browser's jwt cookie for localhost). After login, the browser jwt cookie IS updated (domain=localhost, no port restriction), but takes effect only on next full navigation (SSR).

## PR-18835 / EN-14656 Post Ship Survey — 2026-06-13 (run 3)
- gabriela.voll@bookofthemonth.com (id=16673) is a Rejoin member — box page redirects to /rejoin, cannot show survey card
- fastLogin via POST to core API (port 20082) does NOT set session on SNES (port 20030); use SNES login form at /en-US/login instead
- SNES login form ids: email=email-defaultlogin, password=password-defaultlogin, submit=#account-submit-login
post-ship survey Friend exclusion uses hasMessage() (AccountMessageDb.ts:219-231) which is a bare existence check with no cycle/date filter; a hasMessageByCycle() method exists at line 234 but is unused for this check — old Friend popup rows (msg_id=60/61) from any past cycle permanently exclude the member from future surveys
- Friend tier popup exclusion (msg_id=60/61) uses bare hasMessage() with no cycle scope — members who were ever Friends are permanently excluded from post-ship survey; fix: hasMessageByCycle() scoped to currentCycleId
- survey_response table has no resource_title column; SNES SubmitSurveyOptions also lacks resourceTitle; title recoverable via resource_id→pdp join
- YesNo survey (post-ship): password hash format is SHA2(CONCAT(password, password_salt), 224); salt is NOT account id, it's a separate field. For pre-seeded test accounts, set password via SQL: UPDATE account SET password_hash = SHA2(CONCAT('testpass123', password_salt), 224) WHERE id=<id>.
- PR-18835 / EN-14656 (run 4, 2026-06-13): test account passwords reset at stack start — always run SHA2 password trick before fastLogin: UPDATE account SET password_hash = SHA2(CONCAT('testpass123', password_salt), 224) WHERE id=<id>

## PR-18835 / EN-14656 Post Ship Survey — 2026-06-13 (run 4)
- core.query(sql, params) is the raw SQL method on Core (extends Pool<ICoreDb>); core.db.query does not exist
- core.db.message.query() also not exposed; use core.query() for ad-hoc SQL in scripts
- Test account passwords need to be set: UPDATE account SET password_hash=SHA2(CONCAT("testpass123",password_salt),224) WHERE id=<id>
- postShipSurveyCache.get() fails when assignPostShipSurvey is run standalone in script context (cache not init); use with full core server or test components individually
- hasMessage() behavior proven: returns true for past-cycle Friend popup; hasMessageByCycle() correctly returns false — bug confirmed behaviorally
- survey_response source=site for SNES submissions; app submissions should send source=app
