# Dese Tour Operations Center — Live Setup Guide

> Sprint 17 · Operator Reference  
> Read this from top to bottom. Do not skip sections.  
> Each section depends on the previous one being complete.

---

## Quick Reference

| File | Purpose |
|---|---|
| `DeseTourDashboard.jsx` | The entire CRM application |
| `index.html` | Entry point — configure Supabase + Resend here |
| `supabase_schema.sql` | Database schema — run once |
| `supabase_rls_policies.sql` | Security policies — run once after schema |
| `api/send-email.js` | Vercel serverless email gateway |
| `DEPLOYMENT_CHECKLIST.md` | Detailed technical checklist |
| `EMAIL_SETUP.md` | Resend email setup guide |

**Status indicator** (bottom-left of the app):  
`Mock · ✉ Mock` → demo mode, no real data  
`Supabase · ✉ Mock` → database connected, email not configured  
`Supabase · ✉ Resend` → fully live

---

## Phase 1 — Supabase Setup

### Step 1.1 — Create Supabase Project

1. Go to [supabase.com](https://supabase.com) → **New Project**
2. Fill in:
   - **Name:** `dese-tour-ops`
   - **Database Password:** generate a strong password (20+ chars) — save it securely
   - **Region:** `eu-west-1` (Frankfurt) — closest to Istanbul users
3. Click **Create new project**
4. Wait 1-2 minutes for provisioning

### Step 1.2 — Get Your Connection Details

After the project is ready:

1. Go to **Project Settings** → **API**
2. Copy:
   - **Project URL** — looks like `https://abcdefghijk.supabase.co`
   - **anon public** key — starts with `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
3. **Do NOT copy the `service_role` key** — it bypasses all security. Leave it in the dashboard.

### Step 1.3 — Run Database Schema

1. Supabase Dashboard → **SQL Editor** → **New query**
2. Open `supabase_schema.sql` from your project files
3. Select all (`Cmd+A` / `Ctrl+A`), copy, paste into the SQL editor
4. Click **Run** (or `Cmd+Enter`)
5. You should see: `Success. No rows returned.`

**Verify:**
```sql
-- Run this to confirm all tables were created
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
```
Expected: 15 tables including `staff_users`, `customers`, `leads`, `quotes`, etc.

### Step 1.4 — Seed Reference Data

In the SQL Editor, run this to add lead sources and default settings:

```sql
-- Lead sources (required for lead creation forms)
INSERT INTO public.sources (name, slug, is_active) VALUES
  ('Website',     'website',     true),
  ('WhatsApp',    'whatsapp',    true),
  ('Instagram',   'instagram',   true),
  ('Booking.com', 'booking',     true),
  ('Tripadvisor', 'tripadvisor', true),
  ('Telefon',     'telefon',     true),
  ('Manuel',      'manuel',      true)
ON CONFLICT (slug) DO NOTHING;

-- Application settings
INSERT INTO public.settings (key, value, value_type, label, is_public) VALUES
  ('company_name',     '"Dese Tour"',   'string', 'Şirket Adı',      true),
  ('default_currency', '"EUR"',         'string', 'Varsayılan Para', true),
  ('tax_rate',         '20',            'number', 'KDV Oranı (%)',  true),
  ('deposit_pct',      '25',            'number', 'Kapora Oranı',   true)
ON CONFLICT (key) DO NOTHING;
```

### Step 1.5 — Run RLS Policies

1. SQL Editor → **New query**
2. Open `supabase_rls_policies.sql`, select all, paste, run
3. You should see: `Success. No rows returned.`

**Verify RLS is enabled:**
```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```
All 15 tables should show `rowsecurity = true`.

**Verify helper functions exist:**
```sql
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('get_current_staff_role','is_admin','is_sales','is_operations','is_guide','is_staff');
```
Should return 6 rows.

---

## Phase 2 — First Admin User

### Step 2.1 — Create Auth User

1. Supabase Dashboard → **Authentication** → **Users** → **Add user** → **Create new user**
2. Fill in:
   - **Email:** `berk@desetour.com` (or your real admin email)
   - **Password:** choose a secure password (you'll log in with this)
   - **Auto Confirm User:** ✅ checked (skip email confirmation for internal tool)
3. Click **Create user**
4. **Copy the UUID** from the user row — it looks like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`

### Step 2.2 — Create Staff Profile

In SQL Editor, run this — replacing the placeholder values:

```sql
-- Replace all three placeholder values before running
INSERT INTO public.staff_users (id, full_name, email, role, is_active)
VALUES (
  'AUTH_USER_UUID_HERE',    -- Paste the UUID from Step 2.1
  'Berk Çetinkaya',         -- Full name as it will appear in the app
  'berk@desetour.com',      -- Must match the auth user email exactly
  'admin',                  -- Role: admin | sales | operations | guide
  true
);
```

**Verify:**
```sql
SELECT id, full_name, email, role, is_active FROM public.staff_users;
```
Should return 1 row with your admin user.

### Step 2.3 — Create Additional Staff Users (Optional)

Repeat Steps 2.1–2.2 for each staff member, using the appropriate role:

| Role value | Turkish label | Access |
|---|---|---|
| `admin` | Yönetici | All pages |
| `sales` | Satış | Leads, Customers, Quotes, Tasks, Reminders |
| `operations` | Operasyon | Reservations, Tours, Payments, Tasks, Reminders |
| `guide` | Rehber | Assigned reservations, assigned tasks only |

---

## Phase 3 — Configure the Application

### Step 3.1 — Update `index.html`

Open `index.html` and find the `window.__DESE_CONFIG` block:

```html
<script>
  window.__DESE_CONFIG = {
    VITE_SUPABASE_URL:      "https://YOUR_PROJECT_REF.supabase.co",
    VITE_SUPABASE_ANON_KEY: "YOUR_ANON_KEY",
    USE_RESEND:             "false",
    EMAIL_ENDPOINT:         "/api/send-email",
    FROM_EMAIL:             "hello@desetour.com",
    FROM_NAME:              "Dese Tour",
  };
</script>
```

Replace:
1. `YOUR_PROJECT_REF` → your actual Supabase project ref (e.g. `abcdefghijk`)
2. `YOUR_ANON_KEY` → the anon/public key from Step 1.2

Leave `USE_RESEND: "false"` until Resend is configured (Phase 5).

**Sanity check before saving:**
- URL must start with `https://` and end with `.supabase.co`
- Anon key must start with `eyJ`
- Neither should contain `YOUR_PROJECT_REF` or `YOUR_ANON_KEY` literally

### Step 3.2 — Enable Supabase Auth Email Sign-In

1. Supabase Dashboard → **Authentication** → **Providers** → **Email**
2. Toggle **Enable Email Provider** → ON
3. Toggle **Confirm email** → OFF *(internal tool — skip email confirmation)*
4. Click **Save**

---

## Phase 4 — Deploy to Vercel

### Step 4.1 — Install Vercel CLI

```bash
npm install -g vercel
```

### Step 4.2 — Project Structure

Ensure your project folder contains:
```
dese-tour/
├── index.html              ← updated in Step 3.1
├── DeseTourDashboard.jsx
├── api/
│   └── send-email.js       ← Vercel serverless function
├── package.json            ← must include "resend" dependency
└── vercel.json             ← optional but recommended
```

**Minimum `package.json`:**
```json
{
  "name": "dese-tour-ops",
  "version": "1.0.0",
  "dependencies": {
    "resend": "^3.0.0"
  }
}
```

**Recommended `vercel.json`:**
```json
{
  "functions": {
    "api/send-email.js": {
      "maxDuration": 30,
      "memory": 512
    }
  },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" }
      ]
    }
  ]
}
```

### Step 4.3 — Deploy

```bash
cd dese-tour
vercel --prod
```

Follow the prompts:
- Set up and deploy → **Y**
- Which scope → select your account
- Link to existing project → **N** (first time)
- Project name → `dese-tour-ops`
- Directory → `./` (current)
- Override settings → **N**

Vercel will output your deployment URL: `https://dese-tour-ops.vercel.app`

### Step 4.4 — Add Vercel Environment Variables

These are **server-side only** — never exposed to the browser:

```bash
# Resend API key (get from resend.com → API Keys)
vercel env add RESEND_API_KEY production
# Paste: re_xxxxxxxxxxxxxxxxxxxx

# From address (must be from a verified Resend domain)
vercel env add FROM_EMAIL production
# Paste: hello@desetour.com

# Sender display name
vercel env add FROM_NAME production
# Paste: Dese Tour

# CORS whitelist — your production URL
vercel env add ALLOWED_ORIGINS production
# Paste: https://dese-tour-ops.vercel.app

# Optional: max attachment size in bytes (default 5MB)
vercel env add MAX_ATTACH_BYTES production
# Paste: 5242880
```

Or via **Vercel Dashboard → Project → Settings → Environment Variables**.

### Step 4.5 — Redeploy After Adding Variables

```bash
vercel --prod
```

Variables only take effect after a new deployment.

---

## Phase 5 — Resend Email Setup

> Skip this phase initially. Get login and CRUD working first, then come back.

See `EMAIL_SETUP.md` for the full Resend guide. Summary:

1. Create account at [resend.com](https://resend.com)
2. **Domains** → Add `desetour.com` → add DNS records → verify
3. **API Keys** → Create → copy `re_xxxxxxxxxxxxxxxxxxxx`
4. Add to Vercel: `vercel env add RESEND_API_KEY production`
5. Update `index.html`: set `USE_RESEND: "true"`
6. Redeploy: `vercel --prod`

When Resend is active, the status badge shows `Supabase · ✉ Resend`.

---

## Phase 6 — Smoke Tests

Run these tests in order. Each one confirms the previous phase worked.

### Test 1: App Loads

- [ ] Open your Vercel URL in Chrome
- [ ] Boot screen appears briefly, then login page loads
- [ ] No JavaScript errors in browser console (`F12` → Console)
- [ ] **Expected:** Login page with "Dese Tour" branding and demo credentials box (if mock mode)

### Test 2: Supabase Connection

- [ ] After logging in, check bottom-left badge
- [ ] **Expected:** `Supabase · ✉ Mock` (not `Mock · ✉ Mock`)
- [ ] If still showing `Mock`: check `index.html` URL/key values, then redeploy

### Test 3: Login

- [ ] Enter your admin email and password from Step 2.1
- [ ] Click **Giriş Yap**
- [ ] **Expected:** Dashboard loads within 2 seconds
- [ ] Check top of sidebar: your name and role (`Yönetici`) should appear
- [ ] If login fails: see Troubleshooting → Login Fails

### Test 4: Dashboard Loads Real Data

- [ ] Dashboard should show "Yükleniyor…" briefly, then render
- [ ] KPI cards may show `0` (database is empty — that's correct)
- [ ] No "Veriler yüklenirken bir hata oluştu" error messages
- [ ] **Expected:** Dashboard renders without errors

### Test 5: Create a Customer

- [ ] Navigate to **Misafirler** → click **Yeni Misafir Ekle**
- [ ] Fill in: Name = `Test Guest`, Email = `test@example.com`, Country = `Avustralya`
- [ ] Click **Misafiri Kaydet**
- [ ] **Expected:** Toast "Kaydedildi ✓", customer appears in list
- [ ] Verify in Supabase: `SELECT * FROM public.customers LIMIT 5;`

### Test 6: Create a Lead

- [ ] Navigate to **Talepler** → click **Yeni Talep**
- [ ] Fill in required fields: Name, Source, Tour
- [ ] Click **Talebi Kaydet**
- [ ] **Expected:** Lead appears in list with status "Yeni"

### Test 7: Create a Tour

- [ ] Navigate to **Turlar** → click **Yeni Tur Ekle**
- [ ] Fill in: Name = `Test Tour`, Price = `350`, Currency = `EUR`
- [ ] Click **Turu Kaydet**
- [ ] **Expected:** Tour appears in list

### Test 8: Create a Quote

- [ ] Navigate to **Teklifler** → click **Yeni Teklif**
- [ ] Select a customer, fill in tour name, guest count, price
- [ ] Click **Taslak Kaydet**
- [ ] **Expected:** Navigates to `/quotes/{id}`, quote detail page loads
- [ ] Verify in Supabase: `SELECT id, quote_number, status FROM public.quotes LIMIT 5;`

### Test 9: Quote → Reservation Conversion

- [ ] Open a quote detail page
- [ ] Click **Rezervasyona Dönüştür**
- [ ] **Expected:** Toast "Rezervasyon oluşturuldu ✓", navigates to reservation page
- [ ] Verify: `SELECT * FROM public.reservations LIMIT 5;`

### Test 10: Add a Payment

- [ ] Navigate to **Ödemeler** → click **Yeni Ödeme**
- [ ] Select a reservation, enter amount
- [ ] Click **Kaydet**
- [ ] **Expected:** Payment appears in list

### Test 11: PDF Preview

- [ ] Open a quote detail page
- [ ] Click **PDF Önizleme**
- [ ] **Expected:** Full-screen preview modal opens with proposal layout
- [ ] Proposal shows: guest name, tour, pricing table, footer
- [ ] Fonts render correctly (Playfair Display serif headings)

### Test 12: PDF Download

- [ ] Inside the preview modal, click **PDF İndir**
- [ ] **Expected:** Browser print dialog opens
- [ ] Select **Save as PDF**
- [ ] Enable **"Background graphics"** in the dialog
- [ ] Click Save
- [ ] **Expected:** PDF file saved, opens correctly with colors preserved

### Test 13: Email Send (Resend configured)

> Skip if Resend is not yet configured

- [ ] Inside the quote preview modal, click **Teklifi Gönder**
- [ ] Button shows: `"PDF oluşturuluyor…"` → `"Email gönderiliyor…"` → `"✓ Gönderildi"`
- [ ] **Expected:** Toast "Teklif PDF ekiyle email olarak gönderildi."
- [ ] Check recipient inbox — email arrives with PDF attachment
- [ ] Verify in Resend dashboard: **Emails** → your email appears with status "Delivered"

### Test 14: Role Restrictions

Log in as a Sales user, then:

- [ ] Navigate to **Ödemeler** → **Expected:** "Bu sayfaya erişim yetkiniz bulunmuyor."
- [ ] Navigate to **Rezervasyonlar** → **Expected:** read-only access
- [ ] Sidebar should NOT show: Ödemeler (for Sales role)

Log in as a Guide user:

- [ ] **Expected:** Only Dashboard, Takvim, Rezervasyonlar, Görevler visible in sidebar
- [ ] Try navigating to `/customers` directly → **Expected:** Access denied page

### Test 15: Logout

- [ ] Click **Çıkış Yap** at the bottom of the sidebar
- [ ] **Expected:** Returns to login page
- [ ] Try navigating to `/#/dashboard` directly
- [ ] **Expected:** Login page shown (not dashboard)

---

## Phase 7 — Troubleshooting

### Problem: App stays in Mock mode (`Mock · ✉ Mock` badge)

**Cause:** `index.html` still has placeholder values or wrong URL format.

**Fix:**
1. Open `index.html`, check `window.__DESE_CONFIG`
2. `VITE_SUPABASE_URL` must be `https://YOURREF.supabase.co` (no trailing slash)
3. `VITE_SUPABASE_ANON_KEY` must start with `eyJ`
4. Neither should contain `YOUR_PROJECT_REF` literally
5. After fixing, redeploy: `vercel --prod`
6. Hard-refresh browser: `Ctrl+Shift+R` / `Cmd+Shift+R`

**Check in browser console:**
```js
window.__DESE_CONFIG
// Should show real URL and key, not placeholders
```

### Problem: Login fails — "Hatalı email veya şifre"

**Cause A:** User doesn't exist in Supabase Auth.
- Fix: Supabase Dashboard → Authentication → Users → verify the email exists

**Cause B:** Password is wrong.
- Fix: Supabase Dashboard → Authentication → Users → click user → **Send password reset**

**Cause C:** `staff_users` table is missing the user profile.
- Fix: Run the INSERT from Step 2.2 with the correct UUID

**Cause D:** Auth email confirmation is enabled.
- Fix: Authentication → Providers → Email → disable "Confirm email"

**Debug:** Check browser console for `[DeseTour]` error messages.

### Problem: RLS blocks all records — queries return empty

**Symptom:** Logged-in admin sees no data where data should exist.

**Cause:** `get_current_staff_role()` returns NULL because `staff_users` row is missing or UUID doesn't match.

**Fix:**
```sql
-- Run while logged in as the user (or use the UUID manually)
SELECT id, full_name, role FROM public.staff_users;
-- Compare with auth.users
SELECT id, email FROM auth.users;
-- They must match on the id column
```

If mismatched:
```sql
UPDATE public.staff_users
SET id = 'CORRECT-AUTH-UUID-HERE'
WHERE email = 'berk@desetour.com';
```

**Test the helper function:**
```sql
-- Run in Supabase SQL Editor as an authenticated user
SELECT get_current_staff_role();
-- Should return: admin (not null)
```

### Problem: Email doesn't send

**Symptom:** "Email gönderilirken bir hata oluştu."

**Check 1:** Is `USE_RESEND` set to `"true"` in `index.html`?
```js
window.__DESE_CONFIG.USE_RESEND // should be "true"
```

**Check 2:** Is `RESEND_API_KEY` set in Vercel?
```bash
vercel env ls production
# Should show RESEND_API_KEY
```

**Check 3:** Test the endpoint directly:
```bash
curl -X POST https://your-app.vercel.app/api/send-email \
  -H "Content-Type: application/json" \
  -d '{"to":"test@example.com","subject":"Test","html":"<p>Test</p>"}'
```

Expected: `{"id":"...","success":true}`  
If error: `{"error":"Email service not configured..."}` → `RESEND_API_KEY` not set  
If `503`: Vercel function not deployed — redeploy

**Check 4:** Is the domain verified in Resend?
- Resend Dashboard → Domains → status must be "Verified"

### Problem: PDF attachment missing from email

**Symptom:** Email arrives but no PDF attachment, or PDF generates but is blank.

**Fix A — PDF is blank:**
In `DeseTourDashboard.jsx`, find `_buildProposalHtml` and increase the font render buffer:
```js
// Change from 300 to 800ms
await new Promise(resolve => setTimeout(resolve, 800));
```

**Fix B — Attachment too large (Vercel Hobby 4.5MB limit):**
In `PDFService._renderToPdf()`, reduce scale from 2 to 1.5:
```js
const canvas = await window.html2canvas(element, {
  scale: 1.5,  // was 2 — reduces file size by ~40%
  ...
```

**Fix C — CDN blocked:**
Network/firewall blocking `cdnjs.cloudflare.com`. Self-host the libraries:
```bash
curl -o public/html2canvas.min.js https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
curl -o public/jspdf.umd.min.js   https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
```
Then update the URLs in `PDFService._ensureLibs()`.

### Problem: CORS error on `/api/send-email`

**Symptom:** Browser console shows: `Access-Control-Allow-Origin` error.

**Fix:**
```bash
vercel env add ALLOWED_ORIGINS production
# Enter: https://your-actual-domain.vercel.app
vercel --prod  # redeploy
```

If using a custom domain: `https://ops.desetour.com,https://dese-tour-ops.vercel.app`

### Problem: Password reset link opens wrong page

**Symptom:** Supabase sends reset email, user clicks link, lands on generic page instead of the reset form.

**Cause:** Supabase redirect URL not configured.

**Fix:**
1. Supabase Dashboard → **Authentication** → **URL Configuration**
2. **Site URL:** `https://your-app.vercel.app`
3. **Redirect URLs:** add `https://your-app.vercel.app/#/reset-password`
4. Save

The app handles `/#/reset-password` and shows the `ResetPasswordPage` component.

### Problem: Vercel env variables not available in function

**Symptom:** `send-email.js` logs `RESEND_API_KEY not set` even though you added it.

**Fix:** Environment variables only load after a new deployment:
```bash
vercel --prod  # always redeploy after adding env vars
```

Verify they're set:
```bash
vercel env ls production
```

### Problem: Supabase `createClient` not found

**Symptom:** Console error: `window.__supabase is undefined` or `createClient is not a function`.

**Cause:** The Supabase CDN script failed to load.

**Fix:**
1. Check `index.html` has this **before** the app script:
```html
<script src="https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<script>
  if (window.supabase) { window.__supabase = window.supabase; }
</script>
```
2. Check browser network tab: the Supabase CDN script returns 200 OK
3. If `unpkg.com` is blocked: self-host `supabase.js` locally

---

## Phase 8 — Go / No-Go Checklist

**Do not open to real users until all items below are checked.**

### ✅ Must Pass Before Going Live

**Authentication**
- [ ] Admin can log in with real Supabase credentials
- [ ] Login page redirects to dashboard after successful login
- [ ] Dashboard shows real name (`Berk Çetinkaya`) not hardcoded
- [ ] Logout returns to login page and prevents navigating back to dashboard
- [ ] Status badge shows `Supabase` not `Mock`

**Security**
- [ ] RLS is enabled on all 15 tables (verified via SQL query in Step 1.5)
- [ ] `get_current_staff_role()` returns `admin` for admin user
- [ ] Sales user cannot access Ödemeler (payments) page
- [ ] Guide user cannot access Teklifler (quotes) page
- [ ] No `service_role` key visible in browser → Network tab

**Data (CRUD)**
- [ ] Customer can be created and appears in Supabase `customers` table
- [ ] Lead can be created and appears in `leads` table
- [ ] Quote can be created and appears in `quotes` table
- [ ] Quote converts to reservation (`reservations` table updated)
- [ ] Payment can be recorded (`payments` table updated)

**PDF**
- [ ] PDF preview modal opens (Test 11 passed)
- [ ] PDF downloads without being blank (Test 12 passed)
- [ ] PDF has correct colors when "Background graphics" is enabled

**Email (if Resend configured)**
- [ ] `/api/send-email` returns `{"success":true}` to a curl test
- [ ] Real email arrives in inbox
- [ ] PDF attachment opens correctly
- [ ] Resend dashboard shows "Delivered" status

**Stability**
- [ ] No red errors in browser console during normal use
- [ ] App loads in under 5 seconds on a standard connection
- [ ] Mobile (390px): sidebar opens as drawer, tables readable
- [ ] All 19 pages load without crashing

### ⚠️ Known Acceptable Limitations at Launch

These are documented gaps that do not block going live:

| Limitation | Impact | Planned |
|---|---|---|
| CalendarPage shows repo data but not full CRUD | Ops cannot add events directly | Sprint 18 |
| MessagesPage is mock | No real WhatsApp/email inbox | Sprint 18 |
| Settings company info saves to state only | Changes lost on refresh | Sprint 18 |
| Real-time updates disabled | Two users don't see each other's changes live | Sprint 18 |
| WhatsApp integration not connected | Button exists, no function | Sprint 18 |
| Password reset requires manual Supabase URL setup | Redirect may land on wrong page | See Troubleshooting |

---

## Exact Deployment Order (Summary)

```
1. supabase.com    → Create project (5 min)
2. Supabase SQL    → Run supabase_schema.sql (2 min)
3. Supabase SQL    → Run supabase_rls_policies.sql (2 min)
4. Supabase SQL    → Seed sources + settings (1 min)
5. Supabase Auth   → Create admin user → copy UUID (2 min)
6. Supabase SQL    → INSERT into staff_users with UUID (1 min)
7. index.html      → Update VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (2 min)
8. vercel --prod   → First deploy (3 min)
9. Vercel env      → Add RESEND_API_KEY, FROM_EMAIL, FROM_NAME, ALLOWED_ORIGINS
10. vercel --prod  → Redeploy with env vars (2 min)
11. Browser        → Smoke tests 1–10 (15 min)
── Go live with mock email ──
12. resend.com     → Create account, verify domain (30-60 min for DNS)
13. index.html     → Set USE_RESEND="true", update FROM_EMAIL
14. vercel --prod  → Final redeploy (2 min)
15. Browser        → Smoke tests 11–15 (10 min)
── Fully live ──
```

**Total time (first deployment):** ~2 hours including DNS propagation wait.

---

## Appendix A — Useful SQL Queries

```sql
-- List all staff users and their roles
SELECT id, full_name, email, role, is_active FROM public.staff_users ORDER BY role;

-- Count records in each table (use to confirm CRUD is working)
SELECT 'customers' AS tbl, COUNT(*) FROM public.customers UNION ALL
SELECT 'leads',            COUNT(*) FROM public.leads UNION ALL
SELECT 'quotes',           COUNT(*) FROM public.quotes UNION ALL
SELECT 'reservations',     COUNT(*) FROM public.reservations UNION ALL
SELECT 'payments',         COUNT(*) FROM public.payments;

-- Check RLS is enabled everywhere
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' ORDER BY tablename;

-- Check helper functions exist
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name LIKE 'is_%' OR routine_name = 'get_current_staff_role'
ORDER BY routine_name;

-- View recent activity logs
SELECT entity_type, action, description, created_at
FROM public.activity_logs ORDER BY created_at DESC LIMIT 20;

-- Delete all test data (use before go-live)
TRUNCATE public.activity_logs, public.payments, public.reservations,
         public.quote_items, public.quotes, public.tasks, public.reminders,
         public.leads, public.customers CASCADE;
-- Note: does NOT delete sources, settings, staff_users, tours
```

## Appendix B — Environment Variables Reference

| Variable | Location | Value | Required |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `index.html` | `https://xxx.supabase.co` | ✅ |
| `VITE_SUPABASE_ANON_KEY` | `index.html` | `eyJ...` | ✅ |
| `USE_RESEND` | `index.html` | `"true"` or `"false"` | For email |
| `EMAIL_ENDPOINT` | `index.html` | `"/api/send-email"` | For email |
| `FROM_EMAIL` | `index.html` + Vercel | `hello@desetour.com` | For email |
| `FROM_NAME` | `index.html` + Vercel | `Dese Tour` | For email |
| `RESEND_API_KEY` | **Vercel only** | `re_xxxx` | For email |
| `ALLOWED_ORIGINS` | Vercel | `https://your-app.vercel.app` | For CORS |
| `MAX_ATTACH_BYTES` | Vercel | `5242880` | Optional |

> ⚠️ `RESEND_API_KEY` must NEVER appear in `index.html`, `DeseTourDashboard.jsx`, or any client-side file. Vercel environment variables only.

---

*Dese Tour Operations Center · Sprint 17 · Live Setup Guide*
