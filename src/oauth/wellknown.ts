import type express from 'express';
import { oauthConfig } from '../config.js';
import { originOf } from './helpers.js';

/* RFC 9728 — metadata protected resource. `resource` harus PERSIS sama dengan
   URL yang diketik user di Claude (mis. https://mcp-sqlserv.mallvaa.xyz/mcp
   atau https://mcp-sqlserv.mallvaa.xyz/mcp/<projectId>).
   Saat metadata diminta di bawah /mcp/<projectId>, resource di-echo dari path
   itu agar DCR registrasi masuk ke project yang benar. */
export function protectedResourceHandler(req: express.Request, res: express.Response): void {
  const origin = originOf(req);
  const raw = (req.originalUrl ?? '').split('?')[0];
  const suffix = '/.well-known/oauth-protected-resource';
  const base =
    raw.endsWith(suffix) && raw.length > suffix.length && !raw.endsWith('/mcp' + suffix)
      ? `${origin}${raw.slice(0, -suffix.length)}`
      : `${origin}/mcp`;
  res.set('Cache-Control', 'no-store');
  res.json({
    resource: base,
    authorization_servers: [origin],
    scopes_supported: oauthConfig.allowedScopes,
    bearer_methods_supported: ['header'],
  });
}

/* RFC 8414 — authorization server metadata. Disajikan di
   /.well-known/oauth-authorization-server di bawah issuer (root). */
export function asMetadataHandler(req: express.Request, res: express.Response): void {
  const origin = originOf(req);
  res.set('Cache-Control', 'no-store');
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: oauthConfig.allowedScopes,
    issuer_parameter_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
}