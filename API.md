# API Specification — College Election System

The REST API endpoints fulfill Section 17 of the PRD.

---

## Student & Kiosk Endpoints

### 1. Student Authentication
- **Endpoint**: `POST /api/auth/student`
- **Request Body**:
  ```json
  {
    "university_number": "UN2026001",
    "dob": "2002-05-15",
    "election_id": "elec_college_2026"
  }
  ```
- **Response (200 OK)**:
  ```json
  {
    "success": true,
    "session_token": "sess_8f92a...",
    "voter": { "university_number": "UN2026001", "name": "Devansh Roy", "department": "Computer Science" },
    "election": { "id": "elec_college_2026", "name": "Apex Student Council Election 2026" }
  }
  ```

---

### 2. Fetch Ballot Candidates
- **Endpoint**: `GET /api/elections/:id/ballot`
- **Headers**: `Authorization: Bearer <session_token>`
- **Response (200 OK)**:
  ```json
  {
    "election_id": "elec_college_2026",
    "positions": [
      {
        "id": "pos_pres",
        "name": "Student Body President",
        "candidates": [
          { "id": "cand_1", "name": "Aarav Sharma", "department": "Computer Science", "manifesto": "..." }
        ]
      }
    ]
  }
  ```

---

### 3. Atomic Ballot Submission (One-Vote Transaction)
- **Endpoint**: `POST /api/elections/:id/ballot/submit`
- **Headers**: `X-Booth-ID: BOOTH-01`
- **Request Body**:
  ```json
  {
    "session_token": "sess_8f92a...",
    "choices": { "pos_pres": "cand_1", "pos_vp": "cand_4" },
    "booth_id": "BOOTH-01"
  }
  ```
- **Response (200 OK)**:
  ```json
  {
    "success": true,
    "receipt_id": "RCP-8F92A-2026",
    "submitted_at": "2026-09-03T02:00:00.000Z"
  }
  ```

---

## Admin Endpoints

### 4. Admin Authentication
- **Endpoint**: `POST /api/auth/admin`
- **Request Body**: `{ "login_identifier": "admin", "password": "ADMIN@123" }`

### 5. List Elections & Turnout Stats
- **Endpoint**: `GET /api/admin/elections`

### 6. AI Bulk Import Voter Directory
- **Endpoint**: `POST /api/admin/elections/:id/voters/ai-parse`
- **Endpoint**: `POST /api/admin/elections/:id/voters/bulk-commit`

### 7. UN Participation Inspector
- **Endpoint**: `GET /api/admin/elections/:id/participation?un=UN2026001`

### 8. Calculate & Publish Election Results
- **Endpoint**: `GET /api/admin/elections/:id/results`
- **Endpoint**: `POST /api/admin/elections/:id/publish-results`
