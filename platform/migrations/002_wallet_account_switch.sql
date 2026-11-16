ALTER TABLE challenges DROP CONSTRAINT challenges_purpose_check;
ALTER TABLE challenges ADD CONSTRAINT challenges_purpose_check
    CHECK (purpose IN ('login', 'link', 'switch', 'recover'));
