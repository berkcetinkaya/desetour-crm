-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK for: supabase_migration_aal2_enforcement.sql
-- ============================================================
-- File:    supabase_migration_aal2_enforcement_ROLLBACK.sql
-- Restores every policy this migration touched to its EXACT pre-migration
-- text (copied verbatim from supabase_rls_policies.sql and the other
-- migration files' RLS sections), drops public.is_aal2() itself, restores
-- get_current_staff_role() to its exact original body (no is_active
-- filter), and drops the staff_users self-update column guard trigger and
-- its function (STEP 1b / STEP 2b in the forward migration).
--
-- Applying migration then rollback must leave RLS behavior byte-for-byte
-- identical to never having applied the migration at all — validated in
-- the disposable local PostgreSQL sandbox (see implementation report).
--
-- NOT executed against production by this phase; apply by hand after
-- review, and only ever as a deliberate revert of
-- supabase_migration_aal2_enforcement.sql.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 3 (processed in the same table order as the forward
-- migration, for easy side-by-side diffing) — restore each policy's exact
-- original USING/WITH CHECK clause with is_aal2() removed.
-- ──────────────────────────────────────────────────────────────────────────

-- sources
DROP POLICY IF EXISTS "sources: all staff read" ON public.sources;
CREATE POLICY "sources: all staff read" ON public.sources FOR SELECT TO authenticated USING ( is_staff() );
DROP POLICY IF EXISTS "sources: admin write" ON public.sources;
CREATE POLICY "sources: admin write" ON public.sources FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );

-- customers
DROP POLICY IF EXISTS "customers: admin full access" ON public.customers;
CREATE POLICY "customers: admin full access" ON public.customers FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "customers: sales read all" ON public.customers;
CREATE POLICY "customers: sales read all" ON public.customers FOR SELECT TO authenticated USING ( is_sales() AND is_active = TRUE );
DROP POLICY IF EXISTS "customers: sales write" ON public.customers;
CREATE POLICY "customers: sales write" ON public.customers FOR INSERT TO authenticated WITH CHECK ( is_sales() );
DROP POLICY IF EXISTS "customers: sales update" ON public.customers;
CREATE POLICY "customers: sales update" ON public.customers FOR UPDATE TO authenticated USING ( is_sales() ) WITH CHECK ( is_sales() );
DROP POLICY IF EXISTS "customers: operations read" ON public.customers;
CREATE POLICY "customers: operations read" ON public.customers FOR SELECT TO authenticated USING ( is_operations() AND is_active = TRUE );
DROP POLICY IF EXISTS "customers: guide reads assigned customers" ON public.customers;
CREATE POLICY "customers: guide reads assigned customers" ON public.customers FOR SELECT TO authenticated
  USING ( is_guide() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.customer_id = customers.id AND r.assigned_to = auth.uid() AND r.status NOT IN ('cancelled')) );

-- leads
DROP POLICY IF EXISTS "leads: admin full access" ON public.leads;
CREATE POLICY "leads: admin full access" ON public.leads FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "leads: sales read all" ON public.leads;
CREATE POLICY "leads: sales read all" ON public.leads FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "leads: sales write" ON public.leads;
CREATE POLICY "leads: sales write" ON public.leads FOR INSERT TO authenticated WITH CHECK ( is_sales() );
DROP POLICY IF EXISTS "leads: sales update own or assigned" ON public.leads;
CREATE POLICY "leads: sales update own or assigned" ON public.leads FOR UPDATE TO authenticated
  USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) )
  WITH CHECK ( is_sales() );
DROP POLICY IF EXISTS "leads: operations read" ON public.leads;
CREATE POLICY "leads: operations read" ON public.leads FOR SELECT TO authenticated USING ( is_operations() );

