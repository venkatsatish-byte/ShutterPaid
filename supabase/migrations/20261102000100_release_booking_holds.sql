-- Free slots held for customers who didn't finish Stripe Checkout within 10 minutes.
-- Runs inside the database every minute (no Edge Function or secret needed). The slot search
-- already ignores expired holds; this makes them visible as cancelled to the photographer and
-- lets the double-booking constraint accept new bookings for that time.
create extension if not exists pg_cron;

select cron.schedule('release-booking-holds', '* * * * *', $$ select public.release_expired_holds(); $$);
