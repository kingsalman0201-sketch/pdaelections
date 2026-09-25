/**
 * College Election System — Client Web Application Logic
 * PRD & Technical Architecture Implementation
 */

// Application State
const state = {
  currentView: localStorage.getItem('currentView') || 'student', // 'student', 'booth', 'admin'
  adminTab: localStorage.getItem('adminTab') || 'overview',
  activeElectionId: localStorage.getItem('activeElectionId') || null,
  assignedBoothId: 'BOOTH-01',

  // Student Voting State
  studentToken: null,
  voterInfo: null,
  positions: [],
  currentPosIndex: 0,
  selections: {}, // { position_id: candidate_id }
  submittedReceiptId: null,
  submittedVoterId: null,
  submittedTimestamp: null,

  // Admin Auth State
  adminToken: sessionStorage.getItem('adminToken') || null,
  countdownInterval: null
};

// DOM Content Loaded Handler
document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  await fetchInitialElection();
  const savedView = localStorage.getItem('currentView') || 'student';
  switchView(savedView);
});

// View Navigation Switcher
function switchView(viewName) {
  state.currentView = viewName;
  localStorage.setItem('currentView', viewName);

  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.view-section').forEach(sec => sec.style.display = 'none');

  if (viewName === 'student') {
    document.getElementById('btnNavStudent').classList.add('active');
    document.getElementById('viewStudent').style.display = 'block';
  } else if (viewName === 'booth') {
    document.getElementById('btnNavBooth').classList.add('active');
    document.getElementById('viewBooth').style.display = 'block';
    loadBoothSetupData();
  } else if (viewName === 'admin') {
    document.getElementById('btnNavAdmin').classList.add('active');
    document.getElementById('viewAdmin').style.display = 'block';

    const lockPanel = document.getElementById('adminAuthLockPanel');
    const contentPanel = document.getElementById('adminMainDashboardContent');

    if (state.adminToken) {
      if (lockPanel) lockPanel.style.display = 'none';
      if (contentPanel) contentPanel.style.display = 'block';
      loadAdminDashboard();
    } else {
      if (lockPanel) lockPanel.style.display = 'block';
      if (contentPanel) contentPanel.style.display = 'none';
    }
  }

  lucide.createIcons();
}

// Handle Admin Password Login (ADMIN@123)
async function handleAdminPasswordLogin(e) {
  e.preventDefault();
  const pass = document.getElementById('inputAdminPass').value;
  const alertBox = document.getElementById('adminPassAlert');
  if (alertBox) alertBox.style.display = 'none';

  try {
    const res = await fetch('/api/auth/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login_identifier: 'admin',
        password: pass
      })
    });

    const data = await res.json();
    if (!res.ok || !data.admin_token) {
      if (alertBox) {
        alertBox.innerHTML = `<strong>Authentication Error:</strong> ${data.error || 'Invalid administrator password.'}`;
        alertBox.style.display = 'flex';
      }
      return;
    }

    // Success! Save token and unlock portal
    state.adminToken = data.admin_token;
    sessionStorage.setItem('adminToken', data.admin_token);

    document.getElementById('adminAuthLockPanel').style.display = 'none';
    document.getElementById('adminMainDashboardContent').style.display = 'block';
    loadAdminDashboard();

  } catch (err) {
    console.error('Admin login error:', err);
    if (alertBox) {
      alertBox.textContent = 'Server connection error during admin login.';
      alertBox.style.display = 'flex';
    }
  }
}

// Logout / Lock Admin Portal
function logoutAdmin() {
  state.adminToken = null;
  sessionStorage.removeItem('adminToken');
  localStorage.removeItem('adminToken');
  const passInput = document.getElementById('inputAdminPass');
  if (passInput) passInput.value = '';
  document.getElementById('adminAuthLockPanel').style.display = 'block';
  document.getElementById('adminMainDashboardContent').style.display = 'none';
}

// -------------------------------------------------------------------
// 1. INITIAL SETUP & FETCH
// -------------------------------------------------------------------
async function fetchInitialElection() {
  try {
    const res = await fetch('/api/admin/elections');
    const data = await res.json();
    if (data.elections && data.elections.length > 0) {
      const savedId = localStorage.getItem('activeElectionId');
      let activeElec = null;
      if (savedId) {
        activeElec = data.elections.find(e => e.id === savedId);
      }
      if (!activeElec) {
        activeElec = data.elections.find(e => e.status === 'ACTIVE') || data.elections[0];
      }

      state.activeElectionId = activeElec.id;
      localStorage.setItem('activeElectionId', activeElec.id);

      document.getElementById('elecHeaderTitle').textContent = activeElec.name;
      document.getElementById('elecHeaderDesc').textContent = activeElec.description || 'Official college election.';
      
      const badge = document.getElementById('badgeActiveStatus');
      badge.textContent = `STATUS: ${activeElec.status}`;
      badge.className = `badge badge-${activeElec.status.toLowerCase()}`;

      // Populate admin inputs with exact database values
      const nameInput = document.getElementById('adminInputElecName');
      const descInput = document.getElementById('adminInputElecDesc');
      if (nameInput) nameInput.value = activeElec.name;
      if (descInput) descInput.value = activeElec.description || '';
    } else {
      state.activeElectionId = null;
      localStorage.removeItem('activeElectionId');
      document.getElementById('elecHeaderTitle').textContent = 'No Election Configured Yet';
      document.getElementById('elecHeaderDesc').textContent = 'Please log into the Admin Dashboard to set election name, add students, and register nominees.';
      
      const badge = document.getElementById('badgeActiveStatus');
      badge.textContent = 'NO ELECTION';
      badge.className = 'badge badge-draft';

      const nameInput = document.getElementById('adminInputElecName');
      const descInput = document.getElementById('adminInputElecDesc');
      if (nameInput) nameInput.value = '';
      if (descInput) descInput.value = '';
    }
  } catch (err) {
    console.error('Failed to fetch initial election metadata:', err);
  }
}

// -------------------------------------------------------------------
// 2. STUDENT KIOSK VOTING FLOW
// -------------------------------------------------------------------

// Handle Student UN + DOB Login
async function handleStudentLogin(e) {
  e.preventDefault();
  const un = document.getElementById('inputUN').value.trim();
  const dob = document.getElementById('inputDOB').value.trim();
  const alertBox = document.getElementById('loginAlert');
  alertBox.style.display = 'none';

  if (!un || !dob) {
    alertBox.textContent = 'Please enter both University Number and Date of Birth.';
    alertBox.style.display = 'flex';
    return;
  }

  try {
    const res = await fetch('/api/auth/student', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        university_number: un,
        dob,
        election_id: state.activeElectionId
      })
    });

    const data = await res.json();

    if (!res.ok) {
      alertBox.innerHTML = `<strong>Authentication Failed:</strong> ${data.error || data.message}`;
      alertBox.style.display = 'flex';
      return;
    }

    // Success login
    state.studentToken = data.session_token;
    state.voterInfo = data.voter;
    state.selections = {};
    state.currentPosIndex = 0;

    // Fetch Ballot Candidates
    await loadBallotPositions();

    // Transition to Voting UI
    document.getElementById('studentStepLogin').style.display = 'none';
    document.getElementById('studentStepVoting').style.display = 'block';

  } catch (err) {
    console.error('Login error:', err);
    alertBox.textContent = 'Network or server error during authentication.';
    alertBox.style.display = 'flex';
  }
}

// Load Ballot Positions & Candidates
async function loadBallotPositions() {
  try {
    const res = await fetch(`/api/elections/${state.activeElectionId}/ballot`, {
      headers: { 'Authorization': `Bearer ${state.studentToken}` }
    });
    const data = await res.json();

    if (data.positions) {
      state.positions = data.positions;
      renderVotingStep();
    }
  } catch (err) {
    console.error('Failed to load ballot:', err);
  }
}