-- tours
DROP POLICY IF EXISTS "tours: admin full access" ON public.tours;
CREATE POLICY "tours: admin full access" ON public.tours FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "tours: sales read active" ON public.tours;
CREATE POLICY "tours: sales read active" ON public.tours FOR SELECT TO authenticated USING ( is_sales() AND is_active = TRUE );
DROP POLICY IF EXISTS "tours: operations read all" ON public.tours;
CREATE POLICY "tours: operations read all" ON public.tours FOR SELECT TO authenticated USING ( is_operations() );
DROP POLICY IF EXISTS "tours: operations write" ON public.tours;
CREATE POLICY "tours: operations write" ON public.tours FOR INSERT TO authenticated WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "tours: operations update" ON public.tours;
CREATE POLICY "tours: operations update" ON public.tours FOR UPDATE TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "tours: guide reads assigned tour" ON public.tours;
CREATE POLICY "tours: guide reads assigned tour" ON public.tours FOR SELECT TO authenticated
  USING ( is_guide() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.tour_id = tours.id AND r.assigned_to = auth.uid()) );

-- quotes
DROP POLICY IF EXISTS "quotes: admin full access" ON public.quotes;
CREATE POLICY "quotes: admin full access" ON public.quotes FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "quotes: sales read all" ON public.quotes;
CREATE POLICY "quotes: sales read all" ON public.quotes FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "quotes: sales insert" ON public.quotes;
CREATE POLICY "quotes: sales insert" ON public.quotes FOR INSERT TO authenticated WITH CHECK ( is_sales() AND created_by = auth.uid() );
DROP POLICY IF EXISTS "quotes: sales update own" ON public.quotes;
CREATE POLICY "quotes: sales update own" ON public.quotes FOR UPDATE TO authenticated
  USING ( is_sales() AND (created_by = auth.uid() OR assigned_to = auth.uid()) )
  WITH CHECK ( is_sales() AND (created_by = auth.uid() OR assigned_to = auth.uid()) );
DROP POLICY IF EXISTS "quotes: operations read" ON public.quotes;
CREATE POLICY "quotes: operations read" ON public.quotes FOR SELECT TO authenticated USING ( is_operations() );

-- quote_items
DROP POLICY IF EXISTS "quote_items: admin full access" ON public.quote_items;
CREATE POLICY "quote_items: admin full access" ON public.quote_items FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "quote_items: sales via quote" ON public.quote_items;
CREATE POLICY "quote_items: sales via quote" ON public.quote_items FOR SELECT TO authenticated
  USING ( is_sales() AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_items.quote_id) );
DROP POLICY IF EXISTS "quote_items: sales write via quote" ON public.quote_items;
CREATE POLICY "quote_items: sales write via quote" ON public.quote_items FOR INSERT TO authenticated
  WITH CHECK ( is_sales() AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_items.quote_id AND (q.created_by = auth.uid() OR q.assigned_to = auth.uid())) );
DROP POLICY IF EXISTS "quote_items: sales update via quote" ON public.quote_items;
CREATE POLICY "quote_items: sales update via quote" ON public.quote_items FOR UPDATE TO authenticated
  USING ( is_sales() AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_items.quote_id AND (q.created_by = auth.uid() OR q.assigned_to = auth.uid())) );
DROP POLICY IF EXISTS "quote_items: operations read" ON public.quote_items;
CREATE POLICY "quote_items: operations read" ON public.quote_items FOR SELECT TO authenticated USING ( is_operations() );

-- reservations
DROP POLICY IF EXISTS "reservations: admin full access" ON public.reservations;
CREATE POLICY "reservations: admin full access" ON public.reservations FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "reservations: sales read" ON public.reservations;
CREATE POLICY "reservations: sales read" ON public.reservations FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "reservations: operations read all" ON public.reservations;
CREATE POLICY "reservations: operations read all" ON public.reservations FOR SELECT TO authenticated USING ( is_operations() );
DROP POLICY IF EXISTS "reservations: operations insert" ON public.reservations;
CREATE POLICY "reservations: operations insert" ON public.reservations FOR INSERT TO authenticated WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "reservations: operations update" ON public.reservations;
CREATE POLICY "reservations: operations update" ON public.reservations FOR UPDATE TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "reservations: guide reads assigned" ON public.reservations;
CREATE POLICY "reservations: guide reads assigned" ON public.reservations FOR SELECT TO authenticated
  USING ( is_guide() AND assigned_to = auth.uid() AND status NOT IN ('cancelled') );
