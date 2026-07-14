export enum JobStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

export enum JobKind {
  Agent = "agent",
  Export = "export",
  MotionGraphic = "motion_graphic",
}

export interface Job {
  job_id: string;
  kind: JobKind;
  project_id: string;
  owner_key_id: string;
  status: JobStatus;
  last_message?: string;
  result?: unknown;
  error?: string;
  created_at: number;
  updated_at: number;
  // Rolling window of recent progress messages (capped), for status polling.
  progress?: string[];
  last_progress_at?: number;
  thread_id?: string;
}

export interface CreateJobInput {
  kind: JobKind;
  project_id: string;
  owner_key_id: string;
  thread_id?: string;
}

export interface JobStore {
  create(input: CreateJobInput): Promise<Job>;
  get(id: string): Promise<Job | null>;
  update(id: string, patch: Partial<Job>): Promise<Job | null>;
  // Insert/replace a full record under its existing id (write-through mirrors).
  insert(job: Job): Promise<void>;
  // Non-terminal jobs known to this replica — used at shutdown to fail whatever
  // is still running so pollers get a clean terminal answer instead of limbo.
  listNonTerminal(): Promise<Job[]>;
}
