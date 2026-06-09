-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Supabase / PostgreSQL Database Schema
-- ============================================================
-- File:       supabase_schema.sql
-- Platform:   Supabase (PostgreSQL 15+)
-- Schema:     public
-- Version:    V1 — June 2026
-- Docs:       See DATABASE_SCHEMA.md for field-level descriptions
--
-- HOW TO APPLY:
--   Supabase Dashboard → SQL Editor → paste and run.
--   Or use Supabase CLI:
--     supabase db push --file supabase_schema.sql
--
-- NOTES:
--   • All IDs are UUID — generated with gen_random_uuid()
--   • All tables have created_at and updated_at
--   • updated_at is managed by the trigger defined at top
--   • RLS is commented out — see Step 2 to enable
--   • Seed data is at the bottom of the file
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ──────────────────────────────────────────────────────────────────────────

-- Supabase enables these by default; listed for clarity.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- fuzzy text search


-- ──────────────────────────────────────────────────────────────────────────
-- UTILITY: auto-update updated_at trigger
-- Applied to every table that has an updated_at column.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 1: staff_users
-- Application-level profile that mirrors auth.users.
-- One staff_users row per Supabase auth user.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_users (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name    TEXT        NOT NULL,
  email        TEXT        NOT NULL UNIQUE,
  phone        TEXT,
  role         TEXT        NOT NULL DEFAULT 'sales'
                           CHECK (role IN ('admin','sales','reservations','operations','guide')),
  avatar_url   TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.staff_users           IS 'App-level profiles for authenticated staff. Mirrors auth.users.';
COMMENT ON COLUMN public.staff_users.role      IS 'admin | sales | reservations | operations | guide';
COMMENT ON COLUMN public.staff_users.is_active IS 'Set false to deactivate without deleting.';

CREATE TRIGGER trg_staff_users_updated_at
  BEFORE UPDATE ON public.staff_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Staff can read their own profile"
--   ON public.staff_users FOR SELECT
--   USING (auth.uid() = id);
-- CREATE POLICY "Staff can update their own profile"
--   ON public.staff_users FOR UPDATE
--   USING (auth.uid() = id);


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 2: sources
-- Reference table for lead/customer acquisition channels.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sources (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  slug       TEXT        NOT NULL UNIQUE,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.sources      IS 'Lead and customer acquisition channels (WhatsApp, Booking, etc.).';
COMMENT ON COLUMN public.sources.slug IS 'Machine-readable key: whatsapp, instagram, booking, etc.';

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "All staff can read sources"
--   ON public.sources FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Only admin can manage sources"
--   ON public.sources FOR ALL TO authenticated
--   USING (EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role = 'admin'));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 3: customers
-- Guest / customer records. Central entity in the data model.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.customers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name        TEXT        NOT NULL,
  email            TEXT,
  phone            TEXT,
  nationality      TEXT,
  language         TEXT        DEFAULT 'tr',
  birthdate        DATE,
  passport_number  TEXT,                     -- sensitive: restrict via RLS in Step 2
  passport_expiry  DATE,
  address          TEXT,
  notes            TEXT,
  tags             TEXT[]      DEFAULT '{}',
  source_id        UUID        REFERENCES public.sources(id) ON DELETE SET NULL,
  import_type      TEXT        NOT NULL DEFAULT 'manual',
                               -- V2 values: whatsapp | website | meta | booking | tripadvisor
  external_ref     TEXT,       -- V2: external system ID for deduplication
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by       UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.customers                IS 'All guest/customer profiles.';
COMMENT ON COLUMN public.customers.import_type    IS 'manual (V1) | whatsapp | website | meta | booking (V2)';
COMMENT ON COLUMN public.customers.external_ref   IS 'External system reference for V2 integrations.';
COMMENT ON COLUMN public.customers.passport_number IS 'Sensitive — restrict with RLS in Step 2.';

CREATE INDEX IF NOT EXISTS idx_customers_full_name  ON public.customers(full_name);
CREATE INDEX IF NOT EXISTS idx_customers_email      ON public.customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_phone      ON public.customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_source_id  ON public.customers(source_id);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON public.customers(created_at DESC);

-- GIN index for tag array filtering
CREATE INDEX IF NOT EXISTS idx_customers_tags ON public.customers USING GIN (tags);

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Authenticated staff can read customers"
--   ON public.customers FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Authenticated staff can insert customers"
--   ON public.customers FOR INSERT TO authenticated WITH CHECK (TRUE);
-- CREATE POLICY "Authenticated staff can update customers"
--   ON public.customers FOR UPDATE TO authenticated USING (TRUE);
-- NOTE: passport_number access should be further restricted by role.


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 4: leads
-- Sales inquiries and initial contact records.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.leads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_number       TEXT        NOT NULL UNIQUE, -- e.g. LEAD-2026-0042
  customer_id       UUID        REFERENCES public.customers(id) ON DELETE SET NULL,
  -- Temporary contact fields (used before customer record is created)
  contact_name      TEXT        NOT NULL,
  contact_phone     TEXT,
  contact_email     TEXT,
  status            TEXT        NOT NULL DEFAULT 'new'
                                CHECK (status IN (
                                  'new','contacted','quote_sent','quote_approved',
                                  'won','lost','on_hold'
                                )),
  source_id         UUID        REFERENCES public.sources(id) ON DELETE SET NULL,
  import_type       TEXT        NOT NULL DEFAULT 'manual',
  external_ref      TEXT,
  -- Travel details
  destination       TEXT,
  tour_id           UUID,       -- FK → tours.id added after tours table is created
  travel_start_date DATE,
  travel_end_date   DATE,
  pax_adult         INTEGER     DEFAULT 1 CHECK (pax_adult >= 0),
  pax_child         INTEGER     DEFAULT 0 CHECK (pax_child >= 0),
  pax_infant        INTEGER     DEFAULT 0 CHECK (pax_infant >= 0),
  budget            NUMERIC(12,2),
  currency          TEXT        NOT NULL DEFAULT 'TRY',
  notes             TEXT,
  -- Staff
  assigned_to       UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_by        UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  -- Outcome
  lost_reason       TEXT        CHECK (lost_reason IN (
                                  'price','no_response','competitor',
                                  'date_change','cancelled','other'
                                )),
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.leads             IS 'Incoming sales leads and enquiries.';
COMMENT ON COLUMN public.leads.lead_number IS 'Human-readable reference, e.g. LEAD-2026-0042.';
COMMENT ON COLUMN public.leads.status      IS 'new | contacted | quote_sent | quote_approved | won | lost | on_hold';

CREATE INDEX IF NOT EXISTS idx_leads_customer_id   ON public.leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_status        ON public.leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to   ON public.leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_source_id     ON public.leads(source_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at    ON public.leads(created_at DESC);

CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Staff can read all leads"
--   ON public.leads FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Staff can create leads"
--   ON public.leads FOR INSERT TO authenticated WITH CHECK (TRUE);
-- CREATE POLICY "Staff can update their assigned leads or admin can update all"
--   ON public.leads FOR UPDATE TO authenticated
--   USING (assigned_to = auth.uid()
--     OR EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role = 'admin'));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 5: tours
-- Tour product catalog. Referenced by quotes and reservations.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tours (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  description    TEXT,
  category       TEXT        CHECK (category IN (
                               'cultural','nature','sea','religious',
                               'city','custom','transfer','other'
                             )),
  destination    TEXT,
  duration_days  INTEGER     CHECK (duration_days > 0),
  duration_text  TEXT,       -- human-readable, e.g. "8 Saat" or "3 Gün 2 Gece"
  base_price     NUMERIC(12,2),
  currency       TEXT        NOT NULL DEFAULT 'EUR',
  pricing_type   TEXT        NOT NULL DEFAULT 'per_person'
                             CHECK (pricing_type IN ('per_person','flat','group')),
  -- Pricing tiers for per_person type (stored as JSON: {"1":180,"2":240,...})
  pricing_tiers  JSONB,
  -- Operational fields
  requires_guide    BOOLEAN  DEFAULT TRUE,
  requires_vehicle  BOOLEAN  DEFAULT TRUE,
  requires_pickup   BOOLEAN  DEFAULT TRUE,
  included_items    TEXT[],  -- e.g. {"Guide","Entrance Tickets","Lunch"}
  excluded_items    TEXT[],  -- e.g. {"Personal Expenses","Tips"}
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_by     UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.tours                IS 'Tour product catalog — referenced by quotes and reservations.';
COMMENT ON COLUMN public.tours.pricing_tiers  IS 'JSON map of pax count → price, e.g. {"1":180,"2":240}. Used when pricing_type=per_person.';
COMMENT ON COLUMN public.tours.is_active      IS 'Set false to archive; never delete.';

CREATE INDEX IF NOT EXISTS idx_tours_is_active ON public.tours(is_active);
CREATE INDEX IF NOT EXISTS idx_tours_category  ON public.tours(category);

-- Add FK from leads.tour_id now that tours table exists
ALTER TABLE public.leads
  ADD CONSTRAINT fk_leads_tour_id
  FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE SET NULL;

CREATE TRIGGER trg_tours_updated_at
  BEFORE UPDATE ON public.tours
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.tours ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "All staff can read tours"
--   ON public.tours FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Admin and operations can manage tours"
--   ON public.tours FOR ALL TO authenticated
--   USING (EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role IN ('admin','operations')));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 6: quotes
-- Price proposals sent to customers.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quotes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number     TEXT        NOT NULL UNIQUE, -- e.g. Q-2026-031
  lead_id          UUID        NOT NULL REFERENCES public.leads(id) ON DELETE RESTRICT,
  customer_id      UUID        NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  status           TEXT        NOT NULL DEFAULT 'draft'
                               CHECK (status IN (
                                 'draft','sent','approved','rejected','expired','cancelled'
                               )),
  currency         TEXT        NOT NULL DEFAULT 'EUR',
  subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount  NUMERIC(12,2) DEFAULT 0,
  tax_rate         NUMERIC(5,2)  DEFAULT 0,
  tax_amount       NUMERIC(12,2) DEFAULT 0,
  total_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  deposit_required NUMERIC(12,2),
  deposit_pct      NUMERIC(5,2)  DEFAULT 25,  -- e.g. 25 = 25%
  valid_until      DATE,
  notes            TEXT,
  internal_notes   TEXT,
  sent_at          TIMESTAMPTZ,
  approved_at      TIMESTAMPTZ,
  created_by       UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.quotes               IS 'Price proposals linked to leads and customers.';
COMMENT ON COLUMN public.quotes.quote_number  IS 'Human-readable reference, e.g. Q-2026-031.';
COMMENT ON COLUMN public.quotes.deposit_pct   IS 'Percentage of total required as deposit (e.g. 25 = 25%).';

CREATE INDEX IF NOT EXISTS idx_quotes_lead_id     ON public.quotes(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotes_customer_id ON public.quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status      ON public.quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_created_at  ON public.quotes(created_at DESC);

CREATE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Staff can read all quotes"
--   ON public.quotes FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Sales and admin can create/update quotes"
--   ON public.quotes FOR ALL TO authenticated
--   USING (EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role IN ('admin','sales')));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 7: quote_items
-- Line items within a quote (tour, transfer, accommodation, etc.)
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quote_items (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id     UUID        NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  tour_id      UUID        REFERENCES public.tours(id) ON DELETE SET NULL,
  item_type    TEXT        NOT NULL DEFAULT 'tour'
                           CHECK (item_type IN (
                             'accommodation','tour','transfer','flight','meal',
                             'guide','entrance_fee','insurance','extra','discount','other'
                           )),
  description  TEXT        NOT NULL,
  quantity     INTEGER     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency     TEXT        NOT NULL DEFAULT 'EUR',
  sort_order   INTEGER     DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.quote_items          IS 'Individual line items within a quote.';
COMMENT ON COLUMN public.quote_items.tour_id  IS 'NULL for non-tour line items (transfers, fees, etc.).';

CREATE INDEX IF NOT EXISTS idx_quote_items_quote_id ON public.quote_items(quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_items_tour_id  ON public.quote_items(tour_id);

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.quote_items ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Staff can read quote items"
--   ON public.quote_items FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Sales and admin can manage quote items"
--   ON public.quote_items FOR ALL TO authenticated
--   USING (EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role IN ('admin','sales')));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 8: reservations
-- Confirmed bookings. Created from an approved quote or directly.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reservations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_number   TEXT        NOT NULL UNIQUE, -- e.g. R-2026-018
  lead_id              UUID        REFERENCES public.leads(id) ON DELETE SET NULL,
  quote_id             UUID        REFERENCES public.quotes(id) ON DELETE SET NULL,
  customer_id          UUID        NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  tour_id              UUID        REFERENCES public.tours(id) ON DELETE SET NULL,
  status               TEXT        NOT NULL DEFAULT 'pending_confirmation'
                                   CHECK (status IN (
                                     'pending_confirmation','confirmed','in_progress',
                                     'completed','cancelled'
                                   )),
  payment_status       TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (payment_status IN (
                                     'pending','deposit_paid','partial','paid','overdue','refunded'
                                   )),
  destination          TEXT,
  check_in             DATE        NOT NULL,
  check_out            DATE        NOT NULL,
  check_in_time        TIME,                  -- pickup/meeting time on check_in day
  pax_adult            INTEGER     NOT NULL DEFAULT 1 CHECK (pax_adult > 0),
  pax_child            INTEGER     DEFAULT 0 CHECK (pax_child >= 0),
  pax_infant           INTEGER     DEFAULT 0 CHECK (pax_infant >= 0),
  -- Operational details
  guide_name           TEXT,                  -- assigned guide full name
  vehicle_info         TEXT,                  -- e.g. "Mercedes Vito · 34 ABC 123"
  driver_name          TEXT,
  pickup_location      TEXT,
  pickup_time          TIME,
  -- Financials
  total_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency             TEXT         NOT NULL DEFAULT 'EUR',
  deposit_amount       NUMERIC(12,2),
  deposit_due_date     DATE,
  balance_due_date     DATE,
  -- Accommodation
  hotel_name           TEXT,
  hotel_confirmation   TEXT,
  -- Notes
  notes                TEXT,
  internal_notes       TEXT,
  -- Timestamps
  confirmed_at         TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  cancel_reason        TEXT,
  assigned_to          UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_by           UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Constraint: check_out must be >= check_in
  CONSTRAINT chk_reservation_dates CHECK (check_out >= check_in)
);

COMMENT ON TABLE  public.reservations                      IS 'Confirmed travel bookings.';
COMMENT ON COLUMN public.reservations.reservation_number   IS 'Human-readable reference, e.g. R-2026-018.';
COMMENT ON COLUMN public.reservations.payment_status       IS 'pending | deposit_paid | partial | paid | overdue | refunded';
COMMENT ON COLUMN public.reservations.guide_name           IS 'Assigned guide name — will become guide_id FK in V2 when guide management is added.';

CREATE INDEX IF NOT EXISTS idx_reservations_customer_id  ON public.reservations(customer_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status       ON public.reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_payment_status ON public.reservations(payment_status);
CREATE INDEX IF NOT EXISTS idx_reservations_check_in     ON public.reservations(check_in);
CREATE INDEX IF NOT EXISTS idx_reservations_assigned_to  ON public.reservations(assigned_to);
CREATE INDEX IF NOT EXISTS idx_reservations_lead_id      ON public.reservations(lead_id);
CREATE INDEX IF NOT EXISTS idx_reservations_created_at   ON public.reservations(created_at DESC);

CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "All staff can read reservations"
--   ON public.reservations FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Operations and admin can manage reservations"
--   ON public.reservations FOR ALL TO authenticated
--   USING (EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role IN ('admin','reservations','operations')));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 9: payments
-- Payment records linked to reservations.
-- Deposits, balances, and refunds are separate rows.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number   TEXT        NOT NULL UNIQUE, -- e.g. PAY-2026-055
  reservation_id   UUID        NOT NULL REFERENCES public.reservations(id) ON DELETE RESTRICT,
  customer_id      UUID        NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  payment_type     TEXT        NOT NULL DEFAULT 'deposit'
                               CHECK (payment_type IN ('deposit','balance','full','extra','refund')),
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','paid','overdue','cancelled','refunded')),
  amount           NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency         TEXT        NOT NULL DEFAULT 'EUR',
  method           TEXT        CHECK (method IN ('cash','bank_transfer','credit_card','online','wise','paypal','other')),
  due_date         DATE,
  paid_at          TIMESTAMPTZ,
  reference_number TEXT,       -- bank transfer ref, card last 4, etc.
  notes            TEXT,
  created_by       UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.payments               IS 'Payment records. Each deposit/balance/refund is a separate row.';
COMMENT ON COLUMN public.payments.payment_number IS 'Human-readable reference, e.g. PAY-2026-055.';
COMMENT ON COLUMN public.payments.customer_id   IS 'Denormalized for fast customer payment queries.';

CREATE INDEX IF NOT EXISTS idx_payments_reservation_id ON public.payments(reservation_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer_id    ON public.payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_status         ON public.payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_due_date       ON public.payments(due_date);
CREATE INDEX IF NOT EXISTS idx_payments_created_at     ON public.payments(created_at DESC);

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "All staff can read payments"
--   ON public.payments FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Admin and operations can manage payments"
--   ON public.payments FOR ALL TO authenticated
--   USING (EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role IN ('admin','operations','reservations')));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 10: tasks
-- Team tasks. Optionally linked to leads, reservations, or customers.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tasks (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT        NOT NULL,
  description    TEXT,
  status         TEXT        NOT NULL DEFAULT 'todo'
                             CHECK (status IN ('todo','in_progress','done','cancelled')),
  priority       TEXT        NOT NULL DEFAULT 'medium'
                             CHECK (priority IN ('low','medium','high','urgent')),
  category       TEXT,       -- e.g. 'payment', 'guide', 'pickup', 'quote'
  -- Optional links (all nullable — a task doesn't need to be linked)
  assigned_to    UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  lead_id        UUID        REFERENCES public.leads(id) ON DELETE SET NULL,
  reservation_id UUID        REFERENCES public.reservations(id) ON DELETE SET NULL,
  customer_id    UUID        REFERENCES public.customers(id) ON DELETE SET NULL,
  -- Timing
  due_date       DATE,
  due_time       TIME,
  completed_at   TIMESTAMPTZ,
  notes          TEXT,
  created_by     UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.tasks        IS 'Team tasks. Any combination of lead/reservation/customer links is valid.';
COMMENT ON COLUMN public.tasks.status IS 'todo | in_progress | done | cancelled';

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to    ON public.tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status         ON public.tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority       ON public.tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date       ON public.tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_customer_id    ON public.tasks(customer_id);
CREATE INDEX IF NOT EXISTS idx_tasks_reservation_id ON public.tasks(reservation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_lead_id        ON public.tasks(lead_id);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Staff can read all tasks"
--   ON public.tasks FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Staff can manage their own tasks; admin can manage all"
--   ON public.tasks FOR ALL TO authenticated
--   USING (assigned_to = auth.uid()
--     OR created_by = auth.uid()
--     OR EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role = 'admin'));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 11: reminders
-- Date/time-based reminders shown on dashboard.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reminders (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT        NOT NULL,
  description    TEXT,
  remind_at      TIMESTAMPTZ NOT NULL,
  priority       TEXT        NOT NULL DEFAULT 'medium'
                             CHECK (priority IN ('low','medium','high','urgent')),
  type           TEXT,       -- 'payment_follow_up', 'tour_reminder', 'guide_assignment', etc.
  source         TEXT        NOT NULL DEFAULT 'manual'
                             CHECK (source IN ('manual','auto')),
  is_done        BOOLEAN     NOT NULL DEFAULT FALSE,
  done_at        TIMESTAMPTZ,
  -- Optional links
  lead_id        UUID        REFERENCES public.leads(id) ON DELETE SET NULL,
  reservation_id UUID        REFERENCES public.reservations(id) ON DELETE SET NULL,
  customer_id    UUID        REFERENCES public.customers(id) ON DELETE SET NULL,
  assigned_to    UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_by     UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.reminders        IS 'Date-based reminders shown on dashboard.';
COMMENT ON COLUMN public.reminders.source IS 'manual = created by staff; auto = triggered by system rule.';

CREATE INDEX IF NOT EXISTS idx_reminders_assigned_to    ON public.reminders(assigned_to);
CREATE INDEX IF NOT EXISTS idx_reminders_remind_at      ON public.reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_is_done        ON public.reminders(is_done);
CREATE INDEX IF NOT EXISTS idx_reminders_reservation_id ON public.reminders(reservation_id);
CREATE INDEX IF NOT EXISTS idx_reminders_customer_id    ON public.reminders(customer_id);

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Staff can read reminders assigned to them or all if admin"
--   ON public.reminders FOR SELECT TO authenticated
--   USING (assigned_to = auth.uid()
--     OR EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role = 'admin'));
-- CREATE POLICY "Staff can create and manage reminders"
--   ON public.reminders FOR ALL TO authenticated
--   USING (created_by = auth.uid()
--     OR EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role = 'admin'));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 12: activity_logs
-- Immutable append-only audit trail. Never updated or deleted.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT        NOT NULL
               CHECK (entity_type IN (
                 'customer','lead','quote','reservation','payment',
                 'task','reminder','tour','message','settings'
               )),
  entity_id    UUID        NOT NULL,  -- no FK constraint — entity may be deleted
  action       TEXT        NOT NULL
               CHECK (action IN (
                 'created','updated','status_changed','deleted','note_added',
                 'assigned','payment_received','quote_sent','quote_approved',
                 'reservation_confirmed','converted','completed','cancelled',
                 'call','reply','deposit','task','login','export'
               )),
  description  TEXT        NOT NULL,  -- Turkish human-readable summary
  old_value    JSONB,                 -- state before change
  new_value    JSONB,                 -- state after change
  metadata     JSONB,                 -- V2: webhook source, IP, channel, etc.
  performed_by UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NOTE: No updated_at — this table is append-only
);

COMMENT ON TABLE  public.activity_logs             IS 'Append-only audit log. Never update or delete rows.';
COMMENT ON COLUMN public.activity_logs.entity_id   IS 'References the affected record. No FK — entity may be deleted.';
COMMENT ON COLUMN public.activity_logs.old_value   IS 'JSON snapshot before change (optional, used for status_changed etc.).';
COMMENT ON COLUMN public.activity_logs.metadata    IS 'V2: webhook source, API channel, device, IP.';

-- Critical: activity_logs is high-volume — proper indexing is essential
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity      ON public.activity_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_performed_by ON public.activity_logs(performed_by);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at  ON public.activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action      ON public.activity_logs(action);

-- Prevent updates and deletes (activity logs are immutable)
CREATE OR REPLACE RULE activity_logs_no_delete AS ON DELETE TO public.activity_logs DO INSTEAD NOTHING;
CREATE OR REPLACE RULE activity_logs_no_update AS ON UPDATE TO public.activity_logs DO INSTEAD NOTHING;

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "All authenticated staff can read activity logs"
--   ON public.activity_logs FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Only service role can insert activity logs"
--   ON public.activity_logs FOR INSERT TO service_role WITH CHECK (TRUE);
-- NOTE: writes should go through a trusted server-side function, not direct client insert.


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 13: settings
-- System-wide key-value configuration store.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.settings (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT        NOT NULL UNIQUE,
  value        TEXT        NOT NULL,
  value_type   TEXT        NOT NULL DEFAULT 'string'
               CHECK (value_type IN ('string','number','boolean','json')),
  label        TEXT,
  description  TEXT,
  is_public    BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_by   UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.settings          IS 'System-wide configuration. Key-value store.';
COMMENT ON COLUMN public.settings.is_public IS 'true = readable by all authenticated users; false = admin only.';

CREATE TRIGGER trg_settings_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "All staff can read public settings"
--   ON public.settings FOR SELECT TO authenticated USING (is_public = TRUE);
-- CREATE POLICY "Only admin can read all settings"
--   ON public.settings FOR SELECT TO authenticated
--   USING (EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role = 'admin'));
-- CREATE POLICY "Only admin can update settings"
--   ON public.settings FOR UPDATE TO authenticated
--   USING (EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role = 'admin'));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 14: message_threads
-- Conversation threads per customer per channel.
-- One thread = one customer + one channel combination.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.message_threads (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID        REFERENCES public.customers(id) ON DELETE SET NULL,
  channel      TEXT        NOT NULL
               CHECK (channel IN ('whatsapp','email','instagram','facebook','booking','tripadvisor','phone','other')),
  subject      TEXT,
  status       TEXT        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','closed','archived')),
  unread_count INTEGER     NOT NULL DEFAULT 0,
  -- Optional links
  lead_id      UUID        REFERENCES public.leads(id) ON DELETE SET NULL,
  quote_id     UUID        REFERENCES public.quotes(id) ON DELETE SET NULL,
  reservation_id UUID      REFERENCES public.reservations(id) ON DELETE SET NULL,
  -- Metadata
  external_thread_id TEXT, -- V2: WhatsApp conversation ID, Gmail thread ID, etc.
  last_message_at  TIMESTAMPTZ,
  last_message_preview TEXT,
  assigned_to  UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.message_threads                    IS 'One thread per customer per channel combination.';
COMMENT ON COLUMN public.message_threads.external_thread_id IS 'V2: WhatsApp conversation ID, Gmail thread ID, etc.';
COMMENT ON COLUMN public.message_threads.channel            IS 'whatsapp | email | instagram | facebook | booking | tripadvisor | phone | other';

CREATE INDEX IF NOT EXISTS idx_threads_customer_id      ON public.message_threads(customer_id);
CREATE INDEX IF NOT EXISTS idx_threads_channel          ON public.message_threads(channel);
CREATE INDEX IF NOT EXISTS idx_threads_status           ON public.message_threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_last_message_at  ON public.message_threads(last_message_at DESC);

CREATE TRIGGER trg_message_threads_updated_at
  BEFORE UPDATE ON public.message_threads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.message_threads ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "All staff can read message threads"
--   ON public.message_threads FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Staff can update assigned threads; admin can update all"
--   ON public.message_threads FOR UPDATE TO authenticated
--   USING (assigned_to = auth.uid()
--     OR EXISTS (SELECT 1 FROM staff_users WHERE id = auth.uid() AND role = 'admin'));


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE 15: messages
-- Individual messages within a thread.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.messages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     UUID        NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  direction     TEXT        NOT NULL DEFAULT 'inbound'
                CHECK (direction IN ('inbound','outbound','note')),
  body          TEXT        NOT NULL,
  -- Sender info
  sender_name   TEXT,       -- customer name (inbound) or staff name (outbound)
  sender_type   TEXT        CHECK (sender_type IN ('customer','staff','system')),
  staff_id      UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  -- Channel metadata (V2)
  external_id   TEXT,       -- WhatsApp message ID, Gmail message ID, etc.
  channel_meta  JSONB,      -- V2: delivery status, read receipts, attachments, etc.
  -- Status
  is_read       BOOLEAN     NOT NULL DEFAULT FALSE,
  read_at       TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.messages               IS 'Individual messages within a conversation thread.';
COMMENT ON COLUMN public.messages.direction     IS 'inbound = from customer; outbound = from staff; note = internal note.';
COMMENT ON COLUMN public.messages.external_id   IS 'V2: channel-specific message ID for deduplication.';
COMMENT ON COLUMN public.messages.channel_meta  IS 'V2: delivery receipts, attachment URLs, reaction data.';

CREATE INDEX IF NOT EXISTS idx_messages_thread_id  ON public.messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_direction  ON public.messages(direction);
CREATE INDEX IF NOT EXISTS idx_messages_is_read    ON public.messages(is_read);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON public.messages(created_at DESC);

-- RLS PLACEHOLDER — enable in Step 2
-- ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "All staff can read messages"
--   ON public.messages FOR SELECT TO authenticated USING (TRUE);
-- CREATE POLICY "Staff can insert outbound messages and notes"
--   ON public.messages FOR INSERT TO authenticated
--   WITH CHECK (direction IN ('outbound','note') AND staff_id = auth.uid());
-- NOTE: inbound messages should be inserted via service_role (webhook handlers).


-- ──────────────────────────────────────────────────────────────────────────
-- SEED DATA
-- Initial reference data required for the application to function.
-- ──────────────────────────────────────────────────────────────────────────

-- Sources (acquisition channels)
INSERT INTO public.sources (id, name, slug, is_active) VALUES
  (gen_random_uuid(), 'WhatsApp',    'whatsapp',    TRUE),
  (gen_random_uuid(), 'Telefon',     'phone',       TRUE),
  (gen_random_uuid(), 'Instagram',   'instagram',   TRUE),
  (gen_random_uuid(), 'Facebook',    'facebook',    TRUE),
  (gen_random_uuid(), 'Web Sitesi',  'website',     TRUE),
  (gen_random_uuid(), 'E-posta',     'email',       TRUE),
  (gen_random_uuid(), 'Booking.com', 'booking',     TRUE),
  (gen_random_uuid(), 'Tripadvisor', 'tripadvisor', TRUE),
  (gen_random_uuid(), 'Referans',    'referral',    TRUE),
  (gen_random_uuid(), 'Yüz Yüze',   'in_person',   TRUE),
  (gen_random_uuid(), 'Manuel',      'manual',      TRUE),
  (gen_random_uuid(), 'Diğer',       'other',       TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Settings (system configuration)
INSERT INTO public.settings (key, value, value_type, label, description, is_public) VALUES
  ('default_currency',     'EUR',            'string',  'Varsayılan Para Birimi',  'Teklif ve rezervasyonlarda kullanılan varsayılan para birimi',  TRUE),
  ('default_language',     'tr',             'string',  'Varsayılan Dil',          'Uygulama dili',                                                TRUE),
  ('company_name',         'Dese Tour',      'string',  'Şirket Adı',              'Tekliflerde ve belgelerde görünen şirket adı',                  TRUE),
  ('company_email',        '',               'string',  'Şirket E-postası',        'Gönderilen e-postalarda görünen adres',                        FALSE),
  ('company_phone',        '',               'string',  'Şirket Telefonu',         'İletişim bilgileri',                                           FALSE),
  ('company_address',      '',               'string',  'Şirket Adresi',           'Teklif ve fatura alt bilgisi',                                 FALSE),
  ('company_website',      'www.desetour.com','string', 'Web Sitesi',              'Şirket web sitesi',                                            TRUE),
  ('tax_rate',             '20',             'number',  'KDV Oranı',               'Varsayılan KDV oranı (%)',                                     FALSE),
  ('deposit_percentage',   '25',             'number',  'Kapora Yüzdesi',          'Varsayılan kapora oranı (%)',                                  FALSE),
  ('quote_validity_days',  '14',             'number',  'Teklif Geçerlilik Süresi','Tekliflerin varsayılan geçerlilik süresi (gün)',                FALSE),
  ('date_format',          'DD.MM.YYYY',     'string',  'Tarih Formatı',           'Arayüzde kullanılan tarih gösterimi',                          TRUE),
  ('timezone',             'Europe/Istanbul','string',  'Saat Dilimi',             'Uygulama saat dilimi',                                        TRUE),
  ('working_hours_start',  '09:00',          'string',  'Çalışma Saati Başlangıç','Mesai başlangıç saati',                                        FALSE),
  ('working_hours_end',    '18:00',          'string',  'Çalışma Saati Bitiş',    'Mesai bitiş saati',                                            FALSE),
  ('pdf_template',         'premium',        'string',  'PDF Şablonu',             'Teklif PDF şablonu: premium | minimal | classic',              FALSE)
ON CONFLICT (key) DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────
-- HELPER FUNCTION: auto-generate human-readable reference numbers
-- Usage: SELECT next_ref_number('LEAD', 'leads', 'lead_number');
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.next_ref_number(
  prefix      TEXT,
  table_name  TEXT,
  number_col  TEXT
) RETURNS TEXT AS $$
DECLARE
  year_str TEXT := TO_CHAR(NOW(), 'YYYY');
  pattern  TEXT;
  last_num INTEGER;
  next_num INTEGER;
BEGIN
  pattern := prefix || '-' || year_str || '-%';
  EXECUTE format(
    'SELECT COALESCE(MAX(CAST(SPLIT_PART(%I, ''-'', 3) AS INTEGER)), 0) FROM %I WHERE %I LIKE %L',
    number_col, table_name, number_col, pattern
  ) INTO last_num;
  next_num := last_num + 1;
  RETURN prefix || '-' || year_str || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.next_ref_number IS
  'Generates sequential human-readable IDs like LEAD-2026-0042. '
  'Called at the application layer before INSERT.';

-- ── END OF SCHEMA ──────────────────────────────────────────────────────────
