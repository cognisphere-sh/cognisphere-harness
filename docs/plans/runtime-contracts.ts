/**
 * Migration design reference, not an installed runtime implementation.
 * Type-checkable contracts and provider/shared orchestration bodies.
 * OS, Docker Engine, transactional admission, archive and filesystem drivers
 * remain implementation work. Sessions sharing a sandbox are not OS-isolated.
 * Selected integration: direct Pi SDK in the execution child, never a new
 * pi --mode rpc subprocess path. AgentHostClient is our boundary transport.
 */
export type RuntimeKind = "process" | "docker";
export type ArchiveKind = "local" | "cloud" | "database";
export type RunOutcome = "completed" | "failed" | "cancelled";
export type RuntimeState = "created" | "running" | "exited" | "missing" | "unknown";

export interface SessionKey { agentId: string; threadId: string; logicalSessionId: string; }
export interface RunIdentity extends SessionKey {
  runId: string;
  fence: number; // session binding generation, independent of workspace/sandbox fences
}
export interface SandboxCompatibility {
  harnessId: string;
  agentId: string; // resolved from trusted configuration, never caller-selected
  runtime: RuntimeKind;
  profileId: string;
  authorityPolicyRevision: string;
  assetRevision: string;
  recipeHash: string;
  networkPolicyRevision: string;
}
export interface SandboxIdentity {
  harnessId: string;
  agentId: string; // singleton uniqueness is (harnessId, agentId), NOT compatibility
  sandboxId: string;
  generation: number; // replaced supervisor/compute incarnation
}
export interface RuntimeRef extends SandboxIdentity {
  kind: RuntimeKind;
  id: string; // container ID or native process identity, not PID alone
}
export interface AgentSandboxConfig {
  maxSessionsPerSandbox: number; // positive integer; proposed default: 4
  maxConcurrentSlots: 1; // REQUIRED baseline; runtime validation rejects >1
  lifecycle: { mode: "idle"; idleMinutes: number } | { mode: "per_turn" | "always_on" };
}
export const EXAMPLE_SANDBOX_CONFIG: AgentSandboxConfig = {
  maxSessionsPerSandbox: 4, maxConcurrentSlots: 1,
  lifecycle: { mode: "idle", idleMinutes: 15 },
};
export type SlotState = "reserved" | "waiting_for_workspace" | "starting" | "running" | "finalizing" | "persistence_pending";
export type SandboxState = "reserved" | "starting" | "ready" | "draining" | "stopped" | "recovery_required";
export interface SessionSlot {
  reservationId: string;
  session: SessionKey;
  sandbox: SandboxIdentity;
  run: RunIdentity;
  state: SlotState;
  leaseExpiresAt: string;
}
export type AdmissionDecision =
  | { kind: "bound"; slot: SessionSlot } // steer/queue on existing binding; no extra slot
  | { kind: "reserved"; slot: SessionSlot; startSandbox: boolean }
  | { kind: "queued"; reason: "session_capacity" | "provider_capacity" | "recovery_required" | "upgrading" };
