-- ====================================================================
-- College Election System — Centralized PostgreSQL Database Schema (DDL)
-- ====================================================================

-- 1. Admins Table
CREATE TABLE IF NOT EXISTS admins (
  id VARCHAR(64) PRIMARY KEY,
  login_identifier VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(150) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Elections Table
CREATE TABLE IF NOT EXISTS elections (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  start_at TIMESTAMP WITH TIME ZONE,
  end_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(50) NOT NULL DEFAULT 'DRAFT', -- DRAFT, SCHEDULED, ACTIVE, CLOSED, RESULTS_PUBLISHED
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Voters Table
CREATE TABLE IF NOT EXISTS voters (
  id VARCHAR(64) PRIMARY KEY,
  university_number VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  department VARCHAR(100) NOT NULL,
  year INT NOT NULL DEFAULT 1,
  dob VARCHAR(20),
  dob_verifier VARCHAR(255) NOT NULL,
  eligibility_status VARCHAR(50) NOT NULL DEFAULT 'ELIGIBLE', -- ELIGIBLE, BLOCKED
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Polling Booths Table
CREATE TABLE IF NOT EXISTS booths (
  id VARCHAR(64) PRIMARY KEY,
  election_id VARCHAR(64) NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  booth_name VARCHAR(150) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  configuration TEXT,
  last_ping TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Election Voters Participation Table (CRITICAL ONE-VOTE CONSTRAINT)
CREATE TABLE IF NOT EXISTS election_voters (
  id VARCHAR(64) PRIMARY KEY,
  election_id VARCHAR(64) NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  voter_id VARCHAR(64) NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL DEFAULT 'NOT_VOTED', -- NOT_VOTED, VOTED
  voted_at TIMESTAMP WITH TIME ZONE,
  booth_id VARCHAR(64),
  receipt_id VARCHAR(100),
  voted_choices TEXT,
  CONSTRAINT unique_election_voter UNIQUE (election_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_election_voters_status ON election_voters(election_id, status);

-- 6. Election Positions / Posts Table
CREATE TABLE IF NOT EXISTS positions (
  id VARCHAR(64) PRIMARY KEY,
  election_id VARCHAR(64) NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  max_choices INT NOT NULL DEFAULT 1
);

-- 7. Nominees / Candidates Table
CREATE TABLE IF NOT EXISTS candidates (
  id VARCHAR(64) PRIMARY KEY,
  position_id VARCHAR(64) NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  department VARCHAR(100) NOT NULL,
  year INT NOT NULL DEFAULT 1,
  photo_url TEXT,
  manifesto TEXT
);

-- 8. Ballots / Votes Table (STRICT BALLOT SECRECY: ZERO voter_id / UN)
CREATE TABLE IF NOT EXISTS ballots (
  id VARCHAR(64) PRIMARY KEY,
  election_id VARCHAR(64) NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  booth_id VARCHAR(64),
  protected_ballot_data TEXT NOT NULL, -- JSON formatted candidate choices
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ballots_election ON ballots(election_id);

-- 9. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  admin_id VARCHAR(64) NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(100),
  target_id VARCHAR(100),
  details TEXT,
  ip_address VARCHAR(45),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
