/**
 * College Election System — Centralized TypeScript Express Server Engine
 * Implements security headers, CORS controls, rate limiting, and REST routing.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, initDatabaseSchema, seedDemoData, hashString, generateId, generateReceiptId, logAdminAction } from './db.js';
import { generateBoothWisePdfReports } from './pdfService.js';

const app = express();
const PORT = process.env.PORT || 3000;
const db = getDb();

// Initialize database schema on startup
initDatabaseSchema();

// --------------------------------------------------------------------
// 1. SECURITY & NETWORK MIDDLEWARES (PRD Section 9 & API Security)
// --------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: false, // Allowed for inline camera video streams & scripts
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiters for authentication & voting APIs
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 authentication attempts per window
  message: { error: 'Too many authentication attempts. Please try again later.' }
});

const voteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Limit voting attempts to 10 per minute per IP
  message: { error: 'Too many voting requests from this IP. Please wait a moment.' }
});

// Active in-memory session token store
const activeSessions = new Map<string, { voterId: string; electionId: string; created: number }>();

function verifySessionToken(token?: string) {
  if (!token || !activeSessions.has(token)) return null;
  const sess = activeSessions.get(token)!;
  if (Date.now() - sess.created > 2 * 60 * 60 * 1000) { // 2 hour expiry
    activeSessions.delete(token);
    return null;
  }
  return sess;
}

// --------------------------------------------------------------------
// 2. STUDENT AUTHENTICATION & VOTING APIS (PRD Section 2, 3, 4, 10)
// --------------------------------------------------------------------

// Student UN + DOB Authentication
app.post('/api/auth/student', loginLimiter, (req: Request, res: Response) => {
  const { university_number, dob, booth_id } = req.body;

  if (!university_number || !dob) {
    return res.status(400).json({ error: 'University Number and Date of Birth are required.' });
  }

  const cleanUN = String(university_number).trim().toUpperCase();
  const cleanDOB = String(dob).trim();
  const boothRef = booth_id ? String(booth_id).trim() : 'BOOTH-01';

  const activeElec = db.prepare("SELECT id, status FROM elections WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get() as any;
  if (!activeElec) {
    return res.status(400).json({ error: 'No election is currently ACTIVE.' });
  }

  const voter = db.prepare('SELECT * FROM voters WHERE university_number = ?').get(cleanUN) as any;
  if (!voter) {
    return res.status(401).json({ error: 'University Number not found in preloaded eligible directory.' });
  }

  if (voter.eligibility_status === 'BLOCKED') {
    return res.status(403).json({ error: 'This student voter account is currently BLOCKED by admin.' });
  }

  const computedVerifier = hashString(`${cleanUN}:${cleanDOB}`);
  if (voter.dob_verifier !== computedVerifier && voter.dob !== cleanDOB) {
    return res.status(401).json({ error: 'Incorrect Date of Birth provided.' });
  }

  const elecVoter = db.prepare('SELECT status FROM election_voters WHERE election_id = ? AND voter_id = ?').get(activeElec.id, voter.id) as any;

  if (!elecVoter) {
    return res.status(403).json({ error: 'Voter is not registered for the active election.' });
  }

  if (elecVoter.status === 'VOTED') {
    return res.status(409).json({ error: 'This voter has already voted in this election.' });
  }

  const sessionToken = `sess_stu_${crypto.randomBytes(16).toString('hex')}`;
  activeSessions.set(sessionToken, {
    voterId: voter.id,
    electionId: activeElec.id,
    created: Date.now()
  });

  return res.status(200).json({
    success: true,
    session_token: sessionToken,
    election_id: activeElec.id,
    voter: {
      university_number: voter.university_number,
      name: voter.name,
      department: voter.department,
      year: voter.year
    },
    assigned_booth_id: boothRef
  });
});

// Fetch Candidates & Positions for Active Election
app.get('/api/elections/:id/ballot', (req: Request, res: Response) => {
  const electionId = req.params.id;
  const elec = db.prepare('SELECT * FROM elections WHERE id = ?').get(electionId) as any;

  if (!elec || elec.status !== 'ACTIVE') {
    return res.status(400).json({ error: 'Election is not active for voting.' });
  }

  const positions = db.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY display_order ASC').all(electionId) as any[];

  const ballotStructure = positions.map(pos => {
    const candidates = db.prepare('SELECT id, position_id, name, department, year, photo_url, manifesto FROM candidates WHERE position_id = ?').all(pos.id);
    return {
      position_id: pos.id,
      position_name: pos.name,
      max_choices: pos.max_choices,
      candidates
    };
  });

  return res.status(200).json({
    election_name: elec.name,
    positions: ballotStructure
  });
});

// Atomic Vote Submission (PRD Section 4 & 10)
app.post('/api/elections/:id/vote', voteLimiter, (req: Request, res: Response) => {
  const electionId = req.params.id;
  const { session_token, choices, booth_id } = req.body;

  if (!session_token || !choices) {
    return res.status(400).json({ error: 'Session token and ballot choices are required.' });
  }

  const session = verifySessionToken(session_token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired voting session token.' });
  }

  const { voterId } = session;
  const boothRef = (booth_id || 'BOOTH-01').trim().replace(/[^a-zA-Z0-9_-]/g, '_');

  // BEGIN ATOMIC DATABASE TRANSACTION
  db.exec('BEGIN IMMEDIATE;');
  try {
    const elec = db.prepare('SELECT status FROM elections WHERE id = ?').get(electionId) as any;
    if (!elec || elec.status !== 'ACTIVE') {
      db.exec('ROLLBACK;');
      return res.status(400).json({ error: 'Election is no longer ACTIVE.' });
    }

    const elecVoter = db.prepare('SELECT status FROM election_voters WHERE election_id = ? AND voter_id = ?').get(electionId, voterId) as any;

    if (!elecVoter) {
      db.exec('ROLLBACK;');
      return res.status(403).json({ error: 'Voter participation record not found.' });
    }

    if (elecVoter.status === 'VOTED') {
      db.exec('ROLLBACK;');
      return res.status(409).json({ error: 'Duplicate vote detected! This voter has already voted in this election.' });
    }

    const ballotId = generateId('ballot');
    const receiptId = generateReceiptId();
    const nowIso = new Date().toISOString();

    // 1. Record ANONYMOUS ballot choice (NO voter identity attached!)
    db.prepare(`
      INSERT INTO ballots (id, election_id, booth_id, protected_ballot_data, submitted_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(ballotId, electionId, boothRef, JSON.stringify(choices), nowIso);

    // 2. Mark voter participation status = VOTED
    db.prepare(`
      UPDATE election_voters
      SET status = 'VOTED', voted_at = ?, booth_id = ?, receipt_id = ?, voted_choices = ?
      WHERE election_id = ? AND voter_id = ?
    `).run(nowIso, boothRef, receiptId, JSON.stringify(choices), electionId, voterId);

    db.exec('COMMIT;');
    activeSessions.delete(session_token);

    return res.status(200).json({
      success: true,
      receipt_id: receiptId,
      submitted_at: nowIso,
      message: 'Ballot cast successfully and atomically recorded.'
    });

  } catch (txnErr: any) {
    try { db.exec('ROLLBACK;'); } catch (rErr) {}
    console.error('Submission transaction error:', txnErr);
    return res.status(500).json({ error: 'Transaction failed during ballot recording.', details: txnErr.message });
  }
});

// --------------------------------------------------------------------
// 3. ADMIN MANAGEMENT & RESULTS APIS
// --------------------------------------------------------------------

app.post('/api/auth/admin', (req: Request, res: Response) => {
  const { login_identifier, password } = req.body;
  if (!login_identifier || !password) {
    return res.status(400).json({ error: 'Login identifier and password are required.' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE login_identifier = ?').get(login_identifier.trim()) as any;
  if (!admin || admin.password_hash !== hashString(password.trim())) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  const adminToken = `admin_sess_${crypto.randomBytes(16).toString('hex')}`;
  logAdminAction(admin.id, 'ADMIN_LOGIN');

  return res.status(200).json({
    success: true,
    admin_token: adminToken,
    admin: { id: admin.id, name: admin.name, role: admin.role }
  });
});

app.get('/api/admin/elections/:id/results', (req: Request, res: Response) => {
  const electionId = req.params.id;
  const elec = db.prepare('SELECT status FROM elections WHERE id = ?').get(electionId) as any;

  if (!elec) {
    return res.status(404).json({ error: 'Election not found.' });
  }

  const positions = db.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY display_order ASC').all(electionId) as any[];
  const ballots = db.prepare('SELECT protected_ballot_data FROM ballots WHERE election_id = ?').all(electionId) as any[];
  const totalBallotsCast = ballots.length;

  const candidateTally: Record<string, number> = {};
  ballots.forEach(b => {
    try {
      const choices = JSON.parse(b.protected_ballot_data);
      Object.values(choices).forEach((candId: any) => {
        candidateTally[candId] = (candidateTally[candId] || 0) + 1;
      });
    } catch (e) {}
  });

  const resultsData = positions.map(pos => {
    const candidates = db.prepare('SELECT * FROM candidates WHERE position_id = ?').all(pos.id) as any[];
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

  let pdfReports: any[] = [];
  try {
    pdfReports = generateBoothWisePdfReports(electionId);
  } catch (pErr) {}

  return res.status(200).json({
    election_id: electionId,
    election_status: elec.status,
    total_ballots_cast: totalBallotsCast,
    results: resultsData,
    pdf_reports: pdfReports
  });
});

app.post('/api/admin/elections/:id/publish-results', (req: Request, res: Response) => {
  const electionId = req.params.id;
  db.prepare("UPDATE elections SET status = 'RESULTS_PUBLISHED' WHERE id = ?").run(electionId);
  logAdminAction('admin-super-01', 'PUBLISH_RESULTS', 'election', electionId);

  const pdfReports = generateBoothWisePdfReports(electionId);

  return res.status(200).json({
    success: true,
    status: 'RESULTS_PUBLISHED',
    pdf_reports: pdfReports,
    message: `Results published successfully! ${pdfReports.length} booth-wise PDF result report(s) saved.`
  });
});

// Serve Static Frontend Assets & Uploads
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// SPA Fallback
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start Server
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Centralized TypeScript Express Server running on port ${PORT}`);
    console.log(`🔗 Local API URL: http://localhost:${PORT}`);
    console.log(`=======================================================`);
  });
}

export default app;
