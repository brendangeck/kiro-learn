# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in kiro-learn, please report it responsibly:

- **Email:** [bpgeck@gmail.com](mailto:bpgeck@gmail.com)
- **GitHub Security Advisory:** [Open a private advisory](https://github.com/brendangeck/kiro-learn/security/advisories/new)

Please do not open a public issue for security vulnerabilities. I'll acknowledge your report within 72 hours and work with you on a fix.

## Architecture context

kiro-learn runs entirely on your local machine. The collector daemon binds to `127.0.0.1:21100` and is not reachable from other machines on your network.

The only outbound data path is **extraction** — buffered events are sent to Amazon Bedrock through `kiro-cli acp` using your own AWS credentials. kiro-learn does not operate any server in this path and does not phone home, collect telemetry, or contact any third-party service.

For a detailed breakdown of what data is stored locally, what leaves your machine, and how to redact sensitive content, see the [Privacy](https://kiro-learn.mintlify.app/concepts/privacy) page in the docs.

## Supported versions

Security fixes are applied to the latest release only. There is no long-term support for older versions at this time.
