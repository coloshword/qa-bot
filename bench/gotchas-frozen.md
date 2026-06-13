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
