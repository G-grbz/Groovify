# Security Policy

## Supported versions

Security fixes are provided for the latest released version of Gharmonize. Users should upgrade before reporting issues that may already be fixed on `main`.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for an undisclosed vulnerability. Use GitHub Private Vulnerability Reporting when it is enabled for this repository. If private reporting is temporarily unavailable, contact the maintainer through the contact information published on the repository profile and avoid including exploit details in public channels.

Include the affected version, deployment mode (desktop, native web, or Docker), reproduction steps, impact, and any relevant logs with secrets removed.

## Security model

- The native web server binds to `127.0.0.1` by default. Docker explicitly opts into `0.0.0.0`.
- Remote deployments should be placed behind HTTPS and a trusted reverse proxy/firewall.
- Loopback reverse proxies are trusted automatically. `TRUST_PROXY` should only be enabled for additional proxy networks together with explicit `TRUSTED_PROXY_CIDRS`.
- Admin passwords are stored as scrypt hashes. Sensitive settings supported by the settings UI are encrypted at rest with AES-256-GCM.
- Keep `.gharmonize-key`, `.env`, cookie files, media inputs, and output directories out of source control and backups with overly broad access.
- Runtime binary downloads are restricted to trusted HTTPS origins; GitHub release asset SHA-256 digests are verified when supplied by GitHub.
- Electron uses context isolation, renderer sandboxing, navigation restrictions, IPC sender validation, and denies unexpected permission requests.


## Code scanning triage

Gharmonize keeps CodeQL security queries enabled. Project-local controls such as the custom rate limiter, log sanitizer, process allowlist, and path-boundary helpers may not always be modeled by CodeQL. A source-level `codeql[...]` suppression is used only for a reviewed sink where the corresponding security control is immediately present and covered by regression tests. Query-wide exclusions are not used for these cases, so newly introduced unprotected code remains visible to CodeQL.

### Application access boundary

When administrator-gated application access is enabled, Gharmonize enforces the gate on the server before dynamic API/download routes; the browser overlay is not the security boundary. Temporary authorization uses a signed HttpOnly/SameSite cookie bound to a persisted grant, the server-observed client IP, configured expiry, and a persistent access-policy revision, and never grants administrator privileges. Administrators can revoke one active grant without rotating every other session; the next server-side authorization check rejects that cookie, and temporary clients also refresh gate state frequently so an idle UI relocks quickly. Access-policy or admin-password changes revoke all temporary grants. Approval requests use cryptographically random identifiers, a signed HttpOnly per-browser requester identity, bounded request metadata, rate limits, explicit administrator approval, one-pending-or-active-grant-per-IP enforcement, and a 15-minute server-side rejection cooldown. Pending and active grants are available from the Classic jobs-bell access inbox and the YTLive access bell instead of interrupting either UI. Loopback reverse proxies are trusted automatically; non-loopback reverse-proxy deployments must configure `TRUST_PROXY` and `TRUSTED_PROXY_CIDRS` correctly so the IP used for approval and session binding is trustworthy.

## Release verification

Official tagged releases publish a CycloneDX SBOM, a GPG-signed `SHA256SUMS` manifest, the public release-signing key, and GitHub artifact attestations. The public GPG key is itself covered by GitHub provenance, so authenticate the key before importing it:

```bash
gh attestation verify Gharmonize-release-signing-key.asc --repo G-grbz/Gharmonize
gpg --import Gharmonize-release-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS

# Optional direct provenance verification for an individual artifact:
gh attestation verify <artifact> --repo G-grbz/Gharmonize
```

## Official downloads, impersonation, and suspicious distributions

The official Gharmonize project is hosted at:

- Repository: https://github.com/G-grbz/Gharmonize
- Releases: https://github.com/G-grbz/Gharmonize/releases
- Container: https://github.com/G-grbz/Gharmonize/pkgs/container/gharmonize

A third-party repository or website using the Gharmonize name is not automatically an official distribution. In particular, treat a download as suspicious if it asks you to disable antivirus protection, add security exclusions, run an unrelated installer as Administrator, or obtain Gharmonize from an unrelated external domain.

Do not rely on a third-party project's source-code claim as proof that a separately hosted binary is safe. Verify official tagged artifacts with the published `SHA256SUMS` and GitHub artifact attestations described above.

If you find a repository, website, package, or executable that uses the Gharmonize name or project screenshots in a way that could be mistaken for an official release, please report it to the hosting provider and notify the maintainer through the contact information on the official GitHub profile. Include the URL and screenshots when possible.

[Softpedia](https://www.softpedia.com/get/Multimedia/Audio/Other-AUDIO-Tools/Gharmonize.shtml) currently maintains an independent third-party listing and review for Gharmonize. The listing was created independently and was not requested, operated, or managed by this project. The authoritative source for official releases remains the GitHub repository above.
