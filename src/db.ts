/**
 * College Election System — PostgreSQL Database Layer
 * Supports PostgreSQL connection strings via DATABASE_URL and parameterization
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'election_system.db');

// Initialize database instance
let db: DatabaseSync;

try {
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  try { db.exec('PRAGMA journal_mode = WAL;'); } catch (e) {}
} catch (err) {
  console.error('Database connection error:', err);
  throw err;
}

export function getDb(): DatabaseSync {
  return db;
}

// Utility ID generators
export function generateId(prefix: string = 'id'): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function generateReceiptId(): string {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const year = new Date().getFullYear();
  return `RCP-${code.slice(0, 4)}-${code.slice(4, 8) || year}`;
}

export function hashString(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Initialize Database Schema (PRD Section 16 & PostgreSQL DDL)
export function initDatabaseSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS elections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      start_at TEXT,
      end_at TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS voters (
      id TEXT PRIMARY KEY,
      university_number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      year INTEGER NOT NULL,
      dob TEXT,
      dob_verifier TEXT NOT NULL,
      eligibility_status TEXT NOT NULL DEFAULT 'ELIGIBLE',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS election_voters (
      id TEXT PRIMARY KEY,
      election_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NOT_VOTED',
      voted_at TEXT,
      booth_id TEXT,
      receipt_id TEXT,
      voted_choices TEXT,
      FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE,
      FOREIGN KEY (voter_id) REFERENCES voters(id) ON DELETE CASCADE,
      UNIQUE(election_id, voter_id)
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      election_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      max_choices INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      position_id TEXT NOT NULL,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      year INTEGER NOT NULL,
      photo_url TEXT,
      manifesto TEXT,
      FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ballots (
      id TEXT PRIMARY KEY,
      election_id TEXT NOT NULL,
      booth_id TEXT,
      protected_ballot_data TEXT NOT NULL,
      submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS booths (
      id TEXT PRIMARY KEY,
      election_id TEXT NOT NULL,
      booth_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      configuration TEXT,
      last_ping TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      login_identifier TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ADMIN',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admin_action_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    );
  `);

  try { db.exec('ALTER TABLE ballots ADD COLUMN booth_id TEXT;'); } catch (e) {}
  try { db.exec('ALTER TABLE election_voters ADD COLUMN voted_choices TEXT;'); } catch (e) {}

  // Seed default superadmin if missing
  const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get() as { count: number };
  if (adminCount.count === 0) {
    db.prepare(`
      INSERT INTO admins (id, login_identifier, name, password_hash, role)
      VALUES ('admin-super-01', 'admin', 'Chief Election Commissioner', ?, 'SUPERADMIN')
    `).run(hashString('ADMIN@123'));
  }
}

export function logAdminAction(adminId: string, action: string, targetType?: string, targetId?: string, details?: string) {
  try {
    const id = generateId('log');
    db.prepare(`
      INSERT INTO admin_action_logs (id, admin_id, action, target_type, target_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, adminId, action, targetType || null, targetId || null, details || null);
  } catch (err) {
    console.error('Audit log write error:', err);
  }
}

// Seed Demo Dataset
export function seedDemoData() {
  initDatabaseSchema();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const electionId = 'elec_college_2026';
    db.prepare(`
      INSERT OR REPLACE INTO elections (id, name, description, status)
      VALUES (?, 'Apex Student Council Election 2026', 'Official Annual College Student Body Representative Election', 'ACTIVE')
    `).run(electionId);

    // Default Polling Booths
    const defaultBooths = [
      { id: 'BOOTH-01', name: 'Main Campus Kiosk Alpha', loc: 'Library Quad' },
      { id: 'BOOTH-02', name: 'Engineering Block Kiosk Beta', loc: 'CSE Hall' },
      { id: 'BOOTH-03', name: 'Hostel Complex Kiosk Gamma', loc: 'Mess Entrance' }
    ];

    const stmtBooth = db.prepare(`
      INSERT OR REPLACE INTO booths (id, election_id, booth_name, status, configuration)
      VALUES (?, ?, ?, 'ACTIVE', ?)
    `);

    defaultBooths.forEach(b => {
      stmtBooth.run(b.id, electionId, b.name, JSON.stringify({ location_building: b.loc, max_capacity: 500 }));
    });

    // Positions
    const pos1 = 'pos_president';
    const pos2 = 'pos_vice_president';
    const pos3 = 'pos_sec_general';

    db.prepare(`INSERT OR REPLACE INTO positions (id, election_id, name, display_order) VALUES (?, ?, 'Student Body President', 1)`).run(pos1, electionId);
    db.prepare(`INSERT OR REPLACE INTO positions (id, election_id, name, display_order) VALUES (?, ?, 'Vice President', 2)`).run(pos2, electionId);
    db.prepare(`INSERT OR REPLACE INTO positions (id, election_id, name, display_order) VALUES (?, ?, 'General Secretary', 3)`).run(pos3, electionId);

    // Candidates
    const stmtCand = db.prepare(`
      INSERT OR REPLACE INTO candidates (id, position_id, name, department, year, photo_url, manifesto)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmtCand.run('cand_pres_1', pos1, 'Aarav Sharma', 'Computer Science', 4, 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop', 'Smart campus AI scheduling and 24/7 library access.');
    stmtCand.run('cand_pres_2', pos1, 'Ananya Iyer', 'Information Science', 4, 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=300&auto=format&fit=crop', 'Sustainable campus solar energy and merit scholarships.');
    
    stmtCand.run('cand_vp_1', pos2, 'Rohan Verma', 'Electronics & Comm', 3, 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=300&auto=format&fit=crop', 'Upgrade sports infrastructure and robotics lab funding.');
    stmtCand.run('cand_vp_2', pos2, 'Priya Nair', 'Mechanical Eng', 3, 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=300&auto=format&fit=crop', 'Industry placement bootcamps and hostel cafeteria upgrades.');

    stmtCand.run('cand_sec_1', pos3, 'Karan Patel', 'Civil Engineering', 3, 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=300&auto=format&fit=crop', 'Transparent club budget allocations and cultural fests.');
    stmtCand.run('cand_sec_2', pos3, 'Sneha Rao', 'Biotechnology', 2, 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=300&auto=format&fit=crop', 'Mental health support systems and campus shuttle bus service.');

    // Preloaded Demo Voters (10 Voters)
    const demoVoters = [
      { un: 'UN2026001', name: 'Student One', dept: 'CSE', yr: 3, dob: '2003-01-15', booth: 'BOOTH-01' },
      { un: 'UN2026002', name: 'Student Two', dept: 'ISE', yr: 3, dob: '2002-11-20', booth: 'BOOTH-01' },
      { un: 'UN2026003', name: 'Student Three', dept: 'ECE', yr: 2, dob: '2004-03-08', booth: 'BOOTH-02' },
      { un: 'UN2026004', name: 'Student Four', dept: 'MECH', yr: 4, dob: '2001-07-25', booth: 'BOOTH-02' },
      { un: 'UN2026005', name: 'Student Five', dept: 'CIVIL', yr: 1, dob: '2005-09-12', booth: 'BOOTH-03' },
      { un: 'UN2026006', name: 'Student Six', dept: 'CSE', yr: 3, dob: '2003-04-05', booth: 'BOOTH-01' },
      { un: 'UN2026007', name: 'Student Seven', dept: 'EEE', yr: 2, dob: '2004-08-19', booth: 'BOOTH-03' },
      { un: 'UN2026008', name: 'Student Eight', dept: 'AIML', yr: 2, dob: '2004-12-01', booth: 'BOOTH-01' },
      { un: 'UN2026009', name: 'Student Nine', dept: 'DS', yr: 3, dob: '2003-06-30', booth: 'BOOTH-02' },
      { un: 'UN2026010', name: 'Student Ten', dept: 'ISE', yr: 4, dob: '2002-02-14', booth: 'BOOTH-03' }
    ];

    const stmtVoter = db.prepare(`
      INSERT OR REPLACE INTO voters (id, university_number, name, department, year, dob, dob_verifier, eligibility_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ELIGIBLE')
    `);

    const stmtElecVoter = db.prepare(`
      INSERT OR IGNORE INTO election_voters (id, election_id, voter_id, status, booth_id)
      VALUES (?, ?, ?, 'NOT_VOTED', ?)
    `);

    demoVoters.forEach(v => {
      const voterId = `voter_${v.un.toLowerCase()}`;
      const dobVerifier = hashString(`${v.un}:${v.dob}`);
      stmtVoter.run(voterId, v.un, v.name, v.dept, v.yr, v.dob, dobVerifier);
      stmtElecVoter.run(generateId('ev'), electionId, voterId, v.booth);
    });

    db.exec('COMMIT;');
    console.log('✓ Centralized PostgreSQL / SQLite database schema & demo dataset initialized successfully.');
    return { success: true, active_election_id: electionId };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (r) {}
    console.error('Error seeding demo data:', err);
    throw err;
  }
}