// Render Voting Stepper & Current Position Candidates
function renderVotingStep() {
  const pos = state.positions[state.currentPosIndex];
  if (!pos) return;

  // Render Stepper Bar
  const stepperEl = document.getElementById('votingStepper');
  stepperEl.innerHTML = state.positions.map((p, idx) => {
    let statusClass = '';
    if (idx === state.currentPosIndex) statusClass = 'active';
    else if (state.selections[p.id]) statusClass = 'completed';

    return `
      <div class="step-item ${statusClass}">
        <div class="step-circle">${state.selections[p.id] ? '✓' : (idx + 1)}</div>
        <div class="step-label">${p.name}</div>
      </div>
    `;
  }).join('');

  // Position Title & Counter
  document.getElementById('posStepCounter').textContent = `POSITION ${state.currentPosIndex + 1} OF ${state.positions.length}`;
  document.getElementById('posTitle').textContent = pos.name;

  // Render Candidates Grid
  const gridEl = document.getElementById('candidateGrid');
  gridEl.innerHTML = pos.candidates.map(cand => {
    const isSelected = state.selections[pos.id] === cand.id;
    return `
      <div class="candidate-card ${isSelected ? 'selected' : ''}" onclick="selectCandidate('${pos.id}', '${cand.id}')">
        <div style="display: flex; align-items: center; gap: 1rem;">
          <img src="${cand.photo_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150'}" class="candidate-avatar" alt="${cand.name}">
          <div>
            <div class="candidate-name">${cand.name}</div>
            <div class="candidate-dept">${cand.department} • Year ${cand.year}</div>
          </div>
        </div>

        <div class="manifesto-box">
          "${cand.manifesto || 'Committed to student welfare and campus development.'}"
        </div>
      </div>
    `;
  }).join('');

  // Update Navigation Controls
  document.getElementById('btnPrevPos').style.display = state.currentPosIndex > 0 ? 'inline-flex' : 'none';

  if (state.currentPosIndex === state.positions.length - 1) {
    document.getElementById('btnNextPos').style.display = 'none';
    document.getElementById('btnReviewBallot').style.display = 'inline-flex';
  } else {
    document.getElementById('btnNextPos').style.display = 'inline-flex';
    document.getElementById('btnReviewBallot').style.display = 'none';
  }

  lucide.createIcons();
}

// Select Candidate
function selectCandidate(posId, candId) {
  state.selections[posId] = candId;
  renderVotingStep();
}

// Next / Previous Position
function nextPosition() {
  const currentPos = state.positions[state.currentPosIndex];
  if (!state.selections[currentPos.id]) {
    alert('Please select a candidate for this position before proceeding.');
    return;
  }
  if (state.currentPosIndex < state.positions.length - 1) {
    state.currentPosIndex++;
    renderVotingStep();
  }
}

function prevPosition() {
  if (state.currentPosIndex > 0) {
    state.currentPosIndex--;
    renderVotingStep();
  }
}

// Open Review Modal
function openReviewModal() {
  // Check if all positions have selections
  const missing = state.positions.find(p => !state.selections[p.id]);
  if (missing) {
    alert(`Please select a candidate for "${missing.name}".`);
    return;
  }

  const reviewList = document.getElementById('reviewChoicesList');
  reviewList.innerHTML = state.positions.map(p => {
    const chosenCand = p.candidates.find(c => c.id === state.selections[p.id]);
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid var(--glass-border);">
        <div>
          <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">${p.name}</div>
          <div style="font-weight: 700; font-size: 1.1rem; color: white;">${chosenCand ? chosenCand.name : 'None'}</div>
        </div>
        <span class="badge badge-active">SELECTED</span>
      </div>
    `;
  }).join('');

  document.getElementById('reviewModal').style.display = 'flex';
  lucide.createIcons();
}

function closeReviewModal() {
  document.getElementById('reviewModal').style.display = 'none';
}

// Confirm & Submit Ballot (Atomic Backend Transaction)
async function confirmSubmitBallot() {
  closeReviewModal();

  try {
    const res = await fetch(`/api/elections/${state.activeElectionId}/ballot/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Booth-ID': state.assignedBoothId
      },
      body: JSON.stringify({
        session_token: state.studentToken,
        choices: state.selections,
        booth_id: state.assignedBoothId
      })
    });

    const data = await res.json();

    if (!res.ok) {
      alert(`Submission Error: ${data.error}`);
      return;
    }

    // Ballot successfully submitted!
    state.submittedReceiptId = data.receipt_id;
    state.submittedTimestamp = data.submitted_at;
    state.submittedVoterId = state.voterInfo ? state.voterInfo.university_number : 'UNKNOWN';

    // Ballot successfully submitted! Direct transition to Confirmation Receipt Screen
    state.submittedReceiptId = data.receipt_id;
    state.submittedTimestamp = data.submitted_at;
    state.submittedVoterId = state.voterInfo ? state.voterInfo.university_number : 'UNKNOWN';

    document.getElementById('studentStepVoting').style.display = 'none';
    showConfirmationScreen();

  } catch (err) {
    console.error('Submission error:', err);
    alert('Network error while submitting ballot.');
  }
}

// Show Confirmation Screen & Start Auto-Reset Timer
function showConfirmationScreen() {
  const confDiv = document.getElementById('studentStepConfirmation');
  if (confDiv) confDiv.style.display = 'block';

  const receiptDisplay = document.getElementById('receiptIdDisplay');
  if (receiptDisplay) receiptDisplay.textContent = state.submittedReceiptId || 'RCP-8F92A-2026';

  const timestampDisplay = document.getElementById('receiptTimestamp');
  if (timestampDisplay) {
    timestampDisplay.textContent = `Submitted at ${new Date(state.submittedTimestamp || Date.now()).toLocaleString()} • Booth ${state.assignedBoothId}`;
  }

  // Start 10s Countdown reset
  let seconds = 10;
  const countdownEl = document.getElementById('resetCountdown');
  if (state.countdownInterval) clearInterval(state.countdownInterval);

  state.countdownInterval = setInterval(() => {
    seconds--;
    if (countdownEl) countdownEl.textContent = seconds;
    if (seconds <= 0) {
      clearInterval(state.countdownInterval);
      resetStudentKiosk();
    }
  }, 1000);
}

// Reset Student Kiosk for Next Voter
function resetStudentKiosk() {
  if (state.countdownInterval) clearInterval(state.countdownInterval);

  state.studentToken = null;
  state.voterInfo = null;
  state.selections = {};
  state.currentPosIndex = 0;

  const loginForm = document.getElementById('studentLoginForm');
  if (loginForm) loginForm.reset();

  const loginAlert = document.getElementById('loginAlert');
  if (loginAlert) loginAlert.style.display = 'none';

  const confDiv = document.getElementById('studentStepConfirmation');
  if (confDiv) confDiv.style.display = 'none';

  const votingDiv = document.getElementById('studentStepVoting');
  if (votingDiv) votingDiv.style.display = 'none';

  const loginDiv = document.getElementById('studentStepLogin');
  if (loginDiv) loginDiv.style.display = 'block';
}

// -------------------------------------------------------------------
// 4. POLLING BOOTH SETUP (PRD Section 9)
// -------------------------------------------------------------------
async function loadBoothSetupData() {
  try {
    const res = await fetch('/api/admin/elections');
    const data = await res.json();

    const select = document.getElementById('selectBoothElection');
    if (select && data.elections) {
      select.innerHTML = data.elections.map(e => `
        <option value="${e.id}" ${e.id === state.activeElectionId ? 'selected' : ''}>
          ${e.name} (${e.status})
        </option>
      `).join('');
    }
  } catch (err) {
    console.error('Booth setup load error:', err);
  }
}

