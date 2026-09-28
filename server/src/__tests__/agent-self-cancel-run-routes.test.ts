import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));

const mockHeartbeatService = vi.hoisted(() => ({
  buildRunOutputSilence: vi.fn(async () => null),
  cancelRun: vi.fn(),
  decorateActiveRunStatus: vi.fn((run: unknown) => run),
  getRun: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getRunLogAccess: vi.fn(),
  readLog: vi.fn(),
  wakeup: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  getByIdentifier: vi.fn(async () => null),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(async () => ({})),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(async () => []),
}));

const mockRunSecretRedactionRegistry = vi.hoisted(() => ({
  redactForRuns: vi.fn(async (_companyId: string, values: unknown[]) => values),
  redactForRun: vi.fn(
    async (_companyId: string, _runId: string, value: unknown) => value,
  ),
}));

const mockProviderTraceStore = vi.hoisted(() => ({
  inspect: vi.fn(),
  getByRun: vi.fn(),
  readExactEntries: vi.fn(),
  revealFrame: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  listMetadataForRuns: vi.fn(async () => new Map()),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => ({}) as any));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  decide: vi.fn(async () => ({
    allowed: true,
    action: "runs.cancel",
    reason: "allow_explicit_grant",
    explanation: "Allowed by test grant.",
  })),
  hasPermission: vi.fn(async () => true),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  getById: vi.fn(),
  listForRun: vi.fn(),
  readLog: vi.fn(),
}));