DROP POLICY IF EXISTS "reservations: guide update own status" ON public.reservations;
CREATE POLICY "reservations: guide update own status" ON public.reservations FOR UPDATE TO authenticated
  USING ( is_guide() AND assigned_to = auth.uid() )
  WITH CHECK ( is_guide() AND assigned_to = auth.uid() );

-- payments
DROP POLICY IF EXISTS "payments: admin full access" ON public.payments;
CREATE POLICY "payments: admin full access" ON public.payments FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "payments: sales read own" ON public.payments;
CREATE POLICY "payments: sales read own" ON public.payments FOR SELECT TO authenticated
  USING ( is_sales() AND EXISTS (SELECT 1 FROM public.leads l WHERE l.customer_id = payments.customer_id AND (l.assigned_to = auth.uid() OR l.created_by = auth.uid())) );
DROP POLICY IF EXISTS "payments: operations full access" ON public.payments;
CREATE POLICY "payments: operations full access" ON public.payments FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );

-- tasks
DROP POLICY IF EXISTS "tasks: admin full access" ON public.tasks;
CREATE POLICY "tasks: admin full access" ON public.tasks FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "tasks: sales own tasks" ON public.tasks;
CREATE POLICY "tasks: sales own tasks" ON public.tasks FOR SELECT TO authenticated USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) );
DROP POLICY IF EXISTS "tasks: sales insert" ON public.tasks;
CREATE POLICY "tasks: sales insert" ON public.tasks FOR INSERT TO authenticated WITH CHECK ( is_sales() AND created_by = auth.uid() );
DROP POLICY IF EXISTS "tasks: sales update own" ON public.tasks;
CREATE POLICY "tasks: sales update own" ON public.tasks FOR UPDATE TO authenticated
  USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) )
  WITH CHECK ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) );
DROP POLICY IF EXISTS "tasks: operations own tasks" ON public.tasks;
CREATE POLICY "tasks: operations own tasks" ON public.tasks FOR SELECT TO authenticated USING ( is_operations() AND (assigned_to = auth.uid() OR created_by = auth.uid()) );
DROP POLICY IF EXISTS "tasks: operations insert" ON public.tasks;
CREATE POLICY "tasks: operations insert" ON public.tasks FOR INSERT TO authenticated WITH CHECK ( is_operations() AND created_by = auth.uid() );
DROP POLICY IF EXISTS "tasks: operations update own" ON public.tasks;
CREATE POLICY "tasks: operations update own" ON public.tasks FOR UPDATE TO authenticated USING ( is_operations() AND (assigned_to = auth.uid() OR created_by = auth.uid()) );
DROP POLICY IF EXISTS "tasks: guide assigned tasks" ON public.tasks;
CREATE POLICY "tasks: guide assigned tasks" ON public.tasks FOR SELECT TO authenticated USING ( is_guide() AND assigned_to = auth.uid() );
DROP POLICY IF EXISTS "tasks: guide update assigned" ON public.tasks;
CREATE POLICY "tasks: guide update assigned" ON public.tasks FOR UPDATE TO authenticated
  USING ( is_guide() AND assigned_to = auth.uid() )
  WITH CHECK ( is_guide() AND assigned_to = auth.uid() );

-- reminders
DROP POLICY IF EXISTS "reminders: admin full access" ON public.reminders;
CREATE POLICY "reminders: admin full access" ON public.reminders FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "reminders: sales own" ON public.reminders;
CREATE POLICY "reminders: sales own" ON public.reminders FOR SELECT TO authenticated USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) );
DROP POLICY IF EXISTS "reminders: sales insert" ON public.reminders;
CREATE POLICY "reminders: sales insert" ON public.reminders FOR INSERT TO authenticated WITH CHECK ( is_sales() AND created_by = auth.uid() );
DROP POLICY IF EXISTS "reminders: sales update own" ON public.reminders;
CREATE POLICY "reminders: sales update own" ON public.reminders FOR UPDATE TO authenticated USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) );
DROP POLICY IF EXISTS "reminders: operations own" ON public.reminders;
CREATE POLICY "reminders: operations own" ON public.reminders FOR SELECT TO authenticated USING ( is_operations() AND (assigned_to = auth.uid() OR created_by = auth.uid()) );
DROP POLICY IF EXISTS "reminders: operations insert" ON public.reminders;
CREATE POLICY "reminders: operations insert" ON public.reminders FOR INSERT TO authenticated WITH CHECK ( is_operations() AND created_by = auth.uid() );
DROP POLICY IF EXISTS "reminders: operations update own" ON public.reminders;
CREATE POLICY "reminders: operations update own" ON public.reminders FOR UPDATE TO authenticated USING ( is_operations() AND (assigned_to = auth.uid() OR created_by = auth.uid()) );
DROP POLICY IF EXISTS "reminders: guide assigned" ON public.reminders;
CREATE POLICY "reminders: guide assigned" ON public.reminders FOR SELECT TO authenticated USING ( is_guide() AND assigned_to = auth.uid() );
DROP POLICY IF EXISTS "reminders: guide update assigned" ON public.reminders;
CREATE POLICY "reminders: guide update assigned" ON public.reminders FOR UPDATE TO authenticated USING ( is_guide() AND assigned_to = auth.uid() );