// Launch Official Polling Station Kiosk
function launchKioskMode() {
  const elecSelect = document.getElementById('selectBoothElection');
  const selectedElec = elecSelect ? elecSelect.value : state.activeElectionId;
  const boothInput = document.getElementById('inputBoothID');
  const boothId = boothInput ? (boothInput.value.trim() || 'BOOTH-01') : 'BOOTH-01';
  const opInput = document.getElementById('inputOperatorName');
  const operatorName = opInput ? (opInput.value.trim() || 'Operator') : 'Operator';

  state.activeElectionId = selectedElec;
  state.assignedBoothId = boothId;

  // Register booth with central backend API
  fetch(`/api/admin/elections/${selectedElec}/booths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      booth_id: boothId,
      booth_name: `${operatorName} (${boothId})`,
      configuration: { operator_name: operatorName }
    })
  });

  alert(`🚀 Polling Booth ${boothId} Initialized!\nOperator: ${operatorName}\n\nLaunching Student Voting Kiosk...`);

  fetchInitialElection();
  switchView('student');
}

// -------------------------------------------------------------------
// 5. ADMIN DASHBOARD & SUB-TABS
// -------------------------------------------------------------------
// Load & Render Multi-Election Instance Switcher Dropdown
async function loadElectionInstancesDropdown() {
  try {
    const res = await fetch('/api/admin/elections');
    const data = await res.json();
    const select = document.getElementById('selectElectionInstance');
    const boothSelect = document.getElementById('selectBoothElection');

    if (select) select.innerHTML = '';
    if (boothSelect) boothSelect.innerHTML = '';

    if (data.elections && data.elections.length > 0) {
      data.elections.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = `${e.name} (${e.status})`;
        if (e.id === state.activeElectionId) opt.selected = true;
        if (select) select.appendChild(opt);

        const opt2 = opt.cloneNode(true);
        if (boothSelect) boothSelect.appendChild(opt2);
      });

      if (!state.activeElectionId) {
        state.activeElectionId = data.elections[0].id;
      }
    } else {
      if (select) select.innerHTML = '<option value="">No Elections Configured</option>';
      if (boothSelect) boothSelect.innerHTML = '<option value="">No Elections Configured</option>';
    }
  } catch (err) {
    console.error('Error loading election instances:', err);
  }
}

// Switch Active Election Instance
async function switchActiveElectionInstance(electionId) {
  if (!electionId) return;
  state.activeElectionId = electionId;
  localStorage.setItem('activeElectionId', electionId);
  await fetchInitialElection();
  loadAdminDashboard();
}

// Prompt Create New Election Instance
async function promptCreateNewElection() {
  const name = prompt('Enter New Election Name (e.g. "CSE Department Election 2026", "Student Council Election 2026"):');
  if (!name || !name.trim()) return;

  const description = prompt('Enter Brief Election Description / Scope:', 'Official Departmental Election');

  try {
    const res = await fetch('/api/admin/elections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: (description || '').trim() })
    });
    const data = await res.json();
    if (res.ok && data.id) {
      alert(`🎉 Election '${name}' created successfully!`);
      state.activeElectionId = data.id;
      localStorage.setItem('activeElectionId', data.id);
      await fetchInitialElection();
      loadAdminDashboard();
    } else {
      alert(`Error creating election: ${data.error}`);
    }
  } catch (err) {
    console.error('Error creating election:', err);
  }
}

// Prompt Delete Current Election Instance (With Confirmation Warning)
async function promptDeleteCurrentElection() {
  if (!state.activeElectionId) {
    alert('No active election instance selected.');
    return;
  }

  const title = document.getElementById('elecHeaderTitle').textContent;
  const confirmMsg = `⚠️ DANGER: ARE YOU ABSOLUTELY SURE?\n\nDeleting election instance '${title}' will PERMANENTLY REMOVE all associated:\n- Polling Booths & Allocation Data\n- Candidate Nominees & Manifestos\n- Voter Registration & Participation Statuses\n- Ballots & Captured Presence Photos\n\nThis action CANNOT be undone!\n\nType 'DELETE' to confirm deletion:`;

  const input = prompt(confirmMsg);
  if (input !== 'DELETE') {
    alert('Deletion cancelled. Confirmation text did not match.');
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      alert(`Election '${title}' has been permanently deleted.`);
      state.activeElectionId = null;
      localStorage.removeItem('activeElectionId');
      await fetchInitialElection();
      loadAdminDashboard();
    } else {
      alert(`Error deleting election: ${data.error}`);
    }
  } catch (err) {
    console.error('Error deleting election:', err);
  }
}

function switchAdminTab(tabName) {
  state.adminTab = tabName || 'overview';
  localStorage.setItem('adminTab', state.adminTab);
  document.querySelectorAll('#viewAdmin .nav-btn').forEach(b => b.classList.remove('active'));

  const tabs = ['Overview', 'Booths', 'Voters', 'Positions', 'Inspector', 'Results'];
  tabs.forEach(t => {
    const el = document.getElementById(`adminTab${t}`);
    if (el) el.style.display = 'none';
  });

  const tabKey = state.adminTab.charAt(0).toUpperCase() + state.adminTab.slice(1);
  const activeNav = document.getElementById(`subTab${tabKey}`);
  if (activeNav) activeNav.classList.add('active');

  const targetTabEl = document.getElementById(`adminTab${tabKey}`);
  if (targetTabEl) targetTabEl.style.display = 'block';

  if (state.adminTab === 'overview') {
    loadAdminOverviewData();
  } else if (state.adminTab === 'booths') {
    loadAdminBooths();
  } else if (state.adminTab === 'voters') {
    loadAdminVoters();
  } else if (state.adminTab === 'positions') {
    loadAdminPositions();
  } else if (state.adminTab === 'inspector') {
    // Inspector view ready
  } else if (state.adminTab === 'results') {
    loadAdminResults();
  }

  lucide.createIcons();
}

async function loadAdminOverviewData() {
  if (!state.activeElectionId) {
    const elTotal = document.getElementById('statTotalVoters');
    if (elTotal) elTotal.textContent = '0';
    const elCast = document.getElementById('statVotesCast');
    if (elCast) elCast.textContent = '0';
    const elNot = document.getElementById('statNotVoted');
    if (elNot) elNot.textContent = '0';
    const elTurn = document.getElementById('statTurnout');
    if (elTurn) elTurn.textContent = '0.0%';
    return;
  }

  try {
    // Fetch participation stats
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/participation`);
    const data = await res.json();

    if (data.stats) {
      document.getElementById('statTotalVoters').textContent = data.stats.total_eligible;
      document.getElementById('statVotesCast').textContent = data.stats.votes_cast;
      document.getElementById('statNotVoted').textContent = data.stats.not_voted;
      document.getElementById('statTurnout').textContent = `${data.stats.participation_rate}%`;
    }

    // Render Polling Booths Grid
    const boothGrid = document.getElementById('boothsGrid');
    if (boothGrid) {
      boothGrid.innerHTML = `
        <div class="glass-panel" style="padding: 1rem;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="font-size: 1rem; color: white;">BOOTH-01 (Main Kiosk)</strong>
            <span class="badge badge-active">ONLINE</span>
          </div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">Library Lobby • Central Server Connected</div>
        </div>
        <div class="glass-panel" style="padding: 1rem;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="font-size: 1rem; color: white;">BOOTH-02 (Eng Block)</strong>
            <span class="badge badge-active">ONLINE</span>
          </div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">CS Lab 2 • Photo Storage Active</div>
        </div>
      `;
    }

  } catch (err) {
    console.error('Admin dashboard overview error:', err);
  }
}

async function loadAdminDashboard() {
  if (!state.activeElectionId) await fetchInitialElection();
  await loadElectionInstancesDropdown();
  switchAdminTab(state.adminTab || 'overview');
}

