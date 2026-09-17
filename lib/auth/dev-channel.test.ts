import { afterEach, describe, expect, it } from "vitest";
import { DEV_CHANNEL_PROFILE, isDevChannelAuthBypassEnabled } from "./dev-channel";

const originalBypass = process.env.DEV_CHANNEL_BYPASS_AUTH;
const originalMock = process.env.AGENT_MOCK_MODE;

afterEach(() => {
  process.env.DEV_CHANNEL_BYPASS_AUTH = originalBypass;
  process.env.AGENT_MOCK_MODE = originalMock;
});

describe("devchannel auth bypass", () => {
  it("is disabled by default", () => {
    delete process.env.DEV_CHANNEL_BYPASS_AUTH;
    delete process.env.AGENT_MOCK_MODE;
    expect(isDevChannelAuthBypassEnabled()).toBe(false);
  });

  it("is enabled by explicit bypass or mock mode", () => {
    process.env.DEV_CHANNEL_BYPASS_AUTH = "true";
    expect(isDevChannelAuthBypassEnabled()).toBe(true);
    delete process.env.DEV_CHANNEL_BYPASS_AUTH;
    process.env.AGENT_MOCK_MODE = "true";
    expect(isDevChannelAuthBypassEnabled()).toBe(true);
  });

  it("uses a fixed leadership profile without database state", () => {
    expect(DEV_CHANNEL_PROFILE.role).toBe("ceo");
    expect(DEV_CHANNEL_PROFILE.full_name).toBe("Dev Reviewer");
  });
});
