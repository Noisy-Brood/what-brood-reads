import { UnrenderableRuleError } from "./errors";
import type { RuleIdentity } from "./rules";

/**
 * What every adapter asks of a value before it writes it into a rule (DD1
 * §7.5, #1180): plainly an address or a domain, or refused. One set of
 * checks, so what is renderable does not depend on the provider, and each
 * adapter adds only what its own syntax needs on top.
 */

const DNS_PART = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const DOMAIN = new RegExp(`^(?:${DNS_PART}\\.)+[a-z]{2,63}$`);
const LOCAL = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9_+-])?$/;

export const isPlainDomain = (value: string): boolean => DOMAIN.test(value);

export function isPlainAddress(value: string): boolean {
  const at = value.lastIndexOf("@");
  return (
    at > 0 &&
    LOCAL.test(value.slice(0, at)) &&
    isPlainDomain(value.slice(at + 1))
  );
}

export function plainDomain(value: string): string {
  if (!isPlainDomain(value)) throw new UnrenderableRuleError();
  return value;
}

export function plainAddress(value: string): string {
  if (!isPlainAddress(value)) throw new UnrenderableRuleError();
  return value;
}

/**
 * Which Brood made a rule and which rule it is, as the hex an adapter writes
 * into it (#291): the installation's twelve characters, then the rule id's
 * thirty-two.
 */
export function identityHex(identity: RuleIdentity): string {
  const hex = identity.ruleId.replaceAll("-", "").toLowerCase();
  if (
    !/^[0-9a-f]{12}$/.test(identity.installation) ||
    !/^[0-9a-f]{32}$/.test(hex)
  ) {
    throw new UnrenderableRuleError();
  }
  return `${identity.installation}${hex}`;
}

/** The rule id an adapter reads back from those thirty-two characters. */
export const ruleIdOfHex = (h: string): string =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
