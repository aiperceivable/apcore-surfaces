/** Configuration for interpreting actor and scope claims of a verified JWT. */
export interface DelegatedClaims {
  readonly scpClaim?: string;
  readonly actorRolesClaim?: string;
}

interface TokenPrincipal {
  readonly id: string;
  readonly type: string;
  readonly roles: readonly string[];
}

export interface DelegatedJwtAuthority {
  readonly issuer: string;
  readonly subjectId: string;
  readonly scopes: readonly string[];
  readonly actor: TokenPrincipal | null;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateDelegatedClaims(
  mapping: DelegatedClaims, issuer?: string, audience?: string,
): DelegatedClaims {
  if (!nonemptyString(issuer) || !nonemptyString(audience)) {
    throw new TypeError('Delegated JWT claims require an expected issuer and audience');
  }
  for (const name of [mapping.scpClaim, mapping.actorRolesClaim]) {
    if (name !== undefined && !nonemptyString(name)) {
      throw new TypeError('JWT claim names must be nonempty strings');
    }
  }
  return Object.freeze({ ...mapping });
}

function scopeTokens(value: unknown, arraysAllowed = false): string[] {
  const tokens: unknown[] | undefined = typeof value === 'string'
    ? value.split(' ')
    : arraysAllowed && Array.isArray(value) ? value : undefined;
  // RFC 6749 section 3.3 scope-token. A provider array can represent no scopes.
  if (!tokens || !tokens.every(token => nonemptyString(token) && !/[^\x21\x23-\x5b\x5d-\x7e]/.test(token))) {
    throw new TypeError('Invalid JWT scope representation');
  }
  return [...new Set(tokens as string[])].sort();
}

function outerActor(value: unknown, mapping: DelegatedClaims): TokenPrincipal {
  if (!isRecord(value)) throw new TypeError('Invalid JWT actor');
  let node: unknown = value;
  for (let depth = 1; ; depth++) {
    if (depth > 8 || !isRecord(node) || !nonemptyString(node.sub) ||
        (Object.hasOwn(node, 'iss') && !nonemptyString(node.iss))) {
      throw new TypeError('Invalid JWT actor history');
    }
    if (!Object.hasOwn(node, 'act')) break;
    node = node.act;
  }
  const id = value.sub;
  const type = Object.hasOwn(value, 'type') ? value.type : 'agent';
  const roleClaim = mapping.actorRolesClaim;
  const roles = roleClaim !== undefined && Object.hasOwn(value, roleClaim) ? value[roleClaim] : [];
  if (!nonemptyString(id) || !nonemptyString(type) || !Array.isArray(roles) || !roles.every(nonemptyString)) {
    throw new TypeError('Invalid current JWT actor');
  }
  return { id, type, roles: [...roles] };
}

/** Read authority from a payload after the adapter has verified signature, issuer, audience and validity window. */
export function readDelegatedJwtAuthority(
  claims: Record<string, unknown>, mapping: DelegatedClaims, now: number,
): DelegatedJwtAuthority {
  const { iss, sub, aud, exp, iat } = claims;
  if (!nonemptyString(iss) || !nonemptyString(sub) ||
      !(nonemptyString(aud) || (Array.isArray(aud) && aud.length > 0 && aud.every(nonemptyString))) ||
      typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new TypeError('JWT delegated authority requires issuer, subject, audience and expiry');
  }
  for (const name of ['nbf', 'iat']) {
    const time = claims[name];
    if (Object.hasOwn(claims, name) && (typeof time !== 'number' || !Number.isFinite(time))) {
      throw new TypeError('Invalid JWT time claim');
    }
  }
  if (typeof iat === 'number' && iat > now + 30) throw new TypeError('JWT issued in the future');

  const standard = Object.hasOwn(claims, 'scope') ? scopeTokens(claims.scope) : undefined;
  const alternate = mapping.scpClaim !== undefined && Object.hasOwn(claims, mapping.scpClaim)
    ? scopeTokens(claims[mapping.scpClaim], true) : undefined;
  if (standard && alternate && (standard.length !== alternate.length ||
      standard.some((scope, index) => scope !== alternate[index]))) {
    throw new TypeError('JWT scope claims disagree');
  }
  const scopes = standard ?? alternate;
  if (scopes === undefined) throw new TypeError('JWT must carry a configured scope claim');
  return {
    issuer: iss, subjectId: sub, scopes,
    actor: Object.hasOwn(claims, 'act') ? outerActor(claims.act, mapping) : null,
  };
}