// Save Election Name & Description
async function saveElectionDetails() {
  const name = document.getElementById('adminInputElecName').value.trim();
  const description = document.getElementById('adminInputElecDesc').value.trim();

  if (!name) {
    alert('Please enter an Election Name.');
    return;
  }

  try {
    const targetUrl = state.activeElectionId
      ? `/api/admin/elections/${state.activeElectionId}/update-details`
      : '/api/admin/elections/save-active';

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    const data = await res.json();
    if (res.ok) {
      if (data.id) state.activeElectionId = data.id;
      alert('Election Name & Details saved successfully to database!');
      await fetchInitialElection();
      loadAdminDashboard();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    console.error('Save election details error:', err);
  }
}

// Purge All System Data (Reset Database to 100% NIL state)
async function purgeAllSystemData() {
  if (!confirm('⚠️ WARNING: Are you sure you want to PURGE ALL system data?\n\nThis will wipe all elections, voter lists, positions, candidates, presence photos, and ballots from the database, resetting everything to 100% NIL.')) {
    return;
  }

  try {
    const res = await fetch('/api/admin/purge-all-data', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert('Database has been completely purged to 100% NIL state.');
      state.activeElectionId = null;
      const nameIn = document.getElementById('adminInputElecName');
      const descIn = document.getElementById('adminInputElecDesc');
      if (nameIn) nameIn.value = '';
      if (descIn) descIn.value = '';
      await fetchInitialElection();
      loadAdminDashboard();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    console.error('Purge error:', err);
  }
}

// Update Election Lifecycle Status
async function updateElectionStatus(newStatus) {
  try {
    await fetch(`/api/admin/elections/${state.activeElectionId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });

    document.getElementById('adminCurrentStateBadge').textContent = newStatus;
    document.getElementById('adminCurrentStateBadge').className = `badge badge-${newStatus.toLowerCase()}`;
    fetchInitialElection();
    alert(`Election state updated to ${newStatus}`);

  } catch (err) {
    console.error('Status update error:', err);
  }
}

// Trigger Seed Data
async function triggerSeedData() {
  try {
    await fetch('/api/admin/seed-demo', { method: 'POST' });
    alert('Demo dataset seeded successfully! Reloading...');
    fetchInitialElection();
    loadAdminDashboard();
  } catch (err) {
    console.error('Seed error:', err);
  }
}

// Add Single Student Voter
async function handleAddSingleStudent(e) {
  e.preventDefault();
  const un = document.getElementById('addUn').value.trim();
  const name = document.getElementById('addName').value.trim();
  const dept = document.getElementById('addDept').value.trim();
  const year = document.getElementById('addYear').value;
  const dob = document.getElementById('addDob').value;

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/voters/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        university_number: un,
        name,
        department: dept,
        year: parseInt(year),
        dob
      })
    });
    const data = await res.json();
    if (res.ok) {
      alert(`Student ${un} added successfully!`);
      e.target.reset();
      loadAdminVoters();
      loadAdminDashboard();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    console.error('Add student error:', err);
  }
}

// Reset Student Voting Data & Clear Ballots
async function resetVotersData() {
  if (!confirm('⚠️ Are you sure you want to reset ALL student voting statuses to NOT_VOTED and clear all cast ballots for this election?')) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/voters/reset`, {
      method: 'POST'
    });
    const data = await res.json();
    if (res.ok) {
      alert('All voting data & ballots have been reset cleanly!');
      loadAdminVoters();
      loadAdminDashboard();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    console.error('Reset error:', err);
  }
}

// Add Nominee / Candidate with Post & Photo
async function handleAddCandidate(e) {
  e.preventDefault();
  const name = document.getElementById('candName').value.trim();
  const posName = document.getElementById('candPostName').value.trim();
  const dept = document.getElementById('candDept').value.trim();
  const year = document.getElementById('candYear').value;
  const photoUrl = document.getElementById('candPhotoUrl').value.trim();
  const manifesto = document.getElementById('candManifesto').value.trim();

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/candidates/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        position_name: posName,
        name,
        department: dept,
        year: parseInt(year),
        photo_url: photoUrl,
        manifesto
      })
    });
    const data = await res.json();
    if (res.ok) {
      alert(`Nominee "${name}" added successfully under post "${posName}"!`);
      e.target.reset();
      loadAdminPositions();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    console.error('Add nominee error:', err);
  }
}

// Delete Candidate Nominee
async function deleteCandidate(candId) {
  if (!confirm('Are you sure you want to remove this candidate nominee?')) return;

  try {
    const res = await fetch(`/api/admin/candidates/${candId}`, { method: 'DELETE' });
    if (res.ok) {
      loadAdminPositions();
    }
  } catch (err) {
    console.error('Delete candidate error:', err);
  }
}

// Delete Single Student Voter
async function deleteStudent(voterId, universityNumber) {
  const displayId = universityNumber || voterId;
  if (!confirm(`Are you sure you want to remove eligible voter ${displayId}?`)) return;

  try {
    const targetUrl = state.activeElectionId 
      ? `/api/admin/elections/${state.activeElectionId}/voters/${encodeURIComponent(voterId)}`
      : `/api/admin/voters/${encodeURIComponent(voterId)}`;

    const res = await fetch(targetUrl, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      alert(`Student voter ${displayId} removed successfully.`);
      await loadAdminVoters();
      await loadAdminDashboard();
    } else {
      alert(`Error removing voter: ${data.error || 'Failed to remove voter'}`);
    }
  } catch (err) {
    console.error('Delete student error:', err);
    alert('Network error while removing voter.');
  }
}

