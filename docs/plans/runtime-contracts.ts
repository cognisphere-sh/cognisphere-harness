/**
 * Migration design reference, not an installed runtime implementation.
 * Type-checkable contracts and provider/shared orchestration bodies.
 * OS, Docker Engine, transactional admission and filesystem drivers
 * remain implementation work. Sessions sharing a sandbox are not OS-isolated.
 * Selected integration: direct Pi SDK in the execution child, never a new
 * pi --mode rpc subprocess path. AgentHostClient is our boundary transport.
 */
export type RuntimeKind = "process" | "docker";
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
  lifecycle: { mode: "idle"; idleMinutes: number } | { mode: "per_turn" | "always_on" };
}
export interface AgentExecutionConfig {
  maxConcurrentSlots: 1; // existing top-level field; validate JSON as 1, reject larger values
  sandbox: AgentSandboxConfig;
}
export const EXAMPLE_EXECUTION_CONFIG: AgentExecutionConfig = {
  maxConcurrentSlots: 1,
  sandbox: { lifecycle: { mode: "idle", idleMinutes: 15 } },
};
export type SlotState = "reserved" | "waiting_for_workspace" | "starting" | "running" | "finalizing" | "recovery_required";
export type SandboxState = "reserved" | "starting" | "ready" | "draining" | "stopped" | "recovery_required";
export interface SessionSlot {
  reservationId: string; // sole execution reservation, not a separate admitted-session pool
  session: SessionKey;
  sandbox: SandboxIdentity;
  run: RunIdentity;
  state: SlotState;
  leaseExpiresAt: string;
}
export type AdmissionDecision =
  | { kind: "bound"; slot: SessionSlot } // steer/queue on existing binding; no extra slot
  | { kind: "reserved"; slot: SessionSlot; startSandbox: boolean }
  | { kind: "queued"; reason: "execution_capacity" | "provider_capacity" | "recovery_required" | "upgrading" };
