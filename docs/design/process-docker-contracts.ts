/**
 * Migration design reference, not an installed runtime implementation.
 * Type-checkable contracts and provider/shared orchestration bodies.
 * OS, Docker Engine, archive and filesystem drivers are implementation work.
 */
export type RuntimeKind = "process" | "docker";
export type ArchiveKind = "local" | "cloud" | "database";
export type RunOutcome = "completed" | "failed" | "cancelled";
export type RuntimeState = "created" | "running" | "exited" | "missing" | "unknown";

export interface RunIdentity {
  agentId: string;
  threadId: string;
  runId: string;
  fence: number;
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
  workspace: string;
  sessions: string; // only this session/thread's files, no queue database
  runSpec: string; // assembled prompt and nonsecret settings
  scratch: string;
}
export interface MountSpec {
  source: string;
  target: string;
  mode: "ro" | "rw";
}
export interface PreparedVolume {
  paths: AgentPaths;
  mounts: readonly MountSpec[];
  release(): Promise<void>; // releases preparation, never deletes durable data
}
export interface RuntimeRef extends RunIdentity {
  kind: RuntimeKind;
  id: string; // container ID or native process identity, not PID alone
}
export interface RuntimeExit {
  code: number | null;
  signal: string | null;
}
export interface ByteWriter {
  write(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
}
export interface RunningRuntime {
  ref: RuntimeRef;
  stdin: ByteWriter;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<RuntimeExit>;
}
export interface RuntimeStartSpec {
  run: RunIdentity;
  artifact: RuntimeArtifact;
  hostPaths: AgentPaths;
  runtimePaths: AgentPaths;
  mounts: readonly MountSpec[];
  argv: readonly string[]; // common SDK-host flags, constructed using runtime paths
  environment: Readonly<Record<string, string>>; // allowlist; never process.env spread
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

/** Compute lifecycle only. Queue/retry/session/plugin behavior lives elsewhere. */
export abstract class RuntimeProvider {
  abstract readonly kind: RuntimeKind;
  abstract readonly capabilities: RuntimeCapabilities;
  abstract ensureRuntime(recipe: RuntimeRecipe, agentId: string): Promise<RuntimeArtifact>;
  abstract start(spec: RuntimeStartSpec): Promise<RunningRuntime>;
  abstract inspect(ref: RuntimeRef): Promise<RuntimeState>;
  abstract stop(ref: RuntimeRef, graceMs: number): Promise<RuntimeExit>;
  abstract dispose(ref: RuntimeRef): Promise<void>; // remove exited compute metadata
  abstract listOwned(): AsyncIterable<RuntimeRef>;
}

export interface ProcessDriver {
  ensureInstallation(recipe: RuntimeRecipe, agentId: string): Promise<Extract<RuntimeArtifact, { kind: "process" }>>;
  assertAssetsProtected(spec: RuntimeStartSpec): Promise<void>;
  spawn(spec: {
    run: RunIdentity;
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
      run: spec.run,
      executable: spec.artifact.nodeExecutable,
      args: [spec.artifact.agentHostScript, ...spec.argv],
      cwd: spec.runtimePaths.workspace,
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
  run: RunIdentity;
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
  create(spec: DockerCreateSpec): Promise<RuntimeRef>;
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
      run: spec.run, image: spec.artifact.imageDigest,
      entrypoint: ["node", "/opt/runtime/agent-host.mjs"], args: spec.argv,
      cwd: spec.runtimePaths.workspace, env: spec.environment, mounts: spec.mounts,
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

/** Host-local paths serve both initial runtimes; actual mounting belongs to Docker. */
export abstract class AgentVolumeProvider {
  abstract prepare(run: RunIdentity, assetRevision: string): Promise<PreparedVolume>;
  abstract checkpoint(run: RunIdentity, prepared: PreparedVolume): Promise<{ revision: string }>;
}
export interface LocalVolumeDriver {
  prepareSafeDirectories(run: RunIdentity, assetRevision: string): Promise<AgentPaths>;
  checkpointWorkspace(run: RunIdentity, paths: AgentPaths): Promise<{ revision: string }>;
}
export class LocalDirectoryVolumeProvider extends AgentVolumeProvider {
  constructor(private readonly driver: LocalVolumeDriver) { super(); }
  async prepare(run: RunIdentity, assetRevision: string): Promise<PreparedVolume> {
    const paths = await this.driver.prepareSafeDirectories(run, assetRevision);
    return {
      paths,
      mounts: [
        { source: paths.assets, target: "/assets", mode: "ro" },
        { source: paths.runSpec, target: "/run-spec", mode: "ro" },
        { source: paths.sessions, target: "/sessions", mode: "rw" },
        { source: paths.workspace, target: "/workspace", mode: "rw" },
      ],
      async release() { /* durable directories outlive compute */ },
    };
  }
  checkpoint(run: RunIdentity, prepared: PreparedVolume): Promise<{ revision: string }> {
    return this.driver.checkpointWorkspace(run, prepared.paths);
  }
}

export interface SessionKey { agentId: string; threadId: string; logicalSessionId: string; }
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
  // Must reject unresolved prior writes, symlink escapes and unsafe restoration.
  prepare(paths: AgentPaths, runtimePaths: AgentPaths, archive: ArchiveHead, key: SessionKey): Promise<{
    hostFile: string; relativeFile: string; expectedHeadRevision: string | null;
  }>;
  // Called only after Pi and all other session writers have exited.
  capture(paths: AgentPaths, activeRelativePath: string): Promise<{ files: readonly JsonlFile[]; integrity: "valid" | "partial" }>;
}
export interface PreparedSession {
  key: SessionKey;
  hostFile: string;
  relativeFile: string;
  expectedHeadRevision: string | null;
}
/** Shared named hooks; neither provider serializes or appends Pi JSONL. */
export class SessionStorageManager {
  constructor(private readonly store: SessionArchiveStore, private readonly files: SessionFiles) {}
  async beforeBatch(key: SessionKey, paths: AgentPaths, runtimePaths: AgentPaths): Promise<PreparedSession> {
    const archive = await this.store.load(key);
    const prepared = await this.files.prepare(paths, runtimePaths, archive, key);
    return { key, ...prepared };
  }
  async afterBatch(
    run: RunIdentity, paths: AgentPaths, prepared: PreparedSession,
    outcome: RunOutcome, activeRelativePath: string,
  ): Promise<{ state: "saved"; revision: string; integrity: "valid" | "partial"; restorable: boolean } | { state: "no-transcript" }> {
    const { files, integrity } = await this.files.capture(paths, activeRelativePath);
    if (files.length === 0) return { state: "no-transcript" };
    const receipt = await this.store.save({
      key: prepared.key, run, expectedHeadRevision: prepared.expectedHeadRevision,
      integrity, promoteRestore: integrity === "valid",
      idempotencyKey: `${run.runId}:final`, activeRelativePath, files, outcome,
    });
    return { state: "saved", revision: receipt.revision, integrity, restorable: integrity === "valid" };
  }
}

/** Durable agent-authored memory is ordinary workspace content, not session storage. */
export abstract class MemoryProvider {
  abstract beforeBatch(workspace: string): Promise<{ directory: string; indexFile: string }>;
  abstract afterBatch(workspaceRevision: string): Promise<void>;
}
export interface WorkspaceMemoryDriver {
  ensureWithoutOverwrite(workspace: string): Promise<{ directory: string; indexFile: string }>;
}
export class WorkspaceFileMemoryProvider extends MemoryProvider {
  constructor(private readonly driver: WorkspaceMemoryDriver) { super(); }
  beforeBatch(workspace: string) { return this.driver.ensureWithoutOverwrite(workspace); }
  async afterBatch(_workspaceRevision: string): Promise<void> {
    // Already included in the workspace checkpoint. Never rewrite Pi's transcript.
  }
}

export interface AgentPrincipal extends RunIdentity {
  scopes: readonly string[];
  allowedPlugins: readonly string[];
  policyId: string; // server-resolved account, destination and file constraints
  expiresAt: string;
}
export interface HarnessEvent {
  id: string; // server-issued replay cursor
  agentId: string;
  threadId?: string;
  runId?: string;
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
export interface WorkspacePublicationLease {
  agentId: string;
  workspaceId: string;
  generation: number;
  sourceRunId?: string; // audit only; publication also works while compute is idle
}
export interface PluginWorkspaceDriver {
  ensureScopedDirectories(workspace: string, pluginId: string): Promise<PluginWorkspacePaths>;
  // Must serialize against checkpoint freeze, reject symlink escapes, publish
  // under a unique server-assigned name and return only a logical workspace path.
  publishAtomically(lease: WorkspacePublicationLease, staged: StagedPluginFile): Promise<{
    fileId: string;
    relativeWorkspacePath: string;
  }>;
}
/** Plugin files share the workspace volume and its checkpoint lifecycle. */
export class PluginWorkspaceManager {
  constructor(private readonly driver: PluginWorkspaceDriver) {}
  prepare(workspace: string, pluginId: string): Promise<PluginWorkspacePaths> {
    return this.driver.ensureScopedDirectories(workspace, pluginId);
  }
  publish(lease: WorkspacePublicationLease, staged: StagedPluginFile) {
    if (lease.agentId !== staged.agentId) throw new Error("Plugin file agent mismatch");
    return this.driver.publishAtomically(lease, staged);
  }
}