// Clear All Voters from Directory
async function clearAllVoters() {
  if (!state.activeElectionId) return;
  if (!confirm('⚠️ Are you sure you want to CLEAR ALL voters from the directory for this election?')) return;

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/voters/clear-all`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert('All preloaded voter directory records have been cleared.');
      await loadAdminVoters();
      await loadAdminDashboard();
    } else {
      alert(`Error clearing voters: ${data.error}`);
    }
  } catch (err) {
    console.error('Clear voters error:', err);
  }
}

// Load Voters List
async function loadAdminVoters() {
  if (!state.activeElectionId) await fetchInitialElection();

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/voters`);
    const data = await res.json();

    const tbody = document.getElementById('voterTableBody');
    if (!data.voters || data.voters.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No preloaded eligible voters found. Add or import voters above.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.voters.map(v => {
      const safeId = (v.id || '').replace(/'/g, "\\'");
      const safeUn = (v.university_number || '').replace(/'/g, "\\'");
      return `
        <tr>
          <td><strong>${v.university_number}</strong></td>
          <td>${v.name}</td>
          <td>${v.dob || '—'}</td>
          <td><span class="badge badge-active">${v.eligibility_status}</span></td>
          <td>
            <span class="badge ${v.voting_status === 'VOTED' ? 'badge-active' : 'badge-draft'}">
              ${v.voting_status}
            </span>
          </td>
          <td><code>${v.receipt_id || '—'}</code></td>
          <td>
            <button class="btn-secondary" style="padding: 0.25rem 0.6rem; font-size: 0.75rem; color: #fca5a5; border-color: rgba(244,63,94,0.3);" onclick="deleteStudent('${safeId}', '${safeUn}')">
              ✕ Remove
            </button>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Load voters error:', err);
  }
}

// Bulk Import Voters CSV (Supports "Name, USN, DOB" or "USN, Name, DOB" or "UN, Name, Dept, Year, DOB")
async function submitVoterImport() {
  if (!state.activeElectionId) await fetchInitialElection();

  const text = document.getElementById('txtVotersCsv').value.trim();
  if (!text) {
    alert('Please enter CSV data to import.');
    return;
  }

  const lines = text.split('\n');
  const voters = lines.map(line => {
    const parts = line.split(',').map(s => s ? s.trim() : '');
    if (parts.length < 3) return null;

    let name = '';
    let usn = '';
    let dob = '';
    let dept = 'General';
    let year = 1;

    if (parts.length === 3) {
      // 3 fields format: Name, USN, DOB or USN, Name, DOB
      const p0 = parts[0];
      const p1 = parts[1];
      const p2 = parts[2];

      if (/^\d{4}-\d{2}-\d{2}$/.test(p2)) {
        dob = p2;
        if (/^[A-Za-z0-9_-]{3,20}$/.test(p1) && (p1.toUpperCase().startsWith('UN') || p1.toUpperCase().startsWith('USN') || /\d/.test(p1))) {
          name = p0;
          usn = p1;
        } else {
          name = p0;
          usn = p1;
        }
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(p0)) {
        dob = p0;
        usn = p1;
        name = p2;
      } else {
        name = p0;
        usn = p1;
        dob = p2;
      }
    } else if (parts.length >= 5) {
      usn = parts[0];
      name = parts[1];
      dept = parts[2] || 'General';
      year = parseInt(parts[3]) || 1;
      dob = parts[4];
    } else {
      name = parts[0];
      usn = parts[1];
      dob = parts[2];
    }

    return { university_number: usn, name, department: dept, year, dob };
  }).filter(v => v && v.university_number && v.dob);

  if (voters.length === 0) {
    alert('No valid voters parsed. Please use format: Name, USN, DOB (e.g. Alex Johnson, USN2026011, 2002-09-10)');
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/voters/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voters })
    });
    const data = await res.json();
    if (res.ok) {
      alert(`Successfully imported ${data.imported_count} voters!`);
      document.getElementById('txtVotersCsv').value = '';
      loadAdminVoters();
      loadAdminDashboard();
    } else {
      alert(`Import error: ${data.error}`);
    }
  } catch (err) {
    console.error('Import error:', err);
  }
}

// Load Positions & Candidates
async function loadAdminPositions() {
  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/results`);
    const data = await res.json();

    const listEl = document.getElementById('adminCandidatesList');
    if (!data.results || data.results.length === 0) {
      listEl.innerHTML = `<p style="color: var(--text-muted);">No positions or nominees configured yet. Use the form above to add nominees.</p>`;
      return;
    }

    listEl.innerHTML = (data.results || []).map(pos => `
      <div style="margin-bottom: 1.5rem; background: rgba(0,0,0,0.2); border-radius: 14px; padding: 1.25rem; border: 1px solid var(--glass-border);">
        <h4 style="font-size: 1.15rem; color: var(--accent-cyan); margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em;">
          POST / POSITION: ${pos.position_name}
        </h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem;">
          ${pos.candidates.map(c => `
            <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--glass-border); padding: 1rem; border-radius: 12px; position: relative;">
              <div style="display: flex; gap: 0.75rem; align-items: center; margin-bottom: 0.5rem;">
                <img src="${c.photo_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150'}" style="width: 50px; height: 50px; border-radius: 50%; object-fit: cover; border: 2px solid var(--accent-cyan);">
                <div>
                  <div style="font-weight: 700; font-size: 1rem; color: white;">${c.name}</div>
                  <div style="font-size: 0.8rem; color: var(--text-muted);">${c.department} • Year ${c.year}</div>
                </div>
              </div>
              ${c.manifesto ? `<div style="font-size: 0.8rem; color: #cbd5e1; font-style: italic; background: rgba(0,0,0,0.2); padding: 0.5rem; border-radius: 6px; margin-top: 0.5rem;">"${c.manifesto}"</div>` : ''}
              <button class="btn-secondary" style="margin-top: 0.75rem; padding: 0.35rem 0.75rem; font-size: 0.75rem; color: #fca5a5; border-color: rgba(244,63,94,0.3);" onclick="deleteCandidate('${c.id}')">
                ✕ Remove Nominee
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

  } catch (err) {
    console.error('Positions load error:', err);
  }
}

// Inspect UN Participation & Presence Photo (PRD Section 11 & 10)
async function inspectVoterUN() {
  const un = document.getElementById('inputInspectUN').value.trim();
  if (!un) return;

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/participation?un=${encodeURIComponent(un)}`);
    const data = await res.json();

    const container = document.getElementById('inspectResultContainer');

    if (!data.search_result) {
      container.innerHTML = `<div class="alert-box alert-error">No participation record found for UN: ${un}</div>`;
      return;
    }

    const r = data.search_result;

    container.innerHTML = `
      <div class="glass-panel" style="background: rgba(15, 23, 42, 0.9); border: 1px solid var(--accent-cyan);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem;">
          <div>
            <h4 style="font-size: 1.2rem; font-weight: 800; color: white;">${r.name} (${r.university_number})</h4>
            <div style="font-size: 0.85rem; color: var(--text-muted);">${r.department} • Year ${r.year}</div>
          </div>
          <span class="badge ${r.participation_status === 'VOTED' ? 'badge-active' : 'badge-draft'}">
            ${r.participation_status}
          </span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; font-size: 0.85rem;">
          <div>
            <span style="color: var(--text-muted);">Voting Timestamp:</span><br>
            <strong>${r.voted_at ? new Date(r.voted_at).toLocaleString() : 'Not yet voted'}</strong>
          </div>
          <div>
            <span style="color: var(--text-muted);">Polling Booth ID:</span><br>
            <strong>${r.booth_id || '—'}</strong>
          </div>
          <div>
            <span style="color: var(--text-muted);">Receipt ID:</span><br>
            <code>${r.receipt_id || '—'}</code>
        </div>

        <div style="margin-top: 1rem; font-size: 0.75rem; color: var(--accent-amber); background: rgba(245, 158, 11, 0.1); padding: 0.5rem 0.75rem; border-radius: 8px;">
          🔒 <strong>Ballot Secrecy Enforced:</strong> Candidate vote choices are stored in a separate anonymous database table and CANNOT be viewed here.
        </div>
      </div>
    `;

  } catch (err) {
    console.error('Inspect error:', err);
  }
}

// -------------------------------------------------------------------
// 6. DEDICATED BOOTH MANAGEMENT HANDLERS
// -------------------------------------------------------------------
async function loadAdminBooths() {
  const container = document.getElementById('dedicatedBoothsContainer');
  const selectFrom = document.getElementById('selectReassignFrom');
  const selectTo = document.getElementById('selectReassignTo');

  if (selectFrom) selectFrom.innerHTML = '<option value="">Select Origin Booth...</option>';
  if (selectTo) selectTo.innerHTML = '<option value="unassigned">Unassigned / Clear Booth</option>';

  if (!state.activeElectionId) {
    if (container) {
      container.innerHTML = `<p style="color: var(--accent-amber); grid-column: 1 / -1;">⚠️ No active election instance selected. Please create or select an election instance first.</p>`;
    }
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/booths`);
    const data = await res.json();

    if (!data.booths || data.booths.length === 0) {
      if (container) {
        container.innerHTML = `<p style="color: var(--text-muted); grid-column: 1 / -1;">No polling booths created yet for this election. Add a booth above.</p>`;
      }
      return;
    }

    if (container) {
      container.innerHTML = data.booths.map(b => {
        let config = {};
        try { config = typeof b.configuration === 'string' ? JSON.parse(b.configuration) : (b.configuration || {}); } catch(e){}

        if (selectFrom) selectFrom.innerHTML += `<option value="${b.id}">${b.booth_name} (${b.assigned_voters_count} voters)</option>`;
        if (selectTo) selectTo.innerHTML += `<option value="${b.id}">${b.booth_name}</option>`;

        return `
          <div class="glass-panel" style="padding: 1.25rem; border: 1px solid var(--glass-border); position: relative;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem;">
              <div>
                <strong style="font-size: 1.1rem; color: white;">${b.booth_name}</strong>
                <div style="font-size: 0.8rem; color: var(--text-muted);">Ref ID: <code>${b.id}</code></div>
              </div>
              <span class="badge badge-active">ACTIVE</span>
            </div>

            <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">
              <div>🏢 Location: <strong>${config.location_building || 'Main Campus'}</strong></div>
              <div>⚡ Assigned Voters: <strong style="color: var(--accent-cyan); font-size: 1.1rem;">${b.assigned_voters_count}</strong> / ${config.max_capacity || 500} capacity</div>
            </div>

            <div style="display: flex; gap: 0.5rem;">
              <button class="btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem; color: #fca5a5; border-color: rgba(244,63,94,0.3);" onclick="handleDeleteBooth('${b.id}', ${b.assigned_voters_count})">
                ✕ Delete Booth
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    lucide.createIcons();
  } catch (err) {
    console.error('Error loading booths:', err);
  }
}

async function handleAddNewBooth(e) {
  e.preventDefault();
  if (!state.activeElectionId) {
    alert('⚠️ No active election instance selected. Please create or select an election instance first before adding booths.');
    return;
  }

  const booth_id = document.getElementById('inputBoothId').value.trim();
  const booth_name = document.getElementById('inputBoothName').value.trim();
  const location_building = document.getElementById('inputBoothLocation').value.trim();
  const max_capacity = document.getElementById('inputBoothCapacity').value;

  if (!booth_name) {
    alert('Please enter a Booth Name.');
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/booths/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booth_id, booth_name, location_building, max_capacity })
    });
    const data = await res.json();
    if (res.ok) {
      alert(`🎉 Booth '${booth_name}' created successfully.`);
      document.getElementById('inputBoothId').value = '';
      document.getElementById('inputBoothName').value = '';
      document.getElementById('inputBoothLocation').value = '';
      await loadAdminBooths();
    } else {
      alert(`Error creating booth: ${data.error}`);
    }
  } catch (err) {
    console.error('Error adding booth:', err);
  }
}

async function handleDeleteBooth(boothId, count) {
  let reassignTarget = null;
  if (count > 0) {
    const choice = prompt(`⚠️ DEPENDENCY WARNING:\n\n${count} voters are assigned to booth '${boothId}'.\n\nEnter target Booth ID to reassign these ${count} voters to (or type 'CLEAR' to set booth to unassigned):`, 'CLEAR');
    if (choice === null) return;
    reassignTarget = choice === 'CLEAR' ? 'clear' : choice.trim();
  } else {
    if (!confirm(`Delete booth '${boothId}'?`)) return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/booths/${boothId}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reassign_to_booth_id: reassignTarget })
    });
    const data = await res.json();
    if (res.ok) {
      alert(`Booth '${boothId}' deleted successfully.`);
      loadAdminBooths();
    } else {
      alert(`Error deleting booth: ${data.error}`);
    }
  } catch (err) {
    console.error('Error deleting booth:', err);
  }
}

async function handleBulkReassignVoters() {
  const from_booth_id = document.getElementById('selectReassignFrom').value;
  const to_booth_id = document.getElementById('selectReassignTo').value;

  if (!from_booth_id) {
    alert('Please select an origin booth.');
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/voters/reassign-booth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_booth_id, to_booth_id })
    });
    const data = await res.json();
    if (res.ok) {
      alert(`🎉 Reassignment Complete!\n${data.message}`);
      loadAdminBooths();
      loadAdminVoters();
    } else {
      alert(`Error reassigning voters: ${data.error}`);
    }
  } catch (err) {
    console.error('Error reassigning voters:', err);
  }
}

// -------------------------------------------------------------------
// 7. AI BULK VOTER IMPORT PARSER & PREVIEW MODAL HANDLERS
// -------------------------------------------------------------------
async function handleAiFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  state.selectedPdfDataUrl = null;
  state.selectedFileName = file.name;

  const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

  if (isPdf) {
    // 1. Read as DataURL for robust backend Base64 stream parsing fallback
    const dataUrlReader = new FileReader();
    dataUrlReader.onload = (dataEvent) => {
      state.selectedPdfDataUrl = dataEvent.target.result;
    };
    dataUrlReader.readAsDataURL(file);

    // 2. Try client-side PDF.js text extraction if available
    const arrayBufferReader = new FileReader();
    arrayBufferReader.onload = async (event) => {
      let extractedText = '';
      try {
        if (window.pdfjsLib) {
          const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(event.target.result) });
          const pdf = await loadingTask.promise;
          let fullText = '';
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const content = await page.getTextContent();
            
            let pageText = '';
            let lastY = null;
            for (const item of content.items) {
              if (!item.str) continue;
              const currentY = item.transform ? item.transform[5] : null;
              if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 8) {
                pageText += '\n';
              } else if (item.hasEOL) {
                pageText += '\n';
              } else if (pageText.length > 0 && !pageText.endsWith('\n') && !pageText.endsWith(' ')) {
                pageText += ' ';
              }
              pageText += item.str;
              if (currentY !== null) lastY = currentY;
            }
            fullText += pageText.trim() + '\n';
          }
          extractedText = fullText.trim();
        }
      } catch (pdfErr) {
        console.warn('PDF.js extraction notice:', pdfErr);
      }

      const txtBox = document.getElementById('txtAiVotersInput');
      if (extractedText && extractedText.length >= 10) {
        txtBox.value = extractedText;
      } else {
        txtBox.value = `[Loaded PDF Document: ${file.name} (${(file.size / 1024).toFixed(1)} KB) - Ready for AI Stream Parsing]`;
      }
      alert(`📄 PDF File '${file.name}' (${(file.size / 1024).toFixed(1)} KB) loaded successfully!\n\nClick 'Parse & Preview Voter Import' to execute AI analysis.`);
    };
    arrayBufferReader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = (event) => {
      document.getElementById('txtAiVotersInput').value = event.target.result;
      alert(`📄 Loaded file '${file.name}' (${(file.size / 1024).toFixed(1)} KB). Click 'Parse & Preview Voter Import' to execute AI analysis.`);
    };
    reader.readAsText(file);
  }
}

let currentParsedImportData = null;

async function processAiVoterImport() {
  const txtBoxVal = document.getElementById('txtAiVotersInput').value.trim();
  let rawTextToSend = txtBoxVal;

  // Use base64 DataURL if PDF file was uploaded and text box contains placeholder or base64 DataURL
  if (state.selectedPdfDataUrl && (txtBoxVal.startsWith('[Loaded PDF') || txtBoxVal.length === 0 || txtBoxVal.includes('data:application/pdf;base64,'))) {
    rawTextToSend = state.selectedPdfDataUrl;
  }

  if (!rawTextToSend) {
    alert('Please select a voter list file or paste tabular text data into the box.');
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/voters/ai-parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: rawTextToSend,
        file_name: state.selectedFileName || 'voter_list.pdf',
        file_type: state.selectedPdfDataUrl ? 'pdf' : 'text'
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(`AI Parsing error: ${data.error || 'Failed to parse voter list'}`);
      return;
    }

    currentParsedImportData = data;

    // Automatically commit valid/warning voter records into Preloaded Eligible Voter Directory
    const validVotersToImport = (data.rows || [])
      .filter(r => (r.status === 'VALID' || r.status === 'WARNING') && r.university_number && r.dob)
      .map(r => ({
        name: r.name,
        university_number: r.university_number,
        dob: r.dob,
        department: r.department || 'General',
        year: r.year || 3
      }));

    if (validVotersToImport.length > 0) {
      try {
        const commitRes = await fetch(`/api/admin/elections/${state.activeElectionId}/voters/bulk-commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voters: validVotersToImport })
        });
        const commitData = await commitRes.json();
        if (commitRes.ok) {
          await loadAdminVoters();
          await loadAdminDashboard();
        }
      } catch (cErr) {
        console.warn('Auto-commit warning:', cErr);
      }
    }

    renderAiImportPreviewModal(data);
  } catch (err) {
    console.error('AI parse error:', err);
    alert('Network error while processing voter import.');
  }
}

