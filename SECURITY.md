# Security Policy

## Supported versions

This project has no tagged releases. Only the latest commit on `main` receives
security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub:
**Security → Advisories → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and the impact you see. You can
expect an acknowledgement within a few days; a fix is published on `main` and
credited in the advisory, unless you prefer to stay anonymous.

## Scope

In scope: the code in this repository: authentication flows, session and token
handling, and the HTTP layer.

Out of scope: the development defaults in `.env.example` and `docker-compose.yml`
(they are placeholders for a local machine, not production values) and
vulnerabilities in third-party dependencies with no exploitable path here —
those are tracked by Dependabot.
