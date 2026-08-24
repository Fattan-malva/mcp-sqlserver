const PAGE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "IBM Plex Sans", system-ui, sans-serif;
  background: radial-gradient(1200px 600px at 70% -10%, #101a22 0%, #07090c 55%, #050607 100%);
  color: #c9d4dc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
}
.bench { width: 100%; max-width: 480px; }
.bench-brand { font-family: "IBM Plex Mono", monospace; font-weight: 600; font-size: 20px; letter-spacing: .04em; color: #e8f0f5; margin-bottom: 4px; }
.bench-dash { color: #22d3ee; }
.bench-sub { font-family: "IBM Plex Mono", monospace; font-size: 10px; letter-spacing: .18em; color: #5b6b78; margin-bottom: 22px; }
.slide { background: rgba(13, 20, 27, .82); border: 1px solid #1d2a36; border-radius: 10px; padding: 26px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
.slide-cap { display: flex; justify-content: space-between; font-family: "IBM Plex Mono", monospace; font-size: 10px; letter-spacing: .16em; color: #22d3ee; margin-bottom: 18px; }
h1 { font-size: 22px; font-weight: 600; color: #eef4f8; margin-bottom: 8px; }
p { font-size: 13px; line-height: 1.6; color: #93a4b2; margin-bottom: 18px; }
label { display: block; font-family: "IBM Plex Mono", monospace; font-size: 10px; letter-spacing: .14em; color: #7d8d9b; margin: 14px 0 6px; }
input[type=text], input[type=password] {
  width: 100%; background: #0b1117; border: 1px solid #22303d; border-radius: 6px; padding: 11px 12px;
  color: #e8f0f5; font-size: 14px; font-family: "IBM Plex Mono", monospace; outline: none;
}
input:focus { border-color: #22d3ee; }
.kv { font-family: "IBM Plex Mono", monospace; font-size: 12px; background: #0b1117; border: 1px solid #1d2a36; border-radius: 6px; padding: 12px 14px; margin-bottom: 10px; line-height: 1.8; color: #9fb2c1; word-break: break-all; }
.kv b { color: #e8f0f5; font-weight: 500; }
button {
  margin-top: 20px; width: 100%; background: #0891b2; border: none; color: #06222c; cursor: pointer;
  font-family: "IBM Plex Mono", monospace; font-weight: 600; font-size: 13px; letter-spacing: .08em;
  padding: 13px; border-radius: 6px;
}
button:hover { background: #06b6d4; }
button.ghost { background: transparent; border: 1px solid #2a3a49; color: #93a4b2; margin-top: 10px; }
button.ghost:hover { border-color: #4a6272; color: #c9d4dc; }
.error { margin-top: 12px; color: #fb7185; font-family: "IBM Plex Mono", monospace; font-size: 12px; }
.mono { font-family: "IBM Plex Mono", monospace; }
.return { display: block; margin-top: 16px; color: #5b6b78; font-family: "IBM Plex Mono", monospace; font-size: 11px; text-align: center; text-decoration: none; }
.return:hover { color: #93a4b2; }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${PAGE_CSS}</style></head>
<body><div class="bench">
  <div class="bench-brand">mcp<span class="bench-dash">-</span>sqlserv</div>
  <div class="bench-sub">SPECIMEN LAB &middot; OAUTH GATE</div>
  <div class="slide">${body}</div>
</div></body></html>`;
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function loginPageHtml(error?: string): string {
  return page(
    'Login &middot; mcp-sqlserv',
    `<div class="slide-cap"><span>OPERATOR LOGIN</span><span class="mono">AUTH CODE + PKCE</span></div>
     <h1>Allow database access?</h1>
     <p>Claude (or another MCP client) is requesting access to the database specimen. Sign in with console operator credentials to continue.</p>
     <form method="post" action="/oauth/login">
       <label>OPERATOR</label>
       <input type="text" name="user" autocomplete="username" placeholder="admin" required />
       <label>ACCESS KEY</label>
       <input type="password" name="password" autocomplete="current-password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" required />
       ${error ? `<div class="error">${error}</div>` : ''}
       <button type="submit">Sign In &amp; Continue</button>
     </form>`,
  );
}

export function consentPageHtml(p: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  state: string;
}): string {
  return page(
    'Authorization &middot; mcp-sqlserv',
    `<div class="slide-cap"><span>CONNECTION CONSENT</span><span class="mono">RFC 7591</span></div>
     <h1>Allow ${esc(p.clientName)}?</h1>
     <p>The following MCP client is requesting read access to the database (read-only, subject to table permissions). Redirect after authorization:</p>
     <div class="kv">REDIRECT&nbsp;&nbsp;<b>${esc(p.redirectUri)}</b></div>
     <div class="kv">SCOPE&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>${esc(p.scope)}</b></div>
     <div class="kv">RESOURCE&nbsp;&nbsp;<b>${esc(p.resource)}</b></div>
     <form method="post" action="/oauth/authorize">
       <input type="hidden" name="client_id" value="${esc(p.clientId)}" />
       <input type="hidden" name="redirect_uri" value="${esc(p.redirectUri)}" />
       <input type="hidden" name="scope" value="${esc(p.scope)}" />
       <input type="hidden" name="resource" value="${esc(p.resource)}" />
       <input type="hidden" name="code_challenge" value="${esc(p.codeChallenge)}" />
       <input type="hidden" name="code_challenge_method" value="S256" />
       <input type="hidden" name="response_type" value="code" />
       <input type="hidden" name="state" value="${esc(p.state)}" />
       <button type="submit" name="decision" value="approve">Allow Access</button>
       <button type="submit" name="decision" value="deny" class="ghost">Deny</button>
     </form>`,
  );
}

export function errorPageHtml(message: string): string {
  return page(
    'Error &middot; mcp-sqlserv',
    `<div class="slide-cap"><span>OAUTH / ERROR</span><span class="mono">REQUEST INVALID</span></div>
     <h1>Request rejected</h1>
     <div class="kv"><b>${esc(message)}</b></div>`,
  );
}