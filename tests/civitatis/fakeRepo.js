/**
 * tests/civitatis/fakeRepo.js
 * ─────────────────────────────────────────────────────────────────────────
 * An in-memory implementation of the `repo` interface runCivitatisDryRun
 * expects, backed by plain fixture arrays instead of Supabase. Used only
 * by tests — never touches a network or a real database. Mirrors the
 * read-only shape api/_civitatis/supabaseAdmin.js implements for real.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { normalizeFullNameForComparison } = require('../../api/_civitatis/matching');

function createFakeRepo({ source, tourChannels = [], reservations = [], reservationGuests = {}, customers = [] } = {}) {
  return {
    async getCivitatisSource() {
      return source || null;
    },
    async getTourChannelsForSource(sourceId) {
      return tourChannels.filter(tc => tc.source_id === sourceId);
    },
    async findReservationByExternalBooking({ sourceId, externalBookingId }) {
      return reservations.find(r => r.source_id === sourceId && r.external_booking_id === externalBookingId) || null;
    },
    async getReservationGuestNames(reservationId) {
      return reservationGuests[reservationId] || [];
    },
    async findCandidateLegacyReservations({ tourId }) {
      return reservations.filter(r => r.tour_id === tourId && !r.source_id && !r.external_booking_id);
    },
    async findCustomersByContact({ email, phone }) {
      if (!email && !phone) return [];
      return customers.filter(c =>
        (email && c.email && c.email.toLowerCase() === String(email).toLowerCase())
        || (phone && c.phone === phone)
      );
    },
    async findCustomersByName({ fullName }) {
      const key = normalizeFullNameForComparison(fullName);
      if (!key) return [];
      return customers.filter(c => normalizeFullNameForComparison(c.full_name) === key);
    },
  };
}

module.exports = { createFakeRepo };
