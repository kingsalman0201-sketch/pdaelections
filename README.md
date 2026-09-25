# College Election System

> Final Product Requirements Document (PRD) & Technical Architecture Implementation

A secure, multi-laptop college election platform built with **Node.js, PostgreSQL/SQLite (ACID Transactions), and Vanilla JS + CSS Glassmorphic UI**. The system enforces strict administrator-controlled voter pre-loading, UN + DOB student authentication, atomic one-vote-per-UN rules, complete ballot secrecy (logical separation of identity and vote records), multi-booth configuration, AI bulk voter list import, and administrative participation analytics with controlled result publication.

---

## 🌟 Key Features & PRD Compliance

1. **Voter Pre-Loading & Authentication**:
   - Admin uploads official voter lists (University Number, Name, Department, Year, DOB hash, Eligibility Status).
   - Students authenticate using **University Number (UN) + Date of Birth (DOB)**. Self-registration is strictly prohibited.
2. **Atomic One-Vote Enforcement**:
   - Database transactions (`BEGIN IMMEDIATE ... COMMIT`) enforce atomic verification and vote recording.
   - `UNIQUE(election_id, voter_id)` database constraint guarantees exactly one ballot per UN per election.
   - Duplicate login or voting attempts are immediately rejected (`409 Conflict`).
3. **Ballot Secrecy & Logical Separation**:
   - Identity records (`voters`, `election_voters`) and ballot choices (`ballots`) are logically separated in distinct tables.
   - `ballots` table stores protected choice JSON **without any voter_id or UN link**.
   - Admin inspection displays whether a student voted, timestamp, receipt ID, and booth ID without exposing candidate choices.
4. **Multi-Laptop Polling Booth Architecture**:
   - Multiple laptops operate as dedicated polling booths (e.g. `BOOTH-01`, `BOOTH-02`) connecting to the central backend.
   - Polling Booth setup view includes connectivity diagnostics before launching kiosk mode.
5. **Admin Dashboard & Controlled Results**:
   - Real-time voter turnout percentage gauges, votes cast, pending count, live booth status.
   - Election lifecycle state machine: `DRAFT` → `SCHEDULED` → `ACTIVE` → `CLOSED` → `RESULTS_PUBLISHED`.
   - Results calculated automatically from encrypted ballots and published only after election closure.

---

## 🚀 Quick Start Guide

### Prerequisites
- Node.js v22+ (or Antigravity `agy-node` / standard Node.js)

### 1. Start the Backend & Frontend Server
```bash
npm start
# or
agy-node server.js
```
The server will start at `http://localhost:3000`.

### 2. Run Automated Integration & Concurrency Test Suite
```bash
npm test
# or
agy-node tests/test-election.js
```

---

## 🧑‍🎓 Demo Credentials & User Roles

### Student Kiosk Login
- **University Number (UN)**: `UN2026001`
- **Date of Birth (DOB)**: `2002-05-15`
- Additional Preloaded Voters: `UN2026002` (DOB: `2003-08-22`), `UN2026003` (DOB: `2002-11-04`)

### Admin Dashboard Login
- **Admin Identifier**: `admin`
- **Password**: `ADMIN@123`

---

## 📐 Database Schema Overview

```sql
elections       (id, name, description, start_at, end_at, status)
voters          (id, university_number, name, department, year, dob_verifier, eligibility_status)
election_voters (id, election_id, voter_id, status, voted_at, booth_id, receipt_id, UNIQUE(election_id, voter_id))
positions       (id, election_id, name, display_order, max_choices)
candidates      (id, position_id, name, department, year, photo_url, manifesto)
ballots         (id, election_id, booth_id, protected_ballot_data, submitted_at)  <-- ANONYMOUS (NO voter_id/UN!)
booths          (id, election_id, booth_name, status, configuration)
admins          (id, name, login_identifier, password_hash, role, status)
admin_action_logs(id, admin_id, action, target_type, target_id, created_at)
```

---

## 📂 Project Structure

```
.
├── server.js              # Node.js backend server with SQLite transactions & API routes
├── package.json           # Application manifest & npm scripts
├── public/
│   ├── index.html         # Single-page web application container
│   ├── css/style.css      # Design system with glassmorphism theme & dark mode
│   └── js/app.js          # Client application logic
├── tests/
│   └── test-election.js   # Automated integration, transaction & ballot secrecy test suite
├── API.md                 # Complete REST API Specification
└── README.md              # Project documentation
```
