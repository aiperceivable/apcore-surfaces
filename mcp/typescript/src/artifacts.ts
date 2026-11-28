import { randomUUID } from "node:crypto";
import type { Identity } from "apcore-js";

export const ARTIFACT_URI_PREFIX = "apcore-artifact://";
const artifactIdPattern = /^[a-f0-9]{32}$/;
const mediaTypePattern = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?![\s\S])/;

type ArtifactMetadata = { readonly name: string; readonly mimeType: string; readonly size: number };
type StoredArtifact = ArtifactMetadata & {
  readonly content: Buffer;
  readonly authority: string;
  readonly expiresAt: number;
};

function authority(identity: Identity): string {
  return JSON.stringify([identity.issuer ?? null, identity.type, identity.id,
    Array.from(identity.roles).sort(), identity.authorityKey?.() ?? null]);
}

/** Bounded in-process media storage owned by the embedding MCP host. */
export class MCPArtifactStore {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly ttlMilliseconds: number;
  private readonly items = new Map<string, StoredArtifact>();

  constructor({ maxBytes = 8_388_608, maxEntries = 16, ttlSeconds = 300 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("Artifact size limit must be a positive integer");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("Artifact entry limit must be a positive integer");
    }
    if (!Number.isFinite(ttlSeconds * 1000) || ttlSeconds <= 0) {
      throw new TypeError("Artifact expiry must be positive and finite");
    }
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.ttlMilliseconds = ttlSeconds * 1000;
  }

  put(
    content: Uint8Array,
    { name, mimeType, owner }: { name: string; mimeType: string; owner: Identity },
  ): string {
    if (!(content instanceof Uint8Array) || content.length > this.maxBytes) {
      throw new TypeError("Artifact content must be bytes within the size limit");
    }
    if (name.length === 0 || Array.from(name).length > 200 ||
        name.includes("/") || name.includes(String.fromCharCode(92)) || /\p{C}/u.test(name)) {
      throw new TypeError("Artifact name must be a printable filename");
    }
    if (mimeType.length > 127 || !mediaTypePattern.test(mimeType)) {
      throw new TypeError("Artifact MIME type is invalid");
    }
    if (!owner.id) throw new TypeError("An authenticated artifact owner is required");

    const now = performance.now();
    for (const [key, item] of this.items) {
      if (item.expiresAt <= now) this.items.delete(key);
    }
    if (this.items.size >= this.maxEntries) throw new Error("Artifact store is full");

    const key = randomUUID().replaceAll("-", "");
    this.items.set(key, {
      content: Buffer.from(content), name, mimeType, size: content.length,
      authority: authority(owner), expiresAt: now + this.ttlMilliseconds,
    });
    return key;
  }

  describe(uri: string, identity: Identity | null): ArtifactMetadata | null {
    const artifact = this.find(uri, identity);
    return artifact === null ? null : {
      name: artifact.name, mimeType: artifact.mimeType, size: artifact.size,
    };
  }

  read(uri: string, identity: Identity | null): { blob: string; mimeType: string } | null {
    const artifact = this.find(uri, identity);
    return artifact === null ? null : {
      blob: artifact.content.toString("base64"), mimeType: artifact.mimeType,
    };
  }

  private find(uri: string, identity: Identity | null): StoredArtifact | null {
    if (identity === null || !uri.startsWith(ARTIFACT_URI_PREFIX)) return null;
    const key = uri.slice(ARTIFACT_URI_PREFIX.length);
    if (key.length !== 32 || !artifactIdPattern.test(key)) return null;
    const artifact = this.items.get(key);
    if (!artifact) return null;
    if (artifact.expiresAt <= performance.now()) {
      this.items.delete(key);
      return null;
    }
    return artifact.authority === authority(identity) ? artifact : null;
  }
}
