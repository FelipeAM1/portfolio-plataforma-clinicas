ALTER TABLE patients ADD UNIQUE (clinic_id, id);

CREATE TABLE booking_patients (
  clinic_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  PRIMARY KEY (clinic_id, booking_id),
  FOREIGN KEY (clinic_id, booking_id) REFERENCES bookings(clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id)
);

CREATE TABLE encounters (
  clinic_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  author_id uuid NOT NULL DEFAULT current_account_id(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  procedure text NOT NULL CHECK (char_length(procedure) BETWEEN 2 AND 220),
  complaint text NOT NULL CHECK (char_length(complaint) <= 220),
  allergies text NOT NULL CHECK (char_length(allergies) <= 220),
  notes text NOT NULL CHECK (char_length(notes) <= 220),
  PRIMARY KEY (clinic_id, booking_id),
  FOREIGN KEY (clinic_id, booking_id) REFERENCES booking_patients(clinic_id, booking_id),
  FOREIGN KEY (clinic_id, author_id) REFERENCES memberships(clinic_id, account_id)
);

REVOKE ALL ON booking_patients, encounters FROM PUBLIC;
GRANT INSERT (id, clinic_id, professional_id, name) ON patients TO platform_member;
GRANT SELECT, INSERT ON booking_patients TO platform_member;
GRANT SELECT ON encounters TO platform_member;
GRANT INSERT (clinic_id, booking_id, procedure, complaint, allergies, notes) ON encounters TO platform_member;

CREATE POLICY patient_create_from_booking ON patients FOR INSERT TO platform_member
  WITH CHECK (clinic_role(clinic_id) IN ('owner', 'reception') AND staff_is_bookable(clinic_id, professional_id));

ALTER TABLE booking_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_patients FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_patient_read ON booking_patients FOR SELECT TO platform_member
  USING (EXISTS (
    SELECT 1 FROM patients p WHERE p.clinic_id = booking_patients.clinic_id AND p.id = booking_patients.patient_id
  ));
CREATE POLICY booking_patient_link ON booking_patients FOR INSERT TO platform_member
  WITH CHECK (clinic_role(clinic_id) IN ('owner', 'reception') AND EXISTS (
    SELECT 1 FROM bookings b JOIN patients p ON p.clinic_id = b.clinic_id AND p.professional_id = b.staff_id
    WHERE b.clinic_id = booking_patients.clinic_id AND b.id = booking_patients.booking_id
      AND b.status = 'confirmed' AND p.id = booking_patients.patient_id
  ));

ALTER TABLE encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE encounters FORCE ROW LEVEL SECURITY;
CREATE POLICY encounter_read ON encounters FOR SELECT TO platform_member
  USING (EXISTS (
    SELECT 1 FROM booking_patients p WHERE p.clinic_id = encounters.clinic_id AND p.booking_id = encounters.booking_id
  ));
CREATE POLICY encounter_record ON encounters FOR INSERT TO platform_member
  WITH CHECK (
    clinic_role(clinic_id) IN ('owner', 'professional') AND author_id = current_account_id()
    AND EXISTS (
      SELECT 1 FROM bookings b JOIN booking_patients p ON p.clinic_id = b.clinic_id AND p.booking_id = b.id
      WHERE b.clinic_id = encounters.clinic_id AND b.id = encounters.booking_id
        AND b.status = 'confirmed' AND b.staff_id = current_account_id()
    )
  );

ALTER POLICY booking_cancel ON bookings
  USING (clinic_role(clinic_id) IN ('owner', 'reception') AND status = 'confirmed' AND starts_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM encounters e WHERE e.clinic_id = bookings.clinic_id AND e.booking_id = bookings.id
    ));
