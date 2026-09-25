/**
 * College Election System — Official Booth-Wise PDF Result Report Generator
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';

export function generatePdfBuffer({ title, subtitle, summaryInfo, tableHeaders, tableRows, footerText }: {
  title: string;
  subtitle: string;
  summaryInfo: string[];
  tableHeaders: string[];
  tableRows: string[][];
  footerText?: string;
}): Buffer {
  const esc = (str: any) => String(str || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const contentStream: string[] = [];
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

  const objects: string[] = [];
  objects.push('%PDF-1.4\n');

  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n';
  const obj4 = '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  const obj5 = `5 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamText}\nendstream\nendobj\n`;

  const bodyParts = [obj1, obj2, obj3, obj4, obj5];
  let offset = objects[0].length;
  const xrefOffsets: number[] = [];

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

export function generateBoothWisePdfReports(electionId: string) {
  const db = getDb();
  const elec = db.prepare('SELECT * FROM elections WHERE id = ?').get(electionId) as any;
  if (!elec) return [];

  try { db.exec('ALTER TABLE ballots ADD COLUMN booth_id TEXT;'); } catch (e) {}

  const boothRows = db.prepare('SELECT id, booth_name FROM booths WHERE election_id = ?').all(electionId) as any[];
  const boothMap = new Map<string, string>();
  
  boothRows.forEach(b => boothMap.set(b.id, b.booth_name));
  
  const voterBooths = db.prepare('SELECT DISTINCT booth_id FROM election_voters WHERE election_id = ? AND booth_id IS NOT NULL').all(electionId) as any[];
  voterBooths.forEach(vb => {
    if (vb.booth_id && !boothMap.has(vb.booth_id)) {
      boothMap.set(vb.booth_id, `Polling Booth ${vb.booth_id}`);
    }
  });

  const ballotBooths = db.prepare('SELECT DISTINCT booth_id FROM ballots WHERE election_id = ? AND booth_id IS NOT NULL').all(electionId) as any[];
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

  const positions = db.prepare('SELECT * FROM positions WHERE election_id = ? ORDER BY display_order ASC').all(electionId) as any[];
  const uploadsBaseDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
  const resultsDir = path.join(uploadsBaseDir, 'results', electionId);
  fs.mkdirSync(resultsDir, { recursive: true });

  const generatedReports: any[] = [];

  boothsToProcess.forEach(b => {
    const isOverall = b.id === 'OVERALL';
    
    const totalVoters = isOverall
      ? (db.prepare('SELECT COUNT(*) as c FROM election_voters WHERE election_id = ?').get(electionId) as any).c
      : (db.prepare('SELECT COUNT(*) as c FROM election_voters WHERE election_id = ? AND booth_id = ?').get(electionId, b.id) as any).c;

    const votedCount = isOverall
      ? (db.prepare("SELECT COUNT(*) as c FROM election_voters WHERE election_id = ? AND status = 'VOTED'").get(electionId) as any).c
      : (db.prepare("SELECT COUNT(*) as c FROM election_voters WHERE election_id = ? AND booth_id = ? AND status = 'VOTED'").get(electionId, b.id) as any).c;

    const turnoutPct = totalVoters > 0 ? ((votedCount / totalVoters) * 100).toFixed(1) : '0.0';

    const ballots = isOverall
      ? (db.prepare('SELECT protected_ballot_data FROM ballots WHERE election_id = ?').all(electionId) as any[])
      : (db.prepare("SELECT protected_ballot_data FROM ballots WHERE election_id = ? AND (booth_id = ? OR (booth_id IS NULL AND ? = 'BOOTH-01'))").all(electionId, b.id, b.id) as any[]);

    const totalBallots = ballots.length;
    const candidateTally: Record<string, number> = {};

    ballots.forEach(ballot => {
      try {
        const choices = JSON.parse(ballot.protected_ballot_data);
        Object.values(choices).forEach((candId: any) => {
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
    const tableRows: string[][] = [];

    positions.forEach(pos => {
      const candidates = db.prepare('SELECT * FROM candidates WHERE position_id = ?').all(pos.id) as any[];
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