-- activity_logs
DROP POLICY IF EXISTS "activity_logs: admin read all" ON public.activity_logs;
CREATE POLICY "activity_logs: admin read all" ON public.activity_logs FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "activity_logs: sales read own" ON public.activity_logs;
CREATE POLICY "activity_logs: sales read own" ON public.activity_logs FOR SELECT TO authenticated USING ( is_sales() AND performed_by = auth.uid() );
DROP POLICY IF EXISTS "activity_logs: sales read system-generated reservation notifications" ON public.activity_logs;
CREATE POLICY "activity_logs: sales read system-generated reservation notifications" ON public.activity_logs FOR SELECT TO authenticated
  USING ( is_sales() AND entity_type = 'reservation' AND performed_by IS NULL AND metadata->>'auto_ingested' = 'true' );
DROP POLICY IF EXISTS "activity_logs: operations read own" ON public.activity_logs;
CREATE POLICY "activity_logs: operations read own" ON public.activity_logs FOR SELECT TO authenticated
  USING ( is_operations() AND (performed_by = auth.uid() OR entity_type IN ('reservation', 'payment', 'tour')) );
DROP POLICY IF EXISTS "activity_logs: guide read own" ON public.activity_logs;
CREATE POLICY "activity_logs: guide read own" ON public.activity_logs FOR SELECT TO authenticated USING ( is_guide() AND performed_by = auth.uid() );
DROP POLICY IF EXISTS "activity_logs: all staff insert" ON public.activity_logs;
CREATE POLICY "activity_logs: all staff insert" ON public.activity_logs FOR INSERT TO authenticated WITH CHECK ( is_staff() AND performed_by = auth.uid() );

-- settings
DROP POLICY IF EXISTS "settings: all staff read public" ON public.settings;
CREATE POLICY "settings: all staff read public" ON public.settings FOR SELECT TO authenticated USING ( is_staff() AND is_public = TRUE );
DROP POLICY IF EXISTS "settings: admin read all" ON public.settings;
CREATE POLICY "settings: admin read all" ON public.settings FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "settings: admin write" ON public.settings;
CREATE POLICY "settings: admin write" ON public.settings FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );

-- message_threads
DROP POLICY IF EXISTS "message_threads: admin full access" ON public.message_threads;
CREATE POLICY "message_threads: admin full access" ON public.message_threads FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "message_threads: sales read assigned or open" ON public.message_threads;
CREATE POLICY "message_threads: sales read assigned or open" ON public.message_threads FOR SELECT TO authenticated
  USING ( is_sales() AND (assigned_to = auth.uid() OR assigned_to IS NULL) AND status = 'open' );
DROP POLICY IF EXISTS "message_threads: sales update assigned" ON public.message_threads;
CREATE POLICY "message_threads: sales update assigned" ON public.message_threads FOR UPDATE TO authenticated
  USING ( is_sales() AND (assigned_to = auth.uid() OR assigned_to IS NULL) )
  WITH CHECK ( is_sales() AND (assigned_to = auth.uid() OR assigned_to IS NULL) );
