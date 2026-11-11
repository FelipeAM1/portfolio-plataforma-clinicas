CREATE EXTENSION btree_gist;
CREATE ROLE platform_booking NOLOGIN NOBYPASSRLS;

CREATE TABLE categories (
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  parent_id uuid,
  is_root boolean GENERATED ALWAYS AS (parent_id IS NULL) STORED,
  parent_is_root boolean GENERATED ALWAYS AS (true) STORED,
  PRIMARY KEY (clinic_id, id),
  UNIQUE (clinic_id, id, is_root),
  UNIQUE NULLS NOT DISTINCT (clinic_id, parent_id, name),
  FOREIGN KEY (clinic_id, parent_id, parent_is_root) REFERENCES categories(clinic_id, id, is_root)
);

CREATE TABLE services (
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  id uuid NOT NULL,
  category_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (clinic_id, id),
  UNIQUE (clinic_id, category_id, name),
  FOREIGN KEY (clinic_id, category_id) REFERENCES categories(clinic_id, id)
);

CREATE TABLE service_options (
  clinic_id uuid NOT NULL,
  id uuid NOT NULL,
  service_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  duration integer NOT NULL CHECK (duration BETWEEN 15 AND 480),
  price_kind text NOT NULL CHECK (price_kind IN ('fixed', 'from', 'unit', 'quote')),
  price_cents integer CHECK (price_cents BETWEEN 0 AND 99999999),
  price_unit text,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (clinic_id, id),
  UNIQUE (clinic_id, service_id, name),
  CHECK ((price_cents IS NULL) = (price_kind = 'quote')),
  CHECK ((price_unit IS NOT NULL) = (price_kind = 'unit')),
  FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, id)
);

CREATE TABLE bookable_staff (
  clinic_id uuid NOT NULL,
  id uuid NOT NULL,
  display_name text NOT NULL,
  PRIMARY KEY (clinic_id, id),
  FOREIGN KEY (clinic_id, id) REFERENCES memberships(clinic_id, account_id)
);

CREATE TABLE service_staff (
  clinic_id uuid NOT NULL,
  service_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  PRIMARY KEY (clinic_id, service_id, staff_id),
  FOREIGN KEY (clinic_id, service_id) REFERENCES services(clinic_id, id),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES bookable_staff(clinic_id, id)
);

CREATE TABLE weekly_hours (
  clinic_id uuid NOT NULL,
  id uuid NOT NULL,
  staff_id uuid NOT NULL,
  weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  opens time NOT NULL,
  closes time NOT NULL CHECK (closes > opens),
  PRIMARY KEY (clinic_id, id),
  UNIQUE (clinic_id, staff_id, weekday, opens, closes),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES bookable_staff(clinic_id, id)
);

CREATE TABLE bookings (
  clinic_id uuid NOT NULL,
  id uuid NOT NULL,
  staff_id uuid NOT NULL,
  option_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  service_name text NOT NULL,
  option_name text NOT NULL,
  patient_name text NOT NULL CHECK (char_length(patient_name) BETWEEN 2 AND 100),
  phone text NOT NULL CHECK (phone ~ '^[0-9]{10,13}$'),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  PRIMARY KEY (clinic_id, id),
  FOREIGN KEY (clinic_id, option_id) REFERENCES service_options(clinic_id, id),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES bookable_staff(clinic_id, id),
  CONSTRAINT no_overlapping_booking EXCLUDE USING gist (
    clinic_id WITH =, staff_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'confirmed')
);

CREATE FUNCTION clinic_role(target uuid) RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT role FROM memberships WHERE clinic_id = target $$;

CREATE FUNCTION public_clinic_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.public_clinic_id', true), '')::uuid $$;

CREATE FUNCTION staff_is_bookable(clinic uuid, staff uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m JOIN public.accounts a ON a.id = m.account_id
    WHERE m.clinic_id = clinic AND m.account_id = staff AND m.active AND a.active
      AND m.role IN ('owner', 'professional')
  )
