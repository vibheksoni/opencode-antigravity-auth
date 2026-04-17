import { describe, expect, it } from "vitest";

import { extractPlannerUpdate, parseConnectFrames } from "./connect";

function frameJson(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const framed = Buffer.alloc(5 + payload.length);
  framed[0] = 0;
  framed.writeUInt32BE(payload.length, 1);
  payload.copy(framed, 5);
  return framed;
}

describe("bridge connect helpers", () => {
  it("parses multiple connect frames and preserves trailing data", () => {
    const first = frameJson({ hello: "world" });
    const second = frameJson({ ok: true });
    const trailing = Buffer.from([1, 2, 3]);
    const input = Buffer.concat([first, second, trailing]);

    const parsed = parseConnectFrames(input);

    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[0]?.payload).toBe("{\"hello\":\"world\"}");
    expect(parsed.frames[1]?.payload).toBe("{\"ok\":true}");
    expect(Array.from(parsed.remaining)).toEqual([1, 2, 3]);
  });

  it("extracts planner response fields from agent state updates", () => {
    const planner = extractPlannerUpdate({
      update: {
        status: "CASCADE_RUN_STATUS_RUNNING",
        mainTrajectoryUpdate: {
          stepsUpdate: {
            steps: [
              {
                type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
                plannerResponse: {
                  messageId: "m1",
                  modifiedResponse: "hello",
                  thinking: "plan",
                },
              },
            ],
          },
          lastStepError: {},
        },
      },
    });

    expect(planner.messageId).toBe("m1");
    expect(planner.response).toBe("hello");
    expect(planner.thinking).toBe("plan");
    expect(planner.status).toBe("CASCADE_RUN_STATUS_RUNNING");
  });
});

