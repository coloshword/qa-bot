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

## PR-18835 / EN-14656 Post Ship Survey — 2026-06-12
- Post Ship Survey feature is Active in app_features (id=135, status=Active)
- Survey IDs: 50=ScaleSurvey (style=scale), 51=YesNoSurvey (style=yesNo); message IDs: 69=ScaleSurvey, 70=YesNoSurvey
- Survey questions sorted by id (ascending): scale has IDs 7743-7747 (1-5), yesNo has 7748=Yes, 7749=No
- Survey only shows if account has active account_message (active=1, seen_cycle_id=NULL) for msg_id 69 or 70
- Test accounts (pw=testpass123): charlotte.calderwood@bookofthemonth.com (id=7793690, scale msg), Ava.meisel@bookofthemonth.com (id=7793673, yesno msg), alexandra.kent@bookofthemonth.com (id=7794164, no msg), dana.allen@bookofthemonth.com (id=5286615, seen msg)
- getPostShipSurveyData is called server-side on box page; fetches accountMessages then surveys via API
- Scale survey Submit button id=button-scale-survey-submit; Dismiss link id=link-scale-survey-dismiss
