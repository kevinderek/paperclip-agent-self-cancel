import { describe, expect, it } from "vitest";
import {
  CHAT_CONTROL_RECOVERY_STOP_CODE,
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
} from "../chat-control-recovery-stop.js";
import { isOperatorCancelledRun } from "./service.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COLLEAGUE_ID = "22222222-2222-4222-8222-222222222222";

type LatestRun = Parameters<typeof isOperatorCancelledRun>[0];

function cancelledRun(overrides: {
  cancelledByActorType?: unknown;
  agentId?: string;
  status?: LatestRun extends null ? never : "cancelled" | "succeeded" | "failed";
  errorCode?: string | null;
  resultJson?: unknown;
}): LatestRun {
  const {
    cancelledByActorType,
    agentId = AGENT_ID,
    status = "cancelled",
    errorCode = "cancelled",
    resultJson = cancelledByActorType === undefined ? {} : { cancelledByActorType },
  } = overrides;
  return {
    id: "33333333-3333-4333-8333-333333333333",
    agentId,
    status,
    error: "Cancelled",
    errorCode,
    contextSnapshot: {},
    livenessState: null,
    startedAt: new Date("2026-07-15T20:00:00.000Z"),
    createdAt: new Date("2026-07-15T20:00:00.000Z"),
    resultJson,
  } as LatestRun;
}

describe("isOperatorCancelledRun", () => {
  it("exempts an agent-cancelled run so recovery does not re-wake that agent", () => {
    // The loop this guards: agent cancels its own run on a closed issue ->
    // recovery reads an unknown attribution -> classifies stranding -> wakes
    // the same agent -> cancels again, forever.
    expect(
      isOperatorCancelledRun(
        cancelledRun({ cancelledByActorType: "agent" }),
        AGENT_ID,
      ),
    ).toBe(true);
  });

  it("keeps exempting the attributions the board route already stamped", () => {
    expect(
      isOperatorCancelledRun(
        cancelledRun({ cancelledByActorType: "user" }),
        AGENT_ID,
      ),
    ).toBe(true);
    expect(
      isOperatorCancelledRun(
        cancelledRun({ cancelledByActorType: "board" }),
        AGENT_ID,
      ),
    ).toBe(true);
  });

  it("does not exempt an unknown attribution", () => {
    // Deliberately narrow: only "agent" was added. An unrecognised stamp is not
    // proof that a human meant to stop the agent, so it stays on the recovery
    // path. Widening this set is how the exemption turns into a back door.
    for (const stamp of [
      "system",
      "recovery",
      "supervisor",
      "Agent",
      "agent ",
      "",
      null,
      1,
      undefined,
    ]) {
      expect(
        isOperatorCancelledRun(cancelledRun({ cancelledByActorType: stamp }), AGENT_ID),
      ).toBe(false);
    }
  });

  it("ignores the stamp unless the run actually reached cancelled", () => {
    expect(
      isOperatorCancelledRun(
        cancelledRun({ cancelledByActorType: "agent", status: "succeeded" }),
        AGENT_ID,
      ),
    ).toBe(false);
    expect(
      isOperatorCancelledRun(
        cancelledRun({ cancelledByActorType: "agent", status: "failed" }),
        AGENT_ID,
      ),
    ).toBe(false);
  });

  it("keeps the operator_interrupted exemption that needs no stamp", () => {
    expect(
      isOperatorCancelledRun(
        cancelledRun({ errorCode: "operator_interrupted" }),
        AGENT_ID,
      ),
    ).toBe(true);
  });

  it("keeps the chat-control stop codes scoped to the current agent", () => {
    for (const errorCode of [
      CHAT_CONTROL_RECOVERY_STOP_CODE,
      CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
    ]) {
      expect(
        isOperatorCancelledRun(cancelledRun({ errorCode }), AGENT_ID),
      ).toBe(true);
      // Same code, a colleague's run: not this agent's deliberate stop.
      expect(
        isOperatorCancelledRun(
          cancelledRun({ errorCode, agentId: COLLEAGUE_ID }),
          AGENT_ID,
        ),
      ).toBe(false);
    }
  });

  it("handles a missing run", () => {
    expect(isOperatorCancelledRun(null, AGENT_ID)).toBe(false);
  });
});