DROP POLICY IF EXISTS "message_threads: operations read assigned or open" ON public.message_threads;
CREATE POLICY "message_threads: operations read assigned or open" ON public.message_threads FOR SELECT TO authenticated
  USING ( is_operations() AND (assigned_to = auth.uid() OR assigned_to IS NULL) AND status = 'open' );
DROP POLICY IF EXISTS "message_threads: operations update assigned" ON public.message_threads;
CREATE POLICY "message_threads: operations update assigned" ON public.message_threads FOR UPDATE TO authenticated
  USING ( is_operations() AND (assigned_to = auth.uid() OR assigned_to IS NULL) );

-- messages
DROP POLICY IF EXISTS "messages: admin full access" ON public.messages;
CREATE POLICY "messages: admin full access" ON public.messages FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "messages: sales read via thread" ON public.messages;
CREATE POLICY "messages: sales read via thread" ON public.messages FOR SELECT TO authenticated
  USING ( is_sales() AND EXISTS (SELECT 1 FROM public.message_threads t WHERE t.id = messages.thread_id AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL) AND t.status = 'open') );
DROP POLICY IF EXISTS "messages: sales insert outbound" ON public.messages;
CREATE POLICY "messages: sales insert outbound" ON public.messages FOR INSERT TO authenticated
  WITH CHECK ( is_sales() AND direction = 'outbound' AND staff_id = auth.uid() AND EXISTS (SELECT 1 FROM public.message_threads t WHERE t.id = messages.thread_id AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL)) );
DROP POLICY IF EXISTS "messages: operations read via thread" ON public.messages;
CREATE POLICY "messages: operations read via thread" ON public.messages FOR SELECT TO authenticated
  USING ( is_operations() AND EXISTS (SELECT 1 FROM public.message_threads t WHERE t.id = messages.thread_id AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL) AND t.status = 'open') );
DROP POLICY IF EXISTS "messages: operations insert outbound" ON public.messages;
CREATE POLICY "messages: operations insert outbound" ON public.messages FOR INSERT TO authenticated
  WITH CHECK ( is_operations() AND direction = 'outbound' AND staff_id = auth.uid() );

-- guides
DROP POLICY IF EXISTS "guides: admin full access" ON public.guides;
CREATE POLICY "guides: admin full access" ON public.guides FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "guides: operations full access" ON public.guides;
CREATE POLICY "guides: operations full access" ON public.guides FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "guides: sales read" ON public.guides;
CREATE POLICY "guides: sales read" ON public.guides FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "guides: guide role read" ON public.guides;
CREATE POLICY "guides: guide role read" ON public.guides FOR SELECT TO authenticated USING ( is_guide() );

-- guide_languages
DROP POLICY IF EXISTS "guide_languages: admin full access" ON public.guide_languages;
CREATE POLICY "guide_languages: admin full access" ON public.guide_languages FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "guide_languages: operations full access" ON public.guide_languages;
CREATE POLICY "guide_languages: operations full access" ON public.guide_languages FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "guide_languages: sales read" ON public.guide_languages;
CREATE POLICY "guide_languages: sales read" ON public.guide_languages FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "guide_languages: guide role read" ON public.guide_languages;
CREATE POLICY "guide_languages: guide role read" ON public.guide_languages FOR SELECT TO authenticated USING ( is_guide() );

-- guide_payments
DROP POLICY IF EXISTS "guide_payments: admin full access" ON public.guide_payments;
CREATE POLICY "guide_payments: admin full access" ON public.guide_payments FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "guide_payments: operations full access" ON public.guide_payments;
CREATE POLICY "guide_payments: operations full access" ON public.guide_payments FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );

-- agencies
DROP POLICY IF EXISTS "agencies: admin select" ON public.agencies;
CREATE POLICY "agencies: admin select" ON public.agencies FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "agencies: admin insert" ON public.agencies;
CREATE POLICY "agencies: admin insert" ON public.agencies FOR INSERT TO authenticated WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "agencies: admin update" ON public.agencies;
CREATE POLICY "agencies: admin update" ON public.agencies FOR UPDATE TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "agencies: sales select" ON public.agencies;
CREATE POLICY "agencies: sales select" ON public.agencies FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "agencies: sales insert" ON public.agencies;
CREATE POLICY "agencies: sales insert" ON public.agencies FOR INSERT TO authenticated WITH CHECK ( is_sales() );
DROP POLICY IF EXISTS "agencies: sales update" ON public.agencies;
CREATE POLICY "agencies: sales update" ON public.agencies FOR UPDATE TO authenticated USING ( is_sales() ) WITH CHECK ( is_sales() );