export interface SessionAdmissionRequest {
  requestId: string;
  session: SessionKey;
  runId: string;
  compatibility: SandboxCompatibility;
  config: AgentSandboxConfig;
}
interface WorkspaceLeaseBase {
  harnessId: string;
  agentId: string;
  leaseId: string;
  fence: number; // agent-wide writer generation; expiry alone never permits handoff
  expiresAt: string;
}
export interface RunWorkspaceWriteLease extends WorkspaceLeaseBase {
  owner: { kind: "run"; run: RunIdentity };
}
export interface AuxiliaryWorkspaceWriteLease extends WorkspaceLeaseBase {
  owner: { kind: "plugin-publication" | "maintenance"; operationId: string };
}
export type WorkspaceWriteLease = RunWorkspaceWriteLease | AuxiliaryWorkspaceWriteLease;
export interface SessionReleaseReceipt {
  archiveRevision: string | null;
  workspaceRevision: string; // required even if preparation failed before Pi startup
  grantRevoked: true;
  closure: "orderly_session_close" | "provider_stopped" | "not_started";
}
/**
 * Declarative trusted storage contract, not a distributed locking implementation.
 * Reserve atomically under unique(harnessId, agentId), validate limits/deduplicate
 * requests, and reuse the sole compatible sandbox (including provisioning).
 * All SlotStates consume session capacity; archived history does not. Overflow
 * queues: NEVER create a second sandbox. Existing session events steer/queue on
 * their binding. Launch capacity is recorded; reductions drain without eviction.
 * Higher capacity or incompatible profiles require draining/stopping the old
 * supervisor before replacement. Uncertain provisioning reserves the singleton
 * until provider identity/labels prove its outcome, even across upgrades.
 *
 * Admission is not execution authority. Several slots may wait, but exactly one
 * agent-wide WorkspaceWriteLease permits a complete tool-enabled turn. Acquire
 * before shared reads/preparation or arbitrary child/extension startup; waiting
 * slots have no child execution or run grant. Installs, background jobs, memory
 * writes, plugin publication and maintenance use this SAME gate. Descendants
 * cannot outlive the turn's gate. Lease renewal is trusted-controller-only.
 *
 * Keep the gate through child/descendant closure, capture and committed archive
 * plus shared-workspace checkpoint. Revoke grants after bounded close, before
 * slow persistence. Persistence failure retains gate+slot without tool authority.
 * Lease expiry is not a stop: externally fence/stop the old writer and reconcile
 * before handoff. A guest exit claim is not proof hostile descendants are quiet;
 * use provider/storage enforcement when needed. Process profiles cannot claim
 * protections their OS driver lacks. Every mutable actor must be quiescent for
 * consistent capture. A whole-sandbox stop affects all admitted session bindings.
 *
 * finishRun CAS-commits persistence receipts and atomically releases writer gate
 * and session occupancy. cancelWaiting only releases a never-started slot with
 * no held writer lease. Auxiliary writes checkpoint before releasing their gate.
 * Drain is atomic with admission and requires no slots, writer or background work.
 */
export interface AgentSandboxStore {
  reserve(request: SessionAdmissionRequest): Promise<AdmissionDecision>;
  attachRuntime(sandbox: SandboxIdentity, runtime: RuntimeRef): Promise<void>;
  markReady(sandbox: SandboxIdentity): Promise<void>;
  transitionSlot(slot: SessionSlot, next: SlotState): Promise<SessionSlot>; // CAS binding/state
  renewSlot(slot: SessionSlot, expiresAt: string): Promise<SessionSlot>;
  tryAcquireRunWorkspace(slot: SessionSlot): Promise<RunWorkspaceWriteLease | null>;
  tryAcquireAuxiliaryWorkspace(owner: { harnessId: string; agentId: string;
    kind: "plugin-publication" | "maintenance"; operationId: string }): Promise<AuxiliaryWorkspaceWriteLease | null>;
  renewWorkspace(lease: WorkspaceWriteLease, expiresAt: string): Promise<WorkspaceWriteLease>;
  finishRun(slot: SessionSlot, lease: RunWorkspaceWriteLease, receipt: SessionReleaseReceipt): Promise<void>;
  cancelWaiting(slot: SessionSlot): Promise<void>; // no child/grant/held writer lease
  finishAuxiliary(lease: AuxiliaryWorkspaceWriteLease, workspaceRevision: string): Promise<void>;
  beginDrainIfEmpty(sandbox: SandboxIdentity): Promise<boolean>;
  markStopped(sandbox: SandboxIdentity): Promise<void>; // provider-confirmed boundary
  releaseAllocation(sandbox: SandboxIdentity): Promise<void>; // no live/uncertain old compute
  requireRecovery(sandbox: SandboxIdentity, reason: string): Promise<void>;
}