const mockExecutionProjection = vi.hoisted(() => ({
  executionProjectionForRun: vi.fn(async () => null),
  executionProjectionsForRuns: vi.fn(async () => new Map()),
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OWN_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COLLEAGUE_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const CLOSED_ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const OPEN_ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const STUCK_RUN_ID = "66666666-6666-4666-8666-666666666666";
const OBSERVER_RUN_ID = "77777777-7777-4777-8777-777777777777";

function agentActor(agentId: string) {
  return {
    type: "agent",
    agentId,
    companyId: COMPANY_ID,
    // A waking agent always carries the id of its *own* run, never the stranded
    // predecessor's. The tests below rely on that being different.
    runId: OBSERVER_RUN_ID,
    source: "agent_jwt",
    onBehalfOfUserId: null,
    onBehalfOfMemberships: [],
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [COMPANY_ID],
    source: "session" as const,
  };
}

function registerModuleMocks() {
  vi.doMock("../services/execution-projection.js", () => mockExecutionProjection);
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual("../routes/authz.js"),
  );
  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));
  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
  vi.doMock("../services/run-secret-redaction.js", () => ({
    createRunSecretRedactionRegistry: () => mockRunSecretRedactionRegistry,
  }));
  vi.doMock("../services/provider-trace-store.js", () => ({
    providerTraceStore: () => mockProviderTraceStore,
  }));
  vi.doMock("../services/provider-trace-workspace-diff-reprojection.js", () => ({
    projectCodexWorkspaceDiffsFromTrace: vi.fn(),
    persistReprojectedWorkspaceDiffs: vi.fn(),
  }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

/** Chainable db stub that answers the route's single issue-status lookup. */
function createIssueStatusDbStub(status: string | null) {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: (resolve: (value: Array<{ status: string }>) => unknown) =>
      Promise.resolve(status ? [{ status }] : []).then(resolve),
  };
  return { db: { select: vi.fn(() => query) } };
}

let cachedAgentRoutes: typeof import("../routes/agents.js").agentRoutes;
let cachedErrorHandler: typeof import("../middleware/index.js").errorHandler;

/**
 * routes/agents.js pulls in a very large module graph whose one-time transform
 * cost is charged to whichever test imports it first. Load it once here so the
 * first *assertion* does not pay that bill and time out — the same reason
 * server/vitest.config.ts widens testTimeout.
 */
async function warmRouteGraph() {
  vi.resetModules();
  registerModuleMocks();
  cachedAgentRoutes = (await vi.importActual<typeof import("../routes/agents.js")>(
    "../routes/agents.js",
  )).agentRoutes;
  cachedErrorHandler = (await vi.importActual<typeof import("../middleware/index.js")>(
    "../middleware/index.js",
  )).errorHandler;
}

function createApp(
  actor: Express.Request["actor"],
  issueStatus: string | null,
) {
  const { db } = createIssueStatusDbStub(issueStatus);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", cachedAgentRoutes(db as any, {}));
  app.use(cachedErrorHandler);
  return app;
}

describe("agent self-cancel of a run on a closed issue", () => {
  beforeAll(async () => {
    await warmRouteGraph();
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
    });
    mockAgentService.getById.mockResolvedValue({
      id: OWN_AGENT_ID,
      companyId: COMPANY_ID,
      name: "Owner",
      adapterType: "codex_local",
    });
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockLogActivity.mockClear();
    mockHeartbeatService.cancelRun.mockImplementation(async (runId: string) => ({
      id: runId,
      companyId: COMPANY_ID,
      agentId: OWN_AGENT_ID,
      status: "cancelled",
    }));
  });

  it("cancels the agent's own run on a done issue and stamps the agent attribution", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: STUCK_RUN_ID,
      companyId: COMPANY_ID,
      agentId: OWN_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: CLOSED_ISSUE_ID },
    });
    const app = await createApp(agentActor(OWN_AGENT_ID), "done");

    const response = await request(app)
      .post(`/api/heartbeat-runs/${STUCK_RUN_ID}/cancel`)
      .send();

    expect(response.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledTimes(1);
    const [runId, reason, options] = mockHeartbeatService.cancelRun.mock.calls[0]!;
    expect(runId).toBe(STUCK_RUN_ID);
    expect(String(reason)).toContain("owning agent");
    // "agent" — not "user". Recovery only stands down for a deliberate
    // attribution, and a false "user" stamp would be a lie about who acted.
    expect((options as any).resultJson).toEqual({
      cancelledByActorType: "agent",
      cancelledByAgentId: OWN_AGENT_ID,
    });
  });

  it("cancels the agent's own run on a cancelled issue", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: STUCK_RUN_ID,
      companyId: COMPANY_ID,
      agentId: OWN_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: CLOSED_ISSUE_ID },
    });
    const app = await createApp(agentActor(OWN_AGENT_ID), "cancelled");

    const response = await request(app)
      .post(`/api/heartbeat-runs/${STUCK_RUN_ID}/cancel`)
      .send();

    expect(response.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledTimes(1);
  });

  it("refuses a colleague's run, even on a closed issue", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: STUCK_RUN_ID,
      companyId: COMPANY_ID,
      agentId: COLLEAGUE_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: CLOSED_ISSUE_ID },
    });
    const app = await createApp(agentActor(OWN_AGENT_ID), "done");

    const response = await request(app)
      .post(`/api/heartbeat-runs/${STUCK_RUN_ID}/cancel`)
      .send();

    expect(response.status).toBe(403);
    // Assert the reason too. A board-only route also answers 403 here, so the
    // status alone cannot tell "ownership refused this" apart from "agents may
    // not use this route at all". The message is what makes this test bite.
    expect(String(response.body?.error ?? "")).toContain("its own heartbeat runs");
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("refuses a run on a non-terminal issue, so an agent cannot walk away from live work", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: STUCK_RUN_ID,
      companyId: COMPANY_ID,
      agentId: OWN_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: OPEN_ISSUE_ID },
    });
    const app = await createApp(agentActor(OWN_AGENT_ID), "in_progress");

    const response = await request(app)
      .post(`/api/heartbeat-runs/${STUCK_RUN_ID}/cancel`)
      .send();

    expect(response.status).toBe(403);
    expect(String(response.body?.error ?? "")).toContain("done or cancelled");
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("refuses a run on a blocked issue: being blocked is not permission to give up", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: STUCK_RUN_ID,
      companyId: COMPANY_ID,
      agentId: OWN_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: OPEN_ISSUE_ID },
    });
    const app = await createApp(agentActor(OWN_AGENT_ID), "blocked");

    const response = await request(app)
      .post(`/api/heartbeat-runs/${STUCK_RUN_ID}/cancel`)
      .send();

    expect(response.status).toBe(403);
    expect(String(response.body?.error ?? "")).toContain("done or cancelled");
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("refuses a run whose issue cannot be resolved, rather than assuming it is closed", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: STUCK_RUN_ID,
      companyId: COMPANY_ID,
      agentId: OWN_AGENT_ID,
      status: "running",
      contextSnapshot: {},
    });
    const app = await createApp(agentActor(OWN_AGENT_ID), "done");

    const response = await request(app)
      .post(`/api/heartbeat-runs/${STUCK_RUN_ID}/cancel`)
      .send();

    expect(response.status).toBe(403);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("keeps the board path unchanged: same guard, same user attribution", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: STUCK_RUN_ID,
      companyId: COMPANY_ID,
      agentId: COLLEAGUE_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: OPEN_ISSUE_ID },
    });
    const app = await createApp(boardActor(), "in_progress");

    const response = await request(app)
      .post(`/api/heartbeat-runs/${STUCK_RUN_ID}/cancel`)
      .send();

    expect(response.status).toBe(200);
    const [, reason, options] = mockHeartbeatService.cancelRun.mock.calls[0]!;
    expect(reason).toBe("Cancelled by a board operator");
    expect((options as any).resultJson).toEqual({
      cancelledByActorType: "user",
      cancelledByUserId: "board-user",
    });
  });
});