-- agency_emails
DROP POLICY IF EXISTS "agency_emails: admin select" ON public.agency_emails;
CREATE POLICY "agency_emails: admin select" ON public.agency_emails FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "agency_emails: admin insert" ON public.agency_emails;
CREATE POLICY "agency_emails: admin insert" ON public.agency_emails FOR INSERT TO authenticated WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "agency_emails: admin update" ON public.agency_emails;
CREATE POLICY "agency_emails: admin update" ON public.agency_emails FOR UPDATE TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "agency_emails: sales select" ON public.agency_emails;
CREATE POLICY "agency_emails: sales select" ON public.agency_emails FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "agency_emails: sales insert" ON public.agency_emails;
CREATE POLICY "agency_emails: sales insert" ON public.agency_emails FOR INSERT TO authenticated WITH CHECK ( is_sales() );
DROP POLICY IF EXISTS "agency_emails: sales update" ON public.agency_emails;
CREATE POLICY "agency_emails: sales update" ON public.agency_emails FOR UPDATE TO authenticated USING ( is_sales() ) WITH CHECK ( is_sales() );

-- reservation_guests
DROP POLICY IF EXISTS "reservation_guests: admin full access" ON public.reservation_guests;
CREATE POLICY "reservation_guests: admin full access" ON public.reservation_guests FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "reservation_guests: operations full access" ON public.reservation_guests;
CREATE POLICY "reservation_guests: operations full access" ON public.reservation_guests FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "reservation_guests: sales read" ON public.reservation_guests;
CREATE POLICY "reservation_guests: sales read" ON public.reservation_guests FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "reservation_guests: guide reads assigned" ON public.reservation_guests;
CREATE POLICY "reservation_guests: guide reads assigned" ON public.reservation_guests FOR SELECT TO authenticated
  USING ( is_guide() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.id = reservation_guests.reservation_id AND r.assigned_to = auth.uid() AND r.status NOT IN ('cancelled')) );

-- email_ingestions
DROP POLICY IF EXISTS "email_ingestions: admin read" ON public.email_ingestions;
CREATE POLICY "email_ingestions: admin read" ON public.email_ingestions FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "email_ingestions: operations read" ON public.email_ingestions;
CREATE POLICY "email_ingestions: operations read" ON public.email_ingestions FOR SELECT TO authenticated USING ( is_operations() );

-- activity_log_reads
DROP POLICY IF EXISTS "activity_log_reads: staff insert own" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: staff insert own" ON public.activity_log_reads FOR INSERT TO authenticated WITH CHECK ( staff_id = auth.uid() );
DROP POLICY IF EXISTS "activity_log_reads: staff read own" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: staff read own" ON public.activity_log_reads FOR SELECT TO authenticated USING ( staff_id = auth.uid() );
DROP POLICY IF EXISTS "activity_log_reads: admin read all" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: admin read all" ON public.activity_log_reads FOR SELECT TO authenticated USING ( is_admin() );

-- reservation_reviews
DROP POLICY IF EXISTS "reservation_reviews: admin full access" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: admin full access" ON public.reservation_reviews FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "reservation_reviews: operations full access" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: operations full access" ON public.reservation_reviews FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "reservation_reviews: sales read" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: sales read" ON public.reservation_reviews FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "reservation_reviews: guide role read" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: guide role read" ON public.reservation_reviews FOR SELECT TO authenticated USING ( is_guide() );

-- tour_languages
DROP POLICY IF EXISTS "tour_languages: admin full access" ON public.tour_languages;
CREATE POLICY "tour_languages: admin full access" ON public.tour_languages FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "tour_languages: operations full access" ON public.tour_languages;
CREATE POLICY "tour_languages: operations full access" ON public.tour_languages FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "tour_languages: sales read" ON public.tour_languages;
CREATE POLICY "tour_languages: sales read" ON public.tour_languages FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "tour_languages: guide read" ON public.tour_languages;
CREATE POLICY "tour_languages: guide read" ON public.tour_languages FOR SELECT TO authenticated USING ( is_guide() );

