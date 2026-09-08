# Security Policy

## Supported Versions

The project is pre-release. Security fixes target the latest `main` branch until the first stable release.

## Reporting a Vulnerability

Do **not** open a public issue for an unpatched vulnerability. Use GitHub private vulnerability reporting for this repository when available. Include impact, affected component, reproduction steps, and a proposed mitigation if known. Do not include real provider credentials or private stock assets.

Expect an acknowledgement within 7 days. Disclosure timing will be coordinated after validation and remediation.

## Sensitive Data

Never commit API keys, OAuth tokens, cookies, private URLs, generated customer assets, model/property releases, or `.env` files. Rotate any credential immediately if exposed.

## Security Boundary

- The browser owns local project directory handles; the backend accepts only temporary required inputs and cannot write directly to that directory.
- Provider credentials are configured only in backend secret files/environment; the browser has no key-entry form and never receives stored key material. Secure sessions are backend-owned. Tailscale and CORS do not replace application authentication or CSRF protection.
- SVG is hostile input until sanitized; production uses same-origin HTTPS and exposes the API only through Nginx.
- Retry must not duplicate a paid generation request when provider acceptance is unknown.
- Gandiwa is not a legal clearance service and does not guarantee acceptance by any marketplace. AI-based legal review is risk screening only.
