export const BOOKING_ADVANCEMENT_MIGRATION = `
CREATE TABLE advancement_booking_zones(rule_id TEXT PRIMARY KEY REFERENCES expansion_booking_rules(id),time_zone TEXT NOT NULL,disambiguation TEXT NOT NULL CHECK(disambiguation IN('reject','earlier','later')),gap_policy TEXT NOT NULL CHECK(gap_policy IN('reject','shift-forward')),revision INTEGER NOT NULL CHECK(revision>0));
INSERT INTO advancement_booking_zones SELECT id,'UTC','reject','reject',1 FROM expansion_booking_rules;
CREATE TABLE advancement_booking_slot_provenance(slot_id TEXT PRIMARY KEY REFERENCES platform_slots(id),rule_id TEXT NOT NULL REFERENCES expansion_booking_rules(id),rule_revision INTEGER NOT NULL,wall_time TEXT NOT NULL,time_zone TEXT NOT NULL,offset_minutes INTEGER NOT NULL,ambiguous INTEGER NOT NULL CHECK(ambiguous IN(0,1)),shifted INTEGER NOT NULL CHECK(shifted IN(0,1)),resolver_version TEXT NOT NULL,icu_version TEXT NOT NULL,tzdata_version TEXT NOT NULL);
CREATE TABLE advancement_booking_reviews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('resource','rule','holiday')),target_id TEXT NOT NULL,base_fingerprint TEXT NOT NULL,approval_fingerprint TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),expires_at INTEGER NOT NULL,applied_at TEXT);
CREATE INDEX advancement_booking_review_scope ON advancement_booking_reviews(project_id,expires_at);
`;
