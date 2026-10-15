# Personal Access Tokens

This guide covers Personal Access Tokens (PATs) in this web application foundation.

## Table of Contents

- [Overview](#overview)
- [Use Cases](#use-cases)
- [Creating a Token](#creating-a-token)
- [Using a Token](#using-a-token)
- [Managing Tokens](#managing-tokens)
- [Duration Options](#duration-options)
- [API Reference](#api-reference)
- [Security Considerations](#security-considerations)

---

## Overview

Personal Access Tokens are long-lived API tokens that allow programmatic access to the application on behalf of a specific user. Unlike OAuth flows, PATs do not require browser interaction and are suited for automated or non-interactive clients.

A PAT authenticates as the user who created it, inheriting that user's roles and permissions at the time of each request. If the user's roles change, all of their PATs reflect the updated permissions immediately.

---

## Use Cases

- **CI/CD pipelines** - Authenticate automated build and deployment scripts
- **CLI tools** - Provide persistent credentials for command-line applications
- **Scripts and automation** - Run scheduled jobs or batch processes under a specific user identity
- **Third-party integrations** - Connect external services that call the API on behalf of a user

---

## Creating a Token

1. Navigate to **Settings > Personal Access Tokens**
2. Click **Create Token**
3. Enter a descriptive name that identifies where the token will be used (for example, `CI Pipeline` or `CLI Tool`)
4. Set the token duration by entering an integer between 1 and 999, then choosing a unit: minutes, days, or months
5. Click **Create**

The token is displayed once immediately after creation. Copy it and store it securely — the full token value cannot be retrieved again after this step.

Tokens use the format `pat_<hex-string>`.

---

## Using a Token

Include the token in the `Authorization` header of every API request as a Bearer token:

```
Authorization: Bearer pat_xxxxxxxxxxxx...
```

**Example with curl:**

```bash
curl -H "Authorization: Bearer pat_abc123..." https://your-app.com/api/auth/me
```

**Example with JavaScript (fetch):**

```javascript
const response = await fetch('https://your-app.com/api/users', {
  headers: {
    'Authorization': `Bearer ${process.env.PAT_TOKEN}`,
  },
});
```

**Example with Python (requests):**

```python
import requests
import os

response = requests.get(
    'https://your-app.com/api/users',
    headers={'Authorization': f'Bearer {os.environ["PAT_TOKEN"]}'},
)
```

PATs work on all authenticated API endpoints. The request is authorized using the roles and permissions of the user who created the token.

---

## Managing Tokens

All tokens for the current user are visible at **Settings > Personal Access Tokens**.

Each token entry shows:

| Field | Description |
|-------|-------------|
| Name | The descriptive label entered at creation |
| Prefix | A short prefix of the token for identification (e.g., `pat_ab12...`) |
| Created | Date the token was created |
| Expires | Date and time the token expires |
| Last used | Date of the most recent successful request using this token |

To revoke a token, click **Revoke** next to the token entry. Revoked tokens are invalidated immediately. Revocation is permanent — the token cannot be re-activated. Create a new token if continued access is needed.

---

## Duration Options

Choose the duration that matches how long the token needs to remain valid. Prefer shorter durations to limit exposure if a token is compromised.

| Unit | Range | Typical use |
|------|-------|-------------|
| Minutes | 1-999 | Short-lived automation tasks, one-off scripts |
| Days | 1-999 | CI/CD pipelines, active development workflows |
| Months | 1-999 | Long-lived integrations, infrequently rotated credentials |

---

## API Reference

The PAT routes are served by the platform identity slice (`/api/pat`), not by the app's own code; `/api/docs` (group "Personal Access Tokens") is the generated source of truth for field names. All PAT endpoints require a valid JWT Bearer token or a PAT. A PAT can be created and revoked by any signed-in user (no permission string).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/pat` | Create a new personal access token |
| GET | `/api/pat` | List all tokens for the current user |
| DELETE | `/api/pat/:id` | Revoke a token by ID |

### POST /api/pat

Create a new personal access token.

**Request:**
```json
{
  "name": "CI Pipeline",
  "durationValue": 90,
  "durationUnit": "days"
}
```

**Request Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Descriptive label for the token (1-100 characters) |
| `durationValue` | integer | Yes | Length of validity (1-999) |
| `durationUnit` | string | Yes | Unit of duration: `minutes`, `days`, or `months` |
| `orgId` | uuid | No | Organization the token is bound to. Defaults to the caller's organization; in this single-organization deployment that is the default organization. A value the caller is not an active member of answers 400 |

**Response (201 Created):**
```json
{
  "data": {
    "id": "uuid-1234",
    "name": "CI Pipeline",
    "token": "pat_a1b2c3d4e5f6...",
    "tokenPrefix": "pat_a1b2",
    "expiresAt": "2026-06-27T00:00:00.000Z",
    "createdAt": "2026-03-29T00:00:00.000Z",
    "orgId": "uuid-org"
  }
}
```

The `token` field is only present in this response. It is not returned by any other endpoint.

---

### GET /api/pat

List the personal access tokens belonging to the current user, across every organization (`orgId` names the one each is bound to).

**Request:**
```http
GET /api/pat
Authorization: Bearer <token>
```

**Response (200 OK):**
```json
{
  "data": [
    {
      "id": "uuid-1234",
      "name": "CI Pipeline",
      "tokenPrefix": "pat_a1b2",
      "durationValue": 90,
      "durationUnit": "days",
      "createdAt": "2026-03-29T00:00:00.000Z",
      "expiresAt": "2026-06-27T00:00:00.000Z",
      "lastUsedAt": "2026-03-29T12:00:00.000Z",
      "revokedAt": null,
      "orgId": "uuid-org"
    }
  ]
}
```

The list is not filtered: a revoked or expired token stays in it, with `revokedAt` set or `expiresAt` in the past, until the cleanup job deletes it (see "Cleanup" below).

---

### DELETE /api/pat/:id

Revoke a personal access token by its ID.

**Request:**
```http
DELETE /api/pat/uuid-1234
Authorization: Bearer <token>
```

**Response:** `204 No Content`.

**Error Responses:**
- **404 Not Found** - Token not found, does not belong to the current user, or is already revoked

---

## Security Considerations

**Token storage:**
- Tokens are hashed with SHA-256 before being stored in the database. The raw token value cannot be recovered from the database.
- Only a short prefix is stored alongside the hash for identification in the management UI.

**Token handling:**
- Treat PATs like passwords. Do not commit them to version control, include them in logs, or share them in plain text.
- Store tokens in environment variables or secrets management systems (for example, GitHub Actions secrets, HashiCorp Vault, or a CI/CD platform's credential store).

**Rotation and expiration:**
- Use the shortest token duration that meets your needs.
- Rotate tokens on a schedule, especially for long-lived integrations.
- Revoke tokens immediately when they are no longer needed or if they may have been exposed.

**Cleanup:**
- Expired tokens, and tokens revoked more than 30 days ago, are deleted by the `auth.token.cleanup` queue job (registered through the identity jobs adapter; the platform's cron only enqueues it).

**Scope:**
- PATs carry the full permissions of the user who created them. A token created by an Admin user can perform Admin-level operations. Prefer using accounts whose organization role is `contributor` or `viewer` for automated access when full Admin permissions are not required.