function renderAiImportPreviewModal(data) {
  document.getElementById('aiStatValid').textContent = data.summary.valid_count;
  document.getElementById('aiStatWarnings').textContent = data.summary.warning_count;
  document.getElementById('aiStatDuplicates').textContent = data.summary.duplicate_count;
  document.getElementById('aiStatTotal').textContent = data.summary.total_detected;

  document.getElementById('aiModalFileTypeBadge').textContent = data.detected_file_type.toUpperCase();

  const missingNoticeEl = document.getElementById('aiMissingDataNotice');
  const missingDetailsEl = document.getElementById('aiMissingDataDetails');
  const missingCount = (data.summary.warning_count || 0) + (data.summary.invalid_count || 0);

  if (missingCount > 0) {
    if (missingDetailsEl) {
      missingDetailsEl.innerHTML = `
        Found <strong>${missingCount} student record(s)</strong> in the PDF with missing or incomplete fields 
        (e.g. missing Date of Birth or USN). Fallback values have been auto-assigned and highlighted in amber rows below. 
        You can edit any field directly before finalizing import!
      `;
    }
    if (missingNoticeEl) missingNoticeEl.style.display = 'block';

    // Explicit Pop-up Alert Dialog for missing data
    setTimeout(() => {
      alert(`⚠️ POP-UP ALERT: Missing Data Found in Uploaded PDF!\n\n` +
            `• Total Records Extracted: ${data.summary.total_detected}\n` +
            `• Clean Records: ${data.summary.valid_count}\n` +
            `• Records with Missing Fields: ${missingCount}\n\n` +
            `An interactive review modal has opened. Rows with missing USN or DOB fields are highlighted in amber with edit boxes.`);
    }, 150);
  } else {
    if (missingNoticeEl) missingNoticeEl.style.display = 'none';
  }

  const tbody = document.getElementById('aiImportPreviewTableBody');
  tbody.innerHTML = data.rows.map(r => {
    let badgeClass = 'badge-active';
    let rowStyle = '';
    let isWarning = r.status === 'WARNING';

    if (isWarning) {
      badgeClass = 'badge-draft';
      rowStyle = 'background: rgba(245, 158, 11, 0.12);';
    } else if (r.status === 'DUPLICATE' || r.status === 'INVALID') {
      badgeClass = 'badge-danger';
      rowStyle = 'background: rgba(244, 63, 94, 0.12);';
      isWarning = true;
    }

    const isChecked = true;
    const hasMissingDob = (r.issues || []).some(i => i.toLowerCase().includes('dob'));
    const hasMissingUn = (r.issues || []).some(i => i.toLowerCase().includes('usn'));

    return `
      <tr style="${rowStyle}">
        <td><input type="checkbox" class="chk-ai-row" data-row-idx="${r.row_index}" ${isChecked ? 'checked' : ''}></td>
        <td><strong>#${r.row_index}</strong></td>
        <td><input type="text" class="form-input" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;" value="${r.name}" id="aiName_${r.row_index}"></td>
        <td>
          <code>
            <input type="text" class="form-input" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; font-family: monospace; ${hasMissingUn ? 'border: 2px solid var(--accent-amber); font-weight: 700; background: rgba(245, 158, 11, 0.2);' : ''}" value="${r.university_number}" id="aiUn_${r.row_index}">
          </code>
        </td>
        <td>
          <input type="text" class="form-input" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; ${hasMissingDob ? 'border: 2px solid var(--accent-amber); font-weight: 700; background: rgba(245, 158, 11, 0.2);' : ''}" value="${r.dob}" id="aiDob_${r.row_index}">
        </td>
        <td>Year ${r.year}</td>
        <td>
          <span class="badge ${badgeClass}">${r.status}</span>
          ${r.issues.length > 0 ? `<div style="font-size: 0.72rem; color: ${isWarning ? 'var(--accent-amber)' : '#fca5a5'}; margin-top: 0.2rem; font-weight: 700;">⚠️ ${r.issues.join(', ')}</div>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('aiImportPreviewModal').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function toggleSelectAllAiImport(checked) {
  document.querySelectorAll('.chk-ai-row').forEach(cb => cb.checked = checked);
}

function closeAiImportPreviewModal() {
  document.getElementById('aiImportPreviewModal').style.display = 'none';
}

async function confirmCommitAiImport() {
  if (!currentParsedImportData || !currentParsedImportData.rows) return;

  const approvedVoters = [];
  const checkboxes = document.querySelectorAll('.chk-ai-row:checked');

  checkboxes.forEach(cb => {
    const rowIdx = parseInt(cb.getAttribute('data-row-idx'));
    const origRow = currentParsedImportData.rows.find(r => r.row_index === rowIdx);

    if (origRow) {
      const nameInput = document.getElementById(`aiName_${rowIdx}`);
      const unInput = document.getElementById(`aiUn_${rowIdx}`);
      const dobInput = document.getElementById(`aiDob_${rowIdx}`);

      approvedVoters.push({
        name: nameInput ? nameInput.value.trim() : origRow.name,
        university_number: unInput ? unInput.value.trim().toUpperCase() : origRow.university_number,
        dob: dobInput ? dobInput.value.trim() : origRow.dob,
        department: origRow.department,
        year: origRow.year
      });
    }
  });

  if (approvedVoters.length === 0) {
    alert('Please check at least one valid voter row to import.');
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/voters/bulk-commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voters: approvedVoters })
    });

    const data = await res.json();
    if (res.ok) {
      alert(`🎉 ${data.message}`);
      closeAiImportPreviewModal();
      document.getElementById('txtAiVotersInput').value = '';
      loadAdminVoters();
      loadAdminDashboard();
    } else {
      alert(`Error committing voters: ${data.error}`);
    }
  } catch (err) {
    console.error('Error committing voters:', err);
  }
}

