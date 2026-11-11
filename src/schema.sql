CREATE ROLE platform_auth NOLOGIN NOBYPASSRLS;
CREATE ROLE platform_member NOLOGIN NOBYPASSRLS;

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE clinics (
  id uuid PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100)
);

CREATE TABLE memberships (
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  role text NOT NULL CHECK (role IN ('owner', 'reception', 'professional')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (clinic_id, account_id)
);

CREATE TABLE patients (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  professional_id uuid,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  FOREIGN KEY (clinic_id, professional_id) REFERENCES memberships(clinic_id, account_id)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  idle_until timestamptz NOT NULL
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT SELECT ON accounts TO platform_auth;
GRANT SELECT, INSERT, UPDATE (idle_until), DELETE ON sessions TO platform_auth;
GRANT SELECT ON clinics, memberships, patients TO platform_member;
GRANT UPDATE (name) ON clinics, patients TO platform_member;

CREATE FUNCTION current_account_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY own_memberships ON memberships FOR SELECT TO platform_member
  USING (account_id = current_account_id() AND active);

ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinics FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_read ON clinics FOR SELECT TO platform_member
  USING (EXISTS (SELECT 1 FROM memberships m WHERE m.clinic_id = clinics.id));
CREATE POLICY clinic_rename ON clinics FOR UPDATE TO platform_member
  USING (EXISTS (SELECT 1 FROM memberships m WHERE m.clinic_id = clinics.id AND m.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.clinic_id = clinics.id AND m.role = 'owner'));

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_read ON patients FOR SELECT TO platform_member
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.clinic_id = patients.clinic_id
      AND (m.role IN ('owner', 'reception') OR patients.professional_id = current_account_id())
  ));
CREATE POLICY patient_edit ON patients FOR UPDATE TO platform_member
  USING (EXISTS (
    SELECT 1 FROM memberships m WHERE m.clinic_id = patients.clinic_id AND m.role IN ('owner', 'reception')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM memberships m WHERE m.clinic_id = patients.clinic_id AND m.role IN ('owner', 'reception')
  ));
