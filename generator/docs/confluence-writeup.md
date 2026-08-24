# Secure MCP Server Generation Framework

**Author:** Tim Schwarz
**Date:** January 2025

---

## Executive Summary

This document outlines the security architecture for our autonomous MCP (Model Context Protocol) server generation platform. The platform enables rapid development of secure API integrations while maintaining enterprise-grade security controls and compliance with industry standards.

---

## What is MCP?

Model Context Protocol (MCP) is a standardized protocol for AI agents to interact with external tools and services. MCP servers act as secure bridges between AI systems and APIs, enabling capabilities like:

- Reading/writing to enterprise systems (Jira, ServiceNow, etc.)
- Executing API calls on behalf of users
- Accessing organizational data within permission boundaries

**Security Challenge:** MCP servers have broad access to systems and data. Without proper controls, they represent a significant attack surface.

---

## Security Architecture Overview

### Authentication Model

Our implementation follows the **MCP Authorization Specification (June 2025)** which mandates:

| Requirement | Implementation |
|-------------|----------------|
| OAuth 2.1 with PKCE | All authentication flows require Proof Key for Code Exchange |
| Resource Indicators (RFC 8707) | Tokens are bound to specific MCP servers, preventing misuse |
| Short-lived Tokens | 15-30 minute access tokens with secure refresh |
| No Token Storage | MCP servers validate tokens, never store them |

### Identity Provider Integration

The framework supports enterprise identity providers:

- **Microsoft Entra ID** (Azure AD) - Primary, with On-Behalf-Of flow support
- **Okta** - Supported
- **Auth0** - Supported
- **Keycloak** - Supported

This enables SSO integration and leverages existing identity governance.

### Critical Security Controls

Based on [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices):

**MUST Requirements:**
- ❌ **NO Token Passthrough** - Tokens are never forwarded to downstream APIs
- ❌ **NO Session Authentication** - Sessions used for state only
- ✅ **Token Audience Validation** - Every token validated for intended recipient
- ✅ **Scope Minimization** - Least-privilege access model

**Security Hardening:**
- Input sanitization (SQL injection, command injection, path traversal prevention)
- Session binding to user identity
- Scope validation with wildcard rejection
- Sensitive path access logging

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Identity Provider                           │
│            (Entra ID / Okta / Auth0 / Keycloak)                │
└────────────────────────┬────────────────────────────────────────┘
                         │
              OAuth 2.1 + PKCE + Resource Indicators
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                    AI Agent (MCP Client)                        │
│              Requests scoped access tokens                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
               Bearer Token (audience-validated)
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                 MCP Server (Resource Server)                     │
│   • Validates token audience matches this server                │
│   • Enforces scope-based permissions                            │
│   • Uses On-Behalf-Of for downstream access                     │
│   • Applies input sanitization                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                   OBO Token Exchange
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                  Downstream Services                             │
│         (ServiceNow, Jira, Azure services, etc.)                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Permission Model

### Scope-Based Access Control

MCP tools are protected by scopes tied to user permissions:

| Scope | Access Level | Example Tools |
|-------|--------------|---------------|
| `mcp:read` | Read-only queries | Search, Get, List |
| `mcp:write` | Create/Update operations | Create ticket, Update status |
| `mcp:admin` | Administrative functions | Configuration, User management |

### Role & Group Integration

Permissions can be further restricted by:
- **Entra ID Groups** - Map AD groups to tool access
- **Application Roles** - Define custom role hierarchies
- **Conditional Access** - Enforce location/device policies

---

## Known Vulnerabilities Addressed

Our framework mitigates known MCP security issues:

| Vulnerability | Mitigation |
|---------------|------------|
| CVE-2025-49596 (RCE) | Input sanitization, command pattern blocking |
| SQL Injection | Parameterized queries, injection pattern detection |
| Token Misuse | RFC 8707 resource indicators, audience validation |
| Session Hijacking | User-bound session IDs, no session authentication |
| Prompt Injection | Context isolation, input validation |

---

## Compliance Alignment

The architecture supports:

- **SOC 2 Type II** - Access controls, audit logging
- **ISO 27001** - Information security management
- **GDPR/CCPA** - Data access controls, audit trails

---

## Implementation Status

| Component | Status |
|-----------|--------|
| OAuth 2.1 + PKCE | ✅ Implemented |
| Entra ID Integration | ✅ Implemented |
| Token Validation | ✅ Implemented |
| Security Hardening | ✅ Implemented |
| Audit Logging | ✅ Implemented |
| Automated Generation | ✅ Implemented |

---

## References

- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [OAuth 2.1 (RFC 9700)](https://datatracker.ietf.org/doc/html/rfc9700)
- [Resource Indicators (RFC 8707)](https://datatracker.ietf.org/doc/html/rfc8707)
- [Microsoft Entra ID MCP Guide](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-mcp-server-vscode)

---

## Contact

For questions about this architecture, contact:
- **Tim Schwarz**

---

*This document describes the security architecture at a high level. Implementation details live in the source tree alongside this document.*
