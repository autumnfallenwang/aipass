import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openPage, sealPage } from "../src/paging.ts";

const secret = randomBytes(32);
const who = { agentId: "diabetes-coach", patientRef: "Patient/maria", group: "labs" as const };
const links = ["http://fhir.internal/fhir?_getpages=abc&_getpagesoffset=20"];

describe("paging tokens", () => {
  it("round-trips for the same agent, patient and group", () => {
    const t = sealPage(secret, { ...who, links });
    expect(openPage(secret, t, who)?.links).toEqual(links);
  });

  it("hides the FHIR server's address from the agent", () => {
    const t = sealPage(secret, { ...who, links });
    expect(Buffer.from(t, "base64url").toString("latin1")).not.toContain("fhir.internal");
  });

  it("rejects an edited token", () => {
    const t = sealPage(secret, { ...who, links });
    const flipped = Buffer.from(t, "base64url");
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(openPage(secret, flipped.toString("base64url"), who)).toBeNull();
  });

  it("rejects a token moved to another patient, agent or group", () => {
    const t = sealPage(secret, { ...who, links });
    expect(openPage(secret, t, { ...who, patientRef: "Patient/john" })).toBeNull();
    expect(openPage(secret, t, { ...who, agentId: "scheduling-assistant" })).toBeNull();
    expect(openPage(secret, t, { ...who, group: "vitals" })).toBeNull();
  });

  it("rejects a token from another gateway secret, an expired token and junk", () => {
    expect(openPage(randomBytes(32), sealPage(secret, { ...who, links }), who)).toBeNull();
    expect(openPage(secret, sealPage(secret, { ...who, links }, -1), who)).toBeNull();
    expect(openPage(secret, "not-a-token", who)).toBeNull();
    expect(openPage(secret, "", who)).toBeNull();
  });
});
