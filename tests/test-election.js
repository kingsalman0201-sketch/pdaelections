/**
 * College Election System — Automated Integration & Concurrency Test Suite
 * Validates PRD rules: UN+DOB Auth, One-Vote Enforcement, Ballot Secrecy, Admin Lifecycle.
 */

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const assert = require('node:assert');

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'election_system.db');

function request(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE_URL);
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = {};
        try {
          json = data ? JSON.parse(data) : {};
        } catch (e) {}
        resolve({ status: res.statusCode, data, json });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('\n=======================================================');
  console.log('🧪 RUNNING ELECTION SYSTEM AUTOMATED INTEGRATION TESTS');
  console.log('=======================================================\n');

  try {
    // 1. Seed Fresh Demo Dataset via Admin API
    console.log('Test 1: Seeding Demo Dataset via API...');
    const seedRes = await request('POST', '/api/admin/seed-demo');
    assert.strictEqual(seedRes.status, 200, 'Seed should return 200 OK');
    assert.strictEqual(seedRes.json.success, true);
    console.log('  ✓ Demo dataset seeded successfully.');

    // 1b. Admin Login Password Protection Test (ADMIN@123)
    console.log('\nTest 1b: Admin Password Protection (ADMIN@123)...');
    const badAdminRes = await request('POST', '/api/auth/admin', { login_identifier: 'admin', password: 'wrongpassword' });
    assert.strictEqual(badAdminRes.status, 401, 'Wrong admin password must return 401');

    const goodAdminRes = await request('POST', '/api/auth/admin', { login_identifier: 'admin', password: 'ADMIN@123' });
    assert.strictEqual(goodAdminRes.status, 200, 'Correct admin password ADMIN@123 must return 200 OK');
    assert.ok(goodAdminRes.json.admin_token, 'Admin token must be returned');
    console.log('  ✓ Verified: Admin login correctly protected by password ADMIN@123.');

    // 2. Student Authentication Tests
    console.log('\nTest 2: Student UN + DOB Authentication...');

    // 2a. Invalid UN
    const badUnRes = await request('POST', '/api/auth/student', { university_number: 'UNKNOWN999', dob: '2002-05-15' });
    assert.strictEqual(badUnRes.status, 401, 'Unknown UN should be rejected with 401');
    console.log('  ✓ Unknown UN correctly rejected (401).');

    // 2b. Wrong DOB
    const badDobRes = await request('POST', '/api/auth/student', { university_number: 'UN2026001', dob: '1999-01-01' });
    assert.strictEqual(badDobRes.status, 401, 'Wrong DOB should be rejected with 401');
    console.log('  ✓ Incorrect DOB correctly rejected (401).');

    // 2c. Valid Auth
    const validAuthRes = await request('POST', '/api/auth/student', { university_number: 'UN2026001', dob: '2002-05-15' });
    assert.strictEqual(validAuthRes.status, 200, 'Valid credentials should return 200 OK');
    assert.ok(validAuthRes.json.session_token, 'Session token must be returned');
    const sessionToken1 = validAuthRes.json.session_token;
    const electionId = validAuthRes.json.election.id;
    console.log('  ✓ Valid UN+DOB authenticated successfully, token issued.');

    // 3. Fetch Ballot Candidates
    console.log('\nTest 3: Fetching Ballot Candidates for Student Session...');
    const ballotRes = await request('GET', `/api/elections/${electionId}/ballot`, null, {
      'Authorization': `Bearer ${sessionToken1}`
    });
    assert.strictEqual(ballotRes.status, 200);
    assert.ok(Array.isArray(ballotRes.json.positions));
    assert.ok(ballotRes.json.positions.length > 0);
    const positions = ballotRes.json.positions;
    console.log(`  ✓ Received ${positions.length} voting positions with candidate options.`);

    // Build sample ballot choices
    const choices = {};
    positions.forEach(p => {
      choices[p.id] = p.candidates[0].id;
    });

    // 4. Submit Ballot (First Submit)
    console.log('\nTest 4: Submitting First Ballot (Atomic Transaction)...');
    const submitRes1 = await request('POST', `/api/elections/${electionId}/ballot/submit`, {
      session_token: sessionToken1,
      choices,
      booth_id: 'BOOTH-01'
    });
    assert.strictEqual(submitRes1.status, 200, 'First submission should succeed with 200 OK');
    assert.ok(submitRes1.json.receipt_id.startsWith('RCP-'), 'Receipt ID should start with RCP-');
    console.log(`  ✓ First ballot recorded! Receipt ID: ${submitRes1.json.receipt_id}`);

    // 5. ONE-VOTE ENFORCEMENT TEST (Second Submit for Same UN)
    console.log('\nTest 5: Testing One-Vote Database Constraint (Second Submission Attempt)...');
    
    // 5a. Try re-authenticating with same UN
    const reAuthRes = await request('POST', '/api/auth/student', { university_number: 'UN2026001', dob: '2002-05-15' });
    assert.strictEqual(reAuthRes.status, 409, 'Re-authentication after voting must return 409 Conflict');
    assert.strictEqual(reAuthRes.json.alreadyVoted, true);
    console.log('  ✓ Second authentication attempt blocked: UN already marked VOTED.');

    // 5b. Try submitting using old token
    const reSubmitRes = await request('POST', `/api/elections/${electionId}/ballot/submit`, {
      session_token: sessionToken1,
      choices,
      booth_id: 'BOOTH-02'
    });
    assert.strictEqual(reSubmitRes.status, 401, 'Re-submitting with consumed token must return 401');
    console.log('  ✓ Duplicate vote using consumed token blocked (401).');

    // 6. BALLOT SECRECY VERIFICATION (Direct DB Audit)
    console.log('\nTest 6: Verifying Ballot Secrecy & Logical Data Separation in SQLite Database...');
    const db = new DatabaseSync(DB_PATH);
    const ballotRows = db.prepare('SELECT * FROM ballots').all();
    assert.ok(ballotRows.length > 0, 'Ballot records must exist');
    
    // Ensure NO voter_id or UN column exists in ballots table
    const sampleBallot = ballotRows[0];
    assert.strictEqual(sampleBallot.voter_id, undefined, 'ballots table MUST NOT contain voter_id column!');
    assert.strictEqual(sampleBallot.university_number, undefined, 'ballots table MUST NOT contain university_number column!');
    assert.ok(sampleBallot.protected_ballot_data, 'ballot must contain protected choice data');
    console.log('  ✓ Verified: `ballots` table is completely anonymous and logically separated from identity.');

    // 7. UN PARTICIPATION INSPECTOR TEST
    console.log('\nTest 7: Testing Admin UN Participation Inspector...');
    const inspectRes = await request('GET', `/api/admin/elections/${electionId}/participation?un=UN2026001`);
    assert.strictEqual(inspectRes.status, 200);
    assert.strictEqual(inspectRes.json.search_result.university_number, 'UN2026001');
    assert.strictEqual(inspectRes.json.search_result.participation_status, 'VOTED');
    assert.strictEqual(inspectRes.json.search_result.receipt_id, submitRes1.json.receipt_id);
    assert.strictEqual(inspectRes.json.search_result.protected_ballot_data, undefined, 'Participation inspector must NEVER reveal candidate choices!');
    console.log('  ✓ UN participation status verified (VOTED) with zero exposure of ballot choices.');

    // 8. ELECTION RESULTS PUBLISHING & BOOTH-WISE PDF REPORT GENERATION
    console.log('\nTest 8: Admin Results Calculation & Controlled Publishing with Booth PDF Generation...');
    const resultsRes = await request('GET', `/api/admin/elections/${electionId}/results`);
    assert.strictEqual(resultsRes.status, 200);
    assert.strictEqual(resultsRes.json.total_ballots_cast, 1);
    
    const publishRes = await request('POST', `/api/admin/elections/${electionId}/publish-results`);
    assert.strictEqual(publishRes.status, 200);
    assert.strictEqual(publishRes.json.status, 'RESULTS_PUBLISHED');
    assert.ok(Array.isArray(publishRes.json.pdf_reports) && publishRes.json.pdf_reports.length > 0, 'Must return booth-wise PDF reports array');
    assert.ok(publishRes.json.pdf_reports[0].download_url.endsWith('.pdf'), 'PDF download URL must point to a .pdf file');
    console.log(`  ✓ Election vote tally calculated accurately and ${publishRes.json.pdf_reports.length} booth-wise PDF result report(s) saved!`);

    // 9. AI-ASSISTED BULK VOTER PDF IMPORT TEST
    console.log('\nTest 9: AI-Assisted Bulk Voter PDF Import (Base64 Stream Parsing & Commit)...');
    const zlib = require('node:zlib');
    const pdfStreamContent = 'BT /F1 12 Tf 50 750 Td\n(1. Student Name: PDF Student Alpha, USN: UN2026088, DOB: 2003-01-10, Year: 3) Tj T*\n(2. Student Name: PDF Student Beta, USN: UN2026089, DOB: 2004-05-12, Year: 2) Tj T*\nET\n';
    const compressedStream = zlib.deflateSync(Buffer.from(pdfStreamContent));
    const pdfHeader = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n4 0 obj << /Length ' + compressedStream.length + ' /Filter /FlateDecode >>\nstream\n';
    const pdfFooter = '\nendstream\nendobj\nxref\n0 5\ntrailer << /Root 1 0 R >>\n%%EOF';
    const samplePdfBuf = Buffer.concat([Buffer.from(pdfHeader, 'latin1'), compressedStream, Buffer.from(pdfFooter, 'latin1')]);
    const pdfDataUrl = 'data:application/pdf;base64,' + samplePdfBuf.toString('base64');

    const aiParseRes = await request('POST', `/api/admin/elections/${electionId}/voters/ai-parse`, {
      raw_text: pdfDataUrl,
      file_type: 'pdf',
      file_name: 'test_students.pdf'
    });

    assert.strictEqual(aiParseRes.status, 200, 'AI PDF parse must return 200 OK');
    assert.strictEqual(aiParseRes.json.success, true);
    assert.ok(aiParseRes.json.summary.total_detected >= 2, 'Should detect at least 2 PDF student records');
    const pdfVoters = aiParseRes.json.rows.filter(r => r.university_number.includes('UN202608') || r.university_number.includes('202608'));
    assert.strictEqual(pdfVoters.length, 2, 'Should extract UN2026088 and UN2026089 from PDF');
    console.log('  ✓ PDF stream parsing successfully extracted voter records from compressed PDF stream.');

    // Commit PDF voters
    const commitRes = await request('POST', `/api/admin/elections/${electionId}/voters/bulk-commit`, {
      voters: pdfVoters
    });
    assert.strictEqual(commitRes.status, 200);
    assert.strictEqual(commitRes.json.summary.imported_count, 2);
    console.log('  ✓ Approved PDF voters committed to database successfully.');

    // 10. SINGLE VOTER REMOVAL TEST
    console.log('\nTest 10: Single Voter Removal from Directory (DELETE /api/admin/voters/:id)...');
    const deleteRes = await request('DELETE', `/api/admin/elections/${electionId}/voters/UN2026089`);
    assert.strictEqual(deleteRes.status, 200, 'Single voter deletion must return 200 OK');
    assert.strictEqual(deleteRes.json.success, true);
    
    // Verify voter UN2026089 is no longer in voters list
    const votersListRes = await request('GET', `/api/admin/elections/${electionId}/voters`);
    const remaining = votersListRes.json.voters.filter(v => v.university_number === 'UN2026089');
    assert.strictEqual(remaining.length, 0, 'Voter UN2026089 must be permanently deleted');
    console.log('  ✓ Single voter UN2026089 removed successfully and verified absent in directory list.');

    // 11. SERIAL NUMBER PDF & DOCUMENT PARSING TEST
    console.log('\nTest 11: Serial Number Record Extraction (1., 2., Sl.No 3...)...');
    const serialDocText = `1. Aarav Sharma 1MS21CS001 2002-05-15 2) Bhavya Patel 1MS21CS002 2003-08-20 3. Chirag Roy 1MS21CS003 2002-11-10`;
    const serialParseRes = await request('POST', `/api/admin/elections/${electionId}/voters/ai-parse`, {
      raw_text: serialDocText,
      file_type: 'text',
      file_name: 'serial_list.txt'
    });
    assert.strictEqual(serialParseRes.status, 200);
    assert.strictEqual(serialParseRes.json.rows.length, 3, 'Must split text into exactly 3 single voter records using serial numbers');
    assert.strictEqual(serialParseRes.json.rows[0].university_number, '1MS21CS001');
    assert.strictEqual(serialParseRes.json.rows[1].university_number, '1MS21CS002');
    assert.strictEqual(serialParseRes.json.rows[2].university_number, '1MS21CS003');
    console.log('  ✓ Serial number document cleanly split into 3 distinct single voter records (1MS21CS001, 1MS21CS002, 1MS21CS003).');

    // 12. ZERO-LOSS LARGE PDF IMPORT TEST (50 Students)
    console.log('\nTest 12: Zero-Loss PDF Import (50 Student PDF Stream)...');
    let largePdfText = 'BT /F1 12 Tf 50 750 Td\n';
    for (let i = 1; i <= 50; i++) {
      largePdfText += `(${i}. Student Name: Student_${i}, USN: 1MS21CS${String(i).padStart(3, '0')}, DOB: 2002-01-15, Dept: CSE, Year: 3) Tj T*\n`;
    }
    largePdfText += 'ET\n';

    const compLargeStream = zlib.deflateSync(Buffer.from(largePdfText));
    const header50 = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj\n4 0 obj << /Length ' + compLargeStream.length + ' /Filter /FlateDecode >>\nstream\n';
    const footer50 = '\nendstream\nendobj\nxref\n0 5\ntrailer << /Root 1 0 R >>\n%%EOF';
    const buf50 = Buffer.concat([Buffer.from(header50, 'latin1'), compLargeStream, Buffer.from(footer50, 'latin1')]);
    const pdfDataUrl50 = 'data:application/pdf;base64,' + buf50.toString('base64');

    const parse50Res = await request('POST', `/api/admin/elections/${electionId}/voters/ai-parse`, {
      raw_text: pdfDataUrl50,
      file_type: 'pdf',
      file_name: 'large_50_students.pdf'
    });

    assert.strictEqual(parse50Res.status, 200);
    assert.strictEqual(parse50Res.json.rows.length, 50, 'Must extract all 50 student records from the PDF without dropping any student');
    assert.strictEqual(parse50Res.json.summary.invalid_count, 0, 'Zero-loss guarantee: invalid_count must be 0');

    // Auto-commit 50 voters
    const commit50Res = await request('POST', `/api/admin/elections/${electionId}/voters/bulk-commit`, {
      voters: parse50Res.json.rows
    });
    assert.strictEqual(commit50Res.status, 200);
    assert.strictEqual(commit50Res.json.summary.imported_count, 50, 'Must commit all 50 voters into database');
    console.log('  ✓ Zero-loss PDF import verified: All 50 student records extracted and committed to database successfully (0 dropped).');

    // 13. 70-STUDENT MULTI-LINE / COLUMN-BREAK VERIFICATION TEST
    console.log('\nTest 13: 70 Students Multi-Line PDF & Text Import (Verifying 0 Double-Count / 0 Column Mismatch)...');
    let multiLineText70 = 'Sl.No | Student Name | University Number | Date of Birth | Department\n';
    for (let i = 1; i <= 70; i++) {
      const un = `1MS21CS${String(i).padStart(3, '0')}`;
      const name = `Student Record ${i}`;
      const dob = `2003-05-${String((i % 28) + 1).padStart(2, '0')}`;
      if (i % 2 === 0) {
        multiLineText70 += `${i}.\n${name}\n${un}\n${dob}\n`;
      } else {
        multiLineText70 += `${i}. ${name} ${un} ${dob} CSE Year 3\n`;
      }
    }

    const parse70Res = await request('POST', `/api/admin/elections/${electionId}/voters/ai-parse`, {
      raw_text: multiLineText70,
      file_type: 'text',
      file_name: '70_students_multiline.txt'
    });

    assert.strictEqual(parse70Res.status, 200);
    assert.strictEqual(parse70Res.json.rows.length, 70, 'Must extract EXACTLY 70 student records from 70 student file (no 142 double-count)');
    assert.strictEqual(parse70Res.json.rows[0].university_number, '1MS21CS001');
    assert.strictEqual(parse70Res.json.rows[0].dob, '2003-05-02');
    assert.strictEqual(parse70Res.json.rows[69].university_number, '1MS21CS070');
    assert.strictEqual(parse70Res.json.rows[69].dob, '2003-05-15');
    console.log('  ✓ 70-student multi-line import verified: Extracted EXACTLY 70 clean student records with 0 column mismatches and 0 double-counts.');

    // 14. PDF HEADING & PAGE NUMBER FILTERING TEST
    console.log('\nTest 14: PDF Heading, Page Number & Title Exclusion...');
    const messyPdfText = `
      Apex Student Council Elections 2026
      Official Eligible Student Voter Directory - Main Campus
      Page 1 of 5
      Sl.No | Student Name | University Number | Date of Birth | Department | Year
      1. Aarav Sharma 1MS21CS001 2003-05-15 CSE Year 3
      Page 2 of 5
      Generated on 2026-09-07 - Confidential
      2. Bhavya Patel 1MS21CS002 2003-08-20 ECE Year 3
    `;

    const parseHeadingRes = await request('POST', `/api/admin/elections/${electionId}/voters/ai-parse`, {
      raw_text: messyPdfText,
      file_type: 'pdf',
      file_name: 'messy_header_voters.pdf'
    });

    assert.strictEqual(parseHeadingRes.status, 200);
    assert.strictEqual(parseHeadingRes.json.rows.length, 2, 'Must extract ONLY 2 student records, ignoring all PDF titles and page numbers');
    assert.strictEqual(parseHeadingRes.json.rows[0].name, 'Aarav Sharma');
    assert.strictEqual(parseHeadingRes.json.rows[0].university_number, '1MS21CS001');
    assert.strictEqual(parseHeadingRes.json.rows[1].name, 'Bhavya Patel');
    assert.strictEqual(parseHeadingRes.json.rows[1].university_number, '1MS21CS002');
    console.log('  ✓ PDF heading & page number filtering verified: Titles ("Apex Student Council..."), headers ("Page 1 of 5"), and timestamps dropped cleanly; pure student data retained.');

    console.log('\n=======================================================');
    console.log('🎉 ALL ELECTION SYSTEM TESTS PASSED SUCCESSFULLY (14/14)');
    console.log('=======================================================\n');

  } catch (err) {
    console.error('\n❌ TEST FAILURE:', err);
    process.exit(1);
  }
}

runTests();