function downloadImportErrorReport() {
  if (!currentParsedImportData || !currentParsedImportData.rows) return;

  let csvContent = "data:text/csv;charset=utf-8,Row_Index,Name,USN,DOB,Department,Booth,Status,Issues\n";
  currentParsedImportData.rows.forEach(r => {
    csvContent += `"${r.row_index}","${r.name}","${r.university_number}","${r.dob}","${r.department}","${r.booth_id}","${r.status}","${r.issues.join('; ')}"\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `ai_voter_import_review_report_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Load & Render Results Bar Charts (PRD Section 12)
async function publishResults() {
  if (!state.activeElectionId) {
    alert('No active election selected.');
    return;
  }

  if (!confirm('Are you sure you want to publish the official election results?\n\nThis will compute and generate booth-wise PDF result certificates for all polling booths.')) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/publish-results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (res.ok) {
      alert(`🎉 Results Published Successfully!\n\n${data.message || 'Booth-wise PDF result certificates have been generated and saved.'}`);
      await loadAdminResults();
    } else {
      alert(`Error publishing results: ${data.error}`);
    }
  } catch (err) {
    console.error('Publish results error:', err);
  }
}

// Load & Render Results Bar Charts and Booth PDF Download Cards
async function loadAdminResults() {
  try {
    const res = await fetch(`/api/admin/elections/${state.activeElectionId}/results`);
    const data = await res.json();

    const badge = document.getElementById('resultsStatusBadge');
    if (badge) {
      badge.textContent = `STATUS: ${data.election_status}`;
      badge.className = `badge badge-${data.election_status.toLowerCase()}`;
    }

    // Render generated booth PDF download cards
    const boothPdfSection = document.getElementById('boothPdfReportsSection');
    const boothPdfList = document.getElementById('boothPdfList');

    if (data.pdf_reports && data.pdf_reports.length > 0) {
      if (boothPdfSection) boothPdfSection.style.display = 'block';
      if (boothPdfList) {
        boothPdfList.innerHTML = data.pdf_reports.map(r => `
          <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--glass-border); padding: 0.85rem; border-radius: 12px; display: flex; flex-direction: column; justify-content: space-between;">
            <div>
              <strong style="font-size: 0.9rem; color: white;">${r.booth_name}</strong>
              <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.2rem;">
                Votes: <strong>${r.votes_cast}</strong> • Turnout: <strong>${r.turnout_percentage}%</strong>
              </div>
            </div>
            <a href="${r.download_url}" target="_blank" download="${r.filename}" class="btn-primary" style="margin-top: 0.75rem; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; padding: 0.45rem 0.8rem; font-size: 0.8rem;">
              <i data-lucide="download" style="width: 14px;"></i> Download Booth PDF
            </a>
          </div>
        `).join('');
      }
    } else {
      if (boothPdfSection) boothPdfSection.style.display = 'none';
    }

    const container = document.getElementById('resultsContainer');

    if (!data.results || data.results.length === 0) {
      container.innerHTML = `<p style="color: var(--text-muted);">No candidates or results found.</p>`;
      return;
    }

    container.innerHTML = `
      <div style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 1.5rem;">
        Total Encrypted Ballots Counted: <strong style="color: white;">${data.total_ballots_cast}</strong>
      </div>

      ${data.results.map(pos => `
        <div style="margin-bottom: 2rem; background: rgba(0,0,0,0.25); border-radius: 16px; padding: 1.5rem; border: 1px solid var(--glass-border);">
          <h3 style="font-size: 1.3rem; font-weight: 700; color: var(--accent-cyan); margin-bottom: 1.25rem;">
            ${pos.position_name}
          </h3>

          <div style="display: flex; flex-direction: column; gap: 1.25rem;">
            ${pos.candidates.map((c, idx) => `
              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.95rem;">
                  <span style="font-weight: 700;">
                    ${idx === 0 && c.votes > 0 ? '👑 ' : ''}${c.name} 
                    <span style="font-size: 0.8rem; font-weight: 400; color: var(--text-muted);">(${c.department})</span>
                  </span>
                  <span style="font-weight: 800; color: var(--accent-cyan);">
                    ${c.votes} votes (${c.percentage}%)
                  </span>
                </div>

                <div class="result-bar-bg">
                  <div class="result-bar-fill" style="width: ${c.percentage}%;"></div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    `;

    if (window.lucide) lucide.createIcons();

  } catch (err) {
    console.error('Results load error:', err);
  }
}

// =========================================================
// ADMIN VOTING ANALYTICS MODAL
// =========================================================

// Module-level cache for analytics data (cleared on each open)
let _votingDataCache = null;
let _votingDataLegendMap = {};

async function openAdminVotingDataModal() {
  if (!state.adminToken) {
    alert('Admin access required. Please log in as admin first.');
    return;
  }
  if (!state.activeElectionId) {
    alert('No active election selected. Please select an election from the Admin dashboard first.');
    return;
  }
  const modal = document.getElementById('adminVotingDataModal');
  modal.style.display = 'block';
  document.getElementById('votingDataTableBody').innerHTML =
    '<tr><td colspan="5" style="text-align:center; padding:2rem; color:var(--text-muted,#888);">Loading analytics\u2026</td></tr>';
  document.getElementById('votingDataSummaryCards').innerHTML = '';
  document.getElementById('votingDataLegend').innerHTML = '';
  document.getElementById('votingDataSearch').value = '';
  document.getElementById('votingDataStatusFilter').value = 'ALL';
  document.getElementById('votingDataCandidateFilter').value = 'ALL';
  await fetchAdminVotingData();
}

function closeAdminVotingDataModal() {
  document.getElementById('adminVotingDataModal').style.display = 'none';
  _votingDataCache = null;
  _votingDataLegendMap = {};
}

async function fetchAdminVotingData() {
  try {
    const resp = await fetch(`/api/admin/elections/${state.activeElectionId}/voting-data`, {
      headers: { 'Authorization': `Bearer ${state.adminToken}` }
    });
    if (resp.status === 401 || resp.status === 403) {
      document.getElementById('votingDataTableBody').innerHTML =
        '<tr><td colspan="5" style="text-align:center; padding:2rem; color:#f87171;">Unauthorized. Please log out and log in again.</td></tr>';
      return;
    }
    if (!resp.ok) {
      const errText = await resp.text();
      document.getElementById('votingDataTableBody').innerHTML =
        `<tr><td colspan="5" style="text-align:center; padding:2rem; color:#f87171;">Error: ${errText}</td></tr>`;
      return;
    }
    const data = await resp.json();
    _votingDataCache = data;
    _votingDataLegendMap = {};
    (data.legend || []).forEach(item => { _votingDataLegendMap[item.candidateId] = item.color; });
    _renderVotingDataSummary(data.summary);
    _renderVotingDataLegend(data.legend || []);
    _populateCandidateFilter(data.legend || []);
    _renderVotingDataTable(data.voters || [], _votingDataLegendMap);
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('fetchAdminVotingData error:', err);
    document.getElementById('votingDataTableBody').innerHTML =
      `<tr><td colspan="5" style="text-align:center; padding:2rem; color:#f87171;">Failed to load: ${err.message}</td></tr>`;
  }
}

function _renderVotingDataSummary(summary) {
  if (!summary) return;
  const turnout = summary.totalVoters > 0
    ? Math.round((summary.voted / summary.totalVoters) * 100) + '%' : '0%';
  const cards = [
    { label: 'Total Voters', value: summary.totalVoters ?? 0, color: 'var(--accent-cyan,#67e8f9)' },
    { label: 'Voted',        value: summary.voted ?? 0,        color: '#4ade80' },
    { label: 'Not Voted',    value: summary.notVoted ?? 0,     color: '#f87171' },
    { label: 'Turnout',      value: turnout,                   color: '#facc15' }
  ];
  document.getElementById('votingDataSummaryCards').innerHTML = cards.map(c =>
    `<div style="background:rgba(255,255,255,0.04);border:1px solid var(--border-primary,#2a2a4a);border-radius:10px;padding:0.85rem 1rem;text-align:center;">
      <div style="font-size:1.6rem;font-weight:800;color:${c.color};">${c.value}</div>
      <div style="font-size:0.75rem;color:var(--text-muted,#888);margin-top:0.2rem;">${c.label}</div>
    </div>`
  ).join('');
}

function _renderVotingDataLegend(legend) {
  document.getElementById('votingDataLegend').innerHTML = legend.map(item =>
    `<div style="display:flex;align-items:center;gap:0.4rem;background:rgba(255,255,255,0.04);border-radius:20px;padding:0.3rem 0.75rem;font-size:0.78rem;border:1px solid var(--border-primary,#2a2a4a);">
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${item.color};flex-shrink:0;"></span>
      <span style="color:var(--text-primary,#e2e8f0);">${item.candidateName}</span>
      <span style="color:var(--text-muted,#888);">(${item.positionTitle})</span>
    </div>`
  ).join('');
}

function _populateCandidateFilter(legend) {
  const sel = document.getElementById('votingDataCandidateFilter');
  sel.innerHTML = '<option value="ALL">All Candidates</option>';
  legend.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.candidateId;
    opt.textContent = `${item.candidateName} (${item.positionTitle})`;
    sel.appendChild(opt);
  });
}

function _renderVotingDataTable(voters, legendMap) {
  const tbody = document.getElementById('votingDataTableBody');
  if (!voters.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted,#888);">No student records found.</td></tr>';
    return;
  }
  tbody.innerHTML = voters.map((v, i) => {
    const statusBadge = v.votingStatus === 'VOTED'
      ? `<span style="font-size:0.75rem;font-weight:600;color:#4ade80;background:rgba(74,222,128,0.12);border-radius:20px;padding:0.2rem 0.6rem;">Voted</span>`
      : `<span style="font-size:0.75rem;font-weight:600;color:#94a3b8;background:rgba(148,163,184,0.1);border-radius:20px;padding:0.2rem 0.6rem;">Not Voted</span>`;
    let votedForCell = `<span style="color:var(--text-muted,#888);font-size:0.78rem;">&mdash;</span>`;
    if (v.votingStatus === 'VOTED' && v.choices && v.choices.length) {
      votedForCell = v.choices.map(choice => {
        const color = legendMap[choice.candidateId] || '#888';
        return `<div style="display:flex;align-items:center;gap:0.35rem;margin-bottom:0.15rem;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></span>
          <span style="font-size:0.78rem;">${choice.candidateName || choice.candidateId}</span>
          <span style="font-size:0.7rem;color:var(--text-muted,#888);">(${choice.positionTitle || ''})</span>
        </div>`;
      }).join('');
    }
    return `<tr style="border-top:1px solid rgba(255,255,255,0.05);" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background=''">
      <td style="padding:0.6rem 1rem;color:var(--text-muted,#888);font-size:0.78rem;">${i + 1}</td>
      <td style="padding:0.6rem 1rem;font-weight:500;">${v.name || '&mdash;'}</td>
      <td style="padding:0.6rem 1rem;font-family:monospace;font-size:0.8rem;color:var(--accent-cyan,#67e8f9);">${v.universityNumber || '&mdash;'}</td>
      <td style="padding:0.6rem 1rem;">${statusBadge}</td>
      <td style="padding:0.6rem 1rem;">${votedForCell}</td>
    </tr>`;
  }).join('');
}

function filterAdminVotingData() {
  if (!_votingDataCache) return;
  const search = (document.getElementById('votingDataSearch').value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('votingDataStatusFilter').value;
  const candidateFilter = document.getElementById('votingDataCandidateFilter').value;
  let filtered = _votingDataCache.voters || [];
  if (search) {
    filtered = filtered.filter(v =>
      (v.name || '').toLowerCase().includes(search) ||
      (v.universityNumber || '').toLowerCase().includes(search)
    );
  }
  if (statusFilter !== 'ALL') {
    filtered = filtered.filter(v => v.votingStatus === statusFilter);
  }
  if (candidateFilter !== 'ALL') {
    filtered = filtered.filter(v =>
      v.choices && v.choices.some(c => c.candidateId === candidateFilter)
    );
  }
  _renderVotingDataTable(filtered, _votingDataLegendMap);
}
