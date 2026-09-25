/**
 * College Election System — TypeScript Domain Types & Models
 */

export type ElectionStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'CLOSED' | 'RESULTS_PUBLISHED';
export type VoterStatus = 'NOT_VOTED' | 'VOTED';
export type EligibilityStatus = 'ELIGIBLE' | 'BLOCKED';

export interface Admin {
  id: string;
  login_identifier: string;
  name: string;
  password_hash: string;
  role: string;
  created_at: string;
}

export interface Election {
  id: string;
  name: string;
  description?: string;
  start_at?: string;
  end_at?: string;
  status: ElectionStatus;
  created_at: string;
}

export interface Voter {
  id: string;
  university_number: string;
  name: string;
  department: string;
  year: number;
  dob?: string;
  dob_verifier: string;
  eligibility_status: EligibilityStatus;
  created_at: string;
}

export interface ElectionVoter {
  id: string;
  election_id: string;
  voter_id: string;
  status: VoterStatus;
  voted_at?: string;
  booth_id?: string;
  receipt_id?: string;
  voted_choices?: string;
}

export interface CandidateLegendItem {
  candidate_id: string;
  candidate_name: string;
  position_name: string;
  votes: number;
  color_hex: string;
  color_dot: string;
}

export interface VoterVotingDataItem {
  voter_id: string;
  university_number: string;
  name: string;
  department: string;
  year: number;
  status: VoterStatus;
  voted_at?: string;
  candidates: {
    candidate_id: string;
    candidate_name: string;
    position_name: string;
    color_hex: string;
    color_dot: string;
  }[];
}

export interface AdminVotingDataResponse {
  election_id: string;
  election_name: string;
  summary: {
    total_registered: number;
    total_voted: number;
    total_not_voted: number;
  };
  candidate_legend: CandidateLegendItem[];
  voters: VoterVotingDataItem[];
}

export interface Booth {
  id: string;
  election_id: string;
  booth_name: string;
  status: string;
  configuration?: string;
  last_ping?: string;
  created_at: string;
}

export interface Position {
  id: string;
  election_id: string;
  name: string;
  display_order: number;
  max_choices: number;
}

export interface Candidate {
  id: string;
  position_id: string;
  name: string;
  department: string;
  year: number;
  photo_url?: string;
  manifesto?: string;
}

export interface Ballot {
  id: string;
  election_id: string;
  booth_id?: string;
  protected_ballot_data: string;
  submitted_at: string;
}

export interface AuditLog {
  id: string;
  admin_id: string;
  action: string;
  target_type?: string;
  target_id?: string;
  details?: string;
  ip_address?: string;
  created_at: string;
}

export interface StudentAuthPayload {
  university_number: string;
  dob: string;
  booth_id?: string;
}

export interface VoteSubmissionPayload {
  session_token: string;
  choices: Record<string, string>; // position_id -> candidate_id
  booth_id?: string;
}