$$;
REVOKE EXECUTE ON FUNCTION staff_is_bookable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_is_bookable(uuid, uuid) TO platform_member, platform_booking;

REVOKE ALL ON categories, services, service_options, bookable_staff, service_staff, weekly_hours, bookings FROM PUBLIC;
GRANT SELECT ON categories, services, service_options, bookable_staff, service_staff, weekly_hours, bookings TO platform_member;
GRANT INSERT ON categories, services, service_options, service_staff, weekly_hours TO platform_member;
GRANT UPDATE (name) ON categories TO platform_member;
GRANT UPDATE (category_id, name, active) ON services TO platform_member;
GRANT UPDATE (name, duration, price_kind, price_cents, price_unit, active) ON service_options TO platform_member;
GRANT DELETE ON service_staff, weekly_hours TO platform_member;
GRANT UPDATE (status) ON bookings TO platform_member;

GRANT SELECT (id, slug, name) ON clinics TO platform_booking;
GRANT SELECT ON categories, services, service_options, bookable_staff, service_staff, weekly_hours TO platform_booking;
GRANT SELECT (clinic_id, staff_id, starts_at, ends_at, status) ON bookings TO platform_booking;
GRANT INSERT (clinic_id, id, staff_id, option_id, starts_at, ends_at, service_name, option_name, patient_name, phone)
  ON bookings TO platform_booking;
CREATE POLICY clinic_public ON clinics FOR SELECT TO platform_booking USING (true);

DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['categories', 'services', 'service_options', 'bookable_staff', 'service_staff', 'weekly_hours', 'bookings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
    IF relation <> 'bookings' THEN
      EXECUTE format('CREATE POLICY team_read ON %I FOR SELECT TO platform_member USING (clinic_role(clinic_id) IS NOT NULL)', relation);
    END IF;
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['categories', 'services', 'service_options', 'service_staff', 'weekly_hours']
  LOOP
    EXECUTE format(
      'CREATE POLICY owner_write ON %I TO platform_member USING (clinic_role(clinic_id) = ''owner'') WITH CHECK (clinic_role(clinic_id) = ''owner'')',
      relation
    );
  END LOOP;
END
$$;

CREATE POLICY categories_public ON categories FOR SELECT TO platform_booking USING (clinic_id = public_clinic_id());
CREATE POLICY services_public ON services FOR SELECT TO platform_booking USING (clinic_id = public_clinic_id() AND active);
CREATE POLICY options_public ON service_options FOR SELECT TO platform_booking
  USING (clinic_id = public_clinic_id() AND active AND EXISTS (
    SELECT 1 FROM services s WHERE s.clinic_id = service_options.clinic_id AND s.id = service_options.service_id
  ));
CREATE POLICY staff_public ON bookable_staff FOR SELECT TO platform_booking
  USING (clinic_id = public_clinic_id() AND staff_is_bookable(clinic_id, id));
CREATE POLICY service_staff_public ON service_staff FOR SELECT TO platform_booking USING (clinic_id = public_clinic_id());
CREATE POLICY hours_public ON weekly_hours FOR SELECT TO platform_booking USING (clinic_id = public_clinic_id());
CREATE POLICY busy_times_public ON bookings FOR SELECT TO platform_booking
  USING (clinic_id = public_clinic_id() AND status = 'confirmed');
CREATE POLICY booking_create ON bookings FOR INSERT TO platform_booking
  WITH CHECK (clinic_id = public_clinic_id() AND status = 'confirmed');
CREATE POLICY booking_read ON bookings FOR SELECT TO platform_member
  USING (clinic_role(clinic_id) IN ('owner', 'reception')
    OR (clinic_role(clinic_id) = 'professional' AND staff_id = current_account_id()));
CREATE POLICY booking_cancel ON bookings FOR UPDATE TO platform_member
  USING (clinic_role(clinic_id) IN ('owner', 'reception') AND status = 'confirmed' AND starts_at > now())
  WITH CHECK (clinic_role(clinic_id) IN ('owner', 'reception') AND status = 'cancelled');