export interface RuntimeRecipe {
  assetRevision: string;
  recipeHash: string;
  piVersion: string;
  platform: string;
  processSetupScript: string; // approved assets path; never a workspace script
  dockerImage: string; // approved immutable digest after provisioning
}
export type RuntimeArtifact =
  | { kind: "process"; installationId: string; nodeExecutable: string; agentHostScript: string; environment: Readonly<Record<string, string>> }
  | { kind: "docker"; imageDigest: string };
export interface AgentPaths {
  assets: string; // resolved immutable revision, not a moving symlink
  workspace: string; // ONE shared durable agent cwd, used by every session
  sessions: string; // this logical session's Pi JSONL files, no queue database
  scratch: string; // this session only; ephemeral
  home: string; // session-specific HOME/config root, no ambient credentials
  browserProfile: string; // session-specific; not a confidentiality boundary
}
export interface SandboxPaths {
  assets: string;
  workspace: string; // shared files, scripts, memory and project dependencies
  sessionRoots: string; // corresponding per-session Pi JSONL roots
  runSpecs: string; // preplanned RO transfer parent; nonsecret files only
  scratch: string;
}
export interface MountSpec { source: string; target: string; mode: "ro" | "rw"; }
export interface PreparedVolume {
  sandbox: SandboxIdentity;
  paths: SandboxPaths;
  mounts: readonly MountSpec[]; // fixed when sandbox starts
  release(): Promise<void>; // after sandbox stops; never deletes durable data
}
export interface RuntimeExit { code: number | null; signal: string | null; }
export interface ByteWriter {
  write(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>; // supervisor channel, not a single session's input
}
export interface RunningRuntime {
  ref: RuntimeRef;
  stdin: ByteWriter;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<RuntimeExit>; // whole supervisor/compute exit
}
export interface RuntimeStartSpec {
  sandbox: SandboxIdentity;
  compatibility: SandboxCompatibility;
  artifact: RuntimeArtifact;
  hostPaths: SandboxPaths;
  runtimePaths: SandboxPaths;
  mounts: readonly MountSpec[];
  maxSessionsPerSandbox: number;
  argv: readonly string[]; // supervisor flags, not a per-session Pi command
  environment: Readonly<Record<string, string>>; // nonsecret allowlist, no run grant
  identity: { uid: number; gid: number };
  requirements: { assetsReadOnly: boolean; workspaceOnlyTools: boolean };
  limits: { cpu?: number; memoryBytes?: number; pids?: number; stopGraceMs: number };
}
export interface RuntimeCapabilities {
  isolation: "none" | "container";
  readOnlyMounts: boolean;
  hostDirectorySources: boolean;
  resourceLimits: boolean;
  workspaceOnlyTools: boolean;
}
export interface SessionOpenSpec {
  paths: AgentPaths;
  sessionFile: string; // SessionManager.open(file, sessions, workspace) with explicit cwd override
  assetRevision: string;
  systemPrompt: string;
  settings: Readonly<Record<string, unknown>>; // nonsecret; validated by trusted host
  runCapability: string; // minted only after writer lease; never an upstream credential
}
export interface HostSessionRef {
  runtime: RuntimeRef;
  session: SessionKey;
  reservationId: string;
  fence: number;
  workspaceFence: number;
}
export interface AgentHostFrame {
  sandboxId: string;
  sandboxGeneration: number;
  session: SessionKey;
  runId: string;
  fence: number;
  workspaceFence: number;
  sequence: number; // monotonic per run, not global across sandbox sessions
  requestId?: string; // present on replies; unsolicited events use run sequence
  type: string;
  payload: unknown;
}
/**
 * One long-lived supervisor tracks multiple admitted session bindings, but only
 * the workspace-lease owner may start a Pi SDK host child or run arbitrary code.
 * The child imports the pinned SDK, configures resources/model auth explicitly,
 * and maps commands to AgentSession APIs; no stock CLI RPC compatibility layer.
 * Waiting sessions are metadata, not tool-enabled idle children. Every child
 * receives the same cwd, with distinct JSONL/HOME/browser/scratch paths. IDs and
 * paths prevent accidental mixing, not same-agent security isolation. Dynamic
 * specs travel over this channel or a preplanned RO transfer area; opening a
 * session never changes Docker mounts. A session close does not close the whole
 * supervisor channel. Validate binding and live workspace fence outside guest.
 * Input acceptance, agent_settled, child exit and durability are separate events.
 * Awaiting session.prompt must not block the control reader; dispose alone is
 * not evidence that every descendant writer has stopped.
 */
export interface AgentHostClient {
  openSession(slot: SessionSlot, runtime: RuntimeRef, lease: RunWorkspaceWriteLease,
    spec: SessionOpenSpec): Promise<HostSessionRef>;
  startRun(session: HostSessionRef, run: RunIdentity, requestId: string, prompt: unknown): Promise<void>;
  steerRun(session: HostSessionRef, run: RunIdentity, requestId: string, message: unknown): Promise<void>;
  abortRun(session: HostSessionRef, run: RunIdentity): Promise<void>;
  getSessionState(session: HostSessionRef): Promise<{ state: string; activeRunId: string | null }>;
  closeSession(session: HostSessionRef): Promise<{ state: "closed"; activeRelativePath: string }>;
  drain(): Promise<void>; // reject new opens; allow already admitted sessions to settle
  shutdown(): Promise<void>; // whole supervisor; singleton controller authorizes after drain
  events(after: Readonly<Record<string, number>>): AsyncIterable<AgentHostFrame>; // runId -> cursor
}

/** Whole-sandbox supervisor lifecycle. Session completion does not call stop(). */
export abstract class RuntimeProvider {
  abstract readonly kind: RuntimeKind;
  abstract readonly capabilities: RuntimeCapabilities;
  abstract ensureRuntime(recipe: RuntimeRecipe, agentId: string): Promise<RuntimeArtifact>;
  abstract start(spec: RuntimeStartSpec): Promise<RunningRuntime>;
  abstract inspect(ref: RuntimeRef): Promise<RuntimeState>;
  abstract stop(ref: RuntimeRef, graceMs: number): Promise<RuntimeExit>;
  abstract dispose(ref: RuntimeRef): Promise<void>; // remove exited compute metadata
  abstract listOwned(): AsyncIterable<RuntimeRef>; // labels include harness/agent/sandbox/generation
}

export interface ProcessDriver {
  ensureInstallation(recipe: RuntimeRecipe, agentId: string): Promise<Extract<RuntimeArtifact, { kind: "process" }>>;
  assertAssetsProtected(spec: RuntimeStartSpec): Promise<void>;
  spawn(spec: {
    sandbox: SandboxIdentity;
    executable: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    uid: number;
    gid: number;
    detached: true;
    stdio: "pipe";
  }): Promise<RunningRuntime>;
  inspect(ref: RuntimeRef): Promise<RuntimeState>;
  stopGroup(ref: RuntimeRef, graceMs: number): Promise<RuntimeExit>;
  listOwned(): AsyncIterable<RuntimeRef>;
}
export class ProcessRuntimeProvider extends RuntimeProvider {
  readonly kind = "process" as const;
  readonly capabilities = {
    isolation: "none", readOnlyMounts: false, hostDirectorySources: true, resourceLimits: false, workspaceOnlyTools: false,
  } as const;
  constructor(private readonly driver: ProcessDriver) { super(); }
  ensureRuntime(recipe: RuntimeRecipe, agentId: string): Promise<RuntimeArtifact> {
    return this.driver.ensureInstallation(recipe, agentId);
  }
  async start(spec: RuntimeStartSpec): Promise<RunningRuntime> {
    if (spec.artifact.kind !== "process") throw new Error("Process runtime needs a native installation");
    if (spec.requirements.workspaceOnlyTools) throw new Error("Plain Process cannot enforce workspace-only tools");
    if (spec.limits.cpu !== undefined || spec.limits.memoryBytes !== undefined || spec.limits.pids !== undefined) {
      throw new Error("Native resource limits require a separately implemented host enforcement profile");
    }
    if (spec.requirements.assetsReadOnly) await this.driver.assertAssetsProtected(spec);
    return this.driver.spawn({
      sandbox: spec.sandbox,
      executable: spec.artifact.nodeExecutable,
      args: [spec.artifact.agentHostScript, ...spec.argv, "--max-sessions", String(spec.maxSessionsPerSandbox)],
      cwd: spec.runtimePaths.scratch,
      env: { ...spec.artifact.environment, ...spec.environment },
      uid: spec.identity.uid, gid: spec.identity.gid,
      detached: true, stdio: "pipe",
    });
  }
  inspect(ref: RuntimeRef): Promise<RuntimeState> { return this.driver.inspect(ref); }
  stop(ref: RuntimeRef, graceMs: number): Promise<RuntimeExit> {
    return this.driver.stopGroup(ref, graceMs);
  }
  async dispose(_ref: RuntimeRef): Promise<void> { /* no container object to remove */ }
  listOwned(): AsyncIterable<RuntimeRef> { return this.driver.listOwned(); }
}

export interface DockerCreateSpec {
  sandbox: SandboxIdentity;
  image: string;
  entrypoint: readonly string[];
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  mounts: readonly MountSpec[];
  user: string;
  readOnlyRoot: true;
  init: true;
  tty: false;
  openStdin: true;
  capDrop: readonly ["ALL"];
  noNewPrivileges: true;
  network: "agent-runtime"; // separately provisioned; bridge != enforced egress policy
  scratchBytes: number;
  limits: RuntimeStartSpec["limits"];
}
export interface DockerDriver {
  ensureImage(recipe: RuntimeRecipe): Promise<Extract<RuntimeArtifact, { kind: "docker" }>>;
  create(spec: DockerCreateSpec): Promise<RuntimeRef>; // label with full SandboxIdentity
  rememberCreated(ref: RuntimeRef): Promise<void>; // persist identity before starting
  attachAndStart(ref: RuntimeRef): Promise<RunningRuntime>;
  inspect(ref: RuntimeRef): Promise<RuntimeState>;
  stopContainer(ref: RuntimeRef, graceMs: number): Promise<RuntimeExit>;
  removeExited(ref: RuntimeRef): Promise<void>;
  listOwned(): AsyncIterable<RuntimeRef>;
}
export class DockerRuntimeProvider extends RuntimeProvider {
  readonly kind = "docker" as const;
  readonly capabilities = {
    isolation: "container", readOnlyMounts: true, hostDirectorySources: true, resourceLimits: true, workspaceOnlyTools: false,
  } as const;
  constructor(private readonly driver: DockerDriver) { super(); }
  ensureRuntime(recipe: RuntimeRecipe, _agentId: string): Promise<RuntimeArtifact> {
    return this.driver.ensureImage(recipe);
  }
  async start(spec: RuntimeStartSpec): Promise<RunningRuntime> {
    if (spec.artifact.kind !== "docker") throw new Error("Docker runtime needs an image digest");
    if (spec.requirements.workspaceOnlyTools) {
      throw new Error("Strict tool boundary must be implemented before this profile can start");
    }
    const ref = await this.driver.create({
      sandbox: spec.sandbox, image: spec.artifact.imageDigest,
      entrypoint: ["node", "/opt/runtime/agent-supervisor.mjs"],
      args: [...spec.argv, "--max-sessions", String(spec.maxSessionsPerSandbox)],
      cwd: spec.runtimePaths.scratch, env: spec.environment, mounts: spec.mounts,
      user: `${spec.identity.uid}:${spec.identity.gid}`,
      readOnlyRoot: true, init: true, tty: false, openStdin: true,
      capDrop: ["ALL"], noNewPrivileges: true, network: "agent-runtime",
      scratchBytes: 256 * 1024 * 1024, limits: spec.limits,
    });
    // Any failure from here leaves a labelled recoverable container to reconcile.
    await this.driver.rememberCreated(ref);
    return this.driver.attachAndStart(ref);
  }
  inspect(ref: RuntimeRef): Promise<RuntimeState> { return this.driver.inspect(ref); }
  stop(ref: RuntimeRef, graceMs: number): Promise<RuntimeExit> {
    return this.driver.stopContainer(ref, graceMs);
  }
  dispose(ref: RuntimeRef): Promise<void> { return this.driver.removeExited(ref); }
  listOwned(): AsyncIterable<RuntimeRef> { return this.driver.listOwned(); }
}

/** Shared workspace checkpoints require the agent-wide gate; JSONL paths are per-session. */
export abstract class AgentVolumeProvider {
  abstract prepare(sandbox: SandboxIdentity, assetRevision: string, lease: WorkspaceWriteLease): Promise<PreparedVolume>;
  abstract sessionPaths(volume: PreparedVolume, key: SessionKey, lease: RunWorkspaceWriteLease): Promise<AgentPaths>;
  abstract checkpoint(lease: WorkspaceWriteLease, workspace: string): Promise<{ revision: string }>;
}
export interface LocalVolumeDriver {
  // Drivers verify trusted current lease ownership/fence, not just this object's shape.
  prepareAgentRoots(sandbox: SandboxIdentity, assetRevision: string, lease: WorkspaceWriteLease): Promise<SandboxPaths>;
  prepareSessionDirectories(roots: SandboxPaths, key: SessionKey, lease: RunWorkspaceWriteLease): Promise<AgentPaths>;
  checkpointWorkspace(lease: WorkspaceWriteLease, workspace: string): Promise<{ revision: string }>;
}
export class LocalDirectoryVolumeProvider extends AgentVolumeProvider {
  constructor(private readonly driver: LocalVolumeDriver) { super(); }
  async prepare(sandbox: SandboxIdentity, assetRevision: string, lease: WorkspaceWriteLease): Promise<PreparedVolume> {
    const paths = await this.driver.prepareAgentRoots(sandbox, assetRevision, lease);
    return {
      sandbox,
      paths,
      mounts: [
        { source: paths.assets, target: "/assets", mode: "ro" },
        { source: paths.workspace, target: "/workspace", mode: "rw" },
        { source: paths.sessionRoots, target: "/sessions", mode: "rw" },
        { source: paths.runSpecs, target: "/runs", mode: "ro" },
      ],
      async release() { /* durable session directories outlive compute */ },
    };
  }
  sessionPaths(volume: PreparedVolume, key: SessionKey, lease: RunWorkspaceWriteLease): Promise<AgentPaths> {
    if (volume.sandbox.agentId !== key.agentId) throw new Error("Session volume agent mismatch");
    // Driver verifies agent ownership, safe IDs and paths under the mounted root.
    return this.driver.prepareSessionDirectories(volume.paths, key, lease);
  }
  checkpoint(lease: WorkspaceWriteLease, workspace: string): Promise<{ revision: string }> {
    return this.driver.checkpointWorkspace(lease, workspace);
  }
}

export interface JsonlFile {
  relativePath: string; // validated under the session root; never an arbitrary host path
  bytes: Uint8Array;
  sha256: string;
  piHeaderSessionId: string | null;
}
export interface SessionArchive {
  revision: string;
  integrity: "valid" | "partial";
  activeRelativePath: string;
  files: readonly JsonlFile[];
  outcome: RunOutcome;
}
export interface ArchiveHead {
  headRevision: string | null; // newest stored revision, including incomplete captures
  restore: SessionArchive | null; // selected validated complete manifest, possibly older
}
export interface ArchiveWrite {
  key: SessionKey;
  run: RunIdentity;
  workspaceFence: number; // verified with the trusted agent-wide gate at commit
  expectedHeadRevision: string | null;
  integrity: "valid" | "partial";
  promoteRestore: boolean;
  idempotencyKey: string;
  activeRelativePath: string;
  files: readonly JsonlFile[];
  outcome: RunOutcome;
}
export abstract class SessionArchiveStore {
  abstract readonly kind: ArchiveKind;
  abstract load(key: SessionKey): Promise<ArchiveHead>;
  abstract save(write: ArchiveWrite): Promise<{ revision: string }>;
}
export interface ArchiveDriver {
  load(key: SessionKey): Promise<ArchiveHead>;
  commit(write: ArchiveWrite): Promise<{ revision: string }>;
}
export class LocalSessionArchiveStore extends SessionArchiveStore {
  readonly kind = "local" as const;
  constructor(private readonly driver: ArchiveDriver) { super(); }
  load(key: SessionKey) { return this.driver.load(key); }
  save(write: ArchiveWrite) { return this.driver.commit(write); }
}
export class CloudSessionArchiveStore extends SessionArchiveStore {
  readonly kind = "cloud" as const;
  constructor(private readonly driver: ArchiveDriver) { super(); }
  load(key: SessionKey) { return this.driver.load(key); }
  save(write: ArchiveWrite) { return this.driver.commit(write); }
}
export class DatabaseSessionArchiveStore extends SessionArchiveStore {
  readonly kind = "database" as const;
  constructor(private readonly driver: ArchiveDriver) { super(); }
  load(key: SessionKey) { return this.driver.load(key); }
  save(write: ArchiveWrite) { return this.driver.commit(write); }
}

export interface SessionFiles {
  // Agent-wide writer lease already held. Reject unresolved prior writes and
  // symlink escapes. Restore this JSONL only, never roll back shared cwd to an
  // older session's view; workspace recovery uses its own latest committed head.
  prepare(paths: AgentPaths, runtimePaths: AgentPaths, archive: ArchiveHead,
    key: SessionKey, lease: RunWorkspaceWriteLease): Promise<{
    hostFile: string; relativeFile: string; expectedHeadRevision: string | null;
  }>;
  // Hold the same gate through closure/capture, blocking queued sessions and
  // plugin publishers. Uncertain or hostile descendants require external fence.
  capture(paths: AgentPaths, activeRelativePath: string, lease: RunWorkspaceWriteLease): Promise<{
    files: readonly JsonlFile[]; integrity: "valid" | "partial";
  }>;
}
export interface PreparedSession {
  key: SessionKey;
  hostFile: string;
  relativeFile: string;
  expectedHeadRevision: string | null;
}
/**
 * Archive one logical session while holding the agent-wide workspace gate.
 * Neither provider serializes/appends Pi JSONL. The runner also commits the
 * shared workspace checkpoint before releasing that gate. Persistence failure
 * retains gate+slot; a successful capture does not stop the shared supervisor.
 */
export class SessionStorageManager {
  constructor(private readonly store: SessionArchiveStore, private readonly files: SessionFiles) {}
  async beforeBatch(key: SessionKey, paths: AgentPaths, runtimePaths: AgentPaths,
    lease: RunWorkspaceWriteLease): Promise<PreparedSession> {
    const archive = await this.store.load(key);
    const prepared = await this.files.prepare(paths, runtimePaths, archive, key, lease);
    return { key, ...prepared };
  }
  async afterBatch(
    run: RunIdentity, paths: AgentPaths, prepared: PreparedSession,
    outcome: RunOutcome, activeRelativePath: string,
    lease: RunWorkspaceWriteLease,
  ): Promise<{ state: "saved"; revision: string; integrity: "valid" | "partial"; restorable: boolean } | { state: "no-transcript" }> {
    if (run.agentId !== prepared.key.agentId || run.threadId !== prepared.key.threadId ||
        run.logicalSessionId !== prepared.key.logicalSessionId) throw new Error("Session archive identity mismatch");
    const { files, integrity } = await this.files.capture(paths, activeRelativePath, lease);
    if (files.length === 0) return { state: "no-transcript" };
    const receipt = await this.store.save({
      key: prepared.key, run, workspaceFence: lease.fence, expectedHeadRevision: prepared.expectedHeadRevision,
      integrity, promoteRestore: integrity === "valid",
      idempotencyKey: `${run.runId}:final`, activeRelativePath, files, outcome,
    });
    return { state: "saved", revision: receipt.revision, integrity, restorable: integrity === "valid" };
  }
}

/**
 * Agent-wide memory is ordinary shared workspace content, protected by the SAME
 * writer gate as files/scripts/dependencies. It remains separate from Pi JSONL.
 */
export abstract class MemoryProvider {
  abstract beforeBatch(workspace: string, lease: WorkspaceWriteLease): Promise<{ directory: string; indexFile: string }>;
  abstract afterBatch(workspaceRevision: string): Promise<void>;
}
export interface WorkspaceMemoryDriver {
  ensureWithoutOverwrite(workspace: string, lease: WorkspaceWriteLease): Promise<{ directory: string; indexFile: string }>;
}
export class WorkspaceFileMemoryProvider extends MemoryProvider {
  constructor(private readonly driver: WorkspaceMemoryDriver) { super(); }
  beforeBatch(workspace: string, lease: WorkspaceWriteLease) { return this.driver.ensureWithoutOverwrite(workspace, lease); }
  async afterBatch(_workspaceRevision: string): Promise<void> {
    // Already included in the workspace checkpoint. Never rewrite Pi's transcript.
  }
}

export interface AgentPrincipal extends RunIdentity {
  sandbox: SandboxIdentity;
  workspaceFence: number; // broker requires live run-owned writer gate
  scopes: readonly string[];
  allowedPlugins: readonly string[];
  policyId: string; // server-resolved account, destination and file constraints
  expiresAt: string;
}
export interface HarnessEvent {
  id: string; // server-issued replay cursor
  agentId: string;
  threadId?: string;
  logicalSessionId?: string;
  runId?: string;
  sandboxId?: string;
  type: string;
  occurredAt: string;
  payload: unknown;
}
/** Trusted internal interface; never accept caller-selected agent identity. */
/** Operator/browser events and deliberate external delivery are separate operations. */
export interface RunEventSink {
  publish(event: Omit<HarnessEvent, "id">): Promise<{ id: string }>;
}
export interface PluginOperation {
  clientOperationId: string;
  pluginId: string;
  operation: string;
  input: unknown;
}
export interface PluginOperationBroker {
  invoke(principal: AgentPrincipal, operation: PluginOperation): Promise<{
    operationId: string;
    state: "accepted" | "succeeded" | "failed" | "uncertain";
    result?: unknown;
  }>;
}

export interface PluginWorkspacePaths {
  root: string;
  attachments: string;
  files: string;
  cache: string;
}
export interface StagedPluginFile {
  fileId: string;
  agentId: string;
  pluginId: string;
  bytes: Uint8Array;
  originalName: string;
  sha256: string;
}
export interface PluginWorkspaceDriver {
  // Shared agent plugin files use the same gate as turns, installs and memory.
  ensureScopedDirectories(workspace: string, pluginId: string, lease: WorkspaceWriteLease): Promise<PluginWorkspacePaths>;
  // Background publication acquires an auxiliary lease; a broker action within
  // a turn uses that live run's lease without recursively acquiring another.
  // Verify current fence, reject symlink escapes and use server-assigned names.
  publishAtomically(lease: WorkspaceWriteLease, staged: StagedPluginFile): Promise<{
    fileId: string;
    relativeWorkspacePath: string;
  }>;
}
/** Durable staging can proceed freely; mutating the shared workspace cannot. */
export class PluginWorkspaceManager {
  constructor(private readonly driver: PluginWorkspaceDriver) {}
  prepare(workspace: string, pluginId: string, lease: WorkspaceWriteLease): Promise<PluginWorkspacePaths> {
    return this.driver.ensureScopedDirectories(workspace, pluginId, lease);
  }
  publish(lease: WorkspaceWriteLease, staged: StagedPluginFile) {
    if (lease.agentId !== staged.agentId) throw new Error("Plugin file agent mismatch");
    return this.driver.publishAtomically(lease, staged);
  }
}
