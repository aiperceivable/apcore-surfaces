import { registerSubscriberType } from "apcore-js";
import type { ApCoreEvent, EventRetryConfig, EventSubscriber } from "apcore-js";

export interface A2AEventSubscriberOptions {
  readonly timeoutMs?: number;
  readonly skillId?: string;
  readonly id?: string;
  readonly retry?: EventRetryConfig;
}

type AuthHeaders = string | Record<string, unknown>;

let nextSubscriberId = 0;

/** Deliver one A2A HTTP attempt for the Core event emitter. */
export class A2AEventSubscriber implements EventSubscriber {
  readonly subscriberType = "a2a";
  readonly subscriberId: string;
  readonly retry?: EventRetryConfig;
  private readonly headers = new Headers({ "Content-Type": "application/json" });
  private readonly timeoutMs: number;
  private readonly skillId: string;

  constructor(
    private readonly platformUrl: string,
    auth?: AuthHeaders,
    options: A2AEventSubscriberOptions = {},
  ) {
    this.subscriberId = options.id ?? `a2a-${nextSubscriberId++}`;
    this.retry = options.retry;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.skillId = options.skillId ?? "apevo.event_receiver";
    if (typeof auth === "string") {
      this.headers.set("Authorization", `Bearer ${auth}`);
    } else if (auth) {
      for (const [name, value] of Object.entries(auth)) {
        if (typeof value === "string") this.headers.set(name, value);
      }
    }
  }

  async onEvent(event: ApCoreEvent): Promise<void> {
    const body = JSON.stringify({
      skillId: this.skillId,
      event: {
        event_type: event.eventType,
        module_id: event.moduleId,
        timestamp: event.timestamp,
        severity: event.severity,
        data: event.data,
      },
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.platformUrl, {
        method: "POST",
        headers: this.headers,
        body,
        signal: controller.signal,
      }).catch(() => {
        const message = controller.signal.aborted
          ? "A2A event delivery timed out"
          : "A2A event delivery failed";
        throw new Error(message);
      });
      // Delivery has no response body contract. Release it without delaying
      // the status result or interfering with Core's retry decision.
      void response.body?.cancel().catch(() => undefined);
      if (response.status >= 500) {
        throw new Error(`A2A event delivery failed with HTTP ${response.status}`);
      }
      if (response.status >= 400) {
        console.warn("[apcore:a2a]", `Event ${event.eventType} rejected with HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function retryFromConfig(value: unknown): EventRetryConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const retry: EventRetryConfig = {};
  if (typeof raw.max_attempts === "number") retry.maxAttempts = raw.max_attempts;
  if (typeof raw.initial_backoff_ms === "number") retry.initialBackoffMs = raw.initial_backoff_ms;
  if (typeof raw.max_backoff_ms === "number") retry.maxBackoffMs = raw.max_backoff_ms;
  if (typeof raw.backoff_multiplier === "number") retry.backoffMultiplier = raw.backoff_multiplier;
  return retry;
}

/** Select this transport for future `type: a2a` entries, including filter delegates. */
export function registerA2ASubscriber(): void {
  registerSubscriberType("a2a", config => {
    const { platform_url: url, auth, id, timeout_ms: timeoutMs, skill_id: skillId, retry } = config;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error('a2a subscriber requires a non-empty "platform_url" string field');
    }
    return new A2AEventSubscriber(url, auth as AuthHeaders | undefined, {
      id: typeof id === "string" ? id : undefined,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
      skillId: typeof skillId === "string" ? skillId : undefined,
      retry: retryFromConfig(retry),
    });
  });
}
