import { z } from 'zod/v4';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const CHAIN_ID = 11155420;
export const CHAIN = { chainId: '0xaa37dc', chainName: 'OP Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia.optimism.io'],
  blockExplorerUrls: ['https://optimism-sepolia.blockscout.com'] };
export function appOrigin(input: string): string {
  const url = new URL(input);
  if (url.origin !== input || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('APP_ORIGIN must be an HTTPS origin (HTTP allowed only on loopback)');
  }
  return url.origin;
}
export const challengeInput = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.literal(CHAIN_ID), purpose: z.enum(['login', 'link', 'switch', 'recover']).default('login'),
}).strict();
export const verifyInput = z.object({
  id: z.uuid(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();
export const profileInput = z.object({ displayName: z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict();

function playersDocument(value: string) {
  if (/<!/.test(value) || XMLValidator.validate(value) !== true) return false;
  try {
    const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false }).parse(value);
    return Object.keys(parsed).filter(key => key !== '?xml').join(',') === 'players' && !Array.isArray(parsed.players);
  } catch { return false; }
}

// Fixed save shape: no arbitrary filesystem paths or client-owned inventory.
export const savePayload = z.object({ schemaVersion: z.literal(1), playersXml: z.string().max(1_000_000)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'Invalid XML control characters')
  .refine(value => !/<!/.test(value), 'XML declarations/entities/comments are not supported')
  .refine(playersDocument, 'Expected one well-formed players document')
  .refine(value => !/saved-token\s*=\s*["'][^"']+|saved-user\s*=\s*["'](?!0["'])|saved-session\s*=\s*["'](?!false["']|0["'])|remember-password\s*=\s*["'](?!false["']|0["'])/.test(value), 'Upstream login credentials must be removed')
}).strict();
export const saveInput = z.object({ baseRevision: z.number().int().min(0).max(2147483646), payload: savePayload }).strict();
