# Device Authorization Flow (RFC 8628)

This guide covers the Device Authorization Flow implementation in this web application foundation.

> **This flow has two documents.** This one is the narrative guide — concepts,
> a walkthrough, and copy-pasteable integration examples (Node.js, Python,
> React Native, Scalar). For the authoritative request/response schema, exact
> field names, and the security rationale behind the PAT-minting design, see
> [`apps/api/src/device-auth/README.md`](../apps/api/src/device-auth/README.md),
> which lives next to the code and is the source of truth when the two
> disagree.

## Table of Contents

- [Overview](#overview)
- [Use Cases](#use-cases)
- [How It Works](#how-it-works)
- [API Reference](#api-reference)
- [Integration Guides](#integration-guides)
- [Configuration](#configuration)
- [Device Session Management](#device-session-management)
- [Security Considerations](#security-considerations)
- [Error Handling](#error-handling)

---

## Overview

The Device Authorization Flow (defined in [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)) is an OAuth 2.0 extension that enables input-constrained devices to obtain user authorization without requiring a web browser on the device itself.

**Key Characteristics:**
- User authenticates on a separate device (phone, computer)
- Device polls for authorization status
- Short, human-readable codes for easy entry
- Secure, standards-compliant implementation

**Benefits:**
- Works on devices without browsers or keyboards
- User-friendly verification process
- Secure by design (hashed codes, rate limiting, expiration)
- Fully compatible with existing OAuth infrastructure

---

## Use Cases

### CLI Applications
Command-line tools that need user authentication without opening a local web browser.

**Example:** A deployment CLI that needs access to your organization's API:
```bash
$ deploy-cli login
Please visit: http://localhost:3535/activate
Enter code: ABCD-1234
Waiting for authorization...
✓ Authorized successfully!
```

### API Reference (Scalar)
Obtaining a token to use against the interactive [API reference](API.md#openapi-documentation) at `/api/docs`.

**Example:** If you're already signed in to the deployment in your browser, the reference
authorizes itself automatically on load — no token handling needed. Use the device flow instead
when that shortcut doesn't apply: a signed-out browser, a different device, or a non-browser
client that just needs a token to paste into the reference's Authentication panel.

### Mobile Applications
Native mobile apps that want to provide a web-based authorization flow without handling OAuth redirects directly.

### IoT Devices
Smart devices (TVs, thermostats, etc.) with limited input capabilities that need user authorization.

**Example:** A smart TV app displays a code for the user to enter on their phone or computer.

### Third-Party Integrations
External services that need to access your API on behalf of users.

---

## How It Works

### Flow Diagram

```
┌──────────────┐                                  ┌──────────────┐
│    Device    │                                  │     User     │
│ (CLI/App/IoT)│                                  │  (Browser)   │
└──────┬───────┘                                  └──────┬───────┘
       │                                                 │
       │  1. POST /auth/device/code                     │
       ├──────────────────────────────────────►         │
       │                                        │        │
       │  deviceCode: "abc123..."               │        │
       │  userCode: "ABCD-1234"                │        │
       │  verificationUri: "/activate"            │        │
       │◄──────────────────────────────────────         │
       │                                                 │
       │  2. Display code to user                       │
       │  "Visit /activate and enter: ABCD-1234"          │
       │                                                 │
       │                                          3. Navigate to
       │                                             /activate page
       │                                                 │
       │                                          4. Enter code
       │                                             "ABCD-1234"
       │                                                 │
       │                                          5. POST /auth/device/authorize
       │                                             {approve: true}
       │                                                 │
       │  6. POST /auth/device/token                    │
       │     (polling every 5 seconds)                  │
       ├──────────────────────────────────────►         │
       │                                        │        │
       │  Error: authorization_pending          │        │
       │◄──────────────────────────────────────         │
       │                                                 │
       │  7. POST /auth/device/token (retry)            │
       ├──────────────────────────────────────►         │
       │                                        │        │
       │  accessToken: "eyJ..."                │        │
       │  refreshToken: "xyz..."                │        │
       │◄──────────────────────────────────────         │
       │                                                 │
       │  8. Use tokens for API requests                │
       ├──────────────────────────────────────►         │
```

### Step-by-Step Process

#### 1. Device Requests Authorization
The device initiates the flow by requesting a device code pair:

```http
POST /api/auth/device/code
Content-Type: application/json

{
  "clientInfo": {
    "deviceName": "My CLI Tool",
    "userAgent": "my-cli/1.0.0"
  }
}
```

`clientInfo` is entirely optional, and so is every field on it. Omitting
`tokenType` (as above) defaults to `session`, which is what this walkthrough
shows; see [Credential Kinds](#credential-kinds-session-vs-pat) below for the
`pat` alternative and how the response differs.

#### 2. Server Returns Codes
The API responds with device and user codes:

```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/activate",
    "verificationUriComplete": "http://localhost:3535/activate?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  }
}
```

#### 3. User Navigates to Activation Page
The user opens the `verificationUri` or `verificationUriComplete` in a web browser and logs in (if not already authenticated).

#### 4. User Enters Code
On the activation page, the user enters the `userCode` displayed by the device.

#### 5. User Approves or Denies
The frontend calls the authorization endpoint:

```http
POST /api/auth/device/authorize
Authorization: Bearer <user_access_token>
Content-Type: application/json

{
  "userCode": "ABCD-1234",
  "approve": true
}
```

#### 6. Device Polls for Token
Meanwhile, the device continuously polls the token endpoint:

```http
POST /api/auth/device/token
Content-Type: application/json

{
  "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4"
}
```

**While Pending:**
```json
{
  "statusCode": 400,
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

**After Approval (`session` credential — the default shown here):**
```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
}
```

If the device had instead requested `clientInfo.tokenType: "pat"` in step 1,
this response has a different shape (a `pat_...` token, no `refreshToken`, and
a `credentialType: "pat"` discriminator) — see
[Credential Kinds](#credential-kinds-session-vs-pat) below.

#### 7. Device Uses Tokens
The device can now use the access token for authenticated API requests.

---

## API Reference

### Public Endpoints

#### POST /api/auth/device/code
Generate a new device code pair to initiate the device authorization flow.

**Request:**
```json
{
  "clientInfo": {
    "deviceName": "My Application",
    "userAgent": "my-app/1.0.0",
    "tokenType": "pat"
  }
}
```

**Request Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `clientInfo` | object | No | Optional metadata about the client device |
| `clientInfo.deviceName` | string | No | Human-readable device/app name. Reaches the activation page, the sessions list and, for a `pat` credential, the name of the token row in the Access Tokens page (prefixed `Device: `) — treat it as untrusted, since `POST /api/auth/device/code` is unauthenticated |
| `clientInfo.userAgent` | string | No | Free-form client identifier (e.g. `my-cli/1.0.0`) |
| `clientInfo.tokenType` | `"session"` \| `"pat"` | No | Credential kind to mint when the device polls after approval (see the mint-on-poll note below). Defaults to `session` (a short-lived JWT + refresh token, the same behavior as before this field existed). `"pat"` mints a long-lived, revocable personal access token instead — see [Credential Kinds](#credential-kinds-session-vs-pat). An unrecognized value is rejected with `400`, not silently defaulted |

> **These are the only three fields the schema accepts** (`ClientInfoSchema` in
> `apps/api/src/device-auth/dto/device-code-request.dto.ts`). This document
> previously documented `clientInfo.name`, `clientInfo.version` and
> `clientInfo.platform`, none of which exist. That mistake was easy to miss in
> practice: the global `ZodValidationPipe` combined with zod's default
> unknown-key-stripping means a client sending those fields still gets a `200`
> — the unrecognized keys are silently discarded before anything is persisted,
> so nothing reaches `device_codes.client_info` and no error is ever raised.
> Double-check field names against the schema file above rather than this
> document's prose if the two ever disagree again.

**Response (200 OK):**
```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/activate",
    "verificationUriComplete": "http://localhost:3535/activate?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  }
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `deviceCode` | string | Opaque code for device polling (keep secret) |
| `userCode` | string | Human-readable code for user entry (8 chars, formatted XXXX-XXXX) |
| `verificationUri` | string | URL where user should authorize |
| `verificationUriComplete` | string | URL with user code pre-filled |
| `expiresIn` | number | Code lifetime in seconds (default: 900) |
| `interval` | number | Minimum polling interval in seconds (default: 5) |

---

#### POST /api/auth/device/token
Poll for authorization status and obtain tokens when approved.

**Request:**
```json
{
  "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4"
}
```

**Request Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deviceCode` | string | Yes | Device code from /auth/device/code |

**Response (200 OK - Authorized, `session` credential — no `clientInfo.tokenType` was sent, or it was `"session"`):**
```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
}
```

**Response (200 OK - Authorized, `pat` credential — `clientInfo.tokenType: "pat"` was sent):**
```json
{
  "data": {
    "accessToken": "pat_a1b2c3d4...",
    "tokenType": "Bearer",
    "expiresIn": 7776000,
    "credentialType": "pat",
    "expiresAt": "2026-11-28T12:00:00.000Z",
    "tokenId": "123e4567-e89b-12d3-a456-426614174000",
    "tokenName": "Device: My Application"
  }
}
```

Both shapes are the same `DeviceTokenResponseDto`; they differ only in which
optional fields are populated. See
[Credential Kinds](#credential-kinds-session-vs-pat) below for the full
discussion, but in short:

- **`tokenType` is always the literal `"Bearer"`, on both branches.** It
  describes how to present the credential (`Authorization: Bearer <token>`),
  not which kind it is.
- **`credentialType` is the discriminator.** It is present and equal to
  `"pat"` on the PAT branch, and absent on the session branch — never branch
  on `refreshToken === undefined` instead.
- **`refreshToken` exists only on the session branch.** A PAT has no refresh
  token by design.
- **`expiresAt`, `tokenId` and `tokenName` exist only on the PAT branch.**

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `accessToken` | string | The credential to present as `Authorization: Bearer <token>` — a signed JWT for `session`, an opaque `pat_...` string for `pat` |
| `refreshToken` | string | Refresh token for obtaining new access tokens. **Session only** |
| `tokenType` | string | Always `"Bearer"`, for both credential kinds |
| `expiresIn` | number | Token lifetime in seconds, relative to issuance |
| `credentialType` | `"pat"` | Present and equal to `"pat"` only when a personal access token was issued. **Absent** for the default session credential |
| `expiresAt` | string | Absolute (ISO-8601) expiry. **PAT only** |
| `tokenId` | string | Id of the issued PAT, for `DELETE /api/pat/{id}`. **PAT only** |
| `tokenName` | string | Display name of the issued PAT (`Device: <deviceName>`), as shown in the web UI's Access Tokens page. **PAT only** |

**Error Responses:**

See [Error Handling](#error-handling) section for detailed error codes and meanings.

---

### Authenticated Endpoints

All authenticated endpoints require a valid JWT access token in the Authorization header:
```
Authorization: Bearer <access_token>
```

#### GET /api/auth/device/activate
Get activation page information and optionally validate a user code.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | No | User verification code to validate |

**Request (No Code):**
```http
GET /api/auth/device/activate
Authorization: Bearer <token>
```

**Response (No Code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/activate"
  }
}
```

**Request (With Code):**
```http
GET /api/auth/device/activate?code=ABCD-1234
Authorization: Bearer <token>
```

**Response (With Code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/activate",
    "userCode": "ABCD-1234",
    "clientInfo": {
      "deviceName": "My CLI Tool",
      "userAgent": "my-cli/1.0.0"
    },
    "expiresAt": "2024-01-01T12:15:00.000Z"
  }
}
```

**Error Responses:**
- **404 Not Found** - Invalid user code
- **400 Bad Request** - Code has expired or already been processed

---

#### POST /api/auth/device/authorize
Approve or deny a device authorization request.

**Request:**
```json
{
  "userCode": "ABCD-1234",
  "approve": true
}
```

**Request Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userCode` | string | Yes | User code from the device |
| `approve` | boolean | Yes | true to approve, false to deny |

**Response (200 OK):**
```json
{
  "data": {
    "success": true,
    "message": "Device authorized successfully"
  }
}
```

**Error Responses:**
- **404 Not Found** - Invalid user code
- **400 Bad Request** - Code has expired or already been processed

---

#### GET /api/auth/device/sessions
List the current user's approved device sessions.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | No | 1 | Page number |
| `limit` | number | No | 10 | Page size |

**Request:**
```http
GET /api/auth/device/sessions?page=1&limit=10
Authorization: Bearer <token>
```

**Response:**
```json
{
  "data": {
    "sessions": [
      {
        "id": "uuid-1234",
        "userCode": "ABCD-1234",
        "status": "approved",
        "clientInfo": {
          "deviceName": "My CLI Tool",
          "userAgent": "my-cli/1.0.0"
        },
        "createdAt": "2024-01-01T12:00:00.000Z",
        "expiresAt": "2024-01-01T12:15:00.000Z"
      }
    ],
    "total": 5,
    "page": 1,
    "limit": 10
  }
}
```

---

#### DELETE /api/auth/device/sessions/:id
Revoke a specific device session.

**Parameters:**
- `id` (path) - Session ID to revoke

**Request:**
```http
DELETE /api/auth/device/sessions/uuid-1234
Authorization: Bearer <token>
```

**Response (200 OK):**
```json
{
  "data": {
    "success": true,
    "message": "Device session revoked successfully"
  }
}
```

**Error Responses:**
- **404 Not Found** - Session not found or doesn't belong to current user

---

### Credential Kinds: Session vs. PAT

A device chooses what kind of credential it wants when it requests the code, via
`clientInfo.tokenType`:

| | `session` (default) | `pat` |
|---|---|---|
| What it is | Signed JWT access token + refresh token | Opaque personal access token (`pat_...`) |
| Default lifetime | `DEVICE_TOKEN_EXPIRY_DAYS` (7 days) | `DEVICE_PAT_EXPIRY_DAYS` (90 days, clamped 1-999) |
| Refresh token | Yes | No |
| Revocable before expiry | No — a JWT is valid until it expires | Yes — `DELETE /api/pat/{id}`, or the Access Tokens page in the web UI |
| Used by | The browser-driven activation page (sends no `tokenType`) | CLI and other headless clients — see `apps/cli` |

The PAT lifetime can be much longer than the session lifetime precisely *because*
it is revocable server-side: a lost laptop is handled by deleting one row, with
nothing else to rotate. An out-of-range or non-numeric `DEVICE_PAT_EXPIRY_DAYS`
(outside 1-999) is rejected: the server logs a warning and falls back to the
90-day default rather than minting a token with an unpredictable or absurdly
long expiry.

**The PAT is minted on the poll (`POST /api/auth/device/token`), not on
approval (`POST /api/auth/device/authorize`).** Approval only records intent —
`status = approved` plus the approving user's id. This is deliberate: minting
at approval time would require stashing the raw token somewhere until the
device's next poll collects it, and a personal access token is designed to be
returned exactly once and stored only as a hash — writing it into another
column, even briefly, reintroduces a plaintext-credential-at-rest problem on a
table anyone can write a row into (`POST /auth/device/code` is public). Minting
on the poll means the raw token exists only in the API process's memory and in
the HTTPS response body, and it matches how the `session` credential has always
worked (tokens generated at poll time as well). See
[`apps/api/src/device-auth/README.md`](../apps/api/src/device-auth/README.md#why-the-pat-is-minted-on-the-poll-not-at-approval)
for the full security rationale, including why the PAT branch claims the
device code atomically before minting.

A device-issued PAT is named `Device: <deviceName>` so it's identifiable in the
Access Tokens list as device-flow-issued. `deviceName` arrives from an
unauthenticated caller, so it's sanitized (control characters, zero-width and
bidi-override characters stripped, truncated to 100 characters) before that
prefix is applied.

---

## Integration Guides

### CLI Application (Node.js)

```javascript
const axios = require('axios');

const API_BASE = 'http://localhost:3535/api';

async function loginWithDeviceFlow() {
  // Step 1: Request device code
  const codeResponse = await axios.post(`${API_BASE}/auth/device/code`, {
    clientInfo: {
      deviceName: 'My CLI Tool',
      userAgent: `my-cli/1.0.0 (${process.platform})`,
      // A real CLI would typically add `tokenType: 'pat'` here to get a
      // long-lived, revocable credential instead of a short session — see
      // Credential Kinds below and this repo's own `apps/cli` for the worked
      // example. Omitted here to keep this walkthrough on the session path.
    },
  });

  const { deviceCode, userCode, verificationUriComplete, interval } =
    codeResponse.data.data;

  // Step 2: Display instructions to user
  console.log('\nTo authorize this device:');
  console.log(`1. Visit: ${verificationUriComplete}`);
  console.log(`2. Enter code: ${userCode}`);
  console.log('\nWaiting for authorization...\n');

  // Step 3: Poll for token
  const pollInterval = interval * 1000; // Convert to milliseconds
  let authorized = false;

  while (!authorized) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    try {
      const tokenResponse = await axios.post(`${API_BASE}/auth/device/token`, {
        deviceCode,
      });

      // Success! Store tokens
      const { accessToken, refreshToken } = tokenResponse.data.data;
      console.log('✓ Authorized successfully!');

      // Save tokens to config file or environment
      saveTokens(accessToken, refreshToken);
      authorized = true;

    } catch (error) {
      const errorCode = error.response?.data?.error;

      if (errorCode === 'authorization_pending') {
        // Still waiting, continue polling
        process.stdout.write('.');
        continue;
      } else if (errorCode === 'slow_down') {
        // Increase polling interval
        console.log('\nSlowing down polling...');
        pollInterval += 1000;
      } else if (errorCode === 'expired_token') {
        console.error('\n✗ Code expired. Please try again.');
        process.exit(1);
      } else if (errorCode === 'access_denied') {
        console.error('\n✗ Authorization denied.');
        process.exit(1);
      } else {
        console.error('\n✗ Error:', error.message);
        process.exit(1);
      }
    }
  }
}

function saveTokens(accessToken, refreshToken) {
  // Save to config file, environment, or secure storage
  // Implementation depends on your application
}

// Run the login flow
loginWithDeviceFlow().catch(console.error);
```

---

### CLI Application (Python)

```python
import requests
import time
import sys

API_BASE = 'http://localhost:3535/api'

def login_with_device_flow():
    # Step 1: Request device code
    response = requests.post(f'{API_BASE}/auth/device/code', json={
        'clientInfo': {
            'deviceName': 'My Python CLI',
            'userAgent': f'my-python-cli/1.0.0 ({sys.platform})',
            # Add 'tokenType': 'pat' for a long-lived, revocable credential
            # instead of a short session — see Credential Kinds below.
        }
    })

    data = response.json()['data']
    device_code = data['deviceCode']
    user_code = data['userCode']
    verification_uri = data['verificationUriComplete']
    interval = data['interval']

    # Step 2: Display instructions
    print('\nTo authorize this device:')
    print(f'1. Visit: {verification_uri}')
    print(f'2. Enter code: {user_code}')
    print('\nWaiting for authorization...\n')

    # Step 3: Poll for token
    poll_interval = interval
    authorized = False

    while not authorized:
        time.sleep(poll_interval)

        try:
            token_response = requests.post(
                f'{API_BASE}/auth/device/token',
                json={'deviceCode': device_code}
            )

            # Success!
            tokens = token_response.json()['data']
            print('✓ Authorized successfully!')

            # Save tokens
            save_tokens(tokens['accessToken'], tokens['refreshToken'])
            authorized = True

        except requests.HTTPError as e:
            error_data = e.response.json()
            error_code = error_data.get('error')

            if error_code == 'authorization_pending':
                print('.', end='', flush=True)
                continue
            elif error_code == 'slow_down':
                print('\nSlowing down polling...')
                poll_interval += 1
            elif error_code == 'expired_token':
                print('\n✗ Code expired. Please try again.')
                sys.exit(1)
            elif error_code == 'access_denied':
                print('\n✗ Authorization denied.')
                sys.exit(1)
            else:
                print(f'\n✗ Error: {e}')
                sys.exit(1)

def save_tokens(access_token, refresh_token):
    # Save to config file or secure storage
    pass

# Run the login flow
if __name__ == '__main__':
    login_with_device_flow()
```

---

### API Reference (Scalar) Integration

`/api/docs` serves a [Scalar](https://scalar.com) reference, not Swagger UI. Landing on it while
already signed in authorizes it automatically — it exchanges your browser session for an access
token before the page mounts, so there's no manual token step in that case. See
[API.md § One-click session auth](API.md#one-click-session-auth) for how
that exchange works.

To authorize the reference with the device flow instead — e.g. from a signed-out browser or a
separate device:

1. **Request Device Code:** Call `POST /api/auth/device/code` (from the reference's built-in
   request client, curl, or any HTTP client)
2. **Copy User Code:** Note the `userCode` from the response
3. **Authorize in Browser:** Open the `verificationUriComplete` URL and sign in if prompted
4. **Enter Code:** Confirm the user code on the activation page
5. **Poll for Token:** Call `POST /api/auth/device/token` with the `deviceCode`
6. **Use Token:** Authorize the reference with the `accessToken` under the `JWT-auth` scheme
   (Scalar exposes a per-scheme token field; the document declares `JWT-auth` for session tokens
   and `PAT-auth` for personal access tokens)

**Alternative:** If you're already signed in through the browser, hand-creating a personal access
token (`POST /api/pat`) skips the polling loop entirely and is accepted on every authenticated
route (`PAT-auth`) — a reasonable shortcut for this one use case. That is different from what the
device flow itself can now do: a device that is *not* already browser-authenticated (a CLI, a
signed-out browser, a separate device) can ask the device flow to mint a PAT on its behalf by
sending `clientInfo.tokenType: "pat"` in step 1 — see [Credential Kinds](#credential-kinds-session-vs-pat)
below. `POST /api/pat` and the device flow's `pat` credential both end up as rows in the same
Access Tokens list; they differ only in how the token gets minted.

---

### Mobile Application

For React Native or native mobile apps:

```javascript
// React Native example
import React, { useState, useEffect } from 'react';
import { View, Text, Button, Linking } from 'react-native';
import axios from 'axios';

function DeviceAuthScreen() {
  const [userCode, setUserCode] = useState(null);
  const [verificationUri, setVerificationUri] = useState(null);
  const [deviceCode, setDeviceCode] = useState(null);

  useEffect(() => {
    initiateDeviceAuth();
  }, []);

  async function initiateDeviceAuth() {
    const response = await axios.post('http://localhost:3535/api/auth/device/code', {
      clientInfo: {
        deviceName: 'My Mobile App',
        userAgent: `my-mobile-app/1.0.0 (${Platform.OS})`,
      },
    });

    const { deviceCode, userCode, verificationUriComplete, interval } =
      response.data.data;

    setDeviceCode(deviceCode);
    setUserCode(userCode);
    setVerificationUri(verificationUriComplete);

    // Start polling
    pollForAuthorization(deviceCode, interval);
  }

  async function pollForAuthorization(deviceCode, interval) {
    const pollInterval = interval * 1000;

    const poll = async () => {
      try {
        const response = await axios.post('http://localhost:3535/api/auth/device/token', {
          deviceCode,
        });

        // Success! Save tokens and navigate to main app
        const { accessToken, refreshToken } = response.data.data;
        await saveTokens(accessToken, refreshToken);
        navigation.navigate('Home');

      } catch (error) {
        const errorCode = error.response?.data?.error;

        if (errorCode === 'authorization_pending') {
          // Continue polling
          setTimeout(poll, pollInterval);
        } else if (errorCode === 'slow_down') {
          // Increase interval
          setTimeout(poll, pollInterval + 1000);
        } else {
          // Handle error
          console.error('Auth error:', errorCode);
        }
      }
    };

    setTimeout(poll, pollInterval);
  }

  function openVerificationUri() {
    Linking.openURL(verificationUri);
  }

  return (
    <View>
      <Text>To authorize this app:</Text>
      <Text>1. Tap the button below to open your browser</Text>
      <Text>2. Enter this code: {userCode}</Text>
      <Button title="Open Browser" onPress={openVerificationUri} />
      <Text>Waiting for authorization...</Text>
    </View>
  );
}
```

---

## Configuration

### Environment Variables

Configure the device authorization flow in `infra/compose/.env`:

```bash
# Device Authorization Flow (RFC 8628)
DEVICE_CODE_EXPIRY_MINUTES=15
DEVICE_CODE_POLL_INTERVAL=5
DEVICE_TOKEN_EXPIRY_DAYS=7
DEVICE_PAT_EXPIRY_DAYS=90
```

**Variables:**

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DEVICE_CODE_EXPIRY_MINUTES` | number | 15 | How long device codes remain valid (minutes) |
| `DEVICE_CODE_POLL_INTERVAL` | number | 5 | Minimum time between polling requests (seconds) |
| `DEVICE_TOKEN_EXPIRY_DAYS` | number | 7 | Token lifetime for the `session` credential (both access and refresh tokens) |
| `DEVICE_PAT_EXPIRY_DAYS` | number | 90 | Lifetime of the `pat` credential minted when a device requests `clientInfo.tokenType: "pat"`. Clamped to 1-999; an out-of-range or non-numeric value logs a warning and falls back to 90 — see [Credential Kinds](#credential-kinds-session-vs-pat) |

### Configuration Notes

**Expiry Time:**
- **Too short** (< 5 minutes): Users may not have enough time to complete authorization
- **Too long** (> 30 minutes): Increases security risk if codes are leaked
- **Recommended:** 10-15 minutes for most use cases

**Poll Interval:**
- **Too short** (< 3 seconds): Unnecessary server load
- **Too long** (> 10 seconds): Poor user experience
- **Recommended:** 5 seconds for optimal balance

### Backend Configuration

Device auth configuration is loaded in `apps/api/src/config/configuration.ts`:

```typescript
deviceAuth: {
  expiryMinutes: parseInt(process.env.DEVICE_CODE_EXPIRY_MINUTES || '15', 10),
  pollInterval: parseInt(process.env.DEVICE_CODE_POLL_INTERVAL || '5', 10),
  tokenExpiryDays: parseInt(process.env.DEVICE_TOKEN_EXPIRY_DAYS || '7', 10),
  patExpiryDays: parseInt(process.env.DEVICE_PAT_EXPIRY_DAYS || '90', 10),
}
```

`patExpiryDays` is read and clamped by
`DeviceAuthService.resolvePatExpiryDays()`, not by the `configuration.ts`
loader itself — see [Credential Kinds](#credential-kinds-session-vs-pat) above.

---

## Device Session Management

Users can view and manage their authorized device sessions through the API.

### Viewing Active Sessions

```http
GET /api/auth/device/sessions?page=1&limit=10
Authorization: Bearer <token>
```

**Response shows:**
- User code for identification
- Client information (app name, version, platform)
- Authorization timestamp
- Expiration time

### Revoking a Session

If a device is lost or compromised, users can revoke access:

```http
DELETE /api/auth/device/sessions/{session_id}
Authorization: Bearer <token>
```

**Effect:**
- Session marked as denied
- Future token refresh attempts will fail
- User must re-authorize the device

### Session Lifecycle

1. **Pending**: Code generated, waiting for user authorization
2. **Approved**: User approved, device can obtain tokens (single use)
3. **Denied**: User denied or session revoked
4. **Expired**: Code expired before use or marked as used

**Note:** After a device obtains tokens using an approved code, the code is marked as expired (used). The device then uses refresh tokens for subsequent authentications.

**Token Lifetime:** This section describes the default `session` credential. It defaults to a 7-day lifetime (both access and refresh), configurable via `DEVICE_TOKEN_EXPIRY_DAYS`. This overrides the standard JWT TTL settings (`JWT_ACCESS_TTL_MINUTES` and `JWT_REFRESH_TTL_DAYS`) for sessions established through the device authorization flow. A device that instead requested a `pat` credential (`clientInfo.tokenType: "pat"`) gets a `DEVICE_PAT_EXPIRY_DAYS`-lifetime personal access token instead, which is revocable at any time via `DELETE /api/pat/{id}` rather than expiring on a fixed clock — see [Credential Kinds](#credential-kinds-session-vs-pat).

---

## Security Considerations

### Code Format
- **User codes** use only unambiguous characters (no 0/O, 1/I/l)
- 8 characters formatted as `XXXX-XXXX` for easy reading
- Character set: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`

### Code Hashing
- **Device codes** are hashed (SHA-256) before storage
- Only hashes stored in database, never plaintext
- Prevents code leakage from database compromise

### Rate Limiting
- **Per-device rate limiting** enforced on polling
- If device polls too frequently, returns `slow_down` error
- Prevents polling DoS attacks

### Expiration
- **Time-based expiration**: Default 15 minutes
- **Single-use codes**: Marked as expired after token issuance
- **Automatic cleanup**: Expired codes removed by scheduled task

### User Control
- **Explicit approval required**: Users must actively approve each device
- **Deny option**: Users can explicitly deny authorization
- **Session management**: Users can view and revoke device access
- **Audit trail**: All authorizations logged with user and device info

### Input Validation
- User codes normalized (uppercase, whitespace removed)
- Client info validated and sanitized
- Device codes validated format and length

### Database Security
- Device codes stored as SHA-256 hashes
- Foreign key constraints prevent orphaned records
- Indexes optimize lookup performance

---

## Error Handling

Device authorization uses standard OAuth 2.0 error codes as defined in RFC 8628.

### Error Response Format

```json
{
  "statusCode": 400,
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

### Error Codes

#### authorization_pending
**Status:** 400 Bad Request
**Meaning:** User has not yet authorized the device
**Action:** Continue polling at specified interval

```json
{
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

---

#### slow_down
**Status:** 400 Bad Request
**Meaning:** Device is polling too frequently
**Action:** Increase polling interval by at least 5 seconds

```json
{
  "error": "slow_down",
  "error_description": "Polling too frequently. Please slow down."
}
```

**Client Implementation:**
```javascript
if (error === 'slow_down') {
  pollInterval += 5000; // Add 5 seconds
}
```

---

#### expired_token
**Status:** 400 Bad Request
**Meaning:** Device code has expired
**Action:** Start a new device flow (request new code)

```json
{
  "error": "expired_token",
  "error_description": "The device code has expired"
}
```

---

#### access_denied
**Status:** 400 Bad Request
**Meaning:** User explicitly denied authorization
**Action:** Inform user and stop polling

```json
{
  "error": "access_denied",
  "error_description": "User denied the authorization request"
}
```

---

#### invalid_grant
**Status:** 401 Unauthorized
**Meaning:** Invalid device code provided
**Action:** Verify device code and restart flow if necessary

```json
{
  "error": "invalid_grant",
  "error_description": "Invalid device code"
}
```

---

### Error Handling Best Practices

**Polling Loop:**
```javascript
async function pollForToken(deviceCode, interval) {
  let pollInterval = interval * 1000;

  while (true) {
    await sleep(pollInterval);

    try {
      const tokens = await requestToken(deviceCode);
      return tokens; // Success!

    } catch (error) {
      switch (error.code) {
        case 'authorization_pending':
          // Continue polling
          continue;

        case 'slow_down':
          // Increase interval
          pollInterval += 5000;
          continue;

        case 'expired_token':
          throw new Error('Code expired. Please restart authentication.');

        case 'access_denied':
          throw new Error('Authorization denied by user.');

        default:
          throw new Error(`Unexpected error: ${error.message}`);
      }
    }
  }
}
```

**User Feedback:**
- Show "Waiting for authorization..." during `authorization_pending`
- Display error messages clearly for `expired_token` and `access_denied`
- Handle `slow_down` silently (no user notification needed)

---

## Troubleshooting

### "Invalid user code" (404 Not Found)

**Cause:** User entered wrong code or code doesn't exist

**Solutions:**
1. Verify the user code is entered correctly (case-insensitive)
2. Check that the code hasn't expired (15 minutes default)
3. Ensure database is seeded and running

---

### "This code has expired" (400 Bad Request)

**Cause:** More than 15 minutes (default) elapsed since code generation

**Solutions:**
1. Restart the device authorization flow
2. Increase `DEVICE_CODE_EXPIRY_MINUTES` if users need more time

---

### "This code has already been processed" (400 Bad Request)

**Cause:** Code already approved or denied by user

**Solutions:**
1. If approved: device should have received tokens
2. If denied: restart authorization flow
3. Don't attempt to reuse codes

---

### Polling Returns "slow_down" Repeatedly

**Cause:** Device polling too frequently

**Solutions:**
1. Respect the `interval` returned in the initial response
2. Increase polling interval when `slow_down` received
3. Check `DEVICE_CODE_POLL_INTERVAL` configuration

---

### Tokens Not Returned After Approval

**Possible Causes:**
1. Device stopped polling before approval completed
2. Network connectivity issues
3. User account disabled

**Solutions:**
1. Ensure continuous polling until success or explicit error
2. Check API logs for detailed error information
3. Verify user account is active

---

## Additional Resources

- **RFC 8628 Specification:** https://datatracker.ietf.org/doc/html/rfc8628
- **API Documentation:** http://localhost:3535/api/docs
- **Security Architecture:** [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md)
- **API Reference:** [API.md](API.md)
- **Authoritative schema & security rationale:** [`apps/api/src/device-auth/README.md`](../apps/api/src/device-auth/README.md)
- **Reference PAT-flow consumer:** [`apps/cli/README.md`](../apps/cli/README.md) — the first-party CLI (`appctl`), which logs in through this exact flow requesting a `pat` credential

---

## Summary

The Device Authorization Flow provides a secure, user-friendly way for input-constrained devices to obtain user authorization. Key features include:

- Standards-compliant RFC 8628 implementation
- Secure code generation and hashing
- Rate limiting and expiration protection
- User-friendly short codes (XXXX-XXXX format)
- Full session management capabilities
- Comprehensive error handling

For questions or issues, refer to the main documentation or contact the development team.
