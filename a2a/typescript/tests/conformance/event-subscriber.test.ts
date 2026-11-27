import {
  APCore, A2ASubscriber, Config, VERSION, createSubscriberFromConfig, resetSubscriberRegistry,
} from "apcore-js";
import type { ApCoreEvent, EventEmitter } from "apcore-js";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { A2AEventSubscriber, registerA2ASubscriber } from "../../src/index.js";

interface FixtureCase {
  id: string;
  subscriber: Record<string, unknown>;
  status: number;
  delay_ms?: number;
  expected: {
    requests: number;
    authorization?: string;
    source?: string;
    skill_id?: string;
    dead_letters: number;
    circuit_opened: number;
  };
}

interface FixtureEvent {
  event_type: string;
  module_id: string | null;
  timestamp: string;
  severity: string;
  data: Record<string, unknown>;
}

interface RecordedRequest {
  method?: string;
  path?: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

const fixture = JSON.parse(readFileSync(
  new URL("../../../conformance/fixtures/event_subscriber.json", import.meta.url), "utf8",
)) as { event: FixtureEvent; test_cases: FixtureCase[] };
// The published minimum suppresses failures from configured subscribers
// inside CircuitBreakerWrapper. Candidate jobs can require all cases even
// when checking their installation, so a stale minimum cannot pass them.
const legacyCoreFloor = VERSION === "0.33.0" && process.env.APCORE_A2A_REQUIRE_RELIABLE_DELIVERY !== "1";

function createEmitter(configFile: string, receiverUrl: string, test: FixtureCase): EventEmitter {
  const subscriber = test.subscriber.type === "filter"
    ? { ...test.subscriber, delegate_config: { platform_url: receiverUrl } }
    : { ...test.subscriber, platform_url: receiverUrl };
  writeFileSync(configFile, [
    'version: "1.0.0"',
    "project: {name: fixture}",
    "sys_modules:",
    "  enabled: true",
    "  events:",
    "    enabled: true",
    `    subscribers: ${JSON.stringify([subscriber])}`,
  ].join("\n"));
  const app = new APCore({ config: Config.load(configFile), failOnError: true });
  if (!app.events) throw new Error("Configured event bus is unavailable");
  return app.events;
}

function expectRequest(recorded: RecordedRequest, expected: FixtureCase["expected"]): void {
  expect(recorded.method).toBe("POST");
  expect(recorded.path).toBe("/receive");
  expect(recorded.headers["content-type"]).toBe("application/json");
  expect(recorded.headers.authorization).toBe(expected.authorization);
  expect(recorded.headers["x-source"]).toBe(expected.source);
  expect(recorded.body).toEqual({ skillId: expected.skill_id, event: fixture.event });
}

it("assigns distinct generated IDs to legacy and Surface A2A subscribers", () => {
  const core = new A2ASubscriber("https://example.invalid/core");
  const surface = new A2AEventSubscriber("https://example.invalid/surface");
  const secondSurface = new A2AEventSubscriber("https://example.invalid/another");
  expect(new Set([core.subscriberId, surface.subscriberId, secondSurface.subscriberId]).size).toBe(3);
  expect(surface.subscriberId).toMatch(/^a2a-\d+$/);
  expect(surface.subscriberType).toBe(core.subscriberType);
  expect(new A2AEventSubscriber("https://example.invalid/explicit", undefined, { id: "receiver" }).subscriberId).toBe("receiver");
});

describe("configured A2A event subscriber", () => {
  const verifyDelivery = async (test: FixtureCase): Promise<void> => {
    const requests: RecordedRequest[] = [];
    const diagnostics: ApCoreEvent[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      request.once("end", () => {
        requests.push({
          method: request.method,
          path: request.url,
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        const respond = () => { response.writeHead(test.status).end(); };
        if (test.delay_ms === undefined) {
          respond();
        } else {
          const timer = setTimeout(respond, test.delay_ms);
          response.once("close", () => { clearTimeout(timer); });
        }
      });
    });
    const scratch = mkdtempSync(join(tmpdir(), "apcore-a2a-event-"));
    resetSubscriberRegistry();
    try {
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const bound = server.address();
      if (!bound || typeof bound === "string") throw new Error("Receiver TCP address is unavailable");
      const url = `http://127.0.0.1:${bound.port}/receive`;
      const configFile = join(scratch, "apcore.yaml");
      const event: ApCoreEvent = {
        eventType: fixture.event.event_type,
        moduleId: fixture.event.module_id,
        timestamp: fixture.event.timestamp,
        severity: fixture.event.severity,
        data: fixture.event.data,
      };

      const config = { type: "a2a", platform_url: url };
      expect(createSubscriberFromConfig(config)).toBeInstanceOf(A2ASubscriber);
      registerA2ASubscriber();
      expect(createSubscriberFromConfig(config)).toBeInstanceOf(A2AEventSubscriber);
      const emitter = createEmitter(configFile, url, test);
      try {
        for (const eventPattern of ["apcore.event.delivery_failed", "apcore.subscriber.circuit_opened"]) {
          emitter.subscribe({ eventPattern, onEvent: received => { diagnostics.push(received); } });
        }
        emitter.emit(event);
        await emitter.flush();
      } finally {
        await emitter.shutdown();
      }

      expect(requests).toHaveLength(test.expected.requests);
      for (const request of requests) expectRequest(request, test.expected);
      const deadLetters = diagnostics.filter(item => item.eventType === "apcore.event.delivery_failed");
      const circuits = diagnostics.filter(item => item.eventType === "apcore.subscriber.circuit_opened");
      expect(deadLetters).toHaveLength(test.expected.dead_letters);
      expect(circuits).toHaveLength(test.expected.circuit_opened);
      for (const diagnostic of [...deadLetters, ...circuits]) {
        expect(diagnostic.data).toMatchObject({ subscriber_type: "a2a", subscriber_id: expect.stringMatching(/^a2a-\d+$/) });
      }

      if (test.id === "bearer_success") {
        resetSubscriberRegistry();
        expect(createSubscriberFromConfig(config)).toBeInstanceOf(A2ASubscriber);
        const legacy = createEmitter(configFile, url, test);
        try {
          legacy.emit(event);
          await legacy.flush();
        } finally {
          await legacy.shutdown();
        }
        expect(requests).toHaveLength(2);
        expectRequest(requests[1], test.expected);
      }
    } finally {
      resetSubscriberRegistry();
      if (server.listening) {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  for (const test of fixture.test_cases) {
    it.skipIf(legacyCoreFloor && test.expected.dead_letters > 0)(test.id, () => verifyDelivery(test));
  }
});