-- tour_channels
DROP POLICY IF EXISTS "tour_channels: admin full access" ON public.tour_channels;
CREATE POLICY "tour_channels: admin full access" ON public.tour_channels FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "tour_channels: operations full access" ON public.tour_channels;
CREATE POLICY "tour_channels: operations full access" ON public.tour_channels FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );

-- tour_itinerary_stops
DROP POLICY IF EXISTS "tour_itinerary_stops: admin full access" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: admin full access" ON public.tour_itinerary_stops FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "tour_itinerary_stops: operations full access" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: operations full access" ON public.tour_itinerary_stops FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "tour_itinerary_stops: sales read active tour" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: sales read active tour" ON public.tour_itinerary_stops FOR SELECT TO authenticated
  USING ( is_sales() AND EXISTS (SELECT 1 FROM public.tours t WHERE t.id = tour_itinerary_stops.tour_id AND t.is_active = TRUE) );
DROP POLICY IF EXISTS "tour_itinerary_stops: guide reads assigned tour" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: guide reads assigned tour" ON public.tour_itinerary_stops FOR SELECT TO authenticated
  USING ( is_guide() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.tour_id = tour_itinerary_stops.tour_id AND r.assigned_to = auth.uid()) );

-- civitatis_activity_modality_map
DROP POLICY IF EXISTS "civitatis_activity_modality_map: admin full access" ON public.civitatis_activity_modality_map;
CREATE POLICY "civitatis_activity_modality_map: admin full access" ON public.civitatis_activity_modality_map FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "civitatis_activity_modality_map: operations full access" ON public.civitatis_activity_modality_map;
CREATE POLICY "civitatis_activity_modality_map: operations full access" ON public.civitatis_activity_modality_map FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );

-- tour_preparation_rules
DROP POLICY IF EXISTS "tour_preparation_rules: admin full access" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: admin full access" ON public.tour_preparation_rules FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "tour_preparation_rules: operations full access" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: operations full access" ON public.tour_preparation_rules FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "tour_preparation_rules: guide reads assigned tour" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: guide reads assigned tour" ON public.tour_preparation_rules FOR SELECT TO authenticated
  USING ( is_guide() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.tour_id = tour_preparation_rules.tour_id AND r.assigned_to = auth.uid()) );

-- reservation_preparations
DROP POLICY IF EXISTS "reservation_preparations: admin full access" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: admin full access" ON public.reservation_preparations FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "reservation_preparations: operations full access" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: operations full access" ON public.reservation_preparations FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );
DROP POLICY IF EXISTS "reservation_preparations: guide reads assigned" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: guide reads assigned" ON public.reservation_preparations FOR SELECT TO authenticated
  USING ( is_guide() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.id = reservation_preparations.reservation_id AND r.assigned_to = auth.uid() AND r.status NOT IN ('cancelled')) );

-- whatsapp_destinations
DROP POLICY IF EXISTS "whatsapp_destinations: admin full access" ON public.whatsapp_destinations;
CREATE POLICY "whatsapp_destinations: admin full access" ON public.whatsapp_destinations FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "whatsapp_destinations: operations full access" ON public.whatsapp_destinations;
CREATE POLICY "whatsapp_destinations: operations full access" ON public.whatsapp_destinations FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );

-- whatsapp_destination_recipients
DROP POLICY IF EXISTS "whatsapp_destination_recipients: admin full access" ON public.whatsapp_destination_recipients;
CREATE POLICY "whatsapp_destination_recipients: admin full access" ON public.whatsapp_destination_recipients FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "whatsapp_destination_recipients: operations full access" ON public.whatsapp_destination_recipients;
CREATE POLICY "whatsapp_destination_recipients: operations full access" ON public.whatsapp_destination_recipients FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );

-- whatsapp_messages
DROP POLICY IF EXISTS "whatsapp_messages: admin read" ON public.whatsapp_messages;
CREATE POLICY "whatsapp_messages: admin read" ON public.whatsapp_messages FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "whatsapp_messages: operations read" ON public.whatsapp_messages;
CREATE POLICY "whatsapp_messages: operations read" ON public.whatsapp_messages FOR SELECT TO authenticated USING ( is_operations() );

-- civitatis_settlement_items
DROP POLICY IF EXISTS "civitatis_settlement_items: admin full access" ON public.civitatis_settlement_items;
CREATE POLICY "civitatis_settlement_items: admin full access" ON public.civitatis_settlement_items FOR ALL TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "civitatis_settlement_items: operations full access" ON public.civitatis_settlement_items;
CREATE POLICY "civitatis_settlement_items: operations full access" ON public.civitatis_settlement_items FOR ALL TO authenticated USING ( is_operations() ) WITH CHECK ( is_operations() );

-- exchange_rates
DROP POLICY IF EXISTS "exchange_rates: authenticated staff can read" ON public.exchange_rates;
CREATE POLICY "exchange_rates: authenticated staff can read" ON public.exchange_rates FOR SELECT TO authenticated USING ( TRUE );

-- ref_number_counters: untouched by the forward migration; untouched here.


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 2b — drop the staff_users self-update column guard
-- trigger and its function, restoring "own profile update" to its
-- original, unguarded behavior (bare row-level auth.uid() = id only).
-- Must happen before STEP 2's policies are reverted below, though the two
-- are independent (the trigger references no policy by name).
-- ──────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_staff_users_self_update_guard ON public.staff_users;
DROP FUNCTION IF EXISTS public.enforce_staff_self_update_columns();


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 2 — restore staff_users to its single original
-- "all staff can read" policy; drop the bootstrap-exception policy this
-- migration added; restore admin update/insert/delete to no-AAL2.
-- ──────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "staff_users: own profile select at aal1" ON public.staff_users;

DROP POLICY IF EXISTS "staff_users: all staff can read" ON public.staff_users;
CREATE POLICY "staff_users: all staff can read" ON public.staff_users FOR SELECT TO authenticated USING ( is_staff() );

-- "staff_users: own profile update" was never touched by the forward
-- migration — nothing to restore.

DROP POLICY IF EXISTS "staff_users: admin update any" ON public.staff_users;
CREATE POLICY "staff_users: admin update any" ON public.staff_users FOR UPDATE TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "staff_users: admin insert" ON public.staff_users;
CREATE POLICY "staff_users: admin insert" ON public.staff_users FOR INSERT TO authenticated WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "staff_users: admin delete" ON public.staff_users;
CREATE POLICY "staff_users: admin delete" ON public.staff_users FOR DELETE TO authenticated USING ( is_admin() );


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 1b — restore get_current_staff_role() to its exact
-- original body (no is_active filter). Must happen before anything that
-- might depend on its restored behavior; nothing in this rollback file
-- does, so placement here (after the policies/trigger that called it
-- during the migration's lifetime are already gone) is simply tidy.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_current_staff_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM   public.staff_users
  WHERE  id = auth.uid()
  LIMIT  1;
$$;

COMMENT ON FUNCTION public.get_current_staff_role IS
  'Returns the role of the currently logged-in staff member (admin/sales/operations/guide).
   Used inside RLS policies — SECURITY DEFINER to bypass RLS on staff_users.';


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 1 — drop is_aal2() itself, now that nothing references it.
-- ──────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.is_aal2();


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that is_aal2() is gone, the self-
-- update guard is gone, get_current_staff_role() is restored, and no
-- policy references is_aal2() any more.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'is_aal2') AS is_aal2_still_exists_should_be_0,
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'staff_users: own profile select at aal1') AS bootstrap_policy_still_exists_should_be_0,
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND qual ILIKE '%is_aal2()%') AS policies_still_referencing_is_aal2_should_be_0,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'get_current_staff_role' AND prosrc ILIKE '%is_active%') AS get_current_staff_role_still_checks_is_active_should_be_0,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'enforce_staff_self_update_columns') AS self_update_guard_function_still_exists_should_be_0,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'trg_staff_users_self_update_guard') AS self_update_guard_trigger_still_exists_should_be_0;