export interface SessionAdmissionRequest {
  requestId: string;
  session: SessionKey;
  runId: string;
  compatibility: SandboxCompatibility;
  config: AgentExecutionConfig;
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
  outcome: RunOutcome;
  writersStopped: true; // verified by trusted control, not a guest assertion
  grantRevoked: true;
  closure: "orderly_session_close" | "provider_stopped" | "not_started";
}
/**
 * Declarative trusted storage contract, not a distributed locking implementation.
 * Reserve atomically under unique(harnessId, agentId), validate maxConcurrentSlots
 * is exactly 1, deduplicate requests, and reuse the sole compatible sandbox.
 * The sole reservation spans every SlotState, including workspace waiting and
 * recovery_required. Every other session remains in the durable queue; there
 * is no extra admission pool. Historical sessions are unlimited by this setting.
 * Existing session events steer/queue on their binding. Incompatible profiles
 * drain/stop the old supervisor before replacement. Uncertain provisioning keeps
 * the singleton reserved until provider identity proves its outcome; NEVER
 * create a second sandbox, even across upgrades.
 *
 * A reservation is not execution authority: it may wait for plugin publication
 * or maintenance to release the agent-wide WorkspaceWriteLease. Acquire that
 * gate before shared reads/preparation or arbitrary child/extension startup;
 * waiting/queued work has no child execution or run grant. Installs, background
 * jobs, plugin publication and maintenance use this SAME gate. Descendants
 * cannot outlive the turn's gate. Lease renewal is trusted-controller-only.
 *
 * Keep the gate through Pi settlement and verified child/descendant closure.
 * Revoke grants on abort or bounded close. Uncertain cleanup/write failure enters
 * recovery_required, retaining gate+slot without tool authority until reconciled.
 * Pi owns session files directly on the persistent mount; the harness does not
 * capture, rewrite, archive, or checkpoint those files or the workspace per turn.
 * Lease expiry is not a stop: externally fence/stop the old writer and reconcile
 * before handoff. A guest exit claim is not proof hostile descendants are quiet;
 * use provider/storage enforcement when needed. Process profiles cannot claim
 * protections their OS driver lacks. Every prior mutable actor must be stopped
 * before writer handoff. A whole-sandbox stop invalidates the active binding; other
 * sessions remain durably queued and their existing histories are preserved.
 *
 * finishRun CAS-records the trusted outcome/cleanup receipt and releases writer gate
 * and execution reservation. cancelWaiting only releases a never-started slot with
 * no held writer lease. Auxiliary operations record their own durable receipts
 * and stop their writers before releasing the same gate; no filesystem snapshots.
 * Drain is atomic with reservation and requires no reserved run, writer or background work.
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
  finishAuxiliary(lease: AuxiliaryWorkspaceWriteLease, receipt: {
    operationReceiptId: string; writersStopped: true;
  }): Promise<void>;
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
  assets: string; // read-only base release, resolved revision rather than moving symlink
  workspace: string; // persistent agent-managed cwd shared by every session
  sessions: string; // persistent session directory owned by Pi, no queue database
  scratch: string; // this session only; ephemeral
  home: string; // session-specific HOME/config root, no ambient credentials
  browserProfile: string; // session-specific; not a confidentiality boundary
}
export interface SandboxPaths {
  assets: string;
  workspace: string; // agent-managed files, prompt/skill overrides, scripts and dependencies
  sessionRoots: string; // persistent Pi-owned session roots; mounted without copying files
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
  sessionFile?: string; // existing Pi file to open with cwd override; otherwise SDK creates it
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
 * One long-lived supervisor accepts at most one host-authorized session binding.
 * Trusted control enforces maxConcurrentSlots=1 and the workspace gate; only its
 * lease owner may start a Pi SDK host child or run arbitrary code. No launch
 * capacity parameter or supervisor-side admission pool is needed.
 * The child imports the pinned SDK, configures resources/model auth explicitly,
 * and maps commands to AgentSession APIs; no stock CLI RPC compatibility layer.
 * Other sessions stay in the durable queue, not idle SDK children. Every child
 * receives the same cwd, with distinct JSONL/HOME/browser/scratch paths. IDs and
 * paths prevent accidental mixing, not same-agent security isolation. Dynamic
 * specs travel over this channel or a preplanned RO transfer area; opening a
 * session never changes Docker mounts. A session close does not close the whole
 * supervisor channel. Validate binding and live workspace fence outside guest.
 * Input acceptance, agent_settled and verified child exit are separate events.
 * Pi owns session creation/writes/compaction; persistent mounts outlive compute.
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
  closeSession(session: HostSessionRef): Promise<{ state: "closed"; sessionFile?: string }>;
  drain(): Promise<void>; // reject new opens; allow the active session to settle
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
      args: [spec.artifact.agentHostScript, ...spec.argv],
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
      args: spec.argv,
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

/** Prepare persistent mounts and safe SDK paths; Pi alone manages session file contents. */
export abstract class AgentVolumeProvider {
  abstract prepare(sandbox: SandboxIdentity, assetRevision: string, lease: WorkspaceWriteLease): Promise<PreparedVolume>;
  abstract sessionPaths(volume: PreparedVolume, key: SessionKey, lease: RunWorkspaceWriteLease): Promise<AgentPaths>;
}
export interface LocalVolumeDriver {
  // Drivers verify trusted current lease ownership/fence, not just this object's shape.
  prepareAgentRoots(sandbox: SandboxIdentity, assetRevision: string, lease: WorkspaceWriteLease): Promise<SandboxPaths>;
  prepareSessionDirectories(roots: SandboxPaths, key: SessionKey, lease: RunWorkspaceWriteLease): Promise<AgentPaths>;
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
export interface PluginFilePublicationReceipt {
  operationReceiptId: string; // durable idempotent publication result, not a snapshot
  fileId: string;
  relativeWorkspacePath: string;
  sha256: string;
}
export interface PluginWorkspaceDriver {
  // Shared agent plugin files use the same gate as turns and installs.
  ensureScopedDirectories(workspace: string, pluginId: string, lease: WorkspaceWriteLease): Promise<PluginWorkspacePaths>;
  // Background publication acquires an auxiliary lease; a broker action within
  // a turn uses that live run's lease without recursively acquiring another.
  // Verify fence, reject symlink escapes and use server-assigned names. Commit
  // a durable receipt; retry by file ID/hash, rejecting a changed payload.
  publishAtomically(lease: WorkspaceWriteLease, staged: StagedPluginFile): Promise<PluginFilePublicationReceipt>;
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
