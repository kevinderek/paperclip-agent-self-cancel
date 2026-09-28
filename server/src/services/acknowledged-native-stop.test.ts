import { expect, it } from "vitest";
import { isAcknowledgedNativeReassignmentStop, isAcknowledgedNativeStop } from "./acknowledged-native-stop.js";
const run = { id: "run", companyId: "company", nativeIssueId: "issue", status: "cancelled", resultJson: {
  cancelledByActorType: "user", cancelledByUserId: "board", nativeCancellation: {
    schema: "paperclip.native-cancellation.v1", runId: "run", companyId: "company", issueId: "issue",
    scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
    intentAuditId: "intent", acknowledgementAuditId: "ack",
  },
} };
it("recognizes the native receipt used by the Stop button", () => {
  expect(isAcknowledgedNativeStop(run)).toBe(true);
});
it.each([{ runId: "other" }, { companyId: "other" }, { issueId: "other" }, { dispatchState: "pending" },
  { scope: "subtree" }, { acknowledgementAuditId: undefined }])("refuses unrelated or incomplete receipts %j", change => {
  expect(isAcknowledgedNativeStop({ ...run, resultJson: { ...run.resultJson,
    nativeCancellation: { ...run.resultJson.nativeCancellation, ...change } } })).toBe(false);
});

it("does not read an agent cancellation as an acknowledged native stop", () => {
  // Measured, not assumed: the agent branch of the heartbeat-runs cancel route
  // stamps cancelledByActorType "agent" and sets no nativeCancellation receipt,
  // so this reader returns false for such a run. Nothing in the agent-cancel
  // path may depend on it — the deliberate-stop exemption lives in
  // recovery/service.ts instead. This test exists so a later change cannot
  // quietly start leaning on a receipt that is never written.
  const agentCancel = {
    id: "run",
    companyId: "company",
    nativeIssueId: "issue",
    status: "cancelled",
    resultJson: { cancelledByActorType: "agent", cancelledByAgentId: "agent" },
  };
  expect(isAcknowledgedNativeStop(agentCancel)).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop(agentCancel)).toBe(false);
});
it("recognizes an audited handoff without granting operator Stop semantics", () => {
  const handoff = { ...run, resultJson: { reassignmentStopRequested: true, nativeCancellation: run.resultJson.nativeCancellation } };
  expect(isAcknowledgedNativeReassignmentStop(handoff)).toBe(true);
  expect(isAcknowledgedNativeStop(handoff)).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop({ ...handoff, status: "running" })).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop(run)).toBe(false);
});
it.each([{ runId: "other" }, { companyId: "other" }, { issueId: "other" }, { dispatchState: "pending" },
  { scope: "subtree" }, { acknowledgementAuditId: undefined }])("requires an audited handoff receipt %j", change => {
  expect(isAcknowledgedNativeReassignmentStop({ ...run, resultJson: { reassignmentStopRequested: true,
    nativeCancellation: { ...run.resultJson.nativeCancellation, ...change } } })).toBe(false);
});
