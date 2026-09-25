/**
 * College Election System — Backend Server
 * PRD & Technical Architecture Implementation
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

// Helper functions for decoding PDF streams
function decodeASCII85(str) {
  let clean = str.replace(/<~/g, '').replace(/~>/g, '').replace(/\s+/g, '');
  const out = [];
  let tuple = 0;
  let count = 0;

  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    if (c === 122 && count === 0) { // 'z' shortcut for 4 zero bytes
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) continue;
    tuple = tuple * 85 + (c - 33);
    count++;
    if (count === 5) {
      out.push((tuple >> 24) & 0xff, (tuple >> 16) & 0xff, (tuple >> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }

  if (count > 1) {
    let padding = 5 - count;
    for (let p = 0; p < padding; p++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >> 24) & 0xff, (tuple >> 16) & 0xff, (tuple >> 8) & 0xff, tuple & 0xff];
    for (let i = 0; i < 4 - padding; i++) out.push(bytes[i]);
  }

  return Buffer.from(out);
}

function decodeASCIIHex(str) {
  let clean = str.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) clean += '0';
  const out = Buffer.alloc(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return out;
}

function extractPdfTextFromBuffer(pdfBuffer) {
  let extractedTextParts = [];
  const pdfStr = pdfBuffer.toString('latin1');

  const objStreamRegex = /(\d+\s+\d+\s+obj\s*<<[\s\S]*?>>\s*stream[\r\n]+)([\s\S]*?)([\r\n]+endstream)/g;
  let match;

  while ((match = objStreamRegex.exec(pdfStr)) !== null) {
    const header = match[1];
    const streamBody = match[2];

    let currentBuf = Buffer.from(streamBody, 'latin1');

    const isASCII85 = header.includes('ASCII85Decode') || streamBody.includes('<~');
    const isASCIIHex = header.includes('ASCIIHexDecode');
    const isFlate = header.includes('FlateDecode');

    if (isASCII85) {
      currentBuf = decodeASCII85(streamBody);
    } else if (isASCIIHex) {
      currentBuf = decodeASCIIHex(streamBody);
    }

    if (isFlate) {
      try {
        currentBuf = zlib.inflateSync(currentBuf);
      } catch (e1) {
        try {
          currentBuf = zlib.unzipSync(currentBuf);
        } catch (e2) {
          try {
            currentBuf = zlib.inflateRawSync(currentBuf);
          } catch (e3) {}
        }
      }
    }

    const decompStr = currentBuf.toString('latin1');
    const rawLines = decompStr.split(/[\r\n]+/);

    rawLines.forEach(l => {
      const tjMatches = l.match(/\(([^()\\]|\\[\s\S])*\)/g);
      if (tjMatches) {
        let lineText = '';
        tjMatches.forEach(m => {
          let clean = m.slice(1, -1)
            .replace(/\\([()])/g, '$1')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\\\/g, '\\')
            .replace(/\\\d{3}/g, ' ')
            .trim();
          if (clean.length > 0 && !/^\/(Helv|F\d+|Font|CID|WinAnsi|Encoding|Type|Catalog|Pages|ProcSet)/.test(clean)) {
            lineText += (lineText ? ' ' : '') + clean;
          }
        });
        if (lineText.trim()) {
          extractedTextParts.push(lineText.trim());
        }
      }
    });
  }

  if (extractedTextParts.length === 0) {
    const literalMatches = pdfStr.match(/\(([^()\\]|\\[\s\S])*\)/g);
    if (literalMatches) {
      literalMatches.forEach(m => {
        let clean = m.slice(1, -1).trim();
        if (clean.length > 1 && !/^\/(Helv|F\d+|Font|CID|WinAnsi|Encoding|Type)/.test(clean)) {
          extractedTextParts.push(clean);
        }
      });
    }
  }

  return extractedTextParts.join('\n');
}

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'election_system.db');

// Initialize SQLite Database
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
try { db.exec('PRAGMA journal_mode = WAL;'); } catch (e) {}

// Initialize Database Schema (PRD Section 16)
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS elections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      start_at TEXT,
      end_at TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT, SCHEDULED, ACTIVE, CLOSED, RESULTS_PUBLISHED
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS voters (
      id TEXT PRIMARY KEY,
      university_number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      year INTEGER NOT NULL,
      dob TEXT,
      dob_verifier TEXT NOT NULL, -- SHA-256 hash of UN + DOB
      eligibility_status TEXT NOT NULL DEFAULT 'ELIGIBLE', -- ELIGIBLE, BLOCKED
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS election_voters (
      id TEXT PRIMARY KEY,
      election_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NOT_VOTED', -- NOT_VOTED, VOTED
      voted_at TEXT,
      booth_id TEXT,
      receipt_id TEXT,
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

    -- BALLOT SECRECY RULE (PRD Section 11):
    -- NO voter_id or university_number stored in ballots!
    CREATE TABLE IF NOT EXISTS ballots (
      id TEXT PRIMARY KEY,
      election_id TEXT NOT NULL,
      booth_id TEXT,
      protected_ballot_data TEXT NOT NULL, -- JSON string of position_id -> candidate_id
      submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE
    );
  `);

  try { db.exec('ALTER TABLE ballots ADD COLUMN booth_id TEXT;'); } catch (e) {}
  try { db.exec('ALTER TABLE election_voters ADD COLUMN voted_choices TEXT;'); } catch (e) {}

  db.exec(`
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
      name TEXT NOT NULL,
      login_identifier TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ELECTION_ADMIN', -- SUPER_ADMIN, ELECTION_ADMIN
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admin_action_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    );
  `);

  try { db.exec('ALTER TABLE voters ADD COLUMN dob TEXT;'); } catch (e) {}

  // Ensure default super admin exists with password ADMIN@123
  const adminId = 'admin-super-01';
  const hash = hashString('ADMIN@123');
  db.prepare(`
    INSERT OR REPLACE INTO admins (id, name, login_identifier, password_hash, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(adminId, 'Election Administrator', 'admin', hash, 'SUPER_ADMIN');
}

initSchema();

// Utility Helper Functions
function hashString(str) {
  return crypto.createHash('sha256').update(str.trim()).digest('hex');
}

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function generateReceiptId() {
  const parts = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RCP-${parts.substring(0, 4)}-${parts.substring(4, 8)}`;
}

// In-memory voting session cache (session_token -> session data)
const activeSessions = new Map();

function createSessionToken(voterId, electionId, UN, name) {
  const token = `sess_${crypto.randomBytes(16).toString('hex')}`;
  const session = {
    token,
    voterId,
    electionId,
    UN,
    name,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000 // 30 mins
  };
  activeSessions.set(token, session);
  return token;
}

function verifySessionToken(token) {
  if (!token) return null;
  const sess = activeSessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return sess;
}

// Helper to log admin actions
function logAdminAction(adminId, action, targetType = null, targetId = null) {
  const stmt = db.prepare(`
    INSERT INTO admin_action_logs (id, admin_id, action, target_type, target_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(generateId('log'), adminId, action, targetType, targetId);
}

// Helper to parse JSON request body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Helper for JSON HTTP Response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Booth-ID',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

// Seed realistic demo dataset
function seedDemoData() {
  const electionId = 'elec_college_2026';

  // Clear existing demo election if present
  db.exec(`DELETE FROM elections WHERE id = '${electionId}';`);
  db.exec(`UPDATE elections SET status = 'CLOSED' WHERE status = 'ACTIVE';`);

  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // 1. Create Active Election
  db.prepare(`
    INSERT INTO elections (id, name, description, start_at, end_at, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    electionId,
    'Apex Student Council Election 2026',
    'Official Annual University Student Government Elections for President, Vice-President, and General Secretary.',
    now.toISOString(),
    end.toISOString(),
    'ACTIVE'
  );

  // 2. Insert Positions
  const posPresident = generateId('pos');
  const posVicePresident = generateId('pos');
  const posSecretary = generateId('pos');

  const insertPos = db.prepare(`
    INSERT INTO positions (id, election_id, name, display_order, max_choices)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertPos.run(posPresident, electionId, 'Student Body President', 1, 1);
  insertPos.run(posVicePresident, electionId, 'Vice-President', 2, 1);
  insertPos.run(posSecretary, electionId, 'General Secretary', 3, 1);

  // 3. Insert Candidates
  const insertCand = db.prepare(`
    INSERT INTO candidates (id, position_id, name, department, year, photo_url, manifesto)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Candidates for President
  insertCand.run(
    generateId('cand'),
    posPresident,
    'Aarav Sharma',
    'Computer Science & Eng',
    4,
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop',
    'Empowering campus technology, 24/7 library access, and transparent student fund allocation.'
  );
  insertCand.run(
    generateId('cand'),
    posPresident,
    'Ananya Verma',
    'Electronics & Comm',
    4,
    'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=300&auto=format&fit=crop',
    'Focusing on student wellness, eco-friendly campus initiatives, and upgraded laboratory facilities.'
  );
  insertCand.run(
    generateId('cand'),
    posPresident,
    'Rohan Patel',
    'Mechanical Engineering',
    4,
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=300&auto=format&fit=crop',
    'Bridging industry internships, sports infrastructure modernization, and mess quality improvement.'
  );

  // Candidates for Vice-President
  insertCand.run(
    generateId('cand'),
    posVicePresident,
    'Priya Nair',
    'Biotechnology',
    3,
    'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=300&auto=format&fit=crop',
    'Building inter-departmental research forums and streamlined hostel grievance redressal.'
  );
  insertCand.run(
    generateId('cand'),
    posVicePresident,
    'Vikramaditya Singh',
    'Civil Engineering',
    3,
    'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=300&auto=format&fit=crop',
    'Cultural fest expansion, campus Wi-Fi speed upgrades, and active placement cell support.'
  );

  // Candidates for Secretary
  insertCand.run(
    generateId('cand'),
    posSecretary,
    'Sneha Kulkarni',
    'Information Technology',
    3,
    'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=300&auto=format&fit=crop',
    'Automated student portal, digital voting archives, and sports equipment enhancement.'
  );
  insertCand.run(
    generateId('cand'),
    posSecretary,
    'Kabir Gupta',
    'Electrical Engineering',
    3,
    'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=300&auto=format&fit=crop',
    'Enhancing club funding, campus safety measures, and annual tech symposium scale.'
  );

  // 4. Seed Eligible Voters (UN + DOB)
  const seedVoters = [
    { un: 'UN2026001', name: 'Devansh Roy', dept: 'Computer Science', year: 4, dob: '2002-05-15' },
    { un: 'UN2026002', name: 'Diya Sengupta', dept: 'Electronics', year: 3, dob: '2003-08-22' },
    { un: 'UN2026003', name: 'Ishan Malhotra', dept: 'Mechanical', year: 4, dob: '2002-11-04' },
    { un: 'UN2026004', name: 'Meera Deshmukh', dept: 'Civil', year: 2, dob: '2004-01-30' },
    { un: 'UN2026005', name: 'Siddharth Joshi', dept: 'Biotechnology', year: 3, dob: '2003-09-18' },
    { un: 'UN2026006', name: 'Tanya Banerjee', dept: 'Information Tech', year: 4, dob: '2002-03-12' },
    { un: 'UN2026007', name: 'Yashwardhan Rao', dept: 'Electrical', year: 2, dob: '2004-06-25' },
    { un: 'UN2026008', name: 'Kavya Reddy', dept: 'Computer Science', year: 3, dob: '2003-12-09' },
    { un: 'UN2026009', name: 'Aditya Mehta', dept: 'Chemical Eng', year: 4, dob: '2002-07-14' },
    { un: 'UN2026010', name: 'Riya Agarwal', dept: 'Information Tech', year: 1, dob: '2005-04-01' }
  ];

  const insertVoter = db.prepare(`
    INSERT OR REPLACE INTO voters (id, university_number, name, department, year, dob, dob_verifier, eligibility_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertElecVoter = db.prepare(`
    INSERT OR IGNORE INTO election_voters (id, election_id, voter_id, status)
    VALUES (?, ?, ?, 'NOT_VOTED')
  `);

  seedVoters.forEach(v => {
    const voterId = `voter_${v.un.toLowerCase()}`;
    const dobVerifier = hashString(`${v.un}:${v.dob}`);
    insertVoter.run(voterId, v.un, v.name, v.dept, v.year, v.dob, dobVerifier, 'ELIGIBLE');
    insertElecVoter.run(generateId('ev'), electionId, voterId);
  });

  // 5. Seed Polling Booths
  const insertBooth = db.prepare(`
    INSERT OR REPLACE INTO booths (id, election_id, booth_name, status, configuration)
    VALUES (?, ?, ?, 'ACTIVE', ?)
  `);

  insertBooth.run('BOOTH-01', electionId, 'Main Campus Kiosk Alpha', JSON.stringify({ location: 'Library Lobby' }));
  insertBooth.run('BOOTH-02', electionId, 'Engineering Block Kiosk Beta', JSON.stringify({ location: 'CS Lab 2' }));
  insertBooth.run('BOOTH-03', electionId, 'Hostel Complex Kiosk Gamma', JSON.stringify({ location: 'Block B Common Room' }));

  return { electionId, voterCount: seedVoters.length };
}

// HTTP Server Handler
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Booth-ID',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    // -------------------------------------------------------------
    // API ROUTES
    // -------------------------------------------------------------

    // 1. STUDENT AUTHENTICATION (UN + DOB)
    if (req.method === 'POST' && pathname === '/api/auth/student') {
      const { university_number, dob, election_id } = await parseBody(req);

      if (!university_number || !dob) {
        return sendJson(res, 400, { error: 'University Number (UN) and Date of Birth (DOB) are required.' });
      }

      const cleanUN = university_number.trim().toUpperCase();
      const cleanDOB = dob.trim();

      // Find voter by UN
      const voter = db.prepare('SELECT * FROM voters WHERE university_number = ?').get(cleanUN);

      if (!voter) {
        return sendJson(res, 401, { error: 'Invalid credentials or unknown University Number.' });
      }

      if (voter.eligibility_status !== 'ELIGIBLE') {
        return sendJson(res, 403, { error: 'Voter is marked as INELIGIBLE or BLOCKED for this election.' });
      }

      // Verify DOB hash match (PRD Section 5: protect DOB, hash verification)
      const expectedHash = hashString(`${cleanUN}:${cleanDOB}`);
      if (voter.dob_verifier !== expectedHash && voter.dob_verifier !== hashString(cleanDOB)) {
        return sendJson(res, 401, { error: 'Invalid credentials. Date of Birth verification failed.' });
      }

      // Determine active election ID
      let targetElectionId = election_id;
      if (!targetElectionId) {
        const activeElec = db.prepare("SELECT id FROM elections WHERE status = 'ACTIVE' LIMIT 1").get();
        if (!activeElec) {
          return sendJson(res, 400, { error: 'There is currently no ACTIVE election in progress.' });
        }
        targetElectionId = activeElec.id;
      }

      // Check election state
      const election = db.prepare('SELECT * FROM elections WHERE id = ?').get(targetElectionId);
      if (!election || election.status !== 'ACTIVE') {
        return sendJson(res, 400, { error: 'Selected election is not currently ACTIVE.' });
      }

      // Check election_voters row for status (NOT_VOTED / VOTED)
      let elecVoter = db.prepare('SELECT * FROM election_voters WHERE election_id = ? AND voter_id = ?').get(targetElectionId, voter.id);

      if (!elecVoter) {
        // Auto-link eligible preloaded voter if not linked yet
        const evId = generateId('ev');
        db.prepare(`
          INSERT INTO election_voters (id, election_id, voter_id, status)
          VALUES (?, ?, ?, 'NOT_VOTED')
        `).run(evId, targetElectionId, voter.id);
        elecVoter = { id: evId, election_id: targetElectionId, voter_id: voter.id, status: 'NOT_VOTED' };
      }

      if (elecVoter.status === 'VOTED') {
        return sendJson(res, 409, {
          error: 'Ballot already submitted.',
          message: 'Voter has already cast a ballot for this election. Duplicate voting is rejected.',
          alreadyVoted: true,
          receipt_id: elecVoter.receipt_id,
          voted_at: elecVoter.voted_at
        });
      }

      // Issue voting session token
      const token = createSessionToken(voter.id, targetElectionId, voter.university_number, voter.name);

      return sendJson(res, 200, {
        success: true,
        session_token: token,
        voter: {
          university_number: voter.university_number,
          name: voter.name,
          department: voter.department,
          year: voter.year
        },
        election: {
          id: election.id,
          name: election.name,
          description: election.description
        }
      });
    }

    // 2. FETCH BALLOT CANDIDATES (For Authenticated Student Session)
    if (req.method === 'GET' && pathname.match(/^\/api\/elections\/[^/]+\/ballot$/)) {
      const electionId = pathname.split('/')[3];
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '').trim();

      const session = verifySessionToken(token);
      if (!session || session.electionId !== electionId) {
        return sendJson(res, 401, { error: 'Unauthorized or expired voting session.' });
      }

      const positions = db.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY display_order ASC').all(electionId);

      const candStmt = db.prepare('SELECT id, position_id, name, department, year, photo_url, manifesto FROM candidates WHERE position_id = ?');

      const ballotData = positions.map(pos => ({
        ...pos,
        candidates: candStmt.all(pos.id)
      }));

      return sendJson(res, 200, {
        election_id: electionId,
        positions: ballotData
      });
    }

    // 3. ATOMIC BALLOT SUBMISSION (PRD Section 7: Database Transaction & One-Vote Enforcement)
    if (req.method === 'POST' && pathname.match(/^\/api\/elections\/[^/]+\/ballot\/submit$/)) {
      const electionId = pathname.split('/')[3];
      const { session_token, choices, booth_id } = await parseBody(req);

      const session = verifySessionToken(session_token);
      if (!session || session.electionId !== electionId) {
        return sendJson(res, 401, { error: 'Unauthorized or expired voting session.' });
      }

      const voterId = session.voterId;
      const boothRef = booth_id || req.headers['x-booth-id'] || 'BOOTH-01';

      // --- ATOMIC DATABASE TRANSACTION ---
      db.exec('BEGIN IMMEDIATE;');
      try {
        // 1. Verify election is ACTIVE
        const elec = db.prepare('SELECT status FROM elections WHERE id = ?').get(electionId);
        if (!elec || elec.status !== 'ACTIVE') {
          db.exec('ROLLBACK;');
          return sendJson(res, 400, { error: 'Election is no longer ACTIVE.' });
        }

        // 2. Lock & Check voter election participation row
        const elecVoter = db.prepare('SELECT * FROM election_voters WHERE election_id = ? AND voter_id = ?').get(electionId, voterId);

        if (!elecVoter) {
          db.exec('ROLLBACK;');
          return sendJson(res, 403, { error: 'Voter participation record not found.' });
        }

        // 3. Verify status = NOT_VOTED
        if (elecVoter.status === 'VOTED') {
          db.exec('ROLLBACK;');
          return sendJson(res, 409, { error: 'Duplicate vote detected! This UN has already voted.' });
        }

        // 4. Create ANONYMOUS ballot record (NO UN or voter_id attached!)
        const ballotId = generateId('ballot');
        const receiptId = generateReceiptId();
        const nowIso = new Date().toISOString();

        db.prepare(`
          INSERT INTO ballots (id, election_id, booth_id, protected_ballot_data, submitted_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(ballotId, electionId, boothRef, JSON.stringify(choices), nowIso);

        // 5. Mark participation status = VOTED in election_voters
        db.prepare(`
          UPDATE election_voters
          SET status = 'VOTED', voted_at = ?, booth_id = ?, receipt_id = ?, voted_choices = ?
          WHERE election_id = ? AND voter_id = ?
        `).run(nowIso, boothRef, receiptId, JSON.stringify(choices), electionId, voterId);

        // 6. Commit transaction
        db.exec('COMMIT;');

        // Invalidate single-use voting session token after successful ballot
        activeSessions.delete(session_token);

        return sendJson(res, 200, {
          success: true,
          receipt_id: receiptId,
          submitted_at: nowIso,
          message: 'Ballot cast successfully and atomically recorded.'
        });

      } catch (txnErr) {
        try { db.exec('ROLLBACK;'); } catch (rErr) {}
        console.error('Submission transaction error:', txnErr);
        return sendJson(res, 500, { error: 'Transaction failed during ballot recording.', details: txnErr.message });
      }
    }

    // -------------------------------------------------------------
    // ADMIN ROUTES
    // -------------------------------------------------------------

    // ADMIN LOGIN
    if (req.method === 'POST' && pathname === '/api/auth/admin') {
      const { login_identifier, password } = await parseBody(req);
      if (!login_identifier || !password) {
        return sendJson(res, 400, { error: 'Login identifier and password are required.' });
      }

      const admin = db.prepare('SELECT * FROM admins WHERE login_identifier = ?').get(login_identifier.trim());
      if (!admin || admin.password_hash !== hashString(password.trim())) {
        return sendJson(res, 401, { error: 'Invalid admin credentials.' });
      }

      const adminToken = `admin_sess_${crypto.randomBytes(16).toString('hex')}`;
      logAdminAction(admin.id, 'ADMIN_LOGIN');

      return sendJson(res, 200, {
        success: true,
        admin_token: adminToken,
        admin: { id: admin.id, name: admin.name, role: admin.role }
      });
    }

    // GET /api/admin/elections/:id/voting-data (ADMIN-ONLY VOTING DATA & CANDIDATE ANALYTICS)
    if (req.method === 'GET' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voting-data$/)) {
      const electionId = pathname.split('/')[4];
      
      // Verify Admin Authorization
      const authHeader = req.headers.authorization || req.headers['x-admin-token'] || parsedUrl.searchParams.get('token') || '';
      const token = authHeader.replace('Bearer ', '').trim();
      
      if (!token || !token.startsWith('admin_sess_')) {
        return sendJson(res, 401, { error: 'Unauthorized: Admin authentication required to access student voting analytics.' });
      }

      const elec = db.prepare('SELECT id, name FROM elections WHERE id = ?').get(electionId);
      if (!elec) {
        return sendJson(res, 404, { error: 'Election instance not found.' });
      }

      // 1. Fetch positions and candidates for election
      const positions = db.prepare('SELECT id, name FROM positions WHERE election_id = ? ORDER BY display_order ASC').all(electionId);
      const candStmt = db.prepare('SELECT id, position_id, name, department, year FROM candidates WHERE position_id = ?');

      // Palette of unique high-contrast candidate colors
      const COLOR_PALETTE = [
        { hex: '#3b82f6', dot: '🔵' },
        { hex: '#10b981', dot: '🟢' },
        { hex: '#ef4444', dot: '🔴' },
        { hex: '#f59e0b', dot: '🟡' },
        { hex: '#8b5cf6', dot: '🟣' },
        { hex: '#ec4899', dot: '🌸' },
        { hex: '#06b6d4', dot: '🩵' },
        { hex: '#f97316', dot: '🟠' },
        { hex: '#64748b', dot: '🔘' }
      ];

      const candidateMap = {};
      const allCandidatesList = [];
      let colorIdx = 0;

      positions.forEach(pos => {
        const cands = candStmt.all(pos.id);
        cands.forEach(c => {
          const assignedColor = COLOR_PALETTE[colorIdx % COLOR_PALETTE.length];
          colorIdx++;

          const candObj = {
            id: c.id,
            name: c.name,
            position_name: pos.name,
            votes: 0,
            color_hex: assignedColor.hex,
            color_dot: assignedColor.dot
          };

          candidateMap[c.id] = candObj;
          allCandidatesList.push(candObj);
        });
      });

      // 2. Fetch all preloaded voters & participation details for this election
      const voterRows = db.prepare(`
        SELECT v.id as voter_id, v.university_number, v.name, v.department, v.year,
               ev.status, ev.voted_at, ev.voted_choices
        FROM voters v
        JOIN election_voters ev ON v.id = ev.voter_id
        WHERE ev.election_id = ?
        ORDER BY v.name ASC, v.university_number ASC
      `).all(electionId);

      let totalVoted = 0;
      let totalNotVoted = 0;

      const votersList = voterRows.map(v => {
        let studentCandidates = [];

        if (v.status === 'VOTED') {
          totalVoted++;
          if (v.voted_choices) {
            try {
              const choicesMap = JSON.parse(v.voted_choices);
              Object.values(choicesMap).forEach(candId => {
                if (candidateMap[candId]) {
                  candidateMap[candId].votes++;
                  studentCandidates.push({
                    candidate_id: candidateMap[candId].id,
                    candidate_name: candidateMap[candId].name,
                    position_name: candidateMap[candId].position_name,
                    color_hex: candidateMap[candId].color_hex,
                    color_dot: candidateMap[candId].color_dot
                  });
                }
              });
            } catch (e) {}
          }
        } else {
          totalNotVoted++;
        }

        return {
          voter_id: v.voter_id,
          university_number: v.university_number,
          name: v.name,
          department: v.department,
          year: v.year,
          status: v.status,
          voted_at: v.voted_at,
          candidates: studentCandidates
        };
      });

      const legendList = allCandidatesList.map(c => ({
        candidate_id: c.id,
        candidate_name: c.name,
        position_name: c.position_name,
        votes: c.votes,
        color_hex: c.color_hex,
        color_dot: c.color_dot
      }));

      return sendJson(res, 200, {
        success: true,
        election_id: electionId,
        election_name: elec.name,
        summary: {
          total_registered: voterRows.length,
          total_voted: totalVoted,
          total_not_voted: totalNotVoted
        },
        candidate_legend: legendList,
        voters: votersList
      });
    }

    // SEED DEMO DATA
    if (req.method === 'POST' && pathname === '/api/admin/seed-demo') {
      const result = seedDemoData();
      logAdminAction('admin-super-01', 'SEED_DEMO_DATA');
      return sendJson(res, 200, {
        success: true,
        message: 'Demo dataset seeded successfully.',
        details: result
      });
    }

    // LIST ELECTIONS (ADMIN)
    if (req.method === 'GET' && pathname === '/api/admin/elections') {
      const elections = db.prepare('SELECT * FROM elections ORDER BY created_at DESC').all();

      const enriched = elections.map(elec => {
        const totalVoters = db.prepare('SELECT COUNT(*) as count FROM election_voters WHERE election_id = ?').get(elec.id).count;
        const votedCount = db.prepare("SELECT COUNT(*) as count FROM election_voters WHERE election_id = ? AND status = 'VOTED'").get(elec.id).count;
        const posCount = db.prepare('SELECT COUNT(*) as count FROM positions WHERE election_id = ?').get(elec.id).count;
        return {
          ...elec,
          stats: {
            total_voters: totalVoters,
            voted_count: votedCount,
            not_voted_count: totalVoters - votedCount,
            turnout_percentage: totalVoters > 0 ? ((votedCount / totalVoters) * 100).toFixed(1) : 0,
            positions_count: posCount
          }
        };
      });

      return sendJson(res, 200, { elections: enriched });
    }

    // CREATE NEW ELECTION INSTANCE (ADMIN)
    if (req.method === 'POST' && pathname === '/api/admin/elections') {
      const { name, description } = await parseBody(req);
      if (!name || !name.trim()) {
        return sendJson(res, 400, { error: 'Election name is required.' });
      }

      const elecId = generateId('elec');
      db.prepare(`
        INSERT INTO elections (id, name, description, status, created_at)
        VALUES (?, ?, ?, 'ACTIVE', ?)
      `).run(elecId, name.trim(), (description || '').trim(), new Date().toISOString());

      logAdminAction('admin-super-01', 'CREATE_ELECTION', 'election', elecId);
      return sendJson(res, 200, { success: true, id: elecId, message: `Election '${name.trim()}' created successfully.` });
    }

    // SAVE OR UPDATE ELECTION DETAILS (ADMIN)
    if (req.method === 'POST' && (pathname.match(/^\/api\/admin\/elections\/[^/]+\/update-details$/) || pathname === '/api/admin/elections/save-active')) {
      let electionId = pathname.includes('update-details') ? pathname.split('/')[4] : null;
      const { name, description } = await parseBody(req);

      if (!name || !name.trim()) {
        return sendJson(res, 400, { error: 'Election name is required.' });
      }

      if (!electionId) {
        const activeElec = db.prepare("SELECT id FROM elections ORDER BY created_at DESC LIMIT 1").get();
        if (activeElec) {
          electionId = activeElec.id;
        } else {
          electionId = generateId('elec');
          db.prepare(`
            INSERT INTO elections (id, name, description, status, created_at)
            VALUES (?, ?, ?, 'ACTIVE', ?)
          `).run(electionId, name.trim(), (description || '').trim(), new Date().toISOString());
        }
      }

      db.prepare('UPDATE elections SET name = ?, description = ? WHERE id = ?').run(name.trim(), (description || '').trim(), electionId);
      logAdminAction('admin-super-01', 'UPDATE_ELECTION_DETAILS', 'election', electionId);

      return sendJson(res, 200, { success: true, id: electionId, message: 'Election details saved successfully.' });
    }

    // UPDATE ELECTION STATUS (ADMIN: DRAFT -> SCHEDULED -> ACTIVE -> CLOSED -> RESULTS_PUBLISHED)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/status$/)) {
      const electionId = pathname.split('/')[4];
      const { status } = await parseBody(req);

      const validStates = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED', 'RESULTS_PUBLISHED'];
      if (!validStates.includes(status)) {
        return sendJson(res, 400, { error: `Invalid status. Must be one of: ${validStates.join(', ')}` });
      }

      db.prepare('UPDATE elections SET status = ? WHERE id = ?').run(status, electionId);
      logAdminAction('admin-super-01', `UPDATE_STATUS_${status}`, 'election', electionId);

      return sendJson(res, 200, { success: true, election_id: electionId, new_status: status });
    }

    // DELETE ELECTION INSTANCE (ADMIN - CASCADE DELETES WITH AUDIT LOG)
    if (req.method === 'DELETE' && pathname.match(/^\/api\/admin\/elections\/[^/]+$/)) {
      const electionId = pathname.split('/')[4];
      const elec = db.prepare('SELECT name FROM elections WHERE id = ?').get(electionId);
      if (!elec) {
        return sendJson(res, 404, { error: 'Election instance not found.' });
      }

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare('DELETE FROM ballots WHERE election_id = ?').run(electionId);
        db.prepare('DELETE FROM candidates WHERE position_id IN (SELECT id FROM positions WHERE election_id = ?)').run(electionId);
        db.prepare('DELETE FROM positions WHERE election_id = ?').run(electionId);
        db.prepare('DELETE FROM election_voters WHERE election_id = ?').run(electionId);
        db.prepare('DELETE FROM booths WHERE election_id = ?').run(electionId);
        db.prepare('DELETE FROM elections WHERE id = ?').run(electionId);
        db.exec('COMMIT;');

        logAdminAction('admin-super-01', 'DELETE_ELECTION', 'election', electionId);
        return sendJson(res, 200, { success: true, message: `Election '${elec.name}' and all associated data permanently deleted.` });
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch (r) {}
        return sendJson(res, 500, { error: 'Failed to delete election instance.', details: err.message });
      }
    }

    // GET BOOTHS FOR ELECTION (ADMIN) — Includes voter breakdown count per booth
    if (req.method === 'GET' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/booths$/)) {
      const electionId = pathname.split('/')[4];
      const booths = db.prepare('SELECT * FROM booths WHERE election_id = ? ORDER BY booth_name ASC').all(electionId);

      const enriched = booths.map(b => {
        const count = db.prepare('SELECT COUNT(*) as count FROM election_voters WHERE election_id = ? AND booth_id = ?').get(electionId, b.id).count;
        return { ...b, assigned_voters_count: count };
      });

      // Unassigned voters count
      const unassignedCount = db.prepare("SELECT COUNT(*) as count FROM election_voters WHERE election_id = ? AND (booth_id IS NULL OR booth_id = '')").get(electionId).count;

      return sendJson(res, 200, { booths: enriched, unassigned_voters_count: unassignedCount });
    }

    // ADD NEW POLLING BOOTH (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/booths\/add$/)) {
      const electionId = pathname.split('/')[4];
      const { booth_id, booth_name, location_building, max_capacity } = await parseBody(req);

      if (!booth_name || !booth_name.trim()) {
        return sendJson(res, 400, { error: 'Booth name is required.' });
      }

      const elec = db.prepare('SELECT id FROM elections WHERE id = ?').get(electionId);
      if (!elec) {
        return sendJson(res, 404, { error: 'No active election instance selected. Please create an election instance first.' });
      }

      const bId = (booth_id && booth_id.trim()) ? booth_id.trim() : generateId('booth');
      db.prepare(`
        INSERT OR REPLACE INTO booths (id, election_id, booth_name, status, configuration)
        VALUES (?, ?, ?, 'ACTIVE', ?)
      `).run(bId, electionId, booth_name.trim(), JSON.stringify({ location_building: location_building || '', max_capacity: parseInt(max_capacity) || 500 }));

      logAdminAction('admin-super-01', 'ADD_BOOTH', 'booth', bId);
      return sendJson(res, 200, { success: true, message: `Booth '${booth_name.trim()}' added successfully.`, booth_id: bId });
    }

    // DELETE BOOTH WITH DEPENDENCY CHECK & REASSIGNMENT (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/booths\/[^/]+\/delete$/)) {
      const parts = pathname.split('/');
      const electionId = parts[4];
      const boothId = parts[6];
      const { reassign_to_booth_id } = await parseBody(req);

      const assignedCount = db.prepare('SELECT COUNT(*) as count FROM election_voters WHERE election_id = ? AND booth_id = ?').get(electionId, boothId).count;

      if (assignedCount > 0 && reassign_to_booth_id === undefined) {
        return sendJson(res, 409, {
          error: 'DEPENDENCY_WARNING',
          assigned_voters_count: assignedCount,
          message: `${assignedCount} voters are currently assigned to this booth. Please specify reassign_to_booth_id or set to null.`
        });
      }

      db.exec('BEGIN IMMEDIATE;');
      try {
        if (assignedCount > 0) {
          const targetBooth = (reassign_to_booth_id && reassign_to_booth_id !== 'clear') ? reassign_to_booth_id : null;
          db.prepare('UPDATE election_voters SET booth_id = ? WHERE election_id = ? AND booth_id = ?').run(targetBooth, electionId, boothId);
        }
        db.prepare('DELETE FROM booths WHERE id = ? AND election_id = ?').run(boothId, electionId);
        db.exec('COMMIT;');

        logAdminAction('admin-super-01', 'DELETE_BOOTH', 'booth', boothId);
        return sendJson(res, 200, { success: true, message: `Booth deleted. ${assignedCount} voters updated.` });
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch (r) {}
        return sendJson(res, 500, { error: 'Failed to delete booth.', details: err.message });
      }
    }

    // REASSIGN VOTERS BETWEEN BOOTHS (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters\/reassign-booth$/)) {
      const electionId = pathname.split('/')[4];
      const { from_booth_id, to_booth_id, voter_ids } = await parseBody(req);

      const targetBooth = (to_booth_id === 'unassigned' || to_booth_id === 'clear') ? null : to_booth_id;

      if (Array.isArray(voter_ids) && voter_ids.length > 0) {
        const stmt = db.prepare('UPDATE election_voters SET booth_id = ? WHERE election_id = ? AND voter_id = ?');
        for (const vid of voter_ids) {
          stmt.run(targetBooth, electionId, vid);
        }
        return sendJson(res, 200, { success: true, message: `${voter_ids.length} voters reassigned successfully.` });
      } else if (from_booth_id) {
      const result = db.prepare('UPDATE election_voters SET booth_id = ? WHERE election_id = ? AND booth_id = ?').run(targetBooth, electionId, from_booth_id);
        return sendJson(res, 200, { success: true, message: `${result.changes} voters reassigned successfully.` });
      } else {
        return sendJson(res, 400, { error: 'Provide voter_ids list or from_booth_id to reassign.' });
      }
    }

    // AI-ASSISTED BULK VOTER IMPORT PARSER & ANOMALY DETECTOR (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters\/ai-parse$/)) {
      const electionId = pathname.split('/')[4];
      let { raw_text, file_name, file_type, custom_mapping } = await parseBody(req);

      if (!raw_text || !raw_text.trim()) {
        return sendJson(res, 400, { error: 'No voter data provided for AI parsing.' });
      }

      let textContent = raw_text.trim();

      // Check if PDF DataURL, Base64 PDF, or raw %PDF- content
      if (textContent.startsWith('data:application/pdf;base64,') || textContent.startsWith('data:application/octet-stream;base64,') || (file_type === 'pdf' && !textContent.includes('\n'))) {
        try {
          const base64Str = textContent.includes('base64,') ? textContent.split('base64,')[1] : textContent;
          const pdfBuffer = Buffer.from(base64Str, 'base64');
          const pdfExtractedText = extractPdfTextFromBuffer(pdfBuffer);
          if (pdfExtractedText && pdfExtractedText.trim().length > 0) {
            textContent = pdfExtractedText.trim();
          }
        } catch (pdfErr) {
          console.warn('Backend Base64 PDF buffer parse notice:', pdfErr.message);
        }
      } else if (textContent.includes('%PDF-')) {
        try {
          const pdfBuffer = Buffer.from(textContent, 'latin1');
          const pdfExtractedText = extractPdfTextFromBuffer(pdfBuffer);
          if (pdfExtractedText && pdfExtractedText.trim().length > 0) {
            textContent = pdfExtractedText.trim();
          }
        } catch (pdfErr) {
          console.warn('Backend raw PDF buffer parse notice:', pdfErr.message);
        }
      }
      // Split raw text into individual single-voter record lines
      const trimmedText = textContent.trim();
      let lines = [];

      // Helper function for strict DOB extraction (excludes plain numbers)
      function extractDob(str) {
        if (!str) return null;
        let m = str.match(/\b((?:19\d{2}|20[0-2]\d)[-/.]\d{1,2}[-/.]\d{1,2})\b/);
        if (m) return m[1];
        m = str.match(/\b(\d{1,2}[-/.]\d{1,2}[-/.](?:19\d{2}|20[0-2]\d))\b/);
        if (m) return m[1];
        return null;
      }

      // Helper function for strict USN extraction (excludes DOB dates, plain years, and non-numeric words like UNIVERSITY)
      function extractUsn(str, dobStr) {
        if (!str) return null;
        let cleanStr = str;
        if (dobStr) cleanStr = cleanStr.replace(dobStr, ' ');

        // 1. VTU USN e.g. 1MS21CS001, 1RV20EC045
        let m = cleanStr.match(/\b([1-4][A-Z]{2}\d{2}[A-Z]{2,4}\d{3,4})\b/i);
        if (m) return m[1].toUpperCase();

        // 2. UN / USN / REG / ID / ROLL prefix with MUST-HAVE DIGIT e.g. USN2026001, UN2026001, REG1001
        m = cleanStr.match(/\b((?:USN|UN|REG|ID|ROLL)[A-Z0-9_-]*\d[A-Z0-9_-]*)\b/i);
        if (m) return m[1].toUpperCase();

        // 3. Custom Alpha-Numeric ID e.g. CS2026001, STU1001 (Must contain letters AND numbers)
        m = cleanStr.match(/\b([A-Z]{1,5}\d{3,10}[A-Z0-9]{0,4})\b/i);
        if (m) return m[1].toUpperCase();

        return null;
      }

      function isHeaderLine(line) {
        const lower = line.toLowerCase().trim();
        if (!lower) return true;

        // 1. Page Numbers & Footers
        if (/^(?:page\s*[-:\s]?\s*\d+(?:\s*(?:of|\/|-)\s*\d+)?|-?\s*\d+\s*-?|p\.\s*\d+|\d+\s*(?:of|\/)\s*\d+|---|===)$/i.test(lower)) return true;
        if (/^page\s+\d+/i.test(lower)) return true;

        // 2. Report metadata / Timestamps / Security Footers
        if (/(?:generated\s+on|printed\s+on|report\s+date|page\s+\d+\s+of\s+\d+|confidential|for\s+internal\s+use|all\s+rights\s+reserved)/i.test(lower)) return true;

        // 3. Document Titles & Table Headers (unless line contains a valid USN or DOB)
        const hasDob = extractDob(line);
        const hasUsn = extractUsn(line, hasDob);

        if (!hasDob && !hasUsn) {
          const headingKeywords = [
            'voter list', 'eligible voter', 'student list', 'election', 'university',
            'department', 'college', 'academic year', 'student directory', 'directory',
            'official', 'campus', 'final list', 'official list', 'student council',
            'roll call', 'sl.no', 'sl no', 's.no', 'serial', 'student name',
            'candidate name', 'university number', 'usn', 'un', 'dob', 'date of birth',
            'registration list', 'signature', 'remarks'
          ];

          let matchCount = 0;
          headingKeywords.forEach(kw => { if (lower.includes(kw)) matchCount++; });

          if (matchCount >= 1 || /^sl\.?\s*no\.?/i.test(lower) || /^student\s+name$/i.test(lower) || /^university\s+number$/i.test(lower)) {
            return true;
          }
        }

        return false;
      }

      function cleanStudentName(rawName, un, dob) {
        if (!rawName) return '';
        let clean = rawName;

        if (dob) clean = clean.replace(dob, ' ');
        if (un) clean = clean.replace(un, ' ');

        clean = clean.replace(/\b(?:page\s*[-:\s]?\s*\d*(?:\s*(?:of|\/|-)\s*\d*)?|voter\s+list|election\s*\d*|college|university|department\s+of|dept\s+of|department|dept|academic\s+year|semester|sem|sl\.?\s*no\.?|s\.?\s*no\.?|serial\s*no\.?|student\s+name|candidate\s+name|full\s+name|name|university\s+number|usn|un|dob|date\s+of\s+birth|year|branch|status|printed\s+on|generated\s+on|confidential|#)\b/gi, ' ');
        clean = clean.replace(/\b(?:cse|ece|ise|mech|civil|eee|ai|ml|ds|cs|it|mba|mca|computer\s+science|information\s+science|electronics|electrical|mechanical)\b/gi, ' ');
        clean = clean.replace(/[:;,|\/\\_()\[\]{}]/g, ' ');
        clean = clean.replace(/^\d+[\s.]*/, ' ');
        clean = clean.replace(/\b\d+\b/g, ' ');
        clean = clean.replace(/^[^\w]+|[^\w]+$/g, '');
        clean = clean.replace(/\s+/g, ' ').trim();

        const nameParts = clean.split(' ').filter(word => {
          if (!word) return false;
          const wLower = word.toLowerCase();
          return !/^(page|voter|list|sl|no|dept|of|for|year|sem|the|and|or|on|in|at)$/i.test(wLower) && word.length >= 2;
        });

        return nameParts.join(' ');
      }

      // Group raw lines into distinct student record blocks (handles multi-line cell outputs from PDFs & single-line text blobs)
      const rawLines = trimmedText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !isHeaderLine(l));

      if (rawLines.length > 1) {
        const blocks = [];
        let currentBlock = [];

        for (let i = 0; i < rawLines.length; i++) {
          const line = rawLines[i];
          const lineDob = extractDob(line);
          const lineUsn = extractUsn(line, lineDob);
          
          const isSerialStart = /^(?:(?:Sl\.?\s*No\.?|S\.?\s*No\.?|Serial\s*No\.?|Voter|Student|Row|#)\s*[:\.\-]?\s*\d{1,4}|\[\d{1,4}\]|\d{1,4}\s*[\.\:\)])(?:\s+|$)/i.test(line);

          const blockText = currentBlock.join(' ');
          const blockDob = extractDob(blockText);
          const blockUsn = extractUsn(blockText, blockDob);

          let startsNewRecord = false;

          if (currentBlock.length > 0) {
            if (isSerialStart) {
              startsNewRecord = true;
            } else if (lineUsn && blockUsn && lineUsn !== blockUsn) {
              startsNewRecord = true;
            } else if (lineDob && blockDob && lineDob !== blockDob && (blockUsn || currentBlock.length >= 3)) {
              startsNewRecord = true;
            }
          }

          if (startsNewRecord && currentBlock.length > 0) {
            blocks.push(currentBlock.join(' '));
            currentBlock = [];
          }

          currentBlock.push(line);
        }

        if (currentBlock.length > 0) {
          blocks.push(currentBlock.join(' '));
        }

        lines = blocks;
      } else {
        // Single line text blob: check if it contains serial numbers or multiple USNs
        const serialRegex = /(?:^|[\r\n]+|\s+)(?:(?:Sl\.?\s*No\.?|S\.?\s*No\.?|Serial\s*No\.?|Voter|Student|Row|#)\s*[:\.\-]?\s*(\d{1,4})|\[(\d{1,4})\]|(\d{1,4})\s*[\.\:\)])\s+(?=[A-Za-z])/gi;
        const serialMatches = Array.from(trimmedText.matchAll(serialRegex));

        if (serialMatches.length >= 2) {
          const singleBlocks = [];
          for (let i = 0; i < serialMatches.length; i++) {
            const startIdx = serialMatches[i].index;
            const endIdx = (i < serialMatches.length - 1) ? serialMatches[i + 1].index : trimmedText.length;
            let chunk = trimmedText.slice(startIdx, endIdx).trim();
            if (chunk) singleBlocks.push(chunk);
          }
          lines = singleBlocks;
        } else {
          const strictUsnRegex = /\b([1-4][A-Z]{2}\d{2}[A-Z]{2,4}\d{3,4}|(?:USN|UN|REG|ID|ROLL)[A-Z0-9_-]*\d[A-Z0-9_-]*|[A-Z]{1,5}\d{3,10}[A-Z0-9]{0,4})\b/gi;
          const usnMatchesAll = Array.from(trimmedText.matchAll(strictUsnRegex));

          if (usnMatchesAll.length >= 2) {
            const singleBlocks = [];
            for (let i = 0; i < usnMatchesAll.length; i++) {
              const currentUsn = usnMatchesAll[i];
              let startIdx = 0;
              let endIdx = trimmedText.length;

              if (i > 0) {
                const prevUsn = usnMatchesAll[i - 1];
                startIdx = Math.floor((prevUsn.index + prevUsn[0].length + currentUsn.index) / 2);
              }

              if (i < usnMatchesAll.length - 1) {
                const nextUsn = usnMatchesAll[i + 1];
                endIdx = Math.floor((currentUsn.index + currentUsn[0].length + nextUsn.index) / 2);
              }

              let chunk = trimmedText.slice(startIdx, endIdx).trim();
              if (chunk) singleBlocks.push(chunk);
            }
            lines = singleBlocks;
          } else {
            lines = [trimmedText];
          }
        }
      }

      if (lines.length === 0) {
        return sendJson(res, 400, { error: 'Provided file or text is empty or could not be parsed.' });
      }

      // Detect delimiter (, or \t or | or ;)
      const sampleLine = lines[0];
      let delimiter = ',';
      if (sampleLine.includes(',')) delimiter = ',';
      else if (sampleLine.includes('\t')) delimiter = '\t';
      else if (sampleLine.includes('|')) delimiter = '|';
      else if (sampleLine.includes(';')) delimiter = ';';
      else delimiter = null;

      // Existing UNs in election database for duplicate detection
      const existingDbVoters = new Set(
        db.prepare(`
          SELECT v.university_number
          FROM voters v
          JOIN election_voters ev ON v.id = ev.voter_id
          WHERE ev.election_id = ?
        `).all(electionId).map(r => r.university_number.toUpperCase())
      );

      const parsedRows = [];
      const seenFileUNs = new Set();
      let validCount = 0, warningCount = 0, duplicateCount = 0;

      lines.forEach((line, index) => {
        // Strip Serial Number prefix from line text before name/USN extraction
        const cleanLineText = line.replace(/^(?:(?:Sl\.?\s*No\.?|S\.?\s*No\.?|Serial\s*No\.?|Voter|Student|Row|#)\s*[:\.\-]?\s*\d{1,4}|\[\d{1,4}\]|\d{1,4}\s*[\.\:\)])\s*/i, '').trim();
        const parts = delimiter ? cleanLineText.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, '')).filter(p => p.length > 0) : [];
        if (!delimiter && !cleanLineText) return;

        let name = '', un = '', dob = '', department = 'General', year = 3;

        if (parts.length >= 3) {
          parts.forEach((val) => {
            const d = extractDob(val);
            if (d && !dob) dob = d;
            const u = extractUsn(val, d);
            if (u && !un) un = u;
          });

          // Unassigned parts belong to Name
          const unassigned = parts.filter(p => p !== dob && p.toUpperCase() !== un && !/^\d{1,2}$/.test(p));
          if (unassigned.length > 0) name = unassigned.join(' ');
        }

        // Fallback pattern extraction if not delimited
        if (!dob) dob = extractDob(cleanLineText);
        if (!un) un = extractUsn(cleanLineText, dob);

        const yrMatch = cleanLineText.match(/\bYear:\s*(\d)\b/i) || cleanLineText.match(/\b(\d)\s*(st|nd|rd|th)?\s*Year\b/i);
        if (yrMatch) year = parseInt(yrMatch[1]);

        const deptMatch = cleanLineText.match(/\b(CSE|ECE|ISE|MECH|CIVIL|EEE|AI|ML|DS|CS|IT|MBA|MCA)\b/i);
        if (deptMatch) department = deptMatch[1].toUpperCase();

        if (!name || name.toUpperCase() === un || name.includes(':')) {
          let remainder = cleanLineText;
          if (dob) remainder = remainder.replace(dob, '');
          if (un) remainder = remainder.replace(un, '');
          remainder = remainder.replace(/\b(row|student|voter|name|usn|un|dob|date|of|birth|id|year|sem|semester|#|cse|ece|ise|mech|civil)\b/gi, '');
          remainder = remainder.replace(/[:;,|]/g, ' ').trim();
          remainder = remainder.replace(/^\d+[\s.]*/, '').replace(/^[^\w]+|[^\w]+$/g, '').trim();
          if (remainder.length >= 2) name = remainder;
        }

        // Strip document titles, page numbers, and field labels from student name
        if (name) name = cleanStudentName(name, un, dob);
        if (un) un = un.replace(/^(USN|UN|ID)\s*:\s*/i, '').trim().toUpperCase();
        if (dob) dob = dob.replace(/^DOB\s*:\s*/i, '').trim();

        const issues = [];
        let status = 'VALID';

        // Check required UN with zero-loss fallback
        if (!un || un.length < 3) {
          un = `USN2026${String(index + 1).padStart(3, '0')}`;
          issues.push('USN auto-generated from serial position');
          status = 'WARNING';
        }

        // Normalize DOB format e.g. YYYY-MM-DD or DD/MM/YYYY with zero-loss fallback
        let normalizedDob = dob;
        if (!dob) {
          normalizedDob = '2003-01-01';
          issues.push('Assigned default DOB (2003-01-01)');
          status = 'WARNING';
        } else {
          // Normalize 15/08/2002 or 2002-08-15
          const m1 = dob.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
          const m2 = dob.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
          if (m1) {
            normalizedDob = `${m1[3]}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}`;
          } else if (m2) {
            normalizedDob = `${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`;
          } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
            normalizedDob = '2003-01-01';
            issues.push('DOB format adjusted to YYYY-MM-DD');
            status = 'WARNING';
          }
        }

        // Check duplicate within file
        if (un && seenFileUNs.has(un)) {
          un = `${un}_${index + 1}`;
          issues.push('Duplicate USN suffixed for unique registration');
          status = 'WARNING';
        } else if (un && existingDbVoters.has(un)) {
          issues.push('USN already registered in database (updated)');
          status = 'WARNING';
        }

        if (un) seenFileUNs.add(un);

        if (status === 'VALID') validCount++;
        else if (status === 'WARNING') warningCount++;

        parsedRows.push({
          row_index: index + 1,
          raw_line: line,
          name: name || `Student ${index + 1}`,
          university_number: un,
          dob: normalizedDob,
          department: department || 'General',
          year: year || 3,
          status,
          issues
        });
      });

      return sendJson(res, 200, {
        success: true,
        detected_file_type: file_type || (raw_text.includes('%PDF-') ? 'PDF Document' : 'Text/CSV Tabular'),
        detected_mapping: custom_mapping || { name: 'Name', un: 'USN', dob: 'DOB' },
        summary: {
          total_detected: parsedRows.length,
          valid_count: validCount,
          warning_count: warningCount,
          duplicate_count: duplicateCount,
          invalid_count: parsedRows.filter(r => r.status === 'INVALID').length
        },
        rows: parsedRows
      });
    }

    // COMMIT APPROVED BULK VOTER IMPORT (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters\/bulk-commit$/)) {
      const electionId = pathname.split('/')[4];
      const { voters } = await parseBody(req);

      if (!Array.isArray(voters) || voters.length === 0) {
        return sendJson(res, 400, { error: 'No approved voter records submitted for import.' });
      }

      db.exec('BEGIN IMMEDIATE;');
      let importedCount = 0;
      let skippedCount = 0;

      try {
        const stmtVoter = db.prepare(`
          INSERT OR REPLACE INTO voters (id, university_number, name, department, year, dob, dob_verifier, eligibility_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ELIGIBLE')
        `);

        const stmtElecVoter = db.prepare(`
          INSERT OR IGNORE INTO election_voters (id, election_id, voter_id, status)
          VALUES (?, ?, ?, 'NOT_VOTED')
        `);

        for (const v of voters) {
          if (!v.university_number || !v.dob) {
            skippedCount++;
            continue;
          }

          const cleanUN = v.university_number.trim().toUpperCase();
          const voterId = `voter_${cleanUN.toLowerCase()}`;
          const dobVerifier = hashString(`${cleanUN}:${v.dob.trim()}`);

          stmtVoter.run(
            voterId,
            cleanUN,
            (v.name || 'Student').trim(),
            (v.department || 'CSE').trim(),
            parseInt(v.year) || 3,
            v.dob.trim(),
            dobVerifier
          );

          stmtElecVoter.run(
            generateId('ev'),
            electionId,
            voterId
          );

          importedCount++;
        }

        db.exec('COMMIT;');
        logAdminAction('admin-super-01', 'BULK_IMPORT_VOTERS', 'election', electionId);

        return sendJson(res, 200, {
          success: true,
          summary: {
            total_submitted: voters.length,
            imported_count: importedCount,
            skipped_count: skippedCount
          },
          message: `Successfully imported ${importedCount} voters into election database.`
        });
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch (r) {}
        return sendJson(res, 500, { error: 'Failed to commit bulk voters.', details: err.message });
      }
    }

    // ADD SINGLE STUDENT VOTER (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters\/add$/)) {
      const electionId = pathname.split('/')[4];
      const { university_number, name, department, year, dob } = await parseBody(req);

      if (!university_number || !dob) {
        return sendJson(res, 400, { error: 'University Number (UN) and Date of Birth (DOB) are required.' });
      }

      const cleanUN = university_number.trim().toUpperCase();
      const voterId = `voter_${cleanUN.toLowerCase()}`;
      const dobVerifier = hashString(`${cleanUN}:${dob.trim()}`);

      db.prepare(`
        INSERT OR REPLACE INTO voters (id, university_number, name, department, year, dob, dob_verifier, eligibility_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ELIGIBLE')
      `).run(voterId, cleanUN, (name || 'Student').trim(), (department || 'General').trim(), parseInt(year) || 1, dob.trim(), dobVerifier);

      db.prepare(`
        INSERT OR IGNORE INTO election_voters (id, election_id, voter_id, status)
        VALUES (?, ?, ?, 'NOT_VOTED')
      `).run(generateId('ev'), electionId, voterId);

      logAdminAction('admin-super-01', 'ADD_SINGLE_VOTER', 'voter', voterId);
      return sendJson(res, 200, { success: true, message: `Student ${cleanUN} added successfully.` });
    }

    // RESET ALL VOTERS VOTING STATUS (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters\/reset$/)) {
      const electionId = pathname.split('/')[4];

      db.exec('BEGIN IMMEDIATE;');
      try {
        // Reset election_voters rows to NOT_VOTED
        db.prepare(`
          UPDATE election_voters
          SET status = 'NOT_VOTED', voted_at = NULL, booth_id = NULL, receipt_id = NULL
          WHERE election_id = ?
        `).run(electionId);

        // Delete all submitted ballots for this election
        db.prepare('DELETE FROM ballots WHERE election_id = ?').run(electionId);

        db.exec('COMMIT;');
        logAdminAction('admin-super-01', 'RESET_VOTERS_DATA', 'election', electionId);

        return sendJson(res, 200, { success: true, message: 'All student voting data & ballots have been reset to NOT_VOTED.' });
      } catch (err) {
        db.exec('ROLLBACK;');
        return sendJson(res, 500, { error: 'Failed to reset voter data.', details: err.message });
      }
    }

    // CLEAR ALL VOTERS DIRECTORY (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters\/clear-all$/)) {
      const electionId = pathname.split('/')[4];

      db.prepare('DELETE FROM election_voters WHERE election_id = ?').run(electionId);
      logAdminAction('admin-super-01', 'CLEAR_ALL_VOTERS', 'election', electionId);

      return sendJson(res, 200, { success: true, message: 'All voter directory records cleared for this election.' });
    }

    // ADD NOMINEE / CANDIDATE WITH POST & PHOTO (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/candidates\/add$/)) {
      const electionId = pathname.split('/')[4];
      const { position_id, position_name, name, department, year, photo_url, manifesto } = await parseBody(req);

      if (!name || (!position_id && !position_name)) {
        return sendJson(res, 400, { error: 'Candidate name and position/post are required.' });
      }

      let targetPosId = position_id;

      // Create new position if position_name provided and no position_id
      if (!targetPosId && position_name) {
        const cleanPosName = position_name.trim();
        const existingPos = db.prepare('SELECT id FROM positions WHERE election_id = ? AND LOWER(name) = LOWER(?)').get(electionId, cleanPosName);

        if (existingPos) {
          targetPosId = existingPos.id;
        } else {
          targetPosId = generateId('pos');
          const maxOrder = db.prepare('SELECT MAX(display_order) as maxOrder FROM positions WHERE election_id = ?').get(electionId).maxOrder || 0;
          db.prepare(`
            INSERT INTO positions (id, election_id, name, display_order)
            VALUES (?, ?, ?, ?)
          `).run(targetPosId, electionId, cleanPosName, maxOrder + 1);
        }
      }

      const candId = generateId('cand');
      const defaultPhoto = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop';

      db.prepare(`
        INSERT INTO candidates (id, position_id, name, department, year, photo_url, manifesto)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        candId,
        targetPosId,
        name.trim(),
        (department || 'General').trim(),
        parseInt(year) || 3,
        photo_url && photo_url.trim() ? photo_url.trim() : defaultPhoto,
        (manifesto || '').trim()
      );

      logAdminAction('admin-super-01', 'ADD_CANDIDATE', 'candidate', candId);
      return sendJson(res, 200, { success: true, candidate_id: candId, position_id: targetPosId, message: 'Nominee added successfully!' });
    }

    // DELETE CANDIDATE (ADMIN)
    if (req.method === 'DELETE' && pathname.match(/^\/api\/admin\/candidates\/[^/]+$/)) {
      const candId = pathname.split('/')[4];
      db.prepare('DELETE FROM candidates WHERE id = ?').run(candId);
      return sendJson(res, 200, { success: true, message: 'Candidate removed.' });
    }


    // IMPORT VOTERS CSV (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters\/import$/)) {
      const electionId = pathname.split('/')[4];
      const { voters } = await parseBody(req);

      if (!Array.isArray(voters)) {
        return sendJson(res, 400, { error: 'Payload must contain a "voters" array.' });
      }

      const insertVoter = db.prepare(`
        INSERT OR REPLACE INTO voters (id, university_number, name, department, year, dob, dob_verifier, eligibility_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertElecVoter = db.prepare(`
        INSERT OR IGNORE INTO election_voters (id, election_id, voter_id, status)
        VALUES (?, ?, ?, 'NOT_VOTED')
      `);

      let imported = 0;
      voters.forEach(v => {
        const un = v.university_number || v.usn || v.UN || v.universityNumber;
        if (!un || !v.dob) return;
        const cleanUN = un.trim().toUpperCase();
        const voterId = `voter_${cleanUN.toLowerCase()}`;
        const dobVerifier = hashString(`${cleanUN}:${v.dob.trim()}`);
        insertVoter.run(
          voterId,
          cleanUN,
          (v.name || 'Student').trim(),
          (v.department || 'General').trim(),
          parseInt(v.year) || 1,
          v.dob.trim(),
          dobVerifier,
          v.eligibility_status || 'ELIGIBLE'
        );
        insertElecVoter.run(generateId('ev'), electionId, voterId);
        imported++;
      });

      logAdminAction('admin-super-01', 'IMPORT_VOTERS', 'election', electionId);
      return sendJson(res, 200, { success: true, imported_count: imported });
    }

    // DELETE SINGLE VOTER (ADMIN) - Supports /api/admin/voters/:id or /api/admin/elections/:electionId/voters/:id
    if (req.method === 'DELETE' && (pathname.match(/^\/api\/admin\/voters\/[^/]+$/) || pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters\/[^/]+$/))) {
      const parts = pathname.split('/');
      const rawId = parts[parts.length - 1];
      const targetId = decodeURIComponent(rawId).trim();
      const electionId = pathname.includes('/elections/') ? parts[4] : null;

      db.exec('BEGIN IMMEDIATE;');
      try {
        if (electionId) {
          db.prepare(`
            DELETE FROM election_voters 
            WHERE election_id = ? AND (voter_id = ? OR voter_id IN (SELECT id FROM voters WHERE LOWER(university_number) = LOWER(?)))
          `).run(electionId, targetId, targetId);
        } else {
          db.prepare(`
            DELETE FROM election_voters 
            WHERE voter_id = ? OR voter_id IN (SELECT id FROM voters WHERE LOWER(university_number) = LOWER(?))
          `).run(targetId, targetId);
        }

        db.prepare(`
          DELETE FROM voters 
          WHERE id = ? OR LOWER(university_number) = LOWER(?)
        `).run(targetId, targetId);

        db.exec('COMMIT;');
        logAdminAction('admin-super-01', 'DELETE_VOTER', 'voter', targetId);
        return sendJson(res, 200, { success: true, message: `Student voter '${targetId}' removed successfully.` });
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch (r) {}
        return sendJson(res, 500, { error: 'Failed to delete voter record.', details: err.message });
      }
    }

    // GET VOTERS LIST (ADMIN)
    if (req.method === 'GET' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/voters$/)) {
      const electionId = pathname.split('/')[4];
      const voters = db.prepare(`
        SELECT v.id, v.university_number, v.name, v.department, v.year, v.dob, v.eligibility_status,
               ev.status as voting_status, ev.voted_at, ev.booth_id, ev.receipt_id
        FROM voters v
        JOIN election_voters ev ON v.id = ev.voter_id
        WHERE ev.election_id = ?
        ORDER BY v.university_number ASC
      `).all(electionId);

      return sendJson(res, 200, { voters });
    }

    // PARTICIPATION STATISTICS & UN PRESENCE SEARCH (ADMIN)
    if (req.method === 'GET' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/participation$/)) {
      const electionId = pathname.split('/')[4];
      const queryUN = parsedUrl.searchParams.get('un');

      const totalVoters = db.prepare('SELECT COUNT(*) as count FROM election_voters WHERE election_id = ?').get(electionId).count;
      const votedCount = db.prepare("SELECT COUNT(*) as count FROM election_voters WHERE election_id = ? AND status = 'VOTED'").get(electionId).count;
      const notVotedCount = totalVoters - votedCount;

      let searchResult = null;
      if (queryUN) {
        const cleanUN = queryUN.trim().toUpperCase();
        const record = db.prepare(`
          SELECT v.university_number, v.name, v.department, v.year,
                 ev.status as participation_status, ev.voted_at, ev.booth_id, ev.receipt_id
          FROM voters v
          JOIN election_voters ev ON v.id = ev.voter_id
          WHERE ev.election_id = ? AND v.university_number = ?
        `).get(electionId, cleanUN);

        if (record) {
          searchResult = record;
        }
      }

      return sendJson(res, 200, {
        stats: {
          total_eligible: totalVoters,
          votes_cast: votedCount,
          not_voted: notVotedCount,
          participation_rate: totalVoters > 0 ? ((votedCount / totalVoters) * 100).toFixed(1) : '0.0'
        },
        search_result: searchResult
      });
    }

    // POSITIONS & CANDIDATES MANAGEMENT (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/positions$/)) {
      const electionId = pathname.split('/')[4];
      const { name, display_order, candidates } = await parseBody(req);

      const posId = generateId('pos');
      db.prepare(`
        INSERT INTO positions (id, election_id, name, display_order)
        VALUES (?, ?, ?, ?)
      `).run(posId, electionId, name, display_order || 1);

      if (Array.isArray(candidates)) {
        const insertCand = db.prepare(`
          INSERT INTO candidates (id, position_id, name, department, year, photo_url, manifesto)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        candidates.forEach(c => {
          insertCand.run(generateId('cand'), posId, c.name, c.department, parseInt(c.year) || 1, c.photo_url || '', c.manifesto || '');
        });
      }

      logAdminAction('admin-super-01', 'CREATE_POSITION', 'position', posId);
      return sendJson(res, 200, { success: true, position_id: posId });
    }

    // BOOTH MANAGEMENT (ADMIN)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/booths$/)) {
      const electionId = pathname.split('/')[4];
      const { booth_id, booth_name, configuration } = await parseBody(req);

      const bId = booth_id || generateId('booth');
      db.prepare(`
        INSERT OR REPLACE INTO booths (id, election_id, booth_name, status, configuration, last_ping)
        VALUES (?, ?, ?, 'ACTIVE', ?, CURRENT_TIMESTAMP)
      `).run(bId, electionId, booth_name || 'Polling Booth', JSON.stringify(configuration || {}));

      return sendJson(res, 200, { success: true, booth_id: bId });
    }

    // -------------------------------------------------------------
    // BOOTH-WISE PDF RESULTS REPORT GENERATOR
    // -------------------------------------------------------------
    function generatePdfBuffer({ title, subtitle, summaryInfo, tableHeaders, tableRows, footerText }) {
      const esc = (str) => String(str || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

      const contentStream = [];
      contentStream.push('BT');
      contentStream.push('/F1 18 Tf');
      contentStream.push('50 760 Td');
      contentStream.push(`(${esc(title)}) Tj`);
      contentStream.push('ET');

      contentStream.push('BT');
      contentStream.push('/F1 11 Tf');
      contentStream.push('50 740 Td');
      contentStream.push(`(${esc(subtitle)}) Tj`);
      contentStream.push('ET');

      contentStream.push('0.5 w');
      contentStream.push('50 728 m 545 728 l S');

      let currentY = 705;

      if (summaryInfo && summaryInfo.length > 0) {
        summaryInfo.forEach(item => {
          contentStream.push('BT');
          contentStream.push('/F1 10 Tf');
          contentStream.push(`50 ${currentY} Td`);
          contentStream.push(`(${esc(item)}) Tj`);
          contentStream.push('ET');
          currentY -= 16;
        });
        currentY -= 5;
        contentStream.push(`50 ${currentY + 5} m 545 ${currentY + 5} l S`);
        currentY -= 15;
      }

      if (tableHeaders && tableHeaders.length > 0) {
        contentStream.push('BT');
        contentStream.push('/F1 10 Tf');
        contentStream.push(`50 ${currentY} Td`);
        const headerStr = tableHeaders.join('      ');
        contentStream.push(`(${esc(headerStr)}) Tj`);
        contentStream.push('ET');
        currentY -= 12;
        contentStream.push(`50 ${currentY + 3} m 545 ${currentY + 3} l S`);
        currentY -= 15;
      }

      if (tableRows && tableRows.length > 0) {
        tableRows.forEach(row => {
          if (currentY < 60) return;
          contentStream.push('BT');
          contentStream.push('/F1 9 Tf');
          contentStream.push(`50 ${currentY} Td`);
          const rowStr = row.join('      ');
          contentStream.push(`(${esc(rowStr)}) Tj`);
          contentStream.push('ET');
          currentY -= 16;
        });
      }

      contentStream.push(`50 45 m 545 45 l S`);
      contentStream.push('BT');
      contentStream.push('/F1 8 Tf');
      contentStream.push(`50 32 Td`);
      contentStream.push(`(${esc(footerText || "Official College Election System — Cryptographically Verified Booth Result Certificate")}) Tj`);
      contentStream.push('ET');

      const streamText = contentStream.join('\n');
      const streamLen = Buffer.byteLength(streamText, 'ascii');

      const objects = [];
      objects.push('%PDF-1.4\n');

      const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
      const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
      const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n';
      const obj4 = '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
      const obj5 = `5 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamText}\nendstream\nendobj\n`;

      const bodyParts = [obj1, obj2, obj3, obj4, obj5];
      let offset = objects[0].length;
      const xrefOffsets = [];

      bodyParts.forEach((part) => {
        xrefOffsets.push(offset);
        offset += part.length;
      });

      const startXref = offset;
      let xref = `xref\n0 6\n0000000000 65535 f \n`;
      xrefOffsets.forEach(off => {
        xref += String(off).padStart(10, '0') + ' 00000 n \n';
      });

      const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
      return Buffer.from(objects[0] + bodyParts.join('') + xref + trailer, 'latin1');
    }

    function generateBoothWisePdfReports(electionId) {
      const elec = db.prepare('SELECT * FROM elections WHERE id = ?').get(electionId);
      if (!elec) return [];

      // Ensure booth_id column exists on ballots table
      try { db.exec('ALTER TABLE ballots ADD COLUMN booth_id TEXT;'); } catch (e) {}

      const boothRows = db.prepare('SELECT id, booth_name FROM booths WHERE election_id = ?').all(electionId);
      const boothMap = new Map();
      
      boothRows.forEach(b => boothMap.set(b.id, b.booth_name));
      
      const voterBooths = db.prepare('SELECT DISTINCT booth_id FROM election_voters WHERE election_id = ? AND booth_id IS NOT NULL').all(electionId);
      voterBooths.forEach(vb => {
        if (vb.booth_id && !boothMap.has(vb.booth_id)) {
          boothMap.set(vb.booth_id, `Polling Booth ${vb.booth_id}`);
        }
      });

      const ballotBooths = db.prepare('SELECT DISTINCT booth_id FROM ballots WHERE election_id = ? AND booth_id IS NOT NULL').all(electionId);
      ballotBooths.forEach(bb => {
        if (bb.booth_id && !boothMap.has(bb.booth_id)) {
          boothMap.set(bb.booth_id, `Polling Booth ${bb.booth_id}`);
        }
      });

      if (boothMap.size === 0) {
        boothMap.set('BOOTH-01', 'Polling Booth BOOTH-01');
      }

      const boothsToProcess = [
        { id: 'OVERALL', name: 'All Booths Summary (Combined)' },
        ...Array.from(boothMap.entries()).map(([id, name]) => ({ id, name }))
      ];

      const positions = db.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY display_order ASC').all(electionId);
      const resultsDir = path.join(__dirname, 'uploads', 'results', electionId);
      fs.mkdirSync(resultsDir, { recursive: true });

      const generatedReports = [];

      boothsToProcess.forEach(b => {
        const isOverall = b.id === 'OVERALL';
        
        const totalVoters = isOverall
          ? db.prepare('SELECT COUNT(*) as c FROM election_voters WHERE election_id = ?').get(electionId).c
          : db.prepare('SELECT COUNT(*) as c FROM election_voters WHERE election_id = ? AND booth_id = ?').get(electionId, b.id).c;

        const votedCount = isOverall
          ? db.prepare("SELECT COUNT(*) as c FROM election_voters WHERE election_id = ? AND status = 'VOTED'").get(electionId).c
          : db.prepare("SELECT COUNT(*) as c FROM election_voters WHERE election_id = ? AND booth_id = ? AND status = 'VOTED'").get(electionId, b.id).c;

        const turnoutPct = totalVoters > 0 ? ((votedCount / totalVoters) * 100).toFixed(1) : '0.0';

        const ballots = isOverall
          ? db.prepare('SELECT protected_ballot_data FROM ballots WHERE election_id = ?').all(electionId)
          : db.prepare("SELECT protected_ballot_data FROM ballots WHERE election_id = ? AND (booth_id = ? OR (booth_id IS NULL AND ? = 'BOOTH-01'))").all(electionId, b.id, b.id);

        const totalBallots = ballots.length;
        const candidateTally = {};

        ballots.forEach(ballot => {
          try {
            const choices = JSON.parse(ballot.protected_ballot_data);
            Object.values(choices).forEach(candId => {
              candidateTally[candId] = (candidateTally[candId] || 0) + 1;
            });
          } catch(e) {}
        });

        const summaryInfo = [
          `Election Instance: ${elec.name}`,
          `Polling Booth Reference: ${b.name} (${b.id})`,
          `Official Timestamp: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
          `Registered Booth Voters: ${totalVoters}   |   Votes Cast: ${votedCount}   |   Turnout: ${turnoutPct}%`,
          `Total Encrypted Ballots Counted: ${totalBallots}`
        ];

        const tableHeaders = ['Position Title', 'Candidate Name', 'Dept', 'Votes', 'Share %'];
        const tableRows = [];

        positions.forEach(pos => {
          const candidates = db.prepare('SELECT * FROM candidates WHERE position_id = ?').all(pos.id);
          const tally = candidates.map(c => ({
            ...c,
            votes: candidateTally[c.id] || 0,
            pct: totalBallots > 0 ? (((candidateTally[c.id] || 0) / totalBallots) * 100).toFixed(1) : '0.0'
          }));

          tally.sort((a, b) => b.votes - a.votes);

          tally.forEach((c, idx) => {
            const winnerTag = idx === 0 && c.votes > 0 ? '[WINNER] ' : '';
            tableRows.push([
              pos.name.padEnd(20).slice(0, 20),
              (winnerTag + c.name).padEnd(22).slice(0, 22),
              c.department.padEnd(10).slice(0, 10),
              String(c.votes).padStart(6),
              `${c.pct}%`.padStart(7)
            ]);
          });
        });

        const pdfBuffer = generatePdfBuffer({
          title: `OFFICIAL BOOTH ELECTION RESULT CERTIFICATE`,
          subtitle: `Booth: ${b.name} (${b.id}) — ${elec.name}`,
          summaryInfo,
          tableHeaders,
          tableRows,
          footerText: `College Election System — Cryptographically Verified Booth Result Certificate`
        });

        const cleanBoothId = b.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `Result_Summary_${electionId}_${cleanBoothId}.pdf`;
        const filePath = path.join(resultsDir, filename);

        fs.writeFileSync(filePath, pdfBuffer);

        const publicUrl = `/uploads/results/${electionId}/${filename}`;
        generatedReports.push({
          booth_id: b.id,
          booth_name: b.name,
          filename,
          download_url: publicUrl,
          votes_cast: votedCount,
          turnout_percentage: turnoutPct
        });
      });

      return generatedReports;
    }

    // GET RESULTS (ADMIN: Controlled Publication Rule, PRD Section 12)
    if (req.method === 'GET' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/results$/)) {
      const electionId = pathname.split('/')[4];
      const elec = db.prepare('SELECT status FROM elections WHERE id = ?').get(electionId);

      if (!elec) {
        return sendJson(res, 404, { error: 'Election not found.' });
      }

      const positions = db.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY display_order ASC').all(electionId);
      const ballots = db.prepare('SELECT protected_ballot_data FROM ballots WHERE election_id = ?').all(electionId);
      const totalBallotsCast = ballots.length;

      const candidateTally = {};
      ballots.forEach(b => {
        try {
          const choices = JSON.parse(b.protected_ballot_data);
          Object.values(choices).forEach(candId => {
            candidateTally[candId] = (candidateTally[candId] || 0) + 1;
          });
        } catch (e) {}
      });

      const resultsData = positions.map(pos => {
        const candidates = db.prepare('SELECT * FROM candidates WHERE position_id = ?').all(pos.id);
        const enrichedCandidates = candidates.map(c => ({
          ...c,
          votes: candidateTally[c.id] || 0,
          percentage: totalBallotsCast > 0 ? (((candidateTally[c.id] || 0) / totalBallotsCast) * 100).toFixed(1) : '0.0'
        }));

        enrichedCandidates.sort((a, b) => b.votes - a.votes);

        return {
          position_id: pos.id,
          position_name: pos.name,
          candidates: enrichedCandidates
        };
      });

      // Generate booth-wise PDF report download references
      let pdfReports = [];
      try {
        pdfReports = generateBoothWisePdfReports(electionId);
      } catch (pErr) {
        console.error('PDF reports generation error stack:', pErr.stack);
      }

      return sendJson(res, 200, {
        election_id: electionId,
        election_status: elec.status,
        total_ballots_cast: totalBallotsCast,
        results: resultsData,
        pdf_reports: pdfReports
      });
    }

    // PUBLISH RESULTS (ADMIN - GENERATES AND SAVES BOOTH-WISE PDF REPORTS)
    if (req.method === 'POST' && pathname.match(/^\/api\/admin\/elections\/[^/]+\/publish-results$/)) {
      const electionId = pathname.split('/')[4];
      db.prepare("UPDATE elections SET status = 'RESULTS_PUBLISHED' WHERE id = ?").run(electionId);
      logAdminAction('admin-super-01', 'PUBLISH_RESULTS', 'election', electionId);

      // Generate & save PDF result reports for each booth
      const pdfReports = generateBoothWisePdfReports(electionId);

      return sendJson(res, 200, {
        success: true,
        status: 'RESULTS_PUBLISHED',
        pdf_reports: pdfReports,
        message: `Results published successfully! ${pdfReports.length} booth-wise PDF result report(s) saved.`
      });
    }

    // SYSTEM LOGS (ADMIN)
    if (req.method === 'GET' && pathname === '/api/admin/logs') {
      const logs = db.prepare(`
        SELECT l.id, l.action, l.target_type, l.target_id, l.created_at, a.name as admin_name
        FROM admin_action_logs l
        JOIN admins a ON l.admin_id = a.id
        ORDER BY l.created_at DESC LIMIT 50
      `).all();

      return sendJson(res, 200, { logs });
    }

    // -------------------------------------------------------------
    // STATIC FILE SERVING FOR FRONTEND & UPLOADS
    // -------------------------------------------------------------
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);

    if (pathname.startsWith('/uploads/')) {
      filePath = path.join(__dirname, pathname);
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.ico': 'image/x-icon'
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      return fs.createReadStream(filePath).pipe(res);
    }

    // Fallback to index.html for SPA client routing
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return fs.createReadStream(indexPath).pipe(res);
    }

    return sendJson(res, 404, { error: 'Endpoint or asset not found.' });

  } catch (err) {
    console.error('Unhandled server error:', err);
    return sendJson(res, 500, { error: 'Internal server error', message: err.message });
  }
});

// Initialize clean NIL state (only seed if explicitly requested via CLI --seed)
if (process.argv.includes('--seed-only') || process.argv.includes('--seed')) {
  console.log('Seeding demo election data as explicitly requested...');
  seedDemoData();
  if (process.argv.includes('--seed-only')) process.exit(0);
}

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 College Election System Server running on port ${PORT}`);
  console.log(`🔗 Local URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
