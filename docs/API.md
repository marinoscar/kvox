# API Reference

## Base URL

- **Development**: http://localhost:3535/api
- **Production**: https://yourdomain.com/api

## Authentication

All endpoints require JWT Bearer token authentication unless explicitly marked as **Public**.

**Authorization Header:**
```
Authorization: Bearer <access_token>
```

Access tokens are short-lived (15 minutes by default). Use the refresh token flow to obtain new access tokens.

## Response Format

### Success Response

```json
{
  "data": <response_data>,
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

### Error Response

```json
{
  "statusCode": 400,
  "message": "Human readable error message",
  "error": "BadRequest"
}
```

For validation errors:
```json
{
  "statusCode": 400,
  "message": ["Field validation error 1", "Field validation error 2"],
  "error": "BadRequest"
}
```

## Pagination

Endpoints returning lists support pagination with the following query parameters:

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `page` | number | 1 | - | Page number (1-indexed) |
| `pageSize` | number | 20 | 100 | Items per page |

**Paginated Response Format:**
```json
{
  "data": [...],
  "meta": {
    "total": 150,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8
  }
}
```

---

## Endpoints

### Authentication

#### GET /auth/providers
**Public endpoint** - List enabled OAuth providers.

**Response:**
```json
{
  "data": {
    "providers": [
      {
        "name": "google",
        "enabled": true
      }
    ]
  }
}
```

---

#### GET /auth/google
**Public endpoint** - Initiate Google OAuth flow. Redirects to Google consent screen.

**Response:** HTTP 302 redirect to Google

---

#### GET /auth/google/callback
**Public endpoint** - OAuth callback handler (called by Google).

**Query Parameters:**
- `code` (string) - Authorization code from Google
- `state` (string, optional) - CSRF protection state

**Response:** HTTP 302 redirect to frontend with access token in query parameter
- Sets HttpOnly refresh token cookie
- Redirects to `/auth/callback?accessToken=<token>`

**Error Cases:**
- Email not in allowlist → Redirects to `/auth/error?error=not_authorized`
- OAuth failure → Redirects to `/auth/error?error=oauth_failed`

---

#### GET /auth/me
**Requires Authentication** - Get current user profile.

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "profileImageUrl": "/api/users/uuid/avatar/uuid",
  "providerProfileImageUrl": "https://lh3.googleusercontent.com/a/example",
  "hasUploadedProfileImage": false,
  "isActive": true,
  "roles": [
    {
      "id": "uuid",
      "name": "admin",
      "description": "Administrator with full access"
    }
  ],
  "permissions": ["users:read", "users:write", "system_settings:read", ...]
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `profileImageUrl` | string \| null | The picture representing the user, resolved from `profile.imageSource`: `null` for `none`, the provider picture for `provider`, or a same-origin `/api/users/:userId/avatar/:objectId` path for `upload`. May be an absolute URL or a root-relative path. |
| `providerProfileImageUrl` | string \| null | The OAuth provider's picture, regardless of the currently selected source; refreshed from the provider on each login. |
| `hasUploadedProfileImage` | boolean | Whether the caller has an uploaded picture stored (`profile.imageObjectId` is set), regardless of the currently selected source. To preview those bytes, fetch `GET /user-settings/profile-image` (bearer auth) rather than building a URL from this field. |

---

#### POST /auth/refresh
**Public endpoint** - Refresh access token using refresh token cookie.

**Request:** No body required (uses HttpOnly cookie)

**Response:**
```json
{
  "accessToken": "new_jwt_access_token",
  "expiresIn": 900
}
```

Sets new refresh token in HttpOnly cookie (token rotation).

**Error Cases:**
- 401 Unauthorized - Missing or invalid refresh token
- 403 Forbidden - User is disabled

---

#### POST /auth/logout
**Requires Authentication** - Logout and revoke refresh token.

**Request:** No body required

**Response:** HTTP 204 No Content
- Clears refresh token cookie
- Revokes refresh token in database

---

#### POST /auth/logout-all
**Requires Authentication** - Logout from all devices and revoke all refresh tokens.

**Request:** No body required

**Response:** HTTP 204 No Content
- Clears refresh token cookie
- Revokes ALL refresh tokens for the current user across all devices

**Use Case:** Security feature to force re-authentication on all sessions (e.g., after password change or suspected compromise).

---

### Device Authorization (RFC 8628)

The Device Authorization Flow enables input-constrained devices (CLI tools, IoT devices, Smart TVs) to obtain user authorization. See [DEVICE-AUTH.md](DEVICE-AUTH.md) for comprehensive guide and integration examples.

#### POST /auth/device/code
**Public endpoint** - Generate device code pair to initiate device authorization flow.

**Request Body:**
```json
{
  "clientInfo": {
    "name": "My CLI Tool",
    "version": "1.0.0",
    "platform": "linux"
  }
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `clientInfo` | object | No | Optional metadata about client device |
| `clientInfo.name` | string | No | Application name |
| `clientInfo.version` | string | No | Application version |
| `clientInfo.platform` | string | No | Platform identifier |

**Response:**
```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/device",
    "verificationUriComplete": "http://localhost:3535/device?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  }
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `deviceCode` | string | Opaque code for device polling (keep secret) |
| `userCode` | string | Human-readable code for user entry (XXXX-XXXX format) |
| `verificationUri` | string | URL where user should authorize |
| `verificationUriComplete` | string | URL with user code pre-filled |
| `expiresIn` | number | Code lifetime in seconds (default: 900) |
| `interval` | number | Minimum polling interval in seconds (default: 5) |

---

#### POST /auth/device/token
**Public endpoint** - Poll for authorization status and obtain tokens when approved.

**Request Body:**
```json
{
  "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4"
}
```

**Response (200 OK - Authorized):**
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

**Error Responses (400 Bad Request):**

While authorization is pending:
```json
{
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

Device polling too frequently:
```json
{
  "error": "slow_down",
  "error_description": "Polling too frequently. Please slow down."
}
```

Code has expired:
```json
{
  "error": "expired_token",
  "error_description": "The device code has expired"
}
```

User denied authorization:
```json
{
  "error": "access_denied",
  "error_description": "User denied the authorization request"
}
```

**Error Response (401 Unauthorized):**

Invalid device code:
```json
{
  "error": "invalid_grant",
  "error_description": "Invalid device code"
}
```

**Usage:**
1. Device requests code from `/auth/device/code`
2. Device displays `userCode` and `verificationUri` to user
3. Device polls this endpoint every `interval` seconds
4. User visits verification page and approves device
5. Polling returns tokens when approved

---

#### GET /auth/device/activate
**Requires Authentication** - Get activation page information and validate user code.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | No | User verification code to validate |

**Request (No Code):**
```http
GET /auth/device/activate
Authorization: Bearer <token>
```

**Response (No Code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/device"
  }
}
```

**Request (With Code):**
```http
GET /auth/device/activate?code=ABCD-1234
Authorization: Bearer <token>
```

**Response (With Valid Code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/device",
    "userCode": "ABCD-1234",
    "clientInfo": {
      "name": "My CLI Tool",
      "version": "1.0.0",
      "platform": "linux"
    },
    "expiresAt": "2024-01-01T12:15:00.000Z"
  }
}
```

**Error Cases:**
- 404 Not Found - Invalid user code
- 400 Bad Request - Code has expired or already been processed

---

#### POST /auth/device/authorize
**Requires Authentication** - Approve or deny device authorization request.

**Request Body:**
```json
{
  "userCode": "ABCD-1234",
  "approve": true
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userCode` | string | Yes | User code from the device |
| `approve` | boolean | Yes | true to approve, false to deny |

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device authorized successfully"
  }
}
```

**Error Cases:**
- 404 Not Found - Invalid user code
- 400 Bad Request - Code has expired or already been processed

---

#### GET /auth/device/sessions
**Requires Authentication** - List current user's approved device sessions.

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | No | 1 | Page number |
| `limit` | number | No | 10 | Items per page |

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
          "name": "My CLI Tool",
          "version": "1.0.0",
          "platform": "linux"
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

**Use Case:** View all devices that have been authorized to access the account.

---

#### DELETE /auth/device/sessions/:id
**Requires Authentication** - Revoke a specific device session.

**Parameters:**
- `id` (UUID) - Session ID to revoke

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device session revoked successfully"
  }
}
```

**Error Cases:**
- 404 Not Found - Session not found or doesn't belong to current user

**Use Case:** Revoke access for lost or compromised devices.

---

### Test Authentication (Development/Test Only)

**Security Notice:** These endpoints are completely disabled in production. They exist solely to enable automated E2E testing without requiring real OAuth credentials.

#### POST /auth/test/login
**Development/Test Only** - Authenticate as a test user without OAuth.

**Availability:** Only when `NODE_ENV !== 'production'`

**Request Body:**
```json
{
  "email": "test@test.local",
  "role": "admin",
  "displayName": "Test Admin"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Email address for test user |
| `role` | enum | No | Role to assign: `admin`, `contributor`, `viewer` (default: `viewer`) |
| `displayName` | string | No | Display name for the user |

**Response:** HTTP 302 redirect to `/auth/callback?token=<accessToken>&expiresIn=900`
- Sets HttpOnly refresh token cookie (same as OAuth flow)
- Creates user if not exists, assigns specified role

**Error Cases:**
- 403 Forbidden - Endpoint disabled (production environment)
- 400 Bad Request - Invalid email or role

**Use Case:** Playwright E2E tests use this endpoint to authenticate without Google OAuth.

---

### Users

**All user endpoints require Admin role (`users:read` or `users:write` permissions)**

#### GET /users
List all users with pagination and filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `search` | string | - | Search by email or display name |
| `isActive` | boolean | - | Filter by active status |
| `role` | string | - | Filter by role name |
| `sortBy` | enum | `createdAt` | Sort field: `email`, `createdAt`, `updatedAt` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "displayName": "John Doe",
      "profileImageUrl": "https://...",
      "providerDisplayName": "John Doe",
      "providerProfileImageUrl": "https://lh3.googleusercontent.com/...",
      "isActive": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "roles": [
        {
          "id": "uuid",
          "name": "contributor"
        }
      ]
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

**Note:** `providerDisplayName` and `providerProfileImageUrl` may be null if not available from OAuth provider. `profileImageUrl` is resolved from each user's settings the same way `GET /auth/me` resolves it (not a directly stored URL) — see the Settings section's `profile.imageSource` fields below.

---

#### GET /users/:id
Get user by ID.

**Parameters:**
- `id` (UUID) - User ID

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "profileImageUrl": "https://...",
  "providerDisplayName": "John Doe",
  "providerProfileImageUrl": "https://lh3.googleusercontent.com/...",
  "isActive": true,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "roles": [
    {
      "id": "uuid",
      "name": "contributor",
      "description": "Standard user capabilities"
    }
  ],
  "identities": [
    {
      "provider": "google",
      "providerEmail": "user@example.com"
    }
  ]
}
```

**Note:** `providerDisplayName` and `providerProfileImageUrl` may be null if not available from OAuth provider. `profileImageUrl` is resolved from the user's settings the same way `GET /auth/me` resolves it (not a directly stored URL) — see the Settings section's `profile.imageSource` fields below.

**Error Cases:**
- 404 Not Found - User not found

---

#### PATCH /users/:id
Update user properties (activation status, display name).

**Requires:** `users:write` permission

**Parameters:**
- `id` (UUID) - User ID

**Request Body:**
```json
{
  "isActive": false,
  "displayName": "New Name"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `isActive` | boolean | No | Activate or deactivate user |
| `displayName` | string | No | Update user's display name |

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "New Name",
  "isActive": false,
  "roles": [
    {
      "id": "uuid",
      "name": "viewer"
    }
  ]
}
```

**Error Cases:**
- 404 Not Found - User not found

---

#### PUT /users/:id/roles
Update user roles (replaces all current roles).

**Requires:** `rbac:manage` permission

**Parameters:**
- `id` (UUID) - User ID

**Request Body:**
```json
{
  "roleNames": ["admin", "contributor"]
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `roleNames` | string[] | Yes | Array of role names to assign (min: 1) |

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "displayName": "John Doe",
  "isActive": true,
  "roles": [
    {
      "id": "uuid",
      "name": "admin",
      "description": "Administrator with full access"
    },
    {
      "id": "uuid",
      "name": "contributor",
      "description": "Standard user capabilities"
    }
  ]
}
```

**Validation Rules:**
- Cannot remove own admin role (prevents accidental lockout)
- At least one role must be assigned
- Role names must exist in the system

**Error Cases:**
- 400 Bad Request - Invalid role names, empty array, or attempting to remove own admin role
- 401 Unauthorized - Not authenticated
- 403 Forbidden - Missing `rbac:manage` permission
- 404 Not Found - User not found

---

#### GET /users/:userId/avatar/:objectId
**Public endpoint** - no bearer token required or accepted (a plain `<img src>` cannot send one). Streams a user's uploaded profile picture.

**Parameters:**
- `userId` (UUID) - Owning user's ID
- `objectId` (UUID) - Storage object ID (from `profile.imageObjectId`)

**Response:** `200` with the raw image bytes, only while `objectId` is exactly the user's *currently selected* uploaded avatar (`profile.imageSource === "upload" && profile.imageObjectId === objectId`, the underlying storage object still `ready`, owned by that user, under the `avatars/<userId>/` key prefix, and a validated avatar mime type).

**Response Headers:**
| Header | Value |
|--------|-------|
| `Content-Type` | The detected image type (from magic bytes at upload time, never client-declared) |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Disposition` | `inline` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` |
| `Cache-Control` | `private, max-age=86400` |
| `Content-Length` | The image size, when known |

**Error Cases:**
- 404 Not Found - Every failure case returns an identical 404 ("Not found"): malformed UUID, unknown user, wrong/stale `objectId`, a deselected avatar, or missing bytes. This is deliberate — an identical response for every failure prevents using this endpoint to enumerate users or objects.

**Note:** Deleting the avatar object via the generic `DELETE /storage/objects/:id` also makes this endpoint 404 for it. Subject to the app's maintenance-mode gate like other public routes.

---

### Allowlist

**All allowlist endpoints require Admin role (`allowlist:read` or `allowlist:write` permissions)**

The allowlist restricts application access to pre-authorized email addresses. Users must have their email in the allowlist before they can complete OAuth login.

#### GET /allowlist
List allowlisted emails with pagination, filtering, and sorting.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `search` | string | - | Search by email |
| `status` | enum | `all` | Filter by status: `all`, `pending`, `claimed` |
| `sortBy` | enum | `addedAt` | Sort by: `email`, `addedAt`, `claimedAt` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "addedBy": {
        "id": "uuid",
        "email": "admin@example.com"
      },
      "addedAt": "2024-01-01T00:00:00.000Z",
      "claimedBy": {
        "id": "uuid",
        "email": "user@example.com",
        "displayName": "John Doe"
      },
      "claimedAt": "2024-01-02T00:00:00.000Z",
      "notes": "New team member"
    },
    {
      "id": "uuid",
      "email": "pending@example.com",
      "addedBy": {
        "id": "uuid",
        "email": "admin@example.com"
      },
      "addedAt": "2024-01-03T00:00:00.000Z",
      "claimedBy": null,
      "claimedAt": null,
      "notes": null
    }
  ],
  "meta": {
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "totalPages": 5
  }
}
```

**Note:** `addedBy` object contains only `id` and `email` (no `displayName`). `claimedBy` object contains `id`, `email`, and `displayName` when not null.

**Status Filters:**
- `all` - All allowlist entries
- `pending` - Emails not yet claimed by a user (claimedBy is null)
- `claimed` - Emails claimed by registered users (claimedBy is not null)

---

#### POST /allowlist
Add email to allowlist.

**Requires:** `allowlist:write` permission

**Request Body:**
```json
{
  "email": "newuser@example.com",
  "notes": "Marketing team member - starts next week"
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Valid email address (case-insensitive) |
| `notes` | string | No | Optional notes about this user |

**Response:**
```json
{
  "id": "uuid",
  "email": "newuser@example.com",
  "addedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "addedAt": "2024-01-01T00:00:00.000Z",
  "claimedBy": null,
  "claimedAt": null,
  "notes": "Marketing team member - starts next week"
}
```

**Note:** `addedBy` object contains only `id` and `email` (no `displayName`).

**Error Cases:**
- 409 Conflict - Email already exists in allowlist
- 400 Bad Request - Invalid email format

---

#### DELETE /allowlist/:id
Remove email from allowlist.

**Requires:** `allowlist:write` permission

**Parameters:**
- `id` (UUID) - Allowlist entry ID

**Response:** HTTP 204 No Content

**Error Cases:**
- 404 Not Found - Allowlist entry not found
- 400 Bad Request - Cannot remove entry that has been claimed by a user

**Note:** Entries that have been claimed (user has logged in) cannot be removed. This prevents accidentally removing access for existing users.

---

### Settings

#### GET /user-settings
**Requires Authentication** - Get current user's settings.

**Response:**
```json
{
  "theme": "light",
  "profile": {
    "displayName": "John Doe",
    "imageSource": "provider",
    "imageObjectId": null
  },
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "version": 1
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `theme` | enum | UI theme: `light`, `dark`, `system` |
| `profile.displayName` | string \| null | User's display name override (optional, max 100 chars) |
| `profile.imageSource` | enum | Which picture represents the user: `none`, `provider` (OAuth sign-in provider's picture), or `upload` (a picture uploaded via `POST /user-settings/profile-image`) |
| `profile.imageObjectId` | string \| null | The uploaded avatar's storage object ID; present only when relevant, `null` when no avatar has been uploaded/selected |
| `updatedAt` | string | ISO 8601 timestamp of last update |
| `version` | number | Version number for optimistic concurrency control |

**Note:** Rows written before this shape existed carried `useProviderImage`/`customImageUrl` instead; they are normalized to the shape above on every read (`useProviderImage === false` becomes `imageSource: "none"`, anything else becomes `provider`) rather than by a data migration.

---

#### PUT /user-settings
**Requires Authentication** - Replace all user settings.

**Request Body:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "Jane Doe",
    "imageSource": "upload",
    "imageObjectId": "0b6f1c2e-7a53-4a8e-9d0c-2f6a1e9b7c11"
  }
}
```

**Response:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "Jane Doe",
    "imageSource": "upload",
    "imageObjectId": "0b6f1c2e-7a53-4a8e-9d0c-2f6a1e9b7c11"
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "version": 2
}
```

**Note:** This replaces the entire settings object. Use PATCH for partial updates. Omitting `profile.imageObjectId` keeps the currently stored value (never orphans an uploaded avatar); an explicit `null` clears it. Switching to `none`/`provider` while an `imageObjectId` is present keeps it stored, so switching back to `upload` later doesn't require re-uploading.

**Error Cases:**
- 400 Bad Request - `profile.imageSource: "upload"` with no resolvable `imageObjectId` (after the keep/clear logic above): `"profile.imageSource \"upload\" requires profile.imageObjectId. Upload a picture with POST /api/user-settings/profile-image first."`
- 400 Bad Request - `profile.imageObjectId` does not reference an avatar object the caller uploaded: `"profile.imageObjectId must reference a profile image you uploaded with POST /api/user-settings/profile-image."`

---

#### PATCH /user-settings
**Requires Authentication** - Partially update user settings.

**Request Body:**
```json
{
  "theme": "dark"
}
```

**Request Headers (Optional):**
```
If-Match: 1
```

**Response:**
```json
{
  "theme": "dark",
  "profile": {
    "displayName": "John Doe",
    "imageSource": "provider",
    "imageObjectId": null
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "version": 2
}
```

**Optimistic Concurrency Control:**
- Include `If-Match: <version>` header to ensure settings haven't been modified by another request
- Returns **409 Conflict** if version mismatch detected
- Prevents lost updates in concurrent scenarios

**Note:** This performs a shallow merge with existing settings, using JSON Merge Patch semantics for `profile.imageObjectId`: an explicit `null` clears it, an absent field leaves it untouched.

**Error Cases:**
- 400 Bad Request - Same `profile.imageSource`/`profile.imageObjectId` validation as `PUT /user-settings` above.
- 409 Conflict - `If-Match` version mismatch.

---

#### GET /user-settings/profile-image
**Requires:** `user_settings:read` permission (bearer auth)

Streams the caller's own stored uploaded picture (`profile.imageObjectId`), whatever `profile.imageSource` currently selects. Unlike the public `GET /users/:userId/avatar/:objectId` route above, this ignores the selected source — it exists so a settings UI can preview the "upload" option while "none" or "provider" is the active selection, without loosening the public route to do it. Because the caller's identity comes from the authenticated principal rather than a URL parameter, this route can safely be broader: it can only ever serve the caller's own picture.

**Response:** `200` with the raw image bytes of the caller's stored upload.

**Response Headers:**
| Header | Value |
|--------|-------|
| `Content-Type` | The detected image type (from magic bytes at upload time, never client-declared) |
| `Content-Length` | The image size, when known |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Disposition` | `inline` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` |
| `Cache-Control` | `private, no-store` |

**Error Cases:**
- 404 Not Found - No picture is uploaded, the stored object is not a valid avatar of the caller, or the bytes are unavailable.

**Note:** See also `GET /users/:userId/avatar/:objectId` above, which serves only the currently selected picture and requires no auth.

---

#### POST /user-settings/profile-image
**Requires:** `user_settings:write` permission

Upload a profile picture. Multipart/form-data with a single field named `file`.

**Request:** `multipart/form-data`
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | JPEG, PNG, GIF or WebP image, ≤5MB |

The image type is validated by **magic bytes only** — the declared MIME type and filename are ignored. On success the object is stored at `avatars/<userId>/<uuid>.<ext>` as an already-`ready` `storage_objects` row with `metadata.purpose: "avatar"`, `profile.imageSource` is set to `"upload"`, `profile.imageObjectId` is set to the new object, and the previously uploaded avatar object (if different) is best-effort deleted.

**Response:** `200`
```json
{
  "data": {
    "settings": {
      "theme": "dark",
      "profile": {
        "displayName": "Jane Doe",
        "imageSource": "upload",
        "imageObjectId": "0b6f1c2e-7a53-4a8e-9d0c-2f6a1e9b7c11"
      },
      "updatedAt": "2024-01-01T12:00:00.000Z",
      "version": 3
    },
    "profileImageUrl": "/api/users/uuid/avatar/0b6f1c2e-7a53-4a8e-9d0c-2f6a1e9b7c11"
  }
}
```
`profileImageUrl` is resolved the same way `GET /auth/me` resolves it.

**Error Cases:**
- 400 Bad Request - Missing or wrong field name (must be `file`)
- 400 Bad Request - `"Unsupported image type. Upload a JPEG, PNG, GIF or WebP image."` (includes SVG, which is rejected outright)
- 413 Payload Too Large - File exceeds 5MB (`AVATAR_MAX_BYTES`), mapped to error code `PAYLOAD_TOO_LARGE`

**Audit Event:** `user_settings:profile_image:upload` (meta includes `objectId`, `size`, `mimeType`, `previousObjectId`)

---

#### DELETE /user-settings/profile-image
**Requires:** `user_settings:write` permission

Deletes the uploaded avatar object (if any) and clears `profile.imageObjectId`. If `imageSource` was `"upload"` it falls back to `"provider"` (never back to `"none"`). Idempotent — calling it with no avatar stored just returns the current state, no error.

**Response:** `200`, same response shape as `POST /user-settings/profile-image` above.

**Audit Event:** `user_settings:profile_image:delete`

---

#### GET /system-settings
**Requires:** `system_settings:read` permission (Admin only)

Get system-wide settings. The `ui` and `features` namespaces were removed as
unused by issue #366 — nothing at runtime ever read either one. The stored
value now models exactly five namespaces: `notifications`, `jobs`, `nodes`,
`databaseBackup` and `maintenance`, plus the computed `security` block.

**Response:**
```json
{
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "notifications": {
    "browserEnabled": true,
    "disabledEvents": []
  },
  "jobs": {
    "history": {
      "retentionDays": 30,
      "purgeEnabled": true
    },
    "stuckThresholdMinutes": 30
  },
  "nodes": {
    "staleHeartbeatSeconds": 90,
    "offlineStaleMultiplier": 4,
    "offlineRetentionDays": 30,
    "jobSecretBrokerEnabled": false
  },
  "databaseBackup": {
    "enabled": false,
    "frequency": "daily",
    "dayOfWeek": 0,
    "dayOfMonth": 1,
    "timeOfDay": "02:00",
    "timezone": "UTC",
    "retentionCount": 7,
    "storageProvider": "s3",
    "runStaleMinutes": 120,
    "compressionLevel": 6,
    "restoreRollbackMode": "retain_database",
    "oldDatabaseRetentionHours": 48,
    "nodeOffloadEnabled": false
  },
  "maintenance": {
    "enabled": false,
    "message": "This service is temporarily unavailable for scheduled maintenance. Please try again shortly.",
    "allowAdmins": true,
    "startedAt": null,
    "startedById": null
  },
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 1
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `security.jwtAccessTtlMinutes` | number | **Read-only.** JWT access token TTL in minutes, read from the `JWT_ACCESS_TTL_MINUTES` deploy-time environment variable — not stored settings, and not writable through this API |
| `security.refreshTtlDays` | number | **Read-only.** Refresh token TTL in days, read from the `JWT_REFRESH_TTL_DAYS` deploy-time environment variable — not stored settings, and not writable through this API |
| `notifications.browserEnabled` | boolean | Whether browser notifications are enabled deployment-wide. **Enforced** (issue #226): when `false`, the `browser` channel is dropped from `GET /notifications/events`'s advertised channels, from the dispatcher's channel resolution, and from delivery — the SSE stream's `toast` field is set to `false`. Mandatory events (e.g. `security.role_changed`) are the one exception: their channel list is never filtered and the `notifications` row is always written; only the browser toast is suppressed for them |
| `notifications.disabledEvents` | string[] | Notification event keys (e.g. `security.role_changed`, from the notification event registry) suppressed deployment-wide, regardless of per-user preference. Max 100 entries. **Enforced** (issue #226) the same way as `browserEnabled` above — including the same mandatory-event exception |
| `jobs.history.retentionDays` / `jobs.history.purgeEnabled` | number / boolean | How long completed job history is kept, and whether the purge cron runs at all |
| `jobs.stuckThresholdMinutes` | number | How long a claimed job may go without progress before the lease reaper treats it as abandoned |
| `nodes.staleHeartbeatSeconds` / `nodes.offlineStaleMultiplier` / `nodes.offlineRetentionDays` | number | Worker-node fleet health thresholds — see `docs/specs/worker-nodes.md` |
| `nodes.jobSecretBrokerEnabled` | boolean | Whether a worker node may be issued short-lived, job-scoped database credentials at all (epic #345). Default off |
| `databaseBackup.*` | — | Backup schedule and retention policy — see `GET /admin/db-backup/config` and `docs/specs/database-backup.md` |
| `maintenance.*` | — | Maintenance-window state — see `GET /admin/maintenance` and `docs/specs/maintenance-mode.md` |
| `updatedAt` | string | ISO 8601 timestamp of last update |
| `updatedBy` | object | User who last updated settings |
| `version` | number | Version number for optimistic concurrency control |

`GET /notifications/config` exposes just the `browserEnabled` half of this
policy, plus the Web Push half added by #229/#230/#355 —
`{ browserEnabled, pushEnabled, vapidPublicKey }` — to any authenticated
user, with no `system_settings:read` requirement, since a non-admin (e.g. a
viewer) cannot call `GET /system-settings` directly but still needs to know
whether notifications are enabled deployment-wide. `pushEnabled` reflects
whether an active VAPID key pair is currently configured (admin UI or
environment fallback — see `docs/runbooks/vapid-keys.md`), and
`vapidPublicKey` carries that key pair's public half when one is active, so
the web client can pass it to `pushManager.subscribe()` (issue #365; see
`docs/specs/browser-notifications.md` Section 12). Both are `false`/`null`
only when no VAPID configuration is active, not unconditionally.
`disabledEvents` is deliberately not exposed here — per-event suppression
travels with each event as the stream's `toast` flag instead.

---

#### PUT /system-settings
**Requires:** `system_settings:write` permission (Admin only)

Replace all system settings.

**Request Body:**
```json
{
  "notifications": {
    "browserEnabled": true,
    "disabledEvents": []
  }
}
```

`security` is not part of the request body — it is a read-only, server-derived
block (see the GET fields table above). Sending it is not an error; the global
`ZodValidationPipe` silently strips unknown keys, so it has no effect.
`notifications` IS required in the PUT body — omitting it returns
**400 VALIDATION_ERROR** rather than resetting it, because the value that
would be reset is an operator's decision to turn a delivery channel off for
everyone. `jobs`, `nodes`, `databaseBackup` and `maintenance` are each
optional in the PUT body: omitting one leaves it at its stored value rather
than resetting it to the default (see `SystemSettingsService.replaceSettings`).

**Response:**
```json
{
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "notifications": {
    "browserEnabled": true,
    "disabledEvents": []
  },
  "jobs": {
    "history": {
      "retentionDays": 30,
      "purgeEnabled": true
    },
    "stuckThresholdMinutes": 30
  },
  "nodes": {
    "staleHeartbeatSeconds": 90,
    "offlineStaleMultiplier": 4,
    "offlineRetentionDays": 30,
    "jobSecretBrokerEnabled": false
  },
  "databaseBackup": {
    "enabled": false,
    "frequency": "daily",
    "dayOfWeek": 0,
    "dayOfMonth": 1,
    "timeOfDay": "02:00",
    "timezone": "UTC",
    "retentionCount": 7,
    "storageProvider": "s3",
    "runStaleMinutes": 120,
    "compressionLevel": 6,
    "restoreRollbackMode": "retain_database",
    "oldDatabaseRetentionHours": 48,
    "nodeOffloadEnabled": false
  },
  "maintenance": {
    "enabled": false,
    "message": "This service is temporarily unavailable for scheduled maintenance. Please try again shortly.",
    "allowAdmins": true,
    "startedAt": null,
    "startedById": null
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 2
}
```

---

#### PATCH /system-settings
**Requires:** `system_settings:write` permission (Admin only)

Partially update system settings.

**Request Body:**
```json
{
  "jobs": {
    "stuckThresholdMinutes": 45
  }
}
```

Or, to suppress one notification event without touching anything else:
```json
{
  "notifications": {
    "disabledEvents": ["security.role_changed"]
  }
}
```

Every namespace (`notifications`, `jobs`, `nodes`, `databaseBackup`,
`maintenance`) is optional in PATCH, and merges field by field — sending one
field of one namespace leaves every other field, in every other namespace, at
its stored value. `notifications.disabledEvents`, when sent, REPLACES the
stored array wholesale rather than merging entries; send `disabledEvents: []`
to lift every suppression.

**Request Headers (Optional):**
```
If-Match: 1
```

**Response:**
```json
{
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "notifications": {
    "browserEnabled": true,
    "disabledEvents": []
  },
  "jobs": {
    "history": {
      "retentionDays": 30,
      "purgeEnabled": true
    },
    "stuckThresholdMinutes": 45
  },
  "nodes": {
    "staleHeartbeatSeconds": 90,
    "offlineStaleMultiplier": 4,
    "offlineRetentionDays": 30,
    "jobSecretBrokerEnabled": false
  },
  "databaseBackup": {
    "enabled": false,
    "frequency": "daily",
    "dayOfWeek": 0,
    "dayOfMonth": 1,
    "timeOfDay": "02:00",
    "timezone": "UTC",
    "retentionCount": 7,
    "storageProvider": "s3",
    "runStaleMinutes": 120,
    "compressionLevel": 6,
    "restoreRollbackMode": "retain_database",
    "oldDatabaseRetentionHours": 48,
    "nodeOffloadEnabled": false
  },
  "maintenance": {
    "enabled": false,
    "message": "This service is temporarily unavailable for scheduled maintenance. Please try again shortly.",
    "allowAdmins": true,
    "startedAt": null,
    "startedById": null
  },
  "updatedAt": "2024-01-01T12:00:00.000Z",
  "updatedBy": {
    "id": "uuid",
    "email": "admin@example.com"
  },
  "version": 2
}
```

**Optimistic Concurrency Control:**
- Include `If-Match: <version>` header to ensure settings haven't been modified by another request
- Returns **409 Conflict** if version mismatch detected
- Prevents lost updates when multiple admins modify settings concurrently

---

### Storage Objects

The storage system provides file upload and management capabilities with support for large files (GB scale) through resumable multipart uploads.

#### Initialize Resumable Upload

`POST /api/storage/objects/upload/init`

**Requires Authentication** - Initialize a multipart upload for large files. Returns presigned URLs for direct-to-S3 uploads.

**Request Body:**
```json
{
  "name": "document.pdf",
  "size": 104857600,
  "mimeType": "application/pdf"
}
```

`mimeType` is **optional**. A browser reports an empty string for `.amr`, and
`application/octet-stream` or nothing at all for `.m4a` on several Android
builds; when the declared type is generic or absent it is resolved from the
file extension (`.m4a .mp3 .wav .flac .ogg .opus .aac .amr .webm .wma .mp4
.m4b .3gp .aiff .aif .caf .wv`) and the resolved type is what gets stored.

**Response:**
```json
{
  "data": {
    "objectId": "uuid",
    "uploadId": "s3-upload-id",
    "partSize": 10485760,
    "totalParts": 10,
    "presignedUrls": [
      { "partNumber": 1, "url": "https://..." },
      { "partNumber": 2, "url": "https://..." }
    ]
  }
}
```

**`partSize` is chosen per upload, and it is not always the configured
default.** S3 allows at most 10,000 parts, so for a large file the part size is
raised to `max(configured, ceil(size / 10000))`, rounded up to a whole MiB — a
1 TB object simply uses bigger parts rather than being rejected. Slice the file
with exactly the `partSize` returned here; it is stored on the object and
replayed by the status endpoint so a resume slices it the same way.

**`presignedUrls` is the first batch, not the whole upload.** At most ten URLs
come back, as a fast path for a small file. Ask
`POST /api/storage/objects/:id/upload/parts` for the rest, in batches, as you
go — signed URLs expire (`SIGNED_URL_EXPIRY`, one hour by default) and a
multi-GB upload outlives its own first batch.

**Error Cases:**
- 400 Bad Request - File exceeds `MAX_FILE_SIZE`; the message names the actual
  limit and the actual size
- 400 Bad Request - Content type is not in `ALLOWED_MIME_TYPES` (default
  `image/*,application/pdf,video/*,audio/*`) and no known audio extension
  rescues it; the message names the type that was rejected

  ⚠ **This is the generic-upload allowlist only.** `POST /api/transcripts`
  (issue #79) does **not** route its content-type check through
  `ALLOWED_MIME_TYPES` — it enforces its own, fixed `audio/*,video/*` list
  regardless of what an operator has configured here, for the reason given
  under `### Transcripts` below. A 400 from a transcript upload never names
  this setting.

---

#### Sign More Upload Part URLs

`POST /api/storage/objects/:id/upload/parts`

**Requires Authentication** and `storage:write` - Issue signed `PUT` URLs for a
further batch of parts of an in-progress upload. Each call also marks the
upload as still active, which is what keeps it out of the stale-upload sweep
(see `STORAGE_STALE_UPLOAD_HOURS`).

**Request Body:**
```json
{
  "partNumbers": [11, 12, 13]
}
```

At most **100** part numbers per call. Each must be an integer in
`1..totalParts` for this upload, and duplicates are rejected.

**Response:**
```json
{
  "data": {
    "parts": [
      {
        "partNumber": 11,
        "url": "https://...",
        "expiresAt": "2024-01-01T01:00:00.000Z"
      }
    ]
  }
}
```

`expiresAt` is when to come back for a fresh batch rather than discovering the
expiry as a 403 part-way through a file.

**Error Cases:**
- 400 Bad Request - More than 100 part numbers, a duplicate, a part number
  outside `1..totalParts`, or an upload that is no longer `pending`/`uploading`
- 403 Forbidden - Caller does not own the upload, or lacks `storage:write`
- 404 Not Found - Upload not found

---

#### Get Upload Status

`GET /api/storage/objects/:id/upload/status`

**Requires Authentication** - Check progress of an in-progress upload, and the
endpoint a resuming client asks first.

**Response:**
```json
{
  "data": {
    "objectId": "uuid",
    "status": "uploading",
    "uploadedParts": [1, 2, 4],
    "totalParts": 10,
    "partSize": 10485760,
    "uploadedBytes": "31457280",
    "totalBytes": "104857600"
  }
}
```

`uploadedParts` is read from the **storage provider**, not from this
application's own records: it is the list of parts the bucket is actually
holding, so the gaps in it are exactly the parts a resuming client must
re-upload. `partSize` is the size this upload was initialised with — use it,
not your own default, or the resumed parts will contain the wrong bytes.

`uploadedBytes` and `totalBytes` are **strings**; a byte count at this scale
loses precision as a JSON number.

Polling this endpoint also refreshes the upload's activity timestamp, so an
upload a client is watching is never swept away as abandoned.

---

#### Complete Upload

`POST /api/storage/objects/:id/upload/complete`

**Requires Authentication** - Finalize multipart upload after all parts are uploaded.

**Request Body:**
```json
{
  "parts": [
    { "partNumber": 1, "eTag": "\"etag1\"" },
    { "partNumber": 2, "eTag": "\"etag2\"" }
  ]
}
```

**`parts` is optional, and a browser should omit it:**

```json
{}
```

Omitted, the server reads the uploaded parts back from the storage provider
itself. The ETag of a part is a response header on a cross-origin `PUT`, which
a page cannot read unless the bucket lists it in `Access-Control-Expose-Headers`
— so a client that gets its CORS configuration slightly wrong completes the
upload with null ETags and corrupts the object. Supply `parts` only from a
non-browser client that already has the ETags and would rather avoid the extra
`ListParts` call.

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 104857600,
    "mimeType": "application/pdf",
    "status": "processing"
  }
}
```

---

#### Abort Upload

`DELETE /api/storage/objects/:id/upload/abort`

**Requires Authentication** - Cancel an in-progress upload and clean up resources.

**Response:** HTTP 204 No Content

---

#### Simple Upload

`POST /api/storage/objects`

**Requires Authentication** - Direct upload for small files (< 100MB) using multipart/form-data.

**Request:**
- Content-Type: `multipart/form-data`
- Body: File attached as form data with key `file`

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 1048576,
    "mimeType": "application/pdf",
    "status": "uploading"
  }
}
```

---

#### List Objects

`GET /api/storage/objects`

**Requires Authentication** - List storage objects with pagination and filtering.

Objects **managed by another module** (a transcript's source audio, its
playback rendition, its exports) are excluded from this list. They belong to
the feature that created them, not to a generic file browser; that module
lists its own.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `status` | enum | - | Filter by status: `pending`, `uploading`, `processing`, `ready`, `failed` |
| `sortBy` | enum | `createdAt` | Sort field: `createdAt`, `name`, `size` |
| `sortOrder` | enum | `desc` | Sort order: `asc`, `desc` |

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "document.pdf",
      "size": 104857600,
      "mimeType": "application/pdf",
      "status": "ready",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "pageSize": 20,
    "totalPages": 3
  }
}
```

---

#### Get Object

`GET /api/storage/objects/:id`

**Requires Authentication** - Get storage object metadata.

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "size": 104857600,
    "mimeType": "application/pdf",
    "status": "ready",
    "metadata": {
      "customField": "value"
    },
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

#### Get Download URL

`GET /api/storage/objects/:id/download`

**Requires Authentication** - Get a signed download URL for the object.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `expiresIn` | number | 3600 | URL expiration in seconds |

**Response:**
```json
{
  "data": {
    "url": "https://s3.amazonaws.com/...",
    "expiresAt": "2024-01-01T01:00:00.000Z"
  }
}
```

---

#### Delete Object

`DELETE /api/storage/objects/:id`

**Requires Authentication** - Delete a storage object and its associated file.
If the object's resumable upload never completed (`s3UploadId` set, status
`pending`/`uploading`), the multipart upload is aborted first, freeing its
uploaded parts, before the row is deleted (issue #101). An abort that fails
for a reason other than the upload already being gone leaves the object in
place so the stale-upload sweep can retry it later, rather than deleting the
row and losing the only record of the upload to abort.

**Response:** HTTP 204 No Content

**Error Cases:**
- 404 Not Found - Object not found
- 403 Forbidden - User does not own object (non-admin)
- **409 Conflict** - The object is managed by another module and must be
  deleted through that module. The message names the module. This is 409 and
  not 403 on purpose: the caller genuinely owns the bytes, and the refusal is
  about the object's state — something else depends on it. Reading, downloading
  and editing the metadata of a managed object all remain available to its
  owner; only listing and deleting change.

---

#### Update Metadata

`PATCH /api/storage/objects/:id/metadata`

**Requires Authentication** - Update custom metadata for an object.

**Request Body:**
```json
{
  "metadata": {
    "customField": "value",
    "tags": ["document", "important"]
  }
}
```

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "name": "document.pdf",
    "metadata": {
      "customField": "value",
      "tags": ["document", "important"]
    },
    "updatedAt": "2024-01-01T12:00:00.000Z"
  }
}
```

---

### Jobs (Background Queue)

**All routes require Admin role, split `jobs:read` (the four reads below) / `jobs:write` (the four writes)** — see [`docs/specs/job-queue.md`](specs/job-queue.md) for the queue's design (the atomic `FOR UPDATE SKIP LOCKED` claim, retry/rate-limit budgets, the lease reaper) and rejected alternatives; this section documents only the request/response contract.

Every literal route below (`stats`, `insights`, `insights/reset-history`, `retry-failed`, `reset-stuck`) is matched before `:id` — Nest matches in declaration order, and reordering would make e.g. `POST /admin/jobs/reset-stuck` a 400 malformed-UUID error instead of running the sweep.

#### GET /admin/jobs/stats
Queue summary: totals, a per-status and per-type breakdown, how many pending jobs are in backoff, and how many running jobs the lease reaper would reclaim right now. Cached in-process for ~2 seconds.

**Response:**
```json
{
  "data": {
    "total": 1024,
    "byStatus": { "pending": 12, "running": 3, "succeeded": 990, "failed": 19 },
    "byType": [
      { "type": "example.checksum", "label": "Example: Checksum", "total": 500, "byStatus": { "pending": 2, "running": 1, "succeeded": 490, "failed": 7 } }
    ],
    "scheduled": 4,
    "stuckRunning": 0,
    "stuckThresholdMinutes": 30,
    "generatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Note:** `byStatus` keys are always present, zero included — "no failures" and "the key is missing" are the same thing on the wire. `stuckRunning` is counted with the reaper's own predicate against `stuckThresholdMinutes`, so this number and what `reset-stuck` would touch can never disagree.

---

#### GET /admin/jobs/insights?windowDays=
Throughput and completion estimates the summary cannot answer: duration percentiles over a bounded window (default 7 days, max 90), a per-type ETA, and all-time totals merged from `job_stats_rollup`. Computed on demand from pure `SELECT`s — no snapshot table, no background refresh.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `windowDays` | number | 7 | 1–90. Rejected with 400 if out of range, not silently clamped. |

**Response (abridged):**
```json
{
  "data": {
    "windowDays": 7,
    "generatedAt": "2024-01-01T00:00:00.000Z",
    "concurrency": 2,
    "live": { "total": 15, "byStatus": { "...": "..." }, "byType": ["..."], "scheduled": 4, "rateLimited": 0, "retried": 1 },
    "history": {
      "windowStart": "2023-12-25T00:00:00.000Z",
      "throughputSince": "2023-12-31T23:00:00.000Z",
      "overall": { "samples": 490, "avgMs": 820, "p50Ms": 700, "p95Ms": 2100, "throughputPerMin": 3.2 },
      "byType": ["..."]
    },
    "eta": [
      { "type": "example.checksum", "label": "Example: Checksum", "pending": 2, "running": 1, "remaining": 3, "avgMs": 820, "basis": "live", "estimatedMs": 1230 }
    ],
    "lifetime": [
      { "type": "example.checksum", "label": "Example: Checksum", "succeeded": 5400, "failed": 22, "total": 5422, "avgMs": 810, "durationSamples": 5400 }
    ]
  }
}
```

**Note:** `avgMs`/`p50Ms`/`p95Ms` are `null`, never `0`, when a type has no succeeded jobs in the window — `0` would be multiplied into an ETA and turn "no data" into "already done". `basis` says where an ETA's average came from: `live` (this type's own history), `partial` (the overall average, borrowed), or `none` (a shipped constant placeholder). `lifetime` has counts and averages only — percentiles cannot be reconstructed from purged rows.

**Error Cases:**
- 400 Bad Request - `windowDays` out of range

---

#### POST /admin/jobs/insights/reset-history
Deletes every `job_stats_rollup` row (one per job type) and returns how many were removed. Live job rows are untouched — no job is deleted or changes state. On the write side despite touching no job, because a corrupted or fictional rollup is otherwise unrecoverable: the rows that would disprove it were already purged.

**Response:**
```json
{ "data": { "reset": 4 } }
```

---

#### POST /admin/jobs/retry-failed
Moves failed jobs back to `pending` with attempt and rate-limit budgets reset. Idempotent, capped at 500 rows per call.

**Request Body:**
```json
{ "type": "example.checksum" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No | Restrict the sweep to one job type. Omitted retries every failed job. |

**Response:**
```json
{ "data": { "retried": 42, "skipped": 3, "remaining": 0 } }
```

**Note:** `skipped` counts jobs whose deduplication key is already held by a pending/running job — the work it describes is already queued.

---

#### POST /admin/jobs/reset-stuck
Runs the lease reaper on demand: running jobs whose claim aged out, or whose lease expired, are requeued; those that have spent their attempt budget are permanently failed.

**Request Body (optional, empty body allowed):**
```json
{ "olderThanMinutes": 45 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `olderThanMinutes` | number | No | Overrides the `jobs.stuckThresholdMinutes` system setting for this call only. |

**Response:**
```json
{ "data": { "requeued": 1, "failed": 0, "thresholdMinutes": 30 } }
```

---

#### GET /admin/jobs
List jobs, newest first, filterable and paginated. Payloads are **not** included (unbounded JSONB in a paginated list is the shape that cannot be made safe — see the spec).

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `status` | enum | - | `pending`, `running`, `succeeded`, `failed` |
| `type` | string | - | Exact job type |
| `subjectType` / `subjectId` | string | - | What the job is about |
| `scheduled` | `'true'`\|`'false'` | - | `true` selects pending jobs in backoff and **overrides** `status` |
| `processedWithin` | enum | - | Filters on `finishedAt` (falling back to `createdAt`) |

**Response:**
```json
{
  "data": {
    "items": [
      {
        "id": "uuid",
        "type": "example.checksum",
        "typeLabel": "Example: Checksum",
        "subjectType": "storage_object",
        "subjectId": "uuid",
        "dedupKey": null,
        "status": "succeeded",
        "reason": "upload",
        "priority": 0,
        "providerKey": null,
        "modelVersion": null,
        "attempts": 1,
        "lastError": null,
        "createdAt": "2024-01-01T00:00:00.000Z",
        "startedAt": "2024-01-01T00:00:01.000Z",
        "finishedAt": "2024-01-01T00:00:02.000Z",
        "scheduledFor": null,
        "rateLimitedAt": null,
        "rateLimitHits": 0,
        "claimedByNodeId": null,
        "leaseExpiresAt": null,
        "executor": "server"
      }
    ],
    "total": 1024,
    "page": 1,
    "pageSize": 20,
    "totalPages": 52
  }
}
```

**Note:** `attempts` counts attempts **started**, charged at claim time — never 0 for a job that has run at least once.

---

#### POST /admin/jobs/:id/retry
Resets one job to `pending` with its attempt count, error, schedule and claim all cleared.

**Parameters:** `id` (UUID)

**Response:** the job, in the shape above.

**Error Cases:**
- 400 Bad Request - The job is `running` and cannot be retried (use `reset-stuck` if its executor is gone)
- 404 Not Found - Job not found
- 409 Conflict - Another pending/running job already holds this job's deduplication key

---

#### DELETE /admin/jobs/:id
Deletes the row.

**Parameters:** `id` (UUID)

**Response:** HTTP 204 No Content

**Error Cases:**
- 400 Bad Request - The job is `running` and cannot be deleted
- 404 Not Found - Job not found

---

### Worker Nodes

Distributed execution for node-eligible job types. See [`docs/specs/worker-nodes.md`](specs/worker-nodes.md) for the control/data-plane split, the lease, and why `nodes:*` is a permission pair separate from `jobs:*`. Three route groups, each with a different caller and a different blast radius.

#### `/api/nodes/*` — what a node talks to

**`nodes:read`** for the two GETs, **`nodes:write`** for everything else. Reachable by a `nod_…` node credential (the *only* path prefix that credential family can reach — `JwtAuthGuard`'s allowlist) or by a session/PAT holding `nodes:*`; every route is scoped to the caller's own nodes.

##### POST /nodes/register
Register, or reattach to, this machine's row. Idempotent on `(owner, name)` — registering an existing name refreshes hostname, platform, CLI version, eligible types and concurrency rather than creating a second row. Always **200**, never 201 — `reattached` in the body says which happened, so a client never branches on status code to learn it.

**Request Body:**
```json
{
  "name": "worker-1",
  "hostname": "worker-1.local",
  "platform": "linux-x64",
  "cliVersion": "1.2.0",
  "eligibleTypes": ["example.checksum"],
  "concurrency": 4
}
```

**Response:**
```json
{
  "data": {
    "node": {
      "id": "uuid",
      "name": "worker-1",
      "hostname": "worker-1.local",
      "platform": "linux-x64",
      "cliVersion": "1.2.0",
      "eligibleTypes": ["example.checksum"],
      "concurrency": 4,
      "status": "online",
      "capabilities": null,
      "registeredAt": "2024-01-01T00:00:00.000Z",
      "lastHeartbeatAt": null
    },
    "reattached": false
  }
}
```

---

##### GET /nodes/job-types
Every node-eligible job type (both `nodeResultSchema` and `persistNodeResult` present on the handler), each with its result contract as JSON Schema — generated from the server's own Zod definition, never a hand-copied one.

**Response:**
```json
{ "data": { "types": [{ "type": "example.checksum", "resultSchema": { "type": "object", "...": "..." } }] } }
```

---

##### GET /nodes
List the caller's own nodes. **Response:** `{ "data": [ <node>, ... ] }` — plain array, not paginated.

##### GET /nodes/:id
One node the caller owns. 404 if it does not exist.

##### POST /nodes/:id/deregister
Marks `offline`. Deliberately does **not** requeue jobs the node holds — nothing proves a shutting-down process actually stopped. Held jobs return through the lease reaper once their lease expires.

##### POST /nodes/:id/heartbeat
Liveness, plus an optional live refresh of `capabilities`/`concurrency`/`status` (`online`/`offline` only — `draining`/`disabled` are operator-only and a heartbeat can never clear either).

##### POST /nodes/:id/claim
Claims up to the node's `concurrency` runnable jobs under a server-derived lease, through the same atomic claim the in-process worker uses. Requested `types` are intersected with the node's registered `eligibleTypes` (a node may narrow, never widen). A `draining` node gets an empty list; a `disabled` one gets 403.

**Request Body:**
```json
{ "types": ["example.checksum"], "limit": 4 }
```

**Response:**
```json
{
  "data": {
    "jobs": [
      {
        "job": { "id": "uuid", "type": "example.checksum", "subjectType": "storage_object", "subjectId": "uuid", "priority": 0, "attempts": 1, "startedAt": "2024-01-01T00:00:00.000Z", "leaseExpiresAt": "2024-01-01T00:10:00.000Z" },
        "params": { "objectId": "uuid" }
      }
    ]
  }
}
```

**Note:** An empty `jobs` array is the common, non-error answer. Presigned data-plane URLs are **not** included here — see `download-url`/`upload-url` below; minting them at claim time would spend a short expiry on the wrong clock.

##### POST /nodes/:id/jobs/:jobId/renew
Extends the lease by the server's lease interval. `409` once the lease has already expired.

##### POST /nodes/:id/jobs/:jobId/download-url
Signed **GET** for the job's input object, fetched directly from the storage provider — bytes never pass through this API. `409` on an expired lease; `422` when the job names no resolvable input (permanent — report `failure`, do not retry).

##### POST /nodes/:id/jobs/:jobId/upload-url
Signed **PUT** for one whole object, plus **the key the server chose** — a node-supplied `key` is refused with 400 (a signed PUT is an unconditional overwrite; a node-chosen key is a write primitive over the whole bucket).

##### POST /nodes/:id/jobs/:jobId/secret
Issues the one short-lived, job-scoped credential this job's type declares it needs (epic #345, issue #349) — e.g. the PostgreSQL role `db.backup.run` needs to run `pg_dump`. Bounded by the job's own lease (never a second clock of its own), returned **once**, and revoked when the job settles or by the periodic sweep. Send an empty body — any field is refused with `400`. Re-callable while the lease is live: the same grant is extended, never a second one issued.

**Response:** `material`'s shape is the broker's own business, passed through uninterpreted — discrete fields, deliberately never a single DSN string (a `postgresql://user:pass@host/db` is one accidental log line from a leaked password).
```json
{
  "data": {
    "kind": "postgres.readonly",
    "expiresAt": "2024-01-01T00:10:00.000Z",
    "material": { "driver": "postgresql", "host": "db.internal", "port": 5432, "database": "appdb", "user": "appjob_ab12cd34_x7k2", "password": "...", "sslMode": "require" }
  }
}
```

**Error Cases:**
- 400 Bad Request - The request body carried a field a node may not set (send an empty body)
- 403 Forbidden - This deployment does not issue per-job credentials at all (`nodes.jobSecretBrokerEnabled` is off)
- 404 Not Found - This job's type declares no secret broker (will not change on a retry)
- 409 Conflict - The lease has already expired; drop the work
- 503 Service Unavailable - The broker exists but cannot mint a credential right now, carrying an operator-facing `remedy` in `details` (a database that cannot grant `CREATEROLE` is the ordinary case — see [`docs/runbooks/node-job-secrets.md`](runbooks/node-job-secrets.md))

##### POST /nodes/:id/jobs/:jobId/result
Submits a result, validated against the handler's `nodeResultSchema` and persisted through `persistNodeResult`. `400` on a type mismatch, a non-node-persistable type, or a schema failure; `409` on an expired lease (nothing persisted); `500` if persisting threw (the server already settled the job through its own failure path — do not resubmit).

**Response:**
```json
{ "data": { "jobId": "uuid", "outcome": "succeeded", "willRetry": false } }
```

##### POST /nodes/:id/jobs/:jobId/failure
Reports a failure through the same terminal state machine a thrown error in `process()` uses. `rateLimited: true` defers rather than charging an attempt.

**Request Body:**
```json
{ "error": "provider returned 429", "rateLimited": true, "retryAfterMs": 30000 }
```

**Response:** same `JobSettlementResponseDto` shape as `result` above. `willRetry` in the response is the **server's** decision — a `willRetry` sent in the request is advisory only.

---

#### `/api/node-credentials` — minting and revoking worker credentials

Deliberately **unreachable by a `nod_` credential itself** — only a session or `pat_` token — so a leaked node token can never mint another one. `nodes:write` for create/revoke, `nodes:read` for the list (not a bare `@Auth()` the way `GET /api/pat` is: this is fleet inventory, an operational question about the deployment, not a private one about the caller).

##### POST /node-credentials
Mints a `nod_…` credential and returns it **in full, exactly once**.

**Request Body:**
```json
{ "name": "worker-1 prod credential", "expiresInDays": 90 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | 1–100 characters |
| `expiresInDays` | number | No | 1–3650. Omitted means **never expires** — the intended default for an unattended node; revocation, not a clock, is the control. |

**Response:**
```json
{
  "data": {
    "token": "nod_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "id": "uuid",
    "name": "worker-1 prod credential",
    "tokenPrefix": "nod_1a2b",
    "expiresAt": null,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

##### GET /node-credentials
Lists the caller's own credentials, masked (`tokenPrefix` only — never the token, never the stored hash). **Response:** `{ "data": [ <credential, minus token>, ... ] }`.

##### DELETE /node-credentials/:id
Revokes a credential. Takes effect on the node's very next request — nothing cached, no TTL. **Response:** HTTP 204. `404` for not found, not yours, or already revoked (deliberately indistinguishable).

---

#### `/api/admin/nodes/*` — the whole fleet (Admin-only)

`nodes:read` for the three reads, `nodes:write` for the two deletes. Mounted on a **different prefix** than `/api/nodes` so it sits outside the `nod_` allowlist by construction — these routes expose another operator's email and can delete anyone's node or credential. The `credentials` literals are matched before `:id` (Nest declaration order) — see the spec for why.

##### GET /admin/nodes
Every node in the deployment, with owner and per-status job counts. **Response:** `{ "data": [ <node + owner + jobCounts + health>, ... ] }`.

**Note:** `status` is operator state; `health` (`healthy`/`stale`/`offline`) is **derived** from `lastHeartbeatAt` at read time, never stored — read the two together, not one instead of the other.

##### GET /admin/nodes/:id
One node, whoever owns it. 404 if none; never 403 — an administrator's scope is the whole deployment.

##### DELETE /admin/nodes/:id
Deletes the node record. Jobs are **not** deleted — `claimedByNodeId` is cleared and the lease reaper picks them up normally. Does **not** revoke the node's credential (the same token could register a new node).

##### GET /admin/nodes/credentials
Every node credential in the deployment, with its owner. Revoked credentials are included (`revokedAt` set) — part of the audit trail.

##### DELETE /admin/nodes/credentials/:id
Revokes any credential, whoever owns it. `404` if already revoked.

---

### Maintenance

**No dedicated permission** — this is a system setting (`system_settings:read`/`system_settings:write`), stored in the `maintenance` namespace. See [`docs/specs/maintenance-mode.md`](specs/maintenance-mode.md) and [`docs/runbooks/maintenance-mode.md`](runbooks/maintenance-mode.md). Both routes are exempt from the maintenance guard itself (`@AllowDuringMaintenance()`), so the switch that turns a window off is always reachable — `@Auth()` still applies underneath.

#### GET /admin/maintenance
Effective state, plus each contributing layer (`env`, `memory`, `persisted`) so an operator can see which one is deciding the answer.

**Requires:** `system_settings:read`

**Response:**
```json
{
  "data": {
    "enabled": false,
    "message": "This service is temporarily unavailable for scheduled maintenance. Please try again shortly.",
    "allowAdmins": true,
    "startedAt": null,
    "startedById": null,
    "source": "persisted",
    "layers": {
      "env": { "present": false, "enabled": null },
      "memory": { "present": false, "override": null },
      "persisted": { "readable": true, "value": { "enabled": false, "message": "...", "allowAdmins": true, "startedAt": null, "startedById": null } }
    }
  }
}
```

#### PUT /admin/maintenance
Opens or closes the window. Writes the persisted `maintenance` namespace and records an audit event; opening stamps `startedAt`/`startedById`, closing clears both. An environment override (`MAINTENANCE_MODE`), if present, still outranks whatever this writes — check `source` in the response.

**Requires:** `system_settings:write`

**Request Body:**
```json
{ "enabled": true, "message": "Deploying a database migration.", "allowAdmins": true }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | The only required field. |
| `message` | string | No | Omitted keeps whatever message is stored. |
| `allowAdmins` | boolean | No | ⚠ `false` locks administrators out too — the break-glass is `MAINTENANCE_MODE=false` in the environment, not this endpoint. |

**Response:** same shape as `GET` above, reflecting the write.

**Error Cases:**
- 400 Bad Request - Validation error

---

### About (Admin-only)

What is deployed here (issue #124, epic #118). One read-only route reporting the deployment record the CLI wrote at deploy time, plus what only the running process and a live database connection can answer. Gated on `system_settings:read` — **deliberately not a permission of its own** (epic #118 decision 8): "what is deployed here" is an administrator's configuration read, and the web card at `/admin/settings/about` (#126) carries this exact string per the Settings UI Pattern rule 3. Not exempt from the maintenance window — it is an admin page, and administrators bypass the window already unless `allowAdmins` is `false`.

**This endpoint never performs network I/O.** The container has neither the git checkout nor a GitHub credential, and an admin page must not make an outbound call on every load. `updateAvailable` and `checkedAt` are derived from the `remote` block the CLI last recorded (the deploy CLI, `deploy update --check` / `status`), never from a call made here.

#### GET /admin/about
**Requires:** `system_settings:read`

Reads `deploy-info/info.json` (the path in `DEPLOY_INFO_PATH`, default `/app/deploy-info/info.json`, bind-mounted read-only by the CLI) **on every request**, so rewriting the file takes effect on the next response with no restart. **Always answers 200**: the local dev stack and CI have no such file and must still render the page; an operator diagnosing a broken database is the person who most needs the rest of it.

**Response:**
```json
{
  "data": {
    "deployInfo": {
      "schema": 1,
      "app": { "name": "example-app", "version": "1.4.0", "commitSha": "3f2a9c1d…", "ref": "main", "repoUrl": "https://github.com/example-org/example-app" },
      "installedAt": "2026-08-01T09:15:00.000Z",
      "updatedAt": "2026-09-14T22:41:07.000Z",
      "lastCommand": "update",
      "deployedBy": { "cli": "example-cli", "version": "1.4.0" },
      "domain": "app.example.com",
      "bindPort": 3535,
      "host": { "hostname": "vps-01", "os": "Ubuntu 24.04.1 LTS", "kernel": "6.8.0-45-generic", "arch": "x64", "cpuModel": "AMD EPYC 7B13", "cpus": 4, "memoryBytes": 8323072000, "diskBytes": 80530636800, "dockerVersion": "27.1.1", "composeVersion": "2.29.1", "nodeVersion": "22.11.0" },
      "remote": { "sha": "9b8c7d6e…", "commitsBehind": 2, "checkedAt": "2026-09-15T06:00:00.000Z" }
    },
    "deployInfoStatus": "ok",
    "detail": null,
    "runtime": {
      "apiVersion": "1.4.0",
      "nodeVersion": "v22.11.0",
      "processStartedAt": "2026-09-14T22:41:30.000Z",
      "uptimeSeconds": 43110,
      "serverTimeUtc": "2026-09-15T10:40:00.000Z",
      "environment": "production"
    },
    "database": {
      "serverVersion": "PostgreSQL 16.4 (Debian 16.4-1.pgdg120+1) on x86_64-pc-linux-gnu, …",
      "appliedMigrations": 42,
      "lastMigrationName": "20260901120000_add_note_exports",
      "lastMigrationAt": "2026-09-14T22:41:12.000Z"
    },
    "databaseError": null,
    "updateAvailable": true,
    "checkedAt": "2026-09-15T06:00:00.000Z"
  }
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `deployInfo` | object \| null | The file as written by the CLI, parsed. Every field inside is nullable (the CLI's best effort at deploy time), objects are `.passthrough()` so a newer CLI's extra fields ride through, and any key matching `password`/`secret`/`key`/`token` (case-insensitive, at any depth) is stripped before it is relayed. `null` unless `deployInfoStatus` is `ok`. |
| `deployInfoStatus` | `ok` \| `absent` \| `unreadable` \| `invalid` | `absent`: no file at the path — the ordinary state outside a CLI deploy. `unreadable`: the file exists but could not be read or is not JSON (a torn write; the next request reads the finished file). `invalid`: JSON, but not this schema. |
| `detail` | string \| null | The read/parse message when the status is not `ok`. |
| `runtime` | object | `apiVersion` (`APP_VERSION`, else the npm version, else `package.json`), `nodeVersion`, `processStartedAt`, `uptimeSeconds`, `serverTimeUtc` (always `Z`-suffixed — the clock every other timestamp is compared against), `environment` (`NODE_ENV`). |
| `database` | object \| null | `serverVersion` (`SELECT version()` verbatim), `appliedMigrations` (rows in `_prisma_migrations` with `finished_at` set), `lastMigrationName`, `lastMigrationAt`. `null` with `databaseError` set when the query fails — the route still answers 200. |
| `databaseError` | string \| null | Why `database` is null, when it is. |
| `updateAvailable` | boolean \| null | `remote.commitsBehind > 0`. **`null` means unknown, not "no"** — the CLI has never run a remote check. Derived here so the web card and the terminal agree. |
| `checkedAt` | string \| null | `remote.checkedAt`, passed through; `null` until the CLI has checked. |

Every timestamp is ISO-8601 UTC.

**Error Cases:**
- 401 Unauthorized - Missing or invalid token
- 403 Forbidden - Caller lacks `system_settings:read`

---

### Database Backup (Admin-only)

Three permissions: `db_backup:read` (config read, list, single get, download), `db_backup:write` (config write, manual trigger, cancel, delete), and `db_backup:restore` — **deliberately separate from `db_backup:write`** — for restore and rollback. See [`docs/specs/database-backup.md`](specs/database-backup.md) and [`docs/specs/database-restore.md`](specs/database-restore.md) for the streaming/verification contract, the pre-flight gates, and the rejected alternatives; this section documents only the request/response contract. Literal routes (`config`, `runs`) are matched before `runs/:id`.

#### GET /admin/db-backup/node-credential-preflight
Whether a worker node can be handed a short-lived, SELECT-only database credential to take a backup (epic #345). Two independent facts, never conflated: `outcome` is the **capability** — a live probe of whether this database can grant `CREATEROLE` — and `brokerEnabled` is the **policy** (`nodes.jobSecretBrokerEnabled`). ⚠ `outcome: "guided"` is a **200**, never a 4xx — a managed PostgreSQL denying `CREATEROLE` is the ordinary case, not a failure, and the response carries paste-ready SQL an operator runs once to grant it. See [`docs/runbooks/node-job-secrets.md`](runbooks/node-job-secrets.md).

**Requires:** `db_backup:read`

**Response (`outcome: "guided"`):** `outcome` is the capability (can this deployment's role mint at all, right now), `brokerEnabled` is the policy (`nodes.jobSecretBrokerEnabled`) — an operator can face either independently of the other. `guidance` is present only when `outcome` is `"guided"`.
```json
{
  "data": {
    "outcome": "guided",
    "kind": "postgres.readonly",
    "databaseRole": "app_user",
    "targetDatabase": "appdb",
    "brokerEnabled": false,
    "detail": "The database role this API connects as cannot grant roles (CREATEROLE); run the SQL below once to allow it.",
    "guidance": { "reason": "current role lacks CREATEROLE", "commands": "ALTER ROLE app_user CREATEROLE;", "runbook": "docs/runbooks/node-job-secrets.md" }
  }
}
```

---

#### GET /admin/db-backup/config
The stored `databaseBackup` settings namespace plus two fields computed on every read: `nextRunAt` (projected in UTC by the same function the scheduler uses; `null` when disabled, also `null` — with a 200, not an error — when the stored timezone can't be resolved) and `activeRunId` (a display value only, never a pre-flight check — the partial unique index is the real arbiter of "is one already running").

**Requires:** `db_backup:read`

**Response:**
```json
{
  "data": {
    "enabled": true,
    "frequency": "daily",
    "dayOfWeek": 0,
    "dayOfMonth": 1,
    "timeOfDay": "03:00",
    "timezone": "UTC",
    "retentionCount": 14,
    "storageProvider": "s3",
    "runStaleMinutes": 120,
    "compressionLevel": 6,
    "restoreRollbackMode": "retain_database",
    "oldDatabaseRetentionHours": 72,
    "nextRunAt": "2024-01-02T03:00:00.000Z",
    "activeRunId": null
  }
}
```

#### PUT /admin/db-backup/config
Partial update — every field optional; unknown timezone is refused with 400 **at save time**, before anything is written.

**Requires:** `db_backup:write`

**Request Body:** any subset of the fields in the `GET` response above (excluding the two computed ones).

**Response:** the config, in the shape above.

---

#### POST /admin/db-backup/runs
Takes a backup now (`trigger: 'manual'`). Returns as soon as the run row is created — the dump streams in the background.

**Requires:** `db_backup:write`

**Response:**
```json
{ "data": { "id": "uuid", "status": "running", "trigger": "manual", "startedAt": "2024-01-01T00:00:00.000Z", "...": "..." } }
```

**Error Cases:**
- 409 Conflict - A run is already active (`details.activeRunId`)

---

#### GET /admin/db-backup/runs
Paginated, newest first.

**Requires:** `db_backup:read`

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `status` | enum | - | `pending`, `running`, `completed`, `failed`, `stale` |
| `trigger` | enum | - | `manual`, `scheduled`, `pre_restore` |

**Response:**
```json
{
  "data": {
    "items": [
      {
        "id": "uuid",
        "status": "completed",
        "trigger": "scheduled",
        "startedAt": "2024-01-01T03:00:00.000Z",
        "finishedAt": "2024-01-01T03:04:12.000Z",
        "sizeBytes": "1073741824",
        "bytesWritten": "1073741824",
        "storageKey": "backups/2024-01-01T03-00-00.dump",
        "error": null,
        "restoreStatus": null,
        "restoreError": null,
        "restoredAt": null,
        "restoredById": null,
        "restoreScratchDb": null,
        "restoreOldDb": null,
        "swappedAt": null,
        "preRestoreBackupId": null
      }
    ],
    "total": 30,
    "page": 1,
    "pageSize": 20,
    "totalPages": 2
  }
}
```

**Note:** `sizeBytes`/`bytesWritten` are published as **decimal strings**, not numbers — both are `BigInt` columns (a dump can exceed 2 GiB, well past a 32-bit column and past `Number`'s safe-integer precision), so a JSON number would silently lose precision above 2^53. `restoreStatus` and its sibling columns are `null` until a restore is started against this run (#286); poll them via `GET runs/{id}` while `restoreStatus` cycles `restoring` → `verifying` → `swapping` → `completed`/`failed`.

---

#### GET /admin/db-backup/runs/:id
One run, same shape as above — for progress polling.

**Requires:** `db_backup:read`

#### GET /admin/db-backup/runs/:id/download
A short-lived signed URL for the archive.

**Requires:** `db_backup:read` (a read, despite being the single most powerful thing on this controller — its short expiry, not a fourth permission, is what makes that acceptable)

**Response:**
```json
{ "data": { "url": "https://...", "expiresIn": 300 } }
```

#### DELETE /admin/db-backup/runs/:id
Deletes the object, then the row.

**Requires:** `db_backup:write`

**Response:** `{ "data": { "objectDeleted": true } }` — `false` (row still deleted) when the object was already gone.

#### POST /admin/db-backup/runs/:id/cancel
Cancels a running backup.

**Requires:** `db_backup:write`

**Response:** `{ "data": { "result": "signalled" } }` — or `"not_running_here"` when this process is not the one holding the run (another API replica is).

**Error Cases:**
- 400 Bad Request - The run has already settled

---

#### POST /admin/db-backup/runs/:id/restore
Restores the database from this backup. **The status code is not the answer — `mode` is; all three normal outcomes are 200.**

**Requires:** `db_backup:restore` (not `db_backup:write` — a deliberately separate grant; see above)

**Request Body:**
```json
{ "confirmation": "RESTORE" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confirmation` | literal `"RESTORE"` | Yes | Checked by the global validation pipe before any handler code runs. A missing/wrong value is a 400 that starts **nothing** — no lookup, no probe, no download. |
| `overrideSchemaCheck` | boolean | No (default `false`) | Proceeds past a schema-compatibility mismatch. Set only after reading a `blocked` response's `preflight.archiveMigration`/`liveMigration`. |

**Response — `mode: "running"`:** the gates passed and the restore is under way in the background (it takes hours — poll `GET runs/{id}`, watching `restoreStatus`).
```json
{ "data": { "mode": "running", "runId": "uuid", "scratchDatabase": "app_restore_scratch", "oldDatabase": "app_old_20240101", "preflight": { "...": "..." } } }
```

**Response — `mode: "guided"`:** a capability gate failed (e.g. managed PostgreSQL denying `CREATEDB`). Not an error — the deliverable is a paste-ready command block for a human to run by hand.
```json
{ "data": { "mode": "guided", "runId": "uuid", "guidance": { "reason": "...", "commands": "psql ...", "runbook": "docs/runbooks/database-restore.md" }, "preflight": { "...": "..." } } }
```

**Response — `mode: "blocked"`:** a gate refused and nothing was started.
```json
{ "data": { "mode": "blocked", "runId": "uuid", "block": { "gateId": "schema_compatibility", "message": "...", "overridable": true, "overrideParameter": "overrideSchemaCheck" }, "preflight": { "...": "..." } } }
```

**Error Cases:**
- 400 Bad Request - Missing/wrong `confirmation`, or the run is not restorable
- 404 Not Found - Run not found
- 409 Conflict - Another restore/backup is already active (`details.activeRunId`)

---

#### POST /admin/db-backup/runs/:id/rollback
Undoes a completed restore. Same "mode is the answer, all three are 200" contract.

**Requires:** `db_backup:restore`

**Request Body:**
```json
{ "confirmation": "ROLLBACK" }
```

`confirmation` must be the literal `"ROLLBACK"` — a different word from the restore route's on purpose, so a body copied from one route to the other is refused rather than silently accepted.

**Response — `mode: "renamed"`** (`retain_database` mode): the retained pre-swap database was renamed back into place. ⚠ **The process exits moments after this response is flushed** — its connection pool is bound to a database just renamed out from under it; expect the next request to fail until the supervisor restarts the process.
```json
{ "data": { "mode": "renamed", "runId": "uuid", "promoted": "app", "parked": "app_restore_scratch", "detail": "..." } }
```

**Response — `mode: "restore_started"`** (`drop_database`/`pre_restore_dump` mode): rolling back is itself a multi-hour restore, from the automatic pre-restore backup.
```json
{ "data": { "mode": "restore_started", "runId": "uuid", "preRestoreRunId": "uuid", "detail": "..." } }
```

**Response — `mode: "unavailable"`:** nothing left to roll back to (the retained database's retention window passed, or none was taken). Reported honestly as a 200, not a failure.
```json
{ "data": { "mode": "unavailable", "runId": "uuid", "detail": "..." } }
```

---

### Notification Broadcasts

**All routes require Admin role (`broadcasts:read` or `broadcasts:write` permissions)**

Send a message to every active user — composed in the app, sent immediately or scheduled for later. See [`docs/specs/notification-broadcasts.md`](specs/notification-broadcasts.md) for the fan-out mechanism, the audience definition, and why several of these routes behave the way they do; this section documents only the request/response contract.

Every literal route below (`/audience`, `/test`) is matched before `/:id` — Nest matches routes in declaration order, and reordering them would make `GET /admin/broadcasts/audience` 400 as a malformed UUID instead of returning a count.

#### GET /admin/broadcasts/audience
Count the active users a broadcast created right now would target — the same predicate the fan-out itself pages with, so this number cannot disagree with what a send later reports.

**Response:**
```json
{
  "data": {
    "activeUsers": 1284
  }
}
```

---

#### POST /admin/broadcasts/test
Dispatch the composition to the **calling admin only**, over the channels selected. Writes no broadcast row and queues no job — nothing appears in the list and nobody else is contacted. There is no recipient field; the endpoint always sends to the authenticated caller.

**Requires:** `broadcasts:write` permission

**Request Body:** same shape as `POST /admin/broadcasts` below. `scheduledFor`, if present, is accepted and ignored — a test send has no schedule.

**Response:**
```json
{
  "data": {
    "eventKey": "admin.broadcast",
    "channels": ["email", "browser"],
    "sentToUserId": "uuid"
  }
}
```

A 200 means the dispatch was attempted, not that every channel succeeded — per-channel outcomes are recorded as delivery rows, exactly as for a real send.

**Error Cases:**
- 400 Bad Request - Validation error (see `POST /admin/broadcasts` for the full rule set)

---

#### GET /admin/broadcasts
List broadcasts, newest first, optionally filtered by status.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `pageSize` | number | 20 | Items per page (max 100) |
| `status` | enum | - | Filter by lifecycle status: `draft`, `scheduled`, `sending`, `sent`, `canceled`, `failed` |

**Response:**
```json
{
  "data": {
    "items": [
      {
        "id": "uuid",
        "title": "Planned maintenance this Saturday",
        "body": "We will be performing scheduled maintenance...",
        "link": "/status",
        "ctaLabel": "View status page",
        "eventKey": "admin.broadcast",
        "channels": ["email", "browser"],
        "status": "sent",
        "scheduledFor": null,
        "startedAt": "2024-01-01T00:00:00.000Z",
        "finishedAt": "2024-01-01T00:05:00.000Z",
        "canceledAt": null,
        "audienceCutoff": "2024-01-01T00:00:00.000Z",
        "recipientsTargeted": 1284,
        "recipientsDispatched": 1284,
        "lastError": null,
        "createdById": "uuid",
        "createdAt": "2024-01-01T00:00:00.000Z",
        "updatedAt": "2024-01-01T00:05:00.000Z"
      }
    ],
    "total": 12,
    "page": 1,
    "pageSize": 20,
    "totalPages": 1
  }
}
```

**Note:** `draft` is a real status value even though no route in this API can currently produce it — see the spec's schema section for why the enum carries it anyway.

---

#### POST /admin/broadcasts
Compose and queue a broadcast. Records it as `scheduled` and enqueues its fan-out; omit `scheduledFor` to send as soon as the queue claims the job, or supply a future timestamp to schedule it.

**Requires:** `broadcasts:write` permission

**Request Body:**
```json
{
  "title": "Planned maintenance this Saturday",
  "body": "We will be performing scheduled maintenance on Saturday from 2am to 4am UTC.\n\nExpect brief interruptions during this window.",
  "link": "/status",
  "ctaLabel": "View status page",
  "channels": ["email", "browser"],
  "scheduledFor": "2024-01-06T02:00:00.000Z",
  "critical": false
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | 1–120 characters. Becomes the email subject and the notification headline. |
| `body` | string | Yes | 1–2000 characters. Plain text; blank lines separate paragraphs, everything is escaped on render. |
| `link` | string | No | Root-relative only (starts with `/`, not `//`; no control characters or spaces). Destination for the call-to-action. |
| `ctaLabel` | string | No | 1–40 characters. Requires `link` to be present. |
| `channels` | string[] | Yes | Non-empty, duplicate-free subset of `email`, `browser`, `push`. Narrows what this send delivers over. |
| `scheduledFor` | string (ISO 8601, offset required) | No | Must be strictly in the future. Absent means send immediately. |
| `critical` | boolean | No (default `false`) | Marks this as unmuteable (`admin.broadcast_critical`). **Requires `channels` to include `browser`** — the durable in-app notification is the only record a recipient can go back and read. |

**Response:**
```json
{
  "data": {
    "broadcast": {
      "id": "uuid",
      "title": "Planned maintenance this Saturday",
      "body": "We will be performing scheduled maintenance...",
      "link": "/status",
      "ctaLabel": "View status page",
      "eventKey": "admin.broadcast",
      "channels": ["email", "browser"],
      "status": "scheduled",
      "scheduledFor": "2024-01-06T02:00:00.000Z",
      "startedAt": null,
      "finishedAt": null,
      "canceledAt": null,
      "audienceCutoff": null,
      "recipientsTargeted": null,
      "recipientsDispatched": 0,
      "lastError": null,
      "createdById": "uuid",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    },
    "warnings": []
  }
}
```

**Note:** `eventKey` is always derived server-side from `critical` (`admin.broadcast` or `admin.broadcast_critical`) — it cannot be set by the client, and any `eventKey` in the request body is ignored. `warnings` is a non-fatal array, populated (but the broadcast still created) when `browser` is selected while the deployment-wide browser kill switch is currently off.

**Error Cases:**
- 400 Bad Request - Validation error, including: title/body/link/ctaLabel over length, empty or duplicate `channels`, `ctaLabel` without `link`, `scheduledFor` not in the future, or `critical: true` without `browser` in `channels`

---

#### GET /admin/broadcasts/:id
Get one broadcast, including an approximate delivery breakdown.

**Parameters:**
- `id` (UUID) - Broadcast ID

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "title": "Planned maintenance this Saturday",
    "body": "We will be performing scheduled maintenance...",
    "link": "/status",
    "ctaLabel": "View status page",
    "eventKey": "admin.broadcast",
    "channels": ["email", "browser"],
    "status": "sent",
    "scheduledFor": null,
    "startedAt": "2024-01-01T00:00:00.000Z",
    "finishedAt": "2024-01-01T00:05:00.000Z",
    "canceledAt": null,
    "audienceCutoff": "2024-01-01T00:00:00.000Z",
    "recipientsTargeted": 1284,
    "recipientsDispatched": 1284,
    "lastError": null,
    "createdById": "uuid",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:05:00.000Z",
    "approximateDeliveryAttempts": [
      { "channel": "email", "status": "sent", "count": 1270 },
      { "channel": "email", "status": "failed", "count": 14 },
      { "channel": "browser", "status": "sent", "count": 1284 }
    ]
  }
}
```

**Note:** `approximateDeliveryAttempts` is exactly that — approximate. It is computed by grouping `notification_deliveries` rows for this broadcast's `eventKey` within `[startedAt, finishedAt ?? now]`, and a second broadcast raised under the same event key during this window would contribute to the same total. Empty for a broadcast that has not started sending.

**Error Cases:**
- 404 Not Found - Broadcast not found

---

#### POST /admin/broadcasts/:id/cancel
Cancel a scheduled or in-flight broadcast — the only recall mechanism this feature has.

**Requires:** `broadcasts:write` permission

**Parameters:**
- `id` (UUID) - Broadcast ID

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "title": "Planned maintenance this Saturday",
    "body": "We will be performing scheduled maintenance...",
    "link": "/status",
    "ctaLabel": "View status page",
    "eventKey": "admin.broadcast",
    "channels": ["email", "browser"],
    "status": "canceled",
    "scheduledFor": null,
    "startedAt": "2024-01-01T00:00:00.000Z",
    "finishedAt": null,
    "canceledAt": "2024-01-01T00:02:00.000Z",
    "audienceCutoff": "2024-01-01T00:00:00.000Z",
    "recipientsTargeted": 1284,
    "recipientsDispatched": 340,
    "lastError": null,
    "createdById": "uuid",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:02:00.000Z"
  }
}
```

**Note:** ⚠ Cancelling a broadcast that is already `sending` may still let one in-flight chunk (up to 200 recipients) go out — the fan-out only re-checks status between batches. Cancel stops everything after that point; it cannot recall what has already been sent. The row and any queued job rows are kept, not deleted.

**Error Cases:**
- 404 Not Found - Broadcast not found
- 409 Conflict - The broadcast is not `scheduled` or `sending` (already `sent`, `canceled`, or `failed`)

---

#### DELETE /admin/broadcasts/:id
Delete a broadcast's record.

**Requires:** `broadcasts:write` permission

**Parameters:**
- `id` (UUID) - Broadcast ID

**Response:** HTTP 204 No Content

**Error Cases:**
- 404 Not Found - Broadcast not found
- 409 Conflict - The broadcast is currently `sending` (cancel it first)

---

### Push Configuration (Admin-only)

Runtime-configurable Web Push (VAPID) keys — issue #355. Two permissions:
`push:read` (get) and `push:write` (every write) — **deliberately separate
from `system_settings:*`**, mirroring why `broadcasts:*`/`nodes:*`/
`db_backup:*` were split out rather than folded into an existing pair:
generating or rotating key material has a real blast radius (every existing
push subscriber goes dark until it re-subscribes) that should not ride along
with routine settings edits. See
[`docs/specs/browser-notifications.md`](specs/browser-notifications.md) for
the always-registered channel design and the `webPush` settings/credential
split, and [`docs/runbooks/vapid-keys.md`](runbooks/vapid-keys.md) for the
operator-facing flow. **The VAPID private key is never returned by any
endpoint below** — every response carries only a masked
`privateKeyStatus` (`configured`, `hint`, `updatedAt`, `updatedByUserId`).

#### GET /admin/push-config
Current configuration plus `privateKeyStatus`. `configured` is `true` only
when both a public key is stored and a private-key credential exists — the
admin page renders its empty ("Generate & enable") state exactly when this is
`false`.

**Requires:** `push:read`

**Response:**
```json
{
  "data": {
    "enabled": true,
    "publicKey": "BF3z...",
    "subject": "mailto:admin@example.com",
    "configured": true,
    "privateKeyStatus": {
      "configured": true,
      "hint": "••••x9fQ",
      "updatedAt": "2024-01-01T00:00:00.000Z",
      "updatedByUserId": "uuid"
    },
    "settingsError": null,
    "version": 3,
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "updatedBy": { "id": "uuid", "email": "admin@example.com" }
  }
}
```

---

#### PUT /admin/push-config
Full replace of `{ enabled, subject }`. **This endpoint flips the switch; it
does not manufacture keys** — neither VAPID key is settable here.

**Requires:** `push:write`

**Headers:** `If-Match: <version>` (optional) — expected `version` for
optimistic concurrency; use `0` to assert nothing is stored yet, or omit to
overwrite unconditionally.

**Request Body:**
```json
{ "enabled": true, "subject": "mailto:admin@example.com" }
```

**Response:** the configuration, in the shape above.

**Error Cases:**
- 400 Bad Request - Validation error (e.g. `subject` is not a `mailto:`/`http(s)://` value)
- 409 Conflict - Version mismatch (`If-Match` didn't match the stored version), or `enabled: true` was requested with no key pair generated yet

---

#### POST /admin/push-config/generate
First-time-only key generation: a fresh VAPID key pair via `web-push`, the
private key stored in the encrypted credential store, the public key stored
and `enabled` set to `true`. **Not idempotent** — a second call is refused
rather than silently replacing a live key pair with no confirmation step.

**Requires:** `push:write`

**Request Body:**
```json
{ "subject": "mailto:admin@example.com" }
```
`subject` is optional; omitted or blank falls back to the generic default at
send time.

**Response:** the generated configuration, in the shape above.

**Error Cases:**
- 409 Conflict - Web Push is already configured; use rotate instead

---

#### POST /admin/push-config/rotate
Generates a fresh VAPID key pair and replaces the stored one. **Disruptive**:
every existing push subscriber stops receiving pushes until it re-subscribes
(there is no automatic re-subscribe-on-reopen mechanism in this codebase —
see the runbook). `enabled` is left exactly as it was; rotating is not a
decision about whether push should be on.

**Requires:** `push:write`

**Request Body:**
```json
{ "confirmation": "ROTATE", "subject": "mailto:admin@example.com" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confirmation` | literal `"ROTATE"` | Yes | Checked before the service is touched. A body copied from the remove endpoint's confirmation is rejected — the two use deliberately different words. |
| `subject` | string | No | Replaces the stored subject; omitted keeps it. |

**Response:** the rotated configuration, in the shape above.

**Error Cases:**
- 400 Bad Request - Missing/incorrect confirmation, or nothing is configured yet (use `generate` instead)

---

#### DELETE /admin/push-config
Deletes both the stored VAPID private-key credential and the `webPush`
settings row, then returns the resulting (empty) configuration — the same
shape every other route on this controller returns, so a client can render
the post-removal state with no follow-up GET. **Destructive and immediate**
— every existing push subscription becomes unusable, and there is no way to
bring the same key pair back; a subsequent `generate` mints an entirely new
one.

**Requires:** `push:write`

**Request Body:**
```json
{ "confirmation": "REMOVE" }
```
`confirmation` must be the literal `"REMOVE"` — a different word from the
rotate route's on purpose, so a body copied from one route to the other is
refused rather than silently accepted.

**Response:** the resulting (now empty) configuration.

**Error Cases:**
- 400 Bad Request - Missing or incorrect confirmation

---

### Transcripts

Audio in, a diarized and timestamped transcript out — issue #25, epic #19. The
design, including the three state machines, the provider contract and the
access model this section only summarises, is
[`docs/specs/transcription.md`](specs/transcription.md).

Two permissions, `transcripts:read` and `transcripts:write`, both **seeded to
all three roles including Viewer**: creating a transcript is the action this
whole feature exists to enable, and a brand-new account's default role is
Viewer. A permission model that made a fresh signup unable to record their
first conversation would contradict the product's own onboarding.

**Per-transcript access is separate from the permission.** The owner reaches
everything; anybody they shared it with reaches what their share role allows
(`viewer` reads, `editor` also edits). **A caller with no access gets 404,
never 403** — a 403 would confirm that a specific transcript id exists and
merely refuse the caller, and the existence of a private conversation's id is
itself something a stranger has no business learning. `edit` additionally
requires `transcripts:write`: a share caps the *ceiling* an RBAC permission can
raise a user to, never the floor.

**There is deliberately no `transcripts:read_any`.** An administrator who
configures which provider this deployment uses has no path, through any
permission this application grants, to read a transcript they do not own or
hold a share on. Configuring the pipe is not the authority to read what flows
through it.

Three status fields, not one, because the transcode and the transcription run
**concurrently** and a single enum would need one member per combination:

| Field | Values |
|---|---|
| `status` | `uploading` → `processing` → `ready`, plus `failed` and `deleting` |
| `transcriptionStatus` | `waiting_input` → `queued` → `submitting` → `submitted` → `processing` → `completed`, plus `failed` and `cancelled` |
| `playbackStatus` | `pending`, `processing`, `ready`, `failed`, `not_needed` |

`GET /transcripts?status=` filters on the **top-level** field only. Filtering by
a sub-pipeline status would require the caller to know that `processing` can
mean either sub-pipeline, or both.

#### POST /transcripts
Creates the transcript **and** initialises the resumable multipart upload its
audio arrives through, in one call — one user action, one request, both rows or
neither. A client that had to make two calls could get the first to succeed and
the second to fail, leaving a transcript in `uploading` with no upload behind
it.

**Requires:** `transcripts:write`

**Request:**
```json
{
  "title": "Board meeting, 3 March",
  "language": "en",
  "speakersExpected": 4,
  "source": { "name": "meeting.m4a", "size": 148372910, "mimeType": "audio/mp4" }
}
```

`title` defaults to the filename without its extension. `language` omitted or
null asks the provider to detect it. `speakersExpected` is a **hint** a provider
may bias diarization with, never a constraint, and is ignored entirely by a
provider whose `speakersExpectedHint` capability is false.

`source.mimeType` is optional because mobile browsers report audio types
inconsistently — `application/octet-stream`, or nothing at all, for `.m4a` and
`.amr` is the ordinary case — and the file extension decides when it is absent.

**Response:** `201`
```json
{
  "data": {
    "transcript": { "id": "…", "status": "uploading", "…": "…" },
    "upload": {
      "objectId": "…",
      "uploadId": "…",
      "partSize": 16777216,
      "totalParts": 9,
      "presignedUrls": [{ "partNumber": 1, "url": "https://…" }]
    }
  }
}
```

Upload the parts against `POST /storage/objects/:id/upload/parts` and finish
with `POST /storage/objects/:id/upload/complete`, exactly as for any other
resumable upload. Completing it is what starts the pipeline.

Three pre-flight checks run **before** anything is created, so a rejected
request leaves no half-started upload behind for the stale sweep to find:

| Code | When |
|---|---|
| `409` | Transcription is not configured for this deployment: disabled, no provider chosen, a provider this build does not include, or **no API key stored**. The request was well formed; the deployment is not ready, and a 400 would blame the caller for an administrator's unfinished setup |
| `400` | The file is larger than the active provider accepts (5 GB for AssemblyAI), or is not audio or video at all |
| `403` | The caller does not hold `transcripts:write` |

**The `400` type check is `audio/*,video/*`, a fixed allowlist this endpoint
enforces itself — not the operator-configured `ALLOWED_MIME_TYPES` the generic
`POST /api/storage/objects*` surface reads (issue #79).** A deployment whose
`.env` predates issue #21 lists `image/*,application/pdf,video/*` with no
`audio/*` entry, which used to reject every Android `.m4a` recording with a
message about images and PDFs — for a type AssemblyAI's own accepted list
already contains. Recording is this feature's core action, so it cannot be
silently disabled by an unrelated setting written for arbitrary file uploads;
see [`docs/specs/transcription.md` §9.6](specs/transcription.md#96-content-type-allowlist-transcript_source_mime_types-not-storageallowedmimetypes-issue-79)
for the full reasoning. Also note the check is deliberately **wider** than
what AssemblyAI accepts directly: a video file passes here because
`media.audio.transcode` extracts a rendition the provider does accept, decided
later by `selectTranscriptionInput` once that rendition exists.

The upload object is created `managed_by: transcripts`, which makes it
**invisible** to `GET /storage/objects` and makes a generic `DELETE` against it
return 409 — only this transcript being deleted removes it.

⚠ `source.size` is the client's claim, and every check here is made against it.
That is not a trust decision: it is the only number available before a byte has
moved, and refusing a 12 GB file before the upload starts is the entire value of
checking here. The real size is enforced again when the multipart upload
completes.

#### GET /transcripts
The transcripts this caller can open. Ordered by `updatedAt` descending and
paginated by an **opaque cursor** rather than a page number — every pipeline
transition rewrites `updatedAt`, and offset paging over a list that reorders
itself while a user scrolls skips rows and repeats others.

**Requires:** `transcripts:read`

| Query | Meaning |
|---|---|
| `scope` | `owned`, `shared`, or `all` (default) |
| `status` | One top-level status |
| `q` | Case-insensitive title substring |
| `cursor` | `nextCursor` from the previous page |
| `limit` | 1–100, default 20 |

**Response:** `{ "data": { "items": [...], "total": 42, "nextCursor": "…" | null } }`

`total` (issue #190) is how many transcripts **match the current filters**, ignoring
paging. It is counted over the same predicate the page is read with, minus the
keyset cursor clause, and both reads happen in one transaction — so it is
identical on page one and on every subsequent page of an unchanged filter set,
and a client can render "42 transcripts" once without watching the number fall as the
user pages. It is **not** "how many are left", and it is **not** `items.length`.

Each item carries an `access` field — `owner`, `editor` or `viewer` — describing
how **this caller** reaches that row, not the owner's relationship to it.

#### GET /transcripts/summary
Four lists and four counts in one request, for the home page: `inProgress`,
`recent` (eight), `sharedWithMe` (eight), `failed` (eight) and
`counts: { owned, shared, inProgress, failed }`. Exists so the home page
renders in one round trip rather than five.

`failed` is the home page's "Needs attention" section (issue #171, epic #166):
the caller's **own** failed transcripts, newest first. It is **owner-scoped**,
unlike `inProgress`, which unions the caller's shares — retry is owner-only, so
a transcript somebody else owns is a failure this caller cannot act on.

⚠ `counts.failed` is the **true total**, never the length of `failed`. A caller
with thirty failed recordings reads `30` in the count and eight rows in the
list; the cap is a property of the summary, not of how much is wrong. The full
set is `GET /transcripts?status=failed&scope=owned`.

**Requires:** `transcripts:read`

#### GET /transcripts/{id}
Metadata, speakers, all three pipeline statuses, `currentVersion`, and the role
the caller holds.

Carries a **weak ETag**, `W/"v<currentVersion>"`, and honours `If-None-Match`
with a `304` carrying **no body**. Issue #30's transcript view polls this route
on an adaptive schedule while a transcript is in flight; the ETag is what makes
the common case — nothing has moved — cost headers instead of a payload. It is
*weak* because two responses at the same version are semantically, not
byte-for-byte, equivalent: `updatedAt` moves when a poll writes
`lastPolledAt`, and the version does not identify that.

Weak comparison is used, which is the only comparison RFC 9110 permits for
`If-None-Match`, so `"v3"` from a proxy that stripped the prefix still matches
`W/"v3"`, and `*` and comma-separated lists both work.

**Requires:** `transcripts:read`, plus `view` access. **404**, never 403, with
no access.

`sourceSizeBytes` is a **decimal string**, not a number: a multi-gigabyte
recording is the ordinary case here and `JSON.stringify` throws on a BigInt
rather than rounding it.

#### GET /transcripts/{id}/segments
Every segment in reading order, **without word timings** — those are the single
largest thing in this schema, and a segment list carrying them would be tens of
megabytes for a view that renders text. Same weak ETag and 304 as the detail
route.

**Requires:** `transcripts:read`, plus `view` access

#### GET /transcripts/{id}/words?fromMs&toMs
Per-word start, end and confidence for every segment overlapping
`[fromMs, toMs)`, for word-level highlighting during playback.

A **window**, never the whole transcript: a ten-hour recording's word index is
hundreds of megabytes. `toMs` defaults to five minutes past `fromMs` and is
capped at thirty minutes past it; a wider request is **silently narrowed**
rather than refused, and the response echoes the window actually served.

Segments are selected by **overlap**, not containment — one straddling the
window's start carries the words the player is about to highlight.

**Requires:** `transcripts:read`, plus `view` access

#### GET /transcripts/{id}/audio
A short-lived signed GET for the audio: the small, seekable playback rendition
when one is ready, the original upload otherwise. Six-hour TTL, because an
`<audio>` element holds the URL for as long as somebody is listening and a
three-hour recording outlives a one-hour URL halfway through.

`kind` (`playback` | `original`) says which file was signed, so a client can
decide whether to trust the browser to play it.

**Requires:** `transcripts:read`, plus `view` access

#### PATCH /transcripts/{id}
Changes the title. **Not versioned**: a title is metadata about the recording,
not content of it, so recording a rename as a version would put a no-op in the
edit history that a later restore could "undo" into a name nobody chose.

**Requires:** `transcripts:write`, plus `edit` access (owner or `editor` share)

#### DELETE /transcripts/{id}
Owner only. Moves the transcript to `deleting` and queues `transcript.purge`,
which removes **every** managed storage object it ever owned — the original
upload, the playback rendition, the gzipped raw provider result, every snapshot,
every export — deletes the provider's own copy if it still holds one, and only
then deletes the rows.

`deleting` is a real, visible status rather than an immediate row delete because
purging multi-gigabyte objects and calling a third party's delete endpoint is
long-running work. **There is no path back.**

**Requires:** `transcripts:write`, plus `own` access · **Response:** `204`

#### POST /transcripts/{id}/retry
Owner only. Re-runs the stage that failed — and **the stage is derived from the
row, not chosen by the caller**: a transcript the provider already accepted is
re-polled, and only one that never got a provider job is re-submitted. Letting
a client name the stage would allow a second remote job, and a second bill, for
one recording.

The audio is not re-uploaded; it is still in storage. **409** when it is not, or
when the transcript is already complete, still uploading, or being deleted.

**Requires:** `transcripts:write`, plus `own` access

#### POST /transcripts/{id}/cancel
Owner only. Cancels the job on the provider when the provider supports
cancellation, and marks the transcript `failed` / `cancelled` **either way** — a
vendor that will not answer must not stop the owner from stopping waiting. A
cancelled transcript can be retried, which re-submits rather than polling the
abandoned remote job.

**Requires:** `transcripts:write`, plus `own` access

#### POST /transcripts/{id}/operations
Apply up to **200 correction ops in one transaction** and record them as a new
version. This is the write half of *"AI proposes. The user controls the truth."*

**Body:** `{ baseVersion, clientBatchId, ops[] }` ·
**Response:** `{ version, summary, idempotentReplay, speakers[], segments[], merges[] }`

| Op | Payload |
|---|---|
| `segment.update_text` | `{ segmentId, rev, text }` |
| `segment.set_speaker` | `{ segmentId, rev, speakerId }` |
| `segment.split` | `{ segmentId, rev, atWordIndex \| atCharOffset, newSpeakerId? }` — exactly one of the two positions |
| `segment.join` | `{ segmentIds: [a, b], revs: [ra, rb] }` — **adjacent only** |
| `segment.delete` | `{ segmentId, rev }` |
| `speaker.rename` | `{ speakerId, rev, displayName }` |
| `speaker.create` | `{ displayName }` |
| `speaker.merge` | `{ sourceIds[], targetId, keepName? }` |
| `transcript.find_replace` | `{ find, replace, matchCase?, wholeWord?, speakerId? }` |

**`transcript.find_replace` is expanded server-side into concrete
`segment.update_text` ops before the version is recorded.** That is the
load-bearing decision: a version that recorded the abstract call would replay
through a *future* matcher, so a Unicode table update or a bug fix in
word-boundary detection would silently change what a version from last year says
happened. Matching is **literal — never a regular expression** (ReDoS, and the
wrong tool for somebody correcting a misheard name), with optional case
sensitivity and **Unicode-aware** whole-word boundaries: a search for `os` does
not match inside `José`, which a `\b`-based implementation gets wrong.

Server-assigned identity is chosen **before** recording, never at replay time —
a split's `newSegmentId` and resolved `atWordIndex`, a `speaker.create`'s
`speakerId` and `colorIndex` — so replaying a version produces the same ids at
the same seams.

**Concurrency.** `baseVersion` is *informational* and may be stale; what
actually guards each write is the per-entity `rev` on every op, checked inside
the same transaction that writes. Two editors correcting **different** lines
both succeed. `current_version` is allocated by a conditional
`UPDATE … WHERE current_version = $n`, which is also the lock — the loser blocks
on the row, then re-applies against the winner's state.

| Status | When |
|---|---|
| `400` | An op that can never apply — a split that would leave a half empty, a join of non-adjacent segments, a merge naming its own target |
| `403` | The caller can view the transcript but does not hold `transcripts:write` |
| `404` | No such transcript, no share, or a `viewer` share |
| `409` | A stale `rev`. `details` carries `{ currentVersion, conflicts: [{ entity, id, current }] }`, naming **every** conflict at once so one re-fetch resolves them all; `current` is `null` for an entity another editor deleted |

**Idempotency.** A repeated `clientBatchId` returns the **original** result with
`idempotentReplay: true` and creates no second version, so a retry after a
dropped connection or a backgrounded tab is always safe.

**Word timings survive the edit.** Unchanged words keep the provider's own
times; changed ones are re-aligned by token LCS (a substitution inherits the
timing of the word it replaced, an insertion is interpolated between its
neighbours) and the segment becomes `wordsAlignment: interpolated`. A split
divides the word array and a join concatenates it, so both stay `exact` —
nothing was invented. A full retype falls back to `none` with times spread
evenly.

**`merges[]`** carries, per `speaker.merge`, each source speaker and the segment
ids that were on it — the half of an inverse merge a client cannot reconstruct
once the merge has happened.

**Requires:** `transcripts:write`, plus `edit` access

#### GET /transcripts/{id}/search?q&matchCase&wholeWord&speakerId&limit
Every occurrence of `q`, with the segment it is in, where in the media that
segment starts, the offsets inside its text and a short excerpt. The same
literal matcher `transcript.find_replace` uses, so the preview and the
replacement can never disagree about what counts as a hit.

`total` is always the **exact** number of occurrences even when `matches` was
truncated to `limit` (default and maximum 500) — a preview that under-reported
would understate what a replacement is about to rewrite.

**Requires:** `transcripts:read`, plus `view` access

#### GET /transcripts/{id}/versions?cursor&limit
Every save, newest first, cursor-paginated: `{ version, kind, summary, author,
restoredFromVersion, hasSnapshot, opCount, createdAt }`.

**`author: null` means the AI**, not a missing value — version 1 is
`kind: ai_original` and is the provider's own output. It is permanent for the
life of the transcript; nothing in this API ever deletes a version row.

**Requires:** `transcripts:read`, plus `view` access

#### GET /transcripts/{id}/versions/{version}
The transcript as it stood at that version: the nearest snapshot at or before
it, with every later version's ops replayed through **the same pure reducers the
live edit path uses**. Segments come back **without word timings**, exactly as
`GET /transcripts/{id}/segments` does.

**409** while a version older than the first snapshot is still unreachable:
version 1 cannot be rebuilt from ops (it is what the provider *said*, not a
change to anything), so it becomes reachable once its `transcript.snapshot` job
has run.

**Requires:** `transcripts:read`, plus `view` access

#### POST /transcripts/{id}/versions/{version}/restore
**History is never rewritten.** A restore records a *new* version
(`kind: restore`, `ops: [{ op: "restore", fromVersion }]`,
`restored_from_version`), replaces the current-state tables with that version's
content in one transaction, and queues a snapshot. Every version in between —
including the one that existed immediately before the call — stays exactly as it
was, and **version 1, the AI original, is always retrievable**.

**Body:** `{ baseVersion }`, and unlike `POST /operations` it **must equal the
transcript's current version**: a correction batch carries a `rev` on every op
that says what it expects, and a restore carries no such thing, so a stale view
means asking to discard edits the caller has never seen. **409** otherwise, and
**409** for restoring the version that is already current.

**Requires:** `transcripts:write`, plus `edit` access

#### GET /transcripts/exporters
Every registered export format, with the options it accepts. Issue #28.

```json
{
  "data": {
    "exporters": [
      {
        "format": "json",
        "label": "JSON",
        "mimeType": "application/json",
        "extension": "json",
        "options": [
          {
            "key": "includeWords",
            "label": "Include word timings",
            "description": "Adds per-word start, end and confidence to every segment. Much larger, and only useful to something that lines the text up against the audio.",
            "type": "boolean",
            "default": false
          }
        ]
      }
    ]
  }
}
```

**Build the export UI from this response, not from a list of formats compiled
into a client.** The whole point of the exporter registry (spec §8.1) is that
adding a format is one new class on the server: a deployment that registers a
`docx` exporter offers it here, with its own options, and nothing in any client
changes. An option's `key` is what goes inside `options` on the request below;
`default` is the value used when the request omits it.

**Requires:** `transcripts:read`

#### POST /transcripts/{id}/exports
Render one version of this transcript into one format.

**Body:** `{ format, version?, options? }`. `version` defaults to the
transcript's current version and may be **any version in the history** — the
export contains *that* version's content, not the current one. `options` is
validated against the chosen format's own schema from `GET /transcripts/exporters`.

Two success codes, and they mean different things:

| Status | Meaning |
|---|---|
| **202** | No matching export existed; a render has been queued. Poll `GET /transcripts/{id}/exports/{exportId}` |
| **200** | An export of the same version, format and options already exists and has not expired. It is returned as-is; nothing was rendered |

The body carries `reused` for a client that cannot see the status line (a fetch
wrapper that unwraps `{ data }`, a proxy that rewrote it).

```json
{
  "data": {
    "id": "e7c1…",
    "transcriptId": "9f3a…",
    "version": 4,
    "format": "markdown",
    "options": { "includeTimestamps": true, "mergeConsecutive": false },
    "status": "pending",
    "reused": false,
    "mimeType": "text/markdown; charset=utf-8",
    "filename": "Weekly sync (v4).md",
    "sizeBytes": null,
    "error": null,
    "downloadUrl": null,
    "downloadExpiresAt": null,
    "expiresAt": "2026-09-21T12:00:00.000Z",
    "createdAt": "2026-09-14T12:00:00.000Z"
  }
}
```

**There is no synchronous path, at any size.** Every export is a
`transcript.export` job (`5m / 2 attempts`, priority `−10`). Spec §8.5 rejects a
size threshold explicitly: it is two code paths for the same operation, and the
inline one breaks the day a short recording turns out to have a dense correction
history, at the one moment nobody is watching for it. It also means an export
survives the phone that asked for it being backgrounded.

**Reuse is content-addressed**, on `sha256({ format, version, options })` with
the options **as parsed** — so `{}` and an explicit set of every default are the
same export and share one render. A `failed` row is **never** reused: a retry
must actually retry.

**400** for an unknown `format` (the message names the ones that exist) and for
an option the chosen format does not accept — an unknown key is refused rather
than silently ignored, because a stripped key would render without the option
and report success. **404** for a version that does not exist, and for no access.

**Requires:** `transcripts:read`, plus **view** access — an `editor` or `viewer`
share both satisfy it. Taking a conversation you were shown out of this
application is a read.

#### GET /transcripts/{id}/exports/{exportId}
The export's status, and — once `status` is `ready` — a short-lived signed
`downloadUrl` that serves the file as an attachment named
`<title> (v<n>).<ext>`. The `Content-Disposition` is signed **into** the URL, so
the filename cannot be added by a client afterwards and the URL should be handed
to the browser rather than fetched.

Poll while `status` is `pending`. A `failed` export carries the reason in
`error`; requesting the same export again queues a fresh render.

**Exports expire after 7 days**, and `transcripts.housekeeping` deletes both the
row and the file. Nothing is lost — an export is a byte-for-byte reproducible
artifact of a specific version and a specific set of options, so requesting the
identical export again produces the identical file.

**404** for an export id belonging to a different transcript: the lookup is
scoped by `transcriptId`, which *is* the authorisation.

**Requires:** `transcripts:read`, plus view access

#### The three export formats

| Format | What it is |
|---|---|
| `json` | The **public, versioned export schema** published as [`docs/specs/transcript-export.v1.schema.json`](specs/transcript-export.v1.schema.json). Every document carries a literal `schema` field — that file's `$id` — and a consumer switches on it rather than assuming the shape of an unversioned blob. The contract is permanent: a field is added, never removed or repurposed, and a breaking change ships as a **v2** schema with its own `$id` beside this one |
| `markdown` | YAML front matter (title, date, duration, speakers, version) then `**Speaker** · 00:01:23` paragraphs. Every interpolated value is escaped for Markdown's own specials, because a speaker name and a line of speech are text, not markup |
| `pdf` | pdfkit, streamed, with bundled Noto faces: a cover block (title, date, duration, participants with talk time), speaker names in their own colours, a timestamp margin, a running header, and a footer reading `Page x of y · Version n · Exported from <app>` |

**CJK and right-to-left scripts are a documented v1 limitation of the PDF**, not
a silent gap: the bundled Noto Sans covers Latin, Greek and Cyrillic and has no
CJK glyphs, and pdfkit performs no bidirectional reordering. Both are fixed by
bundling the relevant Noto families and adding a bidi pass, and are out of this
epic's scope.

#### Snapshots, and what they are for

A snapshot is a **compaction of replay work, never a second source of truth**.
`transcript.snapshot` writes a gzipped JSON copy of a version's materialized
state to a managed object and links it from `snapshot_object_id`. Policy: always
for version 1 and for every restore; otherwise after **50 versions or 1 MB of
accumulated ops** since the last snapshot, whichever comes first. It is **never
taken inline** — `POST /operations` enqueues it and returns as soon as its own
transaction commits.

The job reads `current_version` and the state together inside one
`REPEATABLE READ` transaction and attaches the snapshot to the version that read
actually saw, not to the one its payload named: a snapshot labelled v7
containing v9's segments would be a lie `materialize()` would faithfully replay
ops on top of.

#### The pipeline behind these routes

Completing the upload raises an event whose listener **only enqueues** — it
never calls the provider inline, which would be a multi-minute network call with
no job row, no timeout, no retry and no visibility in `GET /admin/jobs`. Eight
job types carry the work; all of the ones that talk to the provider are
**server-only**, because the provider API key is a long-lived, account-level
secret no per-job broker can narrow.

| Job type | Profile | What it does |
|---|---|---|
| `media.audio.transcode` | issue #26 | The small, seekable playback rendition |
| `transcription.submit` | `2h / 3 attempts` | Presigns the input **when the job runs**, submits, records the provider handle immediately. Idempotent on that handle |
| `transcription.poll` | `2m / 5 attempts` | Re-enqueues itself with `skipDedup: true`. First delay `clamp(duration × 0.05, 30s, 5m)`, then ×1.5 to a 5-minute cap. Hard deadline `submittedAt + max(6h, 3 × duration)` |
| `transcription.ingest` | `15m / 3 attempts` | Writes speakers, segments, version 1 (`ai_original`) and `status: ready` in **one transaction**; stores the raw provider JSON gzipped for provenance; deletes the provider's copy |
| `transcript.snapshot` | `10m / 3 attempts` | A point-in-time copy of a version's materialized state, read under `REPEATABLE READ`. Server-only: the whole job is a multi-table consistent read |
| `transcript.export` | `5m / 2 attempts` | Renders one version into one format and writes it as a managed object. Priority **−10** — somebody is watching a spinner. Server-only in v1 **not** under one of rule 2's exemptions but because the renderers live in the API: a second copy in the CLI would make the output depend on which executor claimed the job |
| `transcript.purge` | deployment default | Everything a deleted transcript owned |
| `transcripts.housekeeping` | deployment default | Restarts a lost poll chain, fails transcripts whose upload was cleaned up, expires exports. Enqueued by a ten-minute cron that only enqueues |

**Domain failures do not spend a job attempt.** A bad API key, a file the
provider rejects, or the provider's own terminal error all set `failureReason`
and `status: failed`, and the **job returns normally** — it did its job
correctly by recognising the outcome, and retrying would re-ask a question whose
answer cannot change. A `429` throws `RateLimitError` and is deferred through
one shared throttle bucket across submit, poll and ingest, because all three
share one vendor account and one rate-limit budget; the transcript's own status
does not change, so from the owner's point of view a rate limit is invisible
backoff rather than a failure.

Two notifications reach the **owner alone**, never a permission fan-out:
`transcripts.transcript_ready` after ingest commits, and
`transcripts.transcript_failed` carrying the reason and a link to the retry
action. Neither is `mandatory` — being told your own upload finished is a
courtesy a user who transcribes twenty files a day may reasonably mute.

---

### Transcription

Speech-to-text configuration — issue #23, epic #19. Two surfaces with two very
different audiences:

* `/transcription-settings` (Admin) is gated on `system_settings:read` /
  `system_settings:write`. **Not a permission pair of its own**, and
  deliberately so: this configuration IS a namespace (`transcription`) of the
  `global` `system_settings` row that `system-settings.controller.ts` already
  gates on exactly those strings, so a separate pair would make the same bytes
  reachable under two different authorities. (Contrast `push:*`, which was
  split out because rotating a VAPID key has a blast radius that should not
  ride along with routine settings edits. Deleting a transcription API key
  stops future jobs and destroys nothing already stored.)
* `/transcription/config` is readable by **any authenticated user** — a narrow
  capability probe, exactly like `GET /notifications/config`, because the users
  the capability governs do not hold `system_settings:read`.

**The provider API key is never returned by any endpoint below.** It lives in
the encrypted credential store at `(purpose 'transcription', name '<providerId>')`
— one row per provider, so switching vendors does not mean re-entering a key
that already works. Every response carries only a masked `keyStatuses[]` entry
(`configured`, `hint`, `updatedAt`, `updatedByUserId`). **Submitting `apiKey`
empty, or omitting it, preserves the stored key**; erasing is the dedicated
`DELETE` below and nothing else.

#### GET /transcription-settings
The stored policy, a masked key status for every registered provider, and the
provider catalogue (capabilities and form-field descriptors) the admin page
renders itself from — so adding a provider costs no frontend change.

AssemblyAI's `speechModel` field stays a plain string but is read as a
**comma-separated, ordered list** of model ids (e.g.
`"universal-3-5-pro, universal-2"`), sent to the vendor as its `speech_models`
array — AssemblyAI falls back through the list by language support. The
retired singular ids `universal`, `best`, `nano` and `slam-1` (case-insensitive)
are dropped on read; if nothing remains, the default list
`universal-3-5-pro, universal-2` is sent, so an existing deployment's stored
`"universal"` keeps working with no migration (2026-09-14, issue #95 — see
`docs/specs/transcription.md` §2.7).

**Requires:** `system_settings:read`

**Response:**
```json
{
  "data": {
    "settings": {
      "enabled": true,
      "provider": "assemblyai",
      "providers": {
        "assemblyai": { "region": "us", "speechModel": "universal-3-5-pro, universal-2" }
      },
      "audioDelivery": "presigned_url",
      "presignedUrlTtlMinutes": 360,
      "deleteRemoteAfterIngest": true,
      "defaultLanguage": null,
      "transcodeNodeOffloadEnabled": true,
      "playback": { "bitrateKbps": 64 }
    },
    "keyStatuses": [
      {
        "providerId": "assemblyai",
        "configured": true,
        "hint": "••••2b3c",
        "updatedAt": "2024-01-01T00:00:00.000Z",
        "updatedByUserId": "uuid"
      }
    ],
    "providers": [
      {
        "id": "assemblyai",
        "label": "AssemblyAI",
        "capabilities": {
          "diarization": true,
          "wordTimestamps": true,
          "languageDetection": true,
          "speakersExpectedHint": true,
          "acceptsUrl": true,
          "acceptsUpload": true,
          "maxInputBytes": 5368709120,
          "maxDurationMs": 36000000,
          "acceptedMimeTypes": ["audio/mpeg", "audio/wav"],
          "remoteDelete": true,
          "cancel": false
        },
        "fieldDescriptors": [
          {
            "key": "region",
            "label": "Region",
            "type": "select",
            "options": [
              { "value": "us", "label": "United States" },
              { "value": "eu", "label": "European Union" }
            ],
            "required": true,
            "defaultValue": "us"
          }
        ]
      }
    ],
    "version": 5,
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "updatedBy": { "id": "uuid", "email": "admin@example.com" }
  }
}
```

---

#### PUT /transcription-settings
Updates the configuration. **Every settings field is optional** — send only
what changed, including one field inside a nested block
(`{ "playback": { "bitrateKbps": 96 } }` is a legal body). Writes go through
`SystemSettingsService.patchSettings`, so the merge, the validation, the
unknown-key preservation and the version counter are the `global` row's own.

`apiKey` is **write-only**: send it to set or rotate the key for the provider
being saved, and **omit it or send it empty to keep the stored one**. It never
reaches `system_settings` and never appears in a response or an audit row.

**Requires:** `system_settings:write`

**Headers:** `If-Match: <version>` (optional) — expected `version` for
optimistic concurrency; use `0` to assert nothing is stored yet, or omit to
overwrite unconditionally.

**Request Body:**
```json
{
  "enabled": true,
  "provider": "assemblyai",
  "providers": { "assemblyai": { "region": "eu", "speechModel": "universal-3-5-pro, universal-2" } },
  "deleteRemoteAfterIngest": true,
  "defaultLanguage": null,
  "apiKey": "..."
}
```

**Response:** the settings, re-read from storage, in the `GET` shape above.

**Error Cases:**
- 400 Bad Request - Validation error, or an `apiKey` with no provider named and none stored (keys are stored per provider, so there would be nowhere to put it)
- 409 Conflict - Version mismatch (`If-Match` did not match the stored version)

---

#### POST /transcription-settings/test
Probes the provider with the supplied key, or with the stored key when none is
supplied. **The supplied key does not need to have been saved** — proving a key
before committing it is the workflow this endpoint exists for.

⚠ **This returns HTTP 200 even when the probe failed.** A refused probe is a
successful diagnosis, and it is the reason the endpoint exists: read `ok`, and
show `detail`, which distinguishes "the key is wrong, or belongs to the other
region", "the account is rate-limited" and "the endpoint was unreachable" —
three different fixes. Treating 200 as "the credential works" reports success
for every misconfiguration there is. The call is audited (outcome only, never
the key).

**Requires:** `system_settings:write` — probing is side-effecting (it spends a
request against a third party using a credential), and `:read` is held by
anyone who may look at settings. Looking is not probing.

**Request Body:**
```json
{ "provider": "assemblyai", "region": "eu", "apiKey": "..." }
```

**Response:**
```json
{
  "data": {
    "ok": false,
    "latencyMs": 88,
    "detail": "The EU endpoint rejected this API key (HTTP 401). Either the key is wrong, or it belongs to the other region — an AssemblyAI key is issued for one region and is refused by the other in exactly this way."
  }
}
```

**Error Cases:**
- 400 Bad Request - Unknown provider, or no key supplied and none stored (which is a different thing from a failed probe)

---

#### DELETE /transcription-settings/credentials/{provider}
Erases the stored API key for one provider. **The only way to remove a key** —
submitting an empty `apiKey` on `PUT` preserves the stored one, deliberately,
because the form renders that box empty.

Idempotent: removing a key that is not there succeeds. **It does not change the
settings** — removing the active provider's key leaves `enabled` and `provider`
as they were, so a key rotation (delete, then paste the new one) is not an
outage.

**Requires:** `system_settings:write`

**Response:** `204 No Content`

**Error Cases:**
- 400 Bad Request - Unknown provider

---

#### GET /transcription/config
What this deployment can transcribe, for a client deciding whether to offer the
feature and what file to let a user pick.

`available` is `true` only when **all four** of these hold: transcription is
enabled, a provider is chosen, that provider is registered in this build, and
an API key is stored for it. Reporting anything less as available moves the
failure from a disabled button to a failed job minutes later.

The limits are still reported when a provider is chosen but has no key — so a
disabled control can say what it *would* allow — and are zero/empty when no
provider is chosen at all.

**No configuration detail is published here**: not the region, not the model,
not the delivery mode, and no part of the API key. A capability probe hands out
the capability, not the configuration behind it.

**Requires:** `transcripts:read` — which is seeded to **all three roles**,
Admin, Contributor and Viewer (`prisma/seed-data.ts`), so this stays readable
by every ordinary account. That is the property the argument above depends on:
naming a real permission rather than "authenticated and nothing else" costs
nothing here precisely because the permission is universal, while
`system_settings:read` is not.

**Response:**
```json
{
  "data": {
    "available": true,
    "providerLabel": "AssemblyAI",
    "maxUploadBytes": 5368709120,
    "maxDurationMs": 36000000,
    "acceptedExtensions": [".mp3", ".m4a", ".wav", ".flac", ".mov"],
    "acceptedMimeTypes": ["audio/mpeg", "audio/m4a", "audio/wav", "audio/flac", "video/quicktime"]
  }
}
```

---

### Notes

Turning a transcript, another note, or an uploaded document into an
AI-generated, user-correctable document — issue #48 (epic #45), with export
added by issue #54. The design — the two state machines, prompt assembly and
the token budget, the streaming contract, the access model, and the full
privacy statement of what leaves this deployment and under whose account — is
[`docs/specs/notes.md`](specs/notes.md); this section only summarises it.

Two permissions, `notes:read` and `notes:write`, both **seeded to all three
roles including Viewer**: generating a note is the core product action this
epic exists to enable, and a brand-new account's default role is Viewer. A
permission model that made a fresh signup unable to make their first note
would contradict the product's own onboarding.

**There is deliberately no `notes:read_any`**, not even for an admin. A note
is derived from somebody's private conversation, exactly like a transcript,
and no permission string for reading another user's note exists anywhere in
this design, for any role, ever. **A caller with no access gets 404, never
403** — a 403 would confirm that a specific note id exists, and the existence
of a private conversation's id is itself something a stranger has no business
learning.

**Every write that changes the body carries a version conflict, not a
silent overwrite.** `PATCH /notes/{id}` requires `baseVersion` alongside
`body`; a mismatch is a **409** whose `details` names the reason and, for a
stale version, the note's actual current version:

```json
{
  "statusCode": 409,
  "code": "CONFLICT",
  "message": "…",
  "details": { "reason": "stale_base_version", "currentVersion": 4 }
}
```

`details.reason` is one of `stale_base_version`, `already_current`,
`generating`, `deleting`, `template_required`, `ai_not_configured`,
`ai_key_missing`, or `derived_notes_exist` (§ per-endpoint below). Two tabs
editing the same note is the ordinary case this exists to protect, not an
exotic one.

**`GET /notes/{id}` carries a weak ETag**, `W/"v<currentVersion>"`, and
honours `If-None-Match` with a **304 carrying no body** — the same
`versionETag`/`matchesETag` helper `GET /transcripts/{id}` uses, imported
rather than reimplemented. It is *weak* because two responses at the same
version are semantically, not byte-for-byte, equivalent.

**A note carries `titleSource` beside its `title`** (issue #180, epic #163) —
where the name came from, so an AI titling pass can tell a name it may improve
on from one it must leave alone. Two rules fix it, and nothing else writes it:
a non-blank `title` sent to `POST /notes` is `user`, and **any** `PATCH
/notes/{id}` that changes the title is `user` — including one that changes the
body in the same call. A body-only save never touches it.

| Field | Values |
|---|---|
| `notes.status` | `draft` → `generating` → `ready`/`failed`, plus `deleting`. `draft` means "never generated even once"; a note that already produced content goes back to `generating`, never to `draft` |
| `notes.titleSource` | `user` — a person typed this name, so it is **sticky and never overwritten by an AI titling path**; `template` — nobody named the note and it inherited the template's name; `ai` — a titling pass named it from the generated content |
| `note_generations.status` | `pending` → `streaming` → `succeeded`/`failed` |

#### POST /notes
Creates the note **and** queues its generation in one call — the same shape
`POST /transcripts` has: what the user asked for is "a note from this
recording," not "a row I will later ask you to fill in." Every check runs
before anything is created, so a refused request leaves no half-made note
behind.

**Requires:** `notes:write`

**Request:**
```json
{
  "title": "Weekly sync notes",
  "templateId": "…",
  "source": { "type": "transcript", "transcriptId": "…" },
  "contextText": "Focus on decisions, not discussion.",
  "model": "gpt-4o"
}
```

`title` defaults to the template's name — sending one records `titleSource:
"user"`, omitting it records `"template"`. `source` is a discriminated union —
`{ "type": "transcript", "transcriptId" }`, `{ "type": "note", "noteId" }`, or
`{ "type": "document", "objectId" }` — exactly the three `NoteSourceType`
members. There is **no `body` field, and there never may be one**: a note's
first version is `ai_generated` by construction, so a client that could
supply the initial body could mint a note whose history claims the AI wrote
text a user pasted in.

**Response:** `201`
```json
{
  "data": {
    "note": { "id": "…", "status": "draft", "currentVersion": 0, "…": "…" },
    "generationId": "…",
    "jobId": "…",
    "providerId": "openai",
    "model": "gpt-4o"
  }
}
```

⚠ The generation is billed to **your** provider account, not the
deployment's. Watch it arrive on `GET /notes/{id}/stream`; it completes
identically with nobody watching.

**Error Cases:**
- `400` - The assembled prompt does not fit the model's context window (the message names the numbers), or the model is not one this deployment permits
- `404` - The caller cannot read the source, or the template is not theirs and not a built-in
- `409` - `ai_key_missing` (the caller has saved no API key) or `ai_not_configured` (the deployment has not enabled AI, or permits no model this build can run)

---

#### GET /notes
The caller's notes, `updatedAt` descending, paginated by an **opaque cursor**
— generation and every save rewrite `updatedAt`, so offset paging would skip
and repeat rows.

**Requires:** `notes:read`

| Query | Meaning |
|---|---|
| `status` | One of `draft`, `generating`, `ready`, `failed`, `deleting` |
| `sourceType` | `transcript`, `note`, or `document` |
| `sourceTranscriptId` / `sourceNoteId` / `sourceObjectId` | Every note generated from one specific source |
| `templateId` | Every note produced by one template |
| `q` | Case-insensitive title substring |
| `cursor` | `nextCursor` from the previous page |
| `limit` | 1–100, default 20 |

**Response:** `{ "data": { "items": [...], "total": 42, "nextCursor": "…" | null } }`

`total` (issue #190) is how many notes **match the current filters**, ignoring
paging. It is counted over the same predicate the page is read with, minus the
keyset cursor clause, and both reads happen in one transaction — so it is
identical on page one and on every subsequent page of an unchanged filter set,
and a client can render "42 notes" once without watching the number fall as the
user pages. It is **not** "how many are left", and it is **not** `items.length`.

**Template previews never appear here** — a preview has no note (`noteId:
null`) and creates none; this route reads `notes`. Each row carries an
`excerpt` (the first 280 characters of the body), never the whole thing.

Every row also carries **`sourceName`** (issue #192): the name of the
transcript, note or document the note was generated from, denormalised beside
`templateName` so a client renders "from *Q3 planning*" without a second
request. It is resolved for the whole page in a bounded number of queries — at
most one per source kind, never one per row.

⚠ **`sourceName: null` means "no name available", never "no source".** A
deleted source, a soft-deleted one, and one the **caller may no longer read**
all answer the same way: a transcript shared with a user and later unshared
leaves the note pointing at it forever, and every lookup here is scoped to what
the caller may actually see so that this field can never publish a title they
cannot otherwise reach. Clients render the category noun ("a transcript") for
`null`.

---

#### GET /notes/summary
Three lists and four counts in one request: `inProgress`, `recent` (eight),
`failed` (eight), and `counts: { total, ready, inProgress, failed }`. Exists
so the home page renders in one round trip rather than four.

**Requires:** `notes:read`

---

#### GET /notes/exporters
Every registered note export format, with the options it accepts. The export
dialog builds itself from this response rather than from a list compiled
into the client.

**Requires:** `notes:read`

**Response:**
```json
{
  "data": {
    "exporters": [
      {
        "format": "pdf",
        "label": "PDF",
        "mimeType": "application/pdf",
        "extension": "pdf",
        "options": [
          { "key": "includeProvenance", "label": "Include provenance header", "description": "…", "type": "boolean", "default": true }
        ]
      }
    ]
  }
}
```

---

#### GET /notes/exports/{exportId}/download
A short-lived (15 minute) signed URL that serves the rendered file as an
attachment named `<title> (v<n>).<ext>`, with `Content-Disposition` signed
**into** the URL. No note id in the path — the export names its own note, and
access is decided on that note. An export belonging to somebody else's note
answers the same **404** a non-existent export id gets.

**Requires:** `notes:read`

**Response:** `{ "data": { "url": "…", "expiresAt": "…", "filename": "…", "mimeType": "…", "sizeBytes": "…" } }`

**Error Cases:**
- `404` - No such export, not ready yet, expired, or no access to its note

---

#### GET /notes/{id}
The note as it stands: its markdown `body`, `status`, `currentVersion`, which
provider and model produced the current text, and what it was generated
from.

**Requires:** `notes:read`

**Response:** `304` on an `If-None-Match` match to `W/"v<currentVersion>"`, otherwise the note. `404` with no access — never 403.

---

#### GET /notes/{id}/versions
Every save, newest first, cursor-paginated. `author: null` means the AI —
version 1 is always the provider's own output. Nothing in this API ever
deletes a version row short of the note being purged.

**Requires:** `notes:read`

---

#### GET /notes/{id}/versions/{version}
The note **as it was** at this version, in full — a stored full-body
snapshot, not an operation-log replay: a note is a page or two of prose, so
every version holds the whole markdown body. **Version 1 is always
retrievable.**

**Requires:** `notes:read`

---

#### PATCH /notes/{id}
Changes the title, the body, or both. A **body** change requires
`baseVersion` and appends a `note_versions` row with the caller as its
author — the AI's original is never overwritten. A **title** change is
deliberately not versioned, for the identical reason
`PATCH /transcripts/{id}` does not version a rename — but it does set
`titleSource` to `user`, on either path, because a person typing a name is the
strongest signal this application gets about what a note should be called.

**Requires:** `notes:write`

**Request:** `{ "body": "…", "baseVersion": 3, "summary": "Fixed the date", "clientBatchId": "…" }`

Send `clientBatchId` to make a retry safe: a repeat returns the original
result and creates no second version.

**Error Cases:**
- `400` - `baseVersion` missing alongside `body`, or neither field sent
- `404` - No such note, or no access to it
- `409` - `stale_base_version` (body names `details.currentVersion`) or `generating` (a generation is streaming into the note; it is the only writer until it settles)

---

#### POST /notes/{id}/regenerate
The **only** retry path — `note.generate` never auto-retries (`maxAttempts:
1`), because a second attempt would call the same provider with the caller's
own key and show different text than the partial stream already watched
fail. Queues a brand-new job with a fresh one-attempt budget. **History is
kept**: the previous body is already a version and stays one.

**Requires:** `notes:write`

**Request:** `{ "templateId": "…", "contextText": null, "model": "…" }` — every field optional; an empty body re-runs exactly what the note already records.

The web client sends **only the fields the user actually changed**: an
untouched form posts `{}`, and clearing the context box posts
`contextText: null` (the explicit clear this endpoint defines, distinct from
omitting the field). A changed `templateId` or `contextText` is persisted
onto the note and governs later regenerations too; `model` applies to this
generation alone.

⚠ Billed to **your** provider account.

**Error Cases:**
- `404` - No such note, template or source, or no access
- `409` - `generating` (already generating), `ai_key_missing`, or `ai_not_configured`

---

#### POST /notes/{id}/retitle
Name one note from what it actually says — the action behind "Suggest a
title" (issue #184, epic #163). Queues a `note.retitle` job and returns
**202** immediately: titling is a provider call, so it is queue work, not
something a request waits on. Re-read the note to see the new title.

The title comes from the same three ranks a freshly generated note is named
by (`docs/specs/notes.md` §3.4): the model that generated it is asked what it
would call it, falling back to the body's first heading or sentence, falling
back to the name it already has. **None of those fallbacks is an error** — a
caller with no API key saved gets a heading-derived title and a successful
job.

⚠ **This route will rename a note the caller named themselves**, and it is the
only one that will. Asking for a suggestion about a note in front of you is an
explicit choice, so it wins; the bulk sweep below never touches a name a
person chose, because it renames notes nobody is looking at. The previous
title is not kept anywhere — a title is metadata about the note, not versioned
content of it.

**Requires:** `notes:write` · **Response:** `202` with `{ "noteId": "…", "jobId": "…" }`

⚠ Billed to **your** provider account.

**Error Cases:**
- `404` - No such note, or no access to it
- `409` - `generating` (the generation names the note itself when it commits; two passes racing for one title spend tokens for one answer)

---

#### POST /notes/retitle
The bulk sweep: queue a `note.retitle` job for a capped page of the caller's
own notes that are **still named after the template that generated them**, and
report how many are left.

**Selected:** your own notes that are `ready`, not deleted, and whose
`titleSource` is still `template`. **Oldest `updatedAt` first** — a rename
touches the row, so a titled note moves to the back of that ordering and the
next call's page is the next hundred that still need it, with no cursor for
the caller to carry.

⚠ **A note whose `titleSource` is `user` or `ai` is never selected.** `user` is
a name a person chose. `ai` is a note this exact pass has already named from
its own content, and re-running it would spend the owner's money to re-derive
an answer they already have — which is also what makes the sweep terminate:
each success writes `titleSource: ai` and the note leaves the selection, so
`remaining` genuinely reaches `0`. Use `POST /notes/{id}/retitle` to re-name a
specific note regardless.

**Resumable and stoppable.** `queued` is what this call started; `remaining`
is what still matches, counted at request time, so it does not yet reflect the
jobs just queued. Call again once they settle. Stop by not calling again —
each note is its own job, independently retryable from the admin job list, and
no batch state is left behind. Calling twice does **not** queue a note twice:
a note with a `note.retitle` job already pending or running collapses into it.

At most **100** notes per call.

**Requires:** `notes:write` · **Response:** `202` with `{ "queued": 100, "remaining": 412 }`

⚠ Each note is a small completion billed to **your** provider account.

---

#### POST /notes/{id}/versions/{version}/restore
**History is never rewritten.** Appends a new version (`kind: restore`)
whose body is the old one's, recording `restoredFromVersion`. Every version
in between stays exactly as it was.

**Requires:** `notes:write`

**Request:** `{ "baseVersion": 5, "summary": "Reverted to Tuesday's draft" }` — `baseVersion` **must equal** the note's current version; a mismatch is a **409** naming `details.currentVersion`.

**Error Cases:**
- `404` - No such note or version, or no access
- `409` - `stale_base_version`, `already_current` (that version is already current), or `generating`

---

#### DELETE /notes/{id}
Owner only. Moves the note to `deleting` and queues `note.purge`, which
removes its rows and the storage artifacts it owns — its exports, and the
uploaded source document only when this note is the last thing referencing
it. The source **transcript is never touched**.

**Requires:** `notes:write` · **Response:** `204`

**Error Cases:**
- `404` - No such note, or the caller is not its owner
- `409` - `generating` (a purge would race the job writing to it), or `derived_notes_exist` (another note names this one as its source — lists the notes standing in the way)

---

#### POST /notes/{id}/exports
Renders one version of this note into one format — `markdown`, `pdf` or
`docx` — as a **queue job**. There is no size threshold below which an
export runs inline.

**Requires:** `notes:write`

**Request:** `{ "format": "pdf", "version": 3, "options": { "includeProvenance": true } }` — `version` defaults to the current version; `options` is validated against the chosen exporter's own schema from `GET /notes/exporters` (an unknown key is `400`).

**Response:** `202` when a render was queued; `200` when an identical
unexpired export already exists. The `reused` field on the body says which
happened. Every rendered format carries a **provenance header** naming the
source, the template used, the version exported and the generation
timestamp — there is no option to suppress it. Exports expire after **7
days**.

**Error Cases:**
- `400` - Unknown format, or an option that format does not accept
- `404` - No such note or version, or no access to it

---

#### GET /notes/{id}/exports
Every unexpired export of this note, newest first, each with its status and
— once `ready` — a short-lived signed `downloadUrl`. Requesting the same
export again queues a fresh render rather than returning a `failed` row, since
a failed row is never reused.

**Requires:** `notes:read`

---

#### POST /notes/sources/documents
Uploads a document to generate a note from. Multipart, single `file` part.
Stored as a storage object `managed_by: notes` — invisible to
`GET /storage/objects`, refusing the generic `DELETE` with a 409 — and a
`note.source.extract` job is queued to turn it into plain text.

**Requires:** `notes:write`. ⚠ It is `notes:write`, **not** `storage:write`
and not a new pair: uploading here is the first half of creating a note, and
gating it on `storage:write` would let a user who may upload arbitrary files
mint note-managed objects nothing will ever consume, while excluding a user
who may create notes but not upload arbitrary files from the feature.

Accepted types: `application/pdf`, `text/plain`, `text/markdown`. The size
ceiling is the `ai.maxDocumentBytes` system setting (25 MB by default) —
because every byte becomes input tokens on the uploading user's own vendor
account, not because of disk.

**Response:** `201`
```json
{
  "data": {
    "objectId": "…",
    "filename": "quarterly-plan.pdf",
    "mimeType": "application/pdf",
    "size": 214532,
    "jobId": "…",
    "status": "extracting"
  }
}
```

A password-protected, image-only, or corrupt PDF is **not** a failure of
this request: the upload succeeds, and extraction records a readable reason
the note UI shows. Optical character recognition is not supported.

**Error Cases:**
- `400` - Missing file, invalid multipart body, or a type this application cannot read
- `413` - Document exceeds `ai.maxDocumentBytes`

---

### Note Templates

CRUD over the reusable "recipe" (instructions, output format, structure,
tone, length, an optional per-template model override) a note is generated
from, plus preview — issue #50, epic #45. See
[`docs/specs/notes.md`](specs/notes.md) §4.3, §7.

Two permissions, `note_templates:read` and `note_templates:write`, both
seeded to all three roles — a **separate pair from `notes:*`**, not folded
in: templates and notes are governed by two different controllers with two
different write surfaces (editing a recipe versus generating content).

**The two refusals, side by side, because they look inconsistent and are
not:**

| Action | Outcome | Why |
|---|---|---|
| `PATCH`/`DELETE` a **built-in** template | **403** | Its existence is public — it is in every account's own catalogue |
| `PATCH`/`DELETE` **another user's** template | **404** | Its existence is private |

Both decisions are made in exactly one place
(`access/note-template-access.service.ts`), and both are asserted next to
each other in the integration suite so the difference reads as designed
rather than as a bug. Built-ins are immutable through this API under every
role, which keeps the seeded set a stable baseline — `POST /{id}/duplicate`
is how a user customises one.

#### GET /note-templates
The caller's own templates **plus every built-in**, in one list, each
flagged `builtIn`. Another user's templates are never included, under any
role.

**Requires:** `note_templates:read`

**Query:** `includeArchived` (default `false`) — include the caller's own archived templates; built-ins are never archived.

**Response:** `{ "data": { "items": [...], "total": 12 } }` — not paginated.

---

#### POST /note-templates/preview
Try a template — saved or unsaved — against a real source, before trusting
it with a real note. Send either a saved `templateId` (the caller's own, or
a built-in) **or** an unsaved `template` body, exactly one of the two.

**Requires:** `note_templates:write`. ⚠ **This is a real generation, billed
to the caller's own provider account.** It is the same `note.generate` job,
the same prompt assembly, the same token budget and the same error taxonomy
a real note uses — there is no cheaper "simulated" path. `POST /:id/preview`
was the route `docs/specs/notes.md` §6.3 originally sketched; issue #50
supersedes it with the collection-level route above, on `note_templates:write`
because the action performed is "try this template," not a read of the
templates collection.

**Request:**
```json
{
  "templateId": "…",
  "source": { "type": "document", "objectId": "…" },
  "contextText": "…",
  "model": "gpt-4o-mini"
}
```

**Response:** `202`
```json
{
  "data": {
    "generationId": "…",
    "kind": "preview",
    "status": "pending",
    "jobId": "…",
    "templateId": "…",
    "templateName": "Meeting notes",
    "providerId": "openai",
    "model": "gpt-4o-mini",
    "expiresAt": "…"
  }
}
```

**A preview creates no template and no note.** Its generation row has
`noteId: null`, never appears in `GET /notes`, and is hard-deleted at
`expiresAt` (10 minutes) by `notes.housekeeping`.

**Error Cases:**
- `400` - Unpermitted model, or the prompt exceeds the token budget (the message names the numbers)
- `404` - No such template or source, for the caller — never 403
- `409` - AI is not configured, or the caller has no API key

---

#### GET /note-templates/{id}
The caller's own, or a built-in.

**Requires:** `note_templates:read` · **Error Cases:** `404` - No such template, for the caller

---

#### POST /note-templates
Creates a template owned by the caller. There is no `ownerId` field and
there never may be one: a client that could name an owner could name `null`,
which is exactly how a user would mint a built-in.

**Requires:** `note_templates:write`

**Request:** `{ "name": "Meeting notes", "instructions": "…", "outputFormat": "meeting_notes", "structure": ["Overview", "Decisions"], "tone": null, "length": null, "model": null }`

Names are unique among the caller's own templates only. `instructions` over
its 20,000-character ceiling is a **400** naming both the submitted size and
the limit.

**Error Cases:**
- `400` - Invalid body, or oversized instructions
- `409` - The caller already has a template with that name

---

#### PATCH /note-templates/{id}
Edits one of the caller's own templates. Every field optional; an explicit
`null` on `tone`, `length` or `model` clears it.

**Requires:** `note_templates:write`

**Error Cases:**
- `400` - Invalid body, or oversized instructions
- `403` - Built-in templates are immutable
- `404` - No such template, for the caller
- `409` - The caller already has a template with that name

---

#### DELETE /note-templates/{id}
**Archives rather than deletes when notes still reference it**, and says
which happened in `outcome`. The referencing note keeps its `templateId`
either way.

**Requires:** `note_templates:write`

**Response:** `{ "data": { "id": "…", "outcome": "archived", "noteCount": 3 } }`

**Error Cases:**
- `403` - Built-in templates are immutable
- `404` - No such template, for the caller

---

#### POST /note-templates/{id}/duplicate
**This is how you customise a built-in.** Works against any template the
caller can read — a built-in, or another of their own — and produces a new
row owned by the caller, with a suffixed name. The original is untouched.
Every column is copied, not just `instructions`. No lineage is recorded.

**Requires:** `note_templates:write` · **Response:** `201`

**Error Cases:**
- `404` - No such template, for the caller

---

### AI Settings

The deployment AI policy — is AI on, which provider is active, which models
are permitted, and the token/timeout/document ceilings every generation runs
under — issue #47, epic #45; the active-provider axis, live model discovery
and the widened `allowedModels` entry are issue #78; the five-rank
resolution chain that lets a model be permitted with **no typed numbers at
all**, and the raised `allowedModels` cap, are issue #97. See
[`docs/specs/notes.md`](specs/notes.md) §2.5, §6.4.

Gated on `system_settings:read` / `system_settings:write`, **not a
permission pair of its own**: this configuration is the `ai` namespace of
the `global` `system_settings` row that `system-settings.controller.ts`
already gates on exactly those strings, so a separate pair would make the
same bytes reachable under two different authorities — the same argument the
Transcription section above makes for its own settings.

⚠ **Nothing here ever touches a credential, and there is no admin path to
one.** Epic #45 is strict bring-your-own-key: every AI key belongs to an
individual user (`/api/ai-credentials` below), encrypted at rest and
unreadable through the API by design, for any role including an
administrator. There is deliberately no deployment-wide fallback key — a
user with no key has no AI features. **`GET /ai-settings/models` below is the
one exception to "no credential is touched here" in spirit, not in storage**:
it spends the *calling administrator's own* saved key to ask the provider a
question, but never accepts, stores or returns one.

#### GET /ai-settings
The deployment AI policy and the provider catalogue (models and form fields)
the admin page renders itself from.

**Requires:** `system_settings:read`

**Response:**
```json
{
  "data": {
    "settings": {
      "enabled": true,
      "provider": "openai",
      "providers": { "openai": { "baseUrl": "https://api.openai.com/v1", "allowedModels": [ "gpt-4o", { "id": "gpt-4o-mini" }, { "id": "o5-preview", "label": "O5 Preview", "contextWindowTokens": 300000, "maxOutputTokens": 32768 } ], "defaultModel": "gpt-5.4-mini" } },
      "maxInputTokens": 100000,
      "maxOutputTokens": 16384,
      "requestTimeoutMs": 600000,
      "reasoningEffort": "none",
      "maxDocumentBytes": 26214400
    },
    "providers": [ { "id": "openai", "label": "OpenAI", "capabilities": { "models": [ "…" ], "streaming": true, "modelDiscovery": true }, "fieldDescriptors": [ "…" ] } ],
    "unknownModels": [],
    "version": 3,
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "updatedBy": { "id": "…", "email": "admin@example.com" }
  }
}
```

`provider` (#78) is the active provider, or `null` when none has been
chosen — a separate axis from `enabled`, so an operator can switch vendors
without touching the master switch or vice versa. Every hardcoded `'openai'`
consumer literal is gone from this application; adding a second
OpenAI-API-compatible vendor costs an id in `AI_PROVIDER_IDS`, a block in the
provider schema and a provider class, with no consumer edit anywhere.

**`allowedModels` entries are now objects**, not bare strings (#78): each is
`{ id, label?, contextWindowTokens?, maxOutputTokens? }`. A bare string
(`"gpt-4o"`) is still accepted on write and always will be — every
deployment that saved a policy before #78 has strings stored right now — and
it is read back normalised to `{ id: "gpt-4o" }`.

**Since issue #97, `contextWindowTokens`/`maxOutputTokens` are optional in
practice, not merely in the schema.** An administrator no longer has to
supply either number to permit a model. Resolution is a five-rank chain,
applied per number: (1) the entry's own typed value, (2) an exact hit in
this build's catalogue, (3) the provider's own family derivation — a dated
snapshot id such as `gpt-5.4-mini-2026-03-17` takes its family's (
`gpt-5.4-mini`'s) full window — (4) the provider's conservative floor, (5)
unresolved. `GET /ai-settings/models` and `GET /api/ai/config` both report
which rank answered as `source`, plus `derivedFrom` when it was rank 3, so a
client never presents an inference as a verified number. Typed numbers
always outrank everything derived — see
[`docs/specs/notes.md`](specs/notes.md) §2.5 for the full precedence and the
argument for why a conservative floor is safe to fall back to when a typed
number is not, an asymmetry that supersedes the narrower "an unknown model
needs both numbers typed" reading §2.5 previously stated.

`unknownModels` lists model ids the policy permits that **nothing** in this
deployment can budget for — no typed numbers on the entry, no catalogue
hit, no family derivation, and no provider floor. Such a model is never
offered to a user. **Since #97 this is a much narrower list than it used to
be**: in practice it now means only a policy naming a provider this build
does not implement (or a rollback across the addition of one), or a
provider that has deliberately declined to declare a floor — not "this
build has never heard of the model," which resolves automatically now.

`providers[].capabilities.modelDiscovery` (#78) says whether
`GET /ai-settings/models` will work for that provider at all — a provider
with no live model list still accepts any model id typed by hand.

---

#### PUT /ai-settings
Updates the AI policy. Every field optional — send only what changed. **This
endpoint never accepts an API key** — there is no field for one.
`allowedModels` **replaces the stored list wholesale**, RFC 7396's rule for
arrays: a merging list could never express "stop permitting this model."
`provider` may be set to `null` to unset the active provider, or to one of
the ids in `AI_PROVIDER_IDS`; when a request changes `provider` in the same
body as `allowedModels`, the submitted models are validated against the
**new** provider's catalogue, not the previously stored one.

An `allowedModels` entry may be a **bare model id** (`"gpt-4o"`) or an
**object** (`{ "id": "o5-preview", "label": "O5 Preview",
"contextWindowTokens": 300000, "maxOutputTokens": 32768 }`). Both forms are
accepted forever and both are read back as objects. **Since #97 the two
numbers are optional on the object form too** — see the resolution chain
above; they remain the way to override what this deployment would otherwise
derive or fall back to, which is the one rank nothing below it can beat.
`allowedModels` is capped at **200 entries** (raised from 50 by #97, since a
vendor's whole discovered catalogue is now realistically selectable in one
pass rather than hand-typed two numbers at a time) — the cap bounds the
stored settings blob, not how many models a deployment may permit.

**Requires:** `system_settings:write`

**Headers:** `If-Match: <version>` (optional) — `0` asserts nothing is stored yet; omit to overwrite unconditionally.

**Response:** the updated policy, re-read from storage, in the `GET` shape above.

**Error Cases:**
- `400` - Validation error, or an `allowedModels` entry **nothing** in this deployment can budget for — no typed numbers, no catalogue hit, no family derivation, and no provider floor (in practice: the policy names a provider this build does not implement). The message names the missing field(s) and is not a statement that the model is forbidden.
- `409` - Version conflict

---

#### GET /ai-settings/models
Asks the configured (or a named) provider's own API which models it offers,
so `allowedModels` can be chosen from a live list instead of typed from
memory (#78). This is what makes the policy independent of the handful of
models compiled into this build's own catalogue.

⚠ **This spends a real vendor call, on the *calling administrator's own* API
key** — this deployment stores no AI key of any kind (every key belongs to
an individual user), so discovery has to authenticate as the administrator
making the request. The list returned is the one **that key** can reach,
which on OpenAI is project-scoped: two administrators can legitimately see
different lists. The policy saved from this list is checked against
**neither** — it is checked against each user's own key, at generation time,
which is the only authority that matters when a request is actually made.
This is also why the route is gated on `system_settings:write` rather than
`:read`: looking at settings is not probing a third party.

⚠ **This returns HTTP 200 even when the provider refused the call.** Read
`ok` and show `detail` — it distinguishes "the key is wrong," "the account
has no credit" and "the endpoint is unreachable." This is the thing a client
author is most likely to get wrong: a non-2xx is *not* the only failure mode
here, because there isn't one — the route answers 200 either way.

**Requires:** `system_settings:write`

**Query:**
- `?provider=` (optional) — which provider to ask; defaults to the active
  one. Naming a different provider lets an administrator inspect its
  catalogue **before** switching to it.
- `?includeAll=true` (optional, issue #97) — skip the plausible-chat-model
  filter and return the provider's **whole** list. The filter
  (`NON_CHAT_MODEL_MARKERS`) is a convenience over an unstructured vendor
  list — OpenAI's `GET /models` returns embeddings, TTS voices and
  moderation endpoints in the same flat array as chat models, with no
  capability field to tell them apart — and it can only hide a row from this
  dropdown, never make a model unusable: `allowedModels` accepts any id
  typed by hand regardless of whether discovery showed it. `includeAll` is
  the escape hatch for when the heuristic hides something real.

**Response (success):**
```json
{
  "data": {
    "ok": true,
    "detail": "The provider listed 42 chat-capable model(s). Models this build already knows the context window of are marked as such; for any other, a context window and output ceiling were derived or a conservative default was used.",
    "models": [
      { "id": "gpt-4o", "label": "GPT-4o", "known": true, "contextWindowTokens": 128000, "maxOutputTokens": 16384, "source": "catalogue", "derivedFrom": null },
      { "id": "gpt-5.4-mini-2026-03-17", "label": "gpt-5.4-mini-2026-03-17", "known": false, "contextWindowTokens": 400000, "maxOutputTokens": 128000, "source": "derived", "derivedFrom": "gpt-5.4-mini" },
      { "id": "o5-preview", "label": "o5-preview", "known": false, "contextWindowTokens": 128000, "maxOutputTokens": 16384, "source": "default", "derivedFrom": null }
    ]
  }
}
```

**Response (vendor refusal — still HTTP 200):**
```json
{ "data": { "ok": false, "detail": "The provider rejected this API key (HTTP 401). Check that you pasted the whole key and that it has not been revoked in your provider account.", "models": [] } }
```

**Every model now comes back with a usable `contextWindowTokens` and
`maxOutputTokens` (issue #97).** Before #97 both were `null` for any id
absent from the build catalogue, and a client had to collect them from the
administrator by hand before the model could be saved into `allowedModels`.
They are now filled by the same five-rank resolution `PUT /ai-settings`
itself uses — the exact catalogue entry, then the model's family (a dated
snapshot such as `gpt-5.4-mini-2026-03-17` takes `gpt-5.4-mini`'s window),
then the provider's conservative floor — and `source` names which rank
answered (`'catalogue' | 'derived' | 'default'`; `'explicit'` cannot appear
here, since discovery resolves a bare id with no policy entry behind it).
`derivedFrom` names the family, non-null exactly when `source` is
`'derived'`. **The two numbers remain nullable** and `null` still means
"nothing could answer" — reachable now only for a provider that declares no
conservative floor. `known` is **unchanged** and still means an exact
build-catalogue hit; it does **not** mean "needs numbers typed before it can
be permitted" any more — `source` is the field that answers how much of the
pair is verified knowledge versus an inference. The list is sorted
known-models-first, then by resolution strength, then alphabetically.

**Error Cases:**
- `400` - No provider is active and none was named in the query, the named provider is not implemented by this build, the provider cannot list models at all (`capabilities.modelDiscovery: false`), or this deployment's stored settings for that provider are invalid
- `409` - `details.reason: "ai_key_missing"` — **you**, the calling administrator, have saved no API key for that provider under `/api/ai-credentials`. There is no deployment key to fall back to.

---

#### POST /ai-settings/test
Checks that the configured API base URL resolves, terminates TLS and
answers like an OpenAI-compatible API. Supply `baseUrl` to probe a URL
**before** saving it.

⚠ **This is a reachability probe, not a credential probe** — it sends no
key, because this deployment holds none. ⚠ **An HTTP 401 or 403 from the
endpoint is reported as `ok: true`** — an unauthenticated request to a
correctly configured API root is *supposed* to be refused, and that refusal
is the proof the endpoint exists and speaks the protocol; treating it as a
failure would make a correctly configured deployment look broken. ⚠ **This
returns HTTP 200 even when the probe failed** — read the `ok` field and show
`detail`, which distinguishes "unreachable", "wrong path" and "answering
normally".

**Requires:** `system_settings:write` — probing is side-effecting (it spends
an outbound request), and `:read` is held by anyone who may look at
settings. Looking is not probing.

**Request:** `{ "baseUrl": "https://api.openai.com/v1" }` (optional)

**Response:** `{ "data": { "ok": true, "latencyMs": 212, "detail": "…" } }`

---

### AI Credentials

A user's own AI provider key — issue #47, epic #45. See
[`docs/specs/notes.md`](specs/notes.md) §4.2, §9.

Four operations, all `@Auth()` with **no permission string**, and that is the
deliberate answer, not an oversight: the resource is not a feature of this
application, it is the caller's **own credential**, scoped by `userId` in the
query itself. An RBAC permission gates what a role may do to the
application's resources; nothing about a role should decide whether a person
may manage a secret that belongs to them and is billed to them. The nearest
precedent is `/api/user-settings` and `/api/pat`, likewise
ownership-scoped rather than permission-scoped. Ownership is enforced by
`@CurrentUser('id')` reaching every service call's `where` clause — there is
no route parameter naming a user, so there is no id for a caller to
substitute.

⚠ **The key itself is never returned by any response, on any route, for any
role.** It is encrypted at rest under `secret-cipher.ts`'s `'ai-key'` purpose,
and no endpoint's presentation query even selects the ciphertext column.

#### GET /ai-credentials
The caller's **own** stored AI keys — one entry per provider — with a masked
hint, their label and timestamps.

**Requires:** Authenticated, no permission

**Response:** `{ "data": { "credentials": [ { "provider": "openai", "configured": true, "hint": "••••a1b2", "label": "work", "lastUsedAt": "…", "updatedAt": "…" } ] } }`

---

#### PUT /ai-credentials
Stores the caller's **own** provider API key, encrypted. Replacing an
existing key for the same provider overwrites it; there is never a second
row.

**Requires:** Authenticated, no permission

**Request:** `{ "provider": "openai", "apiKey": "sk-…", "label": "work" }` — `apiKey` is **write-only** and never returned. Blank or absent **keeps the stored key** (useful for changing only the label) — blank never means "erase"; erasing is the `DELETE` below.

⚠ Billed to **your** provider account. This application never uses it for
anybody but you, and there is no deployment-wide fallback.

**Error Cases:**
- `400` - Unknown provider, or no key supplied and none stored

---

#### POST /ai-credentials/test
Probes the provider with the supplied key, or the caller's stored key when
none is supplied. **The supplied key does not need to have been saved** —
proving a key before committing it is the workflow this endpoint exists for.

⚠ **This returns HTTP 200 even when the probe failed**, the same convention
`POST /transcription-settings/test` establishes for its own probe. A refused
probe is a successful diagnosis — read the `ok` field and show `detail`,
which distinguishes "the key is wrong" (HTTP 401), "the key is valid but the
account is restricted" (403), "the key is valid but rate-limited or out of
credit" (429), and "the endpoint was unreachable" (a transport failure, not
an API one). Treating 200 as "the key works" reports success for every
misconfiguration there is.

**Requires:** Authenticated, no permission

**Request:** `{ "provider": "openai", "apiKey": "sk-…" }` — `apiKey` optional, falls back to the caller's stored key

**Response:** `{ "data": { "ok": false, "latencyMs": 340, "detail": "The provider rejected this API key (HTTP 401). Check that you pasted the whole key and that it has not been revoked in your provider account." } }`

**Error Cases:**
- `400` - Unknown provider, or no key supplied and none stored — a different thing from a failed probe

---

#### DELETE /ai-credentials/{provider}
Erases the caller's own stored key for one provider. **The only way to
remove a key** — an empty `apiKey` on `PUT` preserves the stored one,
deliberately, because the form renders that box empty. Idempotent: removing
a key that is not there succeeds.

**Requires:** Authenticated, no permission · **Response:** `204`

**Error Cases:**
- `400` - Unknown provider

---

#### GET /ai/config
What this deployment permits, **and whether the calling user has a key** —
for a client deciding whether to offer AI at all and, if so, whether to show
the feature or the "set up your key" prompt. Modelled on
`GET /transcription/config` and `GET /notifications/config` for the identical
reason: the deployment policy (`GET /ai-settings` above) is gated on
`system_settings:read`, which the seeded Viewer and Contributor roles do not
hold — so the users this capability affects are precisely the users who
cannot read it.

**Requires:** `notes:read` — seeded to all three roles, exactly like
`transcripts:read` gates `GET /transcription/config`, rather than left merely
authenticated: naming a real permission the feature actually has, since the
permission is universal here.

`available` is true only when AI is enabled, the configured provider is
registered in this build, at least one permitted model is one this build can
budget requests for, and the token ceilings leave room for input.
⚠ **`keyConfigured` is the single boolean every AI surface in this
application gates on** — false means show the "set up your AI key" prompt,
true means show the feature. It is per-**caller**, resolved without
decrypting anything, and deliberately **independent of `available`**: a user
can save and verify a key before an administrator finishes enabling the
feature, and an enabled deployment still does nothing for a user with no key.

⚠ **`provider`/`providerLabel` are independent of `available` for the same
reason (issue #83)** — they answer *which vendor a key would belong to*, not
*may AI be used right now*. `provider` is populated whenever this deployment
names a provider this build recognises, including while AI is switched off
or nothing is permitted yet, specifically so a user can save and verify
their own key before an administrator finishes enabling the feature: a
non-null `provider` alongside `available: false` is the ordinary state of a
deployment mid-setup, not a bug. `provider: null` means only that there is
genuinely no vendor to name — either none is configured, or the configured
one is unknown to this build — **never** that AI is unavailable. A client
that reads `provider: null` as "AI is unavailable," or that gates the
key-entry form on `available` rather than on `provider`, reproduces exactly
the setup deadlock #83 fixed.

**No configuration detail is published here** — not the base URL, not the
request timeout, and nothing derived from anyone's key beyond the boolean
fact that the caller has one. `models`/`defaultModel` are already narrowed by
policy, so a client can offer them directly without re-checking.

**Each model carries `source`/`derivedFrom` (issue #97)**, resolved through
the same five-rank chain `PUT /ai-settings` and `GET /ai-settings/models`
use: `explicit` (an administrator typed the numbers), `catalogue` (an exact
hit in this build's verified list), `derived` (placed in a known family —
`derivedFrom` names it), or `default` (this vendor's conservative floor,
because nothing better was available). It is the **weakest** of the two
numbers' sources, so a model whose window was derived but whose output
ceiling fell back to the floor still reports `default`. All four are
usable; a client showing an inference as a verified figure is the one thing
this field exists to prevent. The `contextWindowTokens`/`maxOutputTokens`
values here are already narrowed by deployment policy (`Math.min` against
`maxInputTokens`/`maxOutputTokens`) — that narrowing never changes `source`.

**Response:**
```json
{
  "data": {
    "available": true,
    "provider": "openai",
    "providerLabel": "OpenAI",
    "models": [
      { "id": "gpt-5.4-mini", "label": "GPT-5.4 mini", "contextWindowTokens": 400000, "maxOutputTokens": 128000, "source": "catalogue", "derivedFrom": null },
      { "id": "gpt-5.4-mini-2026-03-17", "label": "gpt-5.4-mini-2026-03-17", "contextWindowTokens": 400000, "maxOutputTokens": 128000, "source": "derived", "derivedFrom": "gpt-5.4-mini" }
    ],
    "defaultModel": "gpt-5.4-mini",
    "maxInputTokens": 100000,
    "maxOutputTokens": 16384,
    "keyConfigured": false
  }
}
```

---

### Note Generation Streams

Server-sent events over one `note_generations` row — issue #52, epic #45. See
[`docs/specs/notes.md`](specs/notes.md) §5.

Two routes, one reader:

- `GET /notes/{id}/stream` — attaches to the note's `currentGenerationId`
- `GET /note-generations/{id}/stream` — attaches to a generation by its own
  id, the **only** reachable form for a **template preview**, which has no
  note to be addressed through

Both resolve to a single `note_generations` row and hand it to the same
reader; the bytes they emit are identical. **Requires:** `notes:read` on
both — watching a note being written is reading it, and `notes:read` is
seeded to all three roles precisely because generating a note is the core
product action in this epic. A note (or generation) the caller cannot see
answers **404**, never 403, on both routes.

⚠ **A native browser `EventSource` cannot be used against either route.**
Both take the ordinary `Authorization: Bearer …` header, and `EventSource`
accepts no headers; a `?token=` query parameter is rejected because a URL is
written verbatim into the nginx access log, kept in browser history, and
forwarded in `Referer` — turning a live bearer credential into something
replayable out of a log file. `apps/web/src/services/sse.ts` is the
fetch-based client built for this.

**Resuming with `Last-Event-ID`.** Every frame's `id:` is the **buffer
offset it ends at** (a UTF-16 code-unit index into the accumulated text, not
`note_generations.last_event_id`, which stays a separate "has anything
changed?" counter). Reconnect with the `Last-Event-ID` header (or
`?lastEventId=` for a client that cannot set headers — the header wins when
both are present) carrying the last id seen, and the response resumes from
exactly there: no repeated text, no lost text. A generation that has already
finished is not a special case — the endpoint replays whatever the caller's
offset was missing and then immediately emits `done`.

**Frame shapes:**

| Event | Data |
|---|---|
| `delta` | `{ "delta": "…", "offset": n }` — text appended since the client's position |
| `done` | `{ "status": "succeeded", "offset": n, "currentVersion": n \| null }` — `currentVersion` is `null` for a preview, which has no note |
| `error` | `{ "status": "failed", "offset": n, "errorClass": "auth" \| "refusal" \| "rate_limit" \| "other" \| "timeout" \| "gone", "reason": string \| null }` |

Plus `: heartbeat` comment lines roughly every 25 seconds, so a proxy does
not reap the connection during a long wait for the first token.

⚠ **`errorClass` carries two wire-only values that never exist in
`note_generations.error_class`**: `timeout` (the connection hit its duration
cap while the generation was still not terminal — the job may well be fine;
this is the reader giving up, not the work failing) and `gone` (the row
disappeared mid-connection — a preview's TTL sweep, or the parent note being
purged). The other four (`auth`, `refusal`, `rate_limit`, `other`) are the
stored classes, verbatim.

**Termination.** Terminal status; the client disconnecting; or a hard
duration cap derived from the generation job's own timeout, which answers
`error` with `errorClass: "timeout"` so a wedged job can never pin a
connection open. **The stream is additive** — the note completes identically
whether or not anyone ever connects.

**Example:**
```
: connected

event: delta
id: 27
data: {"delta":"# Weekly sync\n","offset":27}

event: done
id: 812
data: {"status":"succeeded","offset":812,"currentVersion":1}

```

---

### Search

Ranked full-text search over the **content** of your transcripts and notes —
issue #175 (issue #177 documents it), epic #164. Full design (the ranking
model, the index, the cursor, visibility, snippets, degradation) is
[`docs/specs/search.md`](specs/search.md).

#### GET /search

Searches transcript segments/titles and note titles/bodies, scores matches
with `ts_rank_cd` (cover-density ranking, which rewards query terms
appearing close together rather than simply often), and rolls each document
up to the score of its **best** matching passage — never the sum of all its
passages, so a short recording that is *about* a term outranks a long one
that mentions it thirty times in passing.

**Query parameters:**

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `q` | string | Yes | 1–256 characters. |
| `types` | string (CSV) | No | `transcript`, `note`, or both, comma-separated. Defaults to both. An **empty or unrecognised** value is a 400, never silently widened to "both". |
| `limit` | integer | No | 1–50, default 20. |
| `cursor` | string | No | Opaque, from a previous response's `nextCursor`. Tied to the exact `q`, `types` actually searched, caller and ranking model that produced it — see below. |

**Requires:** `transcripts:read` for transcript results, `notes:read` for
note results. **The route itself declares neither permission** —
`PermissionsGuard` requires *all* declared permissions, and this endpoint's
real requirement is *either* one, which no permission decorator can
express. A caller holding only one of the two permissions and requesting
both types is answered with the type they hold — **not a 403** —and
`searchedTypes` in the response names what was actually searched. A caller
holding **neither** permission gets a 403. Notes have no sharing and no
`notes:read_any`; transcripts have no `transcripts:read_any` either — this
endpoint can only ever surface your own notes and transcripts you own or
hold a share on, the same as reading them directly.

**Response:**
```json
{
  "data": {
    "results": [
      {
        "type": "transcript",
        "id": "uuid",
        "title": "Q3 Pricing Review",
        "score": 0.607927,
        "updatedAt": "2024-01-01T00:00:00.000Z",
        "status": "ready",
        "snippets": [
          {
            "html": "...quarterly <mark>pricing</mark> <mark>review</mark> is scheduled for...",
            "startMs": 184200,
            "field": "segment"
          }
        ]
      },
      {
        "type": "note",
        "id": "uuid",
        "title": "Pricing decisions",
        "score": 0.243819,
        "updatedAt": "2024-01-02T00:00:00.000Z",
        "status": "ready",
        "snippets": [
          { "html": "We agreed the new <mark>pricing</mark> takes effect...", "startMs": null, "field": "body" }
        ]
      }
    ],
    "matchedDocuments": 2,
    "truncated": false,
    "nextCursor": null,
    "degraded": null,
    "searchedTypes": ["transcript", "note"]
  }
}
```

**Response fields:**

- `results[].score` — comparable **within this one response only**; it is a
  raw `ts_rank_cd` value with no absolute scale, so it is meaningless
  compared across two different searches.
- `results[].snippets[].html` — **pre-escaped HTML.** The only markup in it
  is balanced `<mark>...</mark>` around the matched terms; every character
  the source text contributed that would otherwise be markup (`&`, `<`,
  `>`, `"`, `'`) is HTML-entity-escaped first. A client renders this
  directly and must **not** re-escape it or otherwise treat it as plain
  text, and must not attempt anything beyond locating `<mark>` boundaries in
  it — it is not a template.
- `results[].snippets[].startMs` — milliseconds into the recording, for a
  client to seek to. `null` for a note, and for a transcript **title**
  match (a title has no position in the audio).
- `matchedDocuments` / `truncated` — the candidate window holds at most 200
  documents. `matchedDocuments` counts how many are in it (never more than
  200); `truncated: true` means the window filled up, so
  `matchedDocuments` is a floor, not an exact count. **There is
  deliberately no `total`** — with a bounded window, a `total` field would
  report the cap rather than a real count for any corpus larger than it.
- `nextCursor` — `null` when this page reached the end of the candidate
  window; otherwise an opaque cursor for the next page.
- `degraded` — `"stopwords"` when `q` parsed to an empty full-text query
  (e.g. `"the and of"`) and the endpoint fell back to the same
  case-insensitive **title** substring match `GET /transcripts?q=` and
  `GET /notes?q=` already use, ordered newest-first with no `score`.
  `null` on the normal ranked path. A client should say "showing title
  matches" rather than presenting a degraded result as a ranked one.
- `searchedTypes` — the types actually searched, i.e. `types` narrowed to
  what the caller's permissions allow. This is how a partial answer
  announces itself; see the permissions note above.

**Error Cases:**
- 400 Bad Request - Missing/empty/oversized `q`, an unrecognised `types` value, `limit` out of range, or a `cursor` from a **different** search (different query text, different type filter, a different caller, or produced under an earlier ranking model version). Refused rather than silently restarted — see `docs/specs/search.md` §5 for why a relevance cursor cannot forgive the way the transcript/note list cursors do
- 403 Forbidden - The caller holds neither `transcripts:read` nor `notes:read`

---

### User Data

The "Danger Zone" — an authenticated user asking this deployment to forget
some or all of the data it holds for them, in bulk — issue #80. The two-layer
product design, the scope matrix, the FK-clearing order, the retry path, why
the job is server-only, and the honest gaps are
[`docs/specs/user-data-deletion.md`](specs/user-data-deletion.md); this
section documents the wire contract only.

Two routes, both `@Auth()` with **no permission string**, deliberately. The
resource is not a feature of this application; it is the caller's **own
data**, scoped by `userId` in the query itself — the identical posture
`ai-credentials.controller.ts` takes (see `### AI Credentials` above), and
the nearest precedent for the same reason: gating either route on a real
permission (`transcripts:write` + `notes:write`, say) would strand exactly
the user who needs this most. A deployment that has revoked someone's write
permission — offboarding, a downgraded role, a misconfigured seed — would
also have revoked their ability to remove the data it is still holding for
them, while leaving the data there. **There is no admin surface here, for
any role** — nobody but the owner can summarise or delete a user's data
through this API.

**Scope matrix.** `scopeIncludes` in `apps/api/src/user-data/job-types.ts` is
the one definition; the table below is a rendering of it, not a second copy.
Every narrow scope maps to exactly one category — only the two composites fan
out:

| Scope | Transcripts | Notes | Note Templates | Files | Credentials |
|---|:---:|:---:|:---:|:---:|:---:|
| `transcripts` | ✓ | | | | |
| `notes` | | ✓ | | | |
| `files` | | | | ✓ | |
| `content` | ✓ | ✓ | ✓ | ✓ | |
| `everything` | ✓ | ✓ | ✓ | ✓ | ✓ |

`content` is everything the user **made**; `everything` is `content` plus
their **credentials** (AI provider keys and personal access tokens) — the
only line the two composites differ on. ⚠ Note templates ride with
`content`/`everything` **only** — the narrow `notes` scope does **not**
remove them. A template is reusable configuration with its own settings
page, not note content, and a user who clicked "Delete notes" was told they
were deleting notes, not silently emptying a different settings page.

**No scope deletes the account.** The `users` row, `user_roles`,
`refresh_tokens` and the caller's session are untouched by every scope,
including `everything` — the caller stays signed in throughout and afterward.

`everything` touches exactly one thing in `user_settings`: it clears the
`onboarding` namespace (epic #271), so the welcome and the setup checklist are
offered again from the start. Every other namespace — `theme`, `profile`,
`navigation`, `notifications`, `dataTables` — survives every scope, including
`everything`. `everything` does revoke every AI provider key and personal
access token the caller holds, so any CLI or script authenticating with one
stops working immediately.

#### GET /user-data/summary
Per-category row counts and the storage bytes behind them, plus whatever
deletion is already in flight for the caller. Scoped entirely to
`@CurrentUser('id')` — there is no parameter naming a user, so there is no
way to ask about anybody else.

**Requires:** Authenticated, no permission

`bytes` is a **decimal string**, not a number, the same convention the
database backup's `bytes` uses: summing `storage_objects.size` (`BigInt`)
for a large media library can exceed `Number.MAX_SAFE_INTEGER`, and a JSON
number would silently round the figure shown in a confirmation dialog.
Counts exclude anything already soft-deleted and awaiting purge — they
shrink only when the caller acts, never on their own.

**Response:**
```json
{
  "data": {
    "transcripts": { "count": 12, "bytes": "3821004521" },
    "notes": { "count": 40, "bytes": "184220" },
    "files": { "count": 3, "bytes": "552012" },
    "noteTemplates": { "count": 2 },
    "credentials": { "aiKeys": 1, "accessTokens": 2 },
    "activeDeletion": null
  }
}
```

`activeDeletion` is non-null while a `user.data.purge` job is `pending` or
`running` for this caller — `{ id, scope, status, requestedAt }`. A client
uses it to disable its own buttons, but it is a courtesy, not the guard:
`POST /user-data/deletions` answers 409 regardless of whether the client
checked it first.

---

#### POST /user-data/deletions
Queues a `user.data.purge` job that deletes, in bulk, the data the caller
owns in the chosen `scope`. Returns **202** as soon as the job exists;
nothing is deleted synchronously — the work fans out across several tables
and object storage and outlives this request.

**Requires:** Authenticated, no permission

**Request:** `{ "scope": "everything", "confirmation": "EVERYTHING" }`

`confirmation` must be **the scope, uppercased** — `TRANSCRIPTS`, `NOTES`,
`FILES`, `CONTENT` or `EVERYTHING` — compared exactly, with no trimming and
no case folding. ⚠ **The token is scope-specific on purpose**: a single
constant like `DELETE` would let a confirmation typed into the "delete my
files" dialog authorise whatever scope a second, unrelated click actually
sent. A mismatch is a 400 naming the exact word required.

⚠ **This scope ignores the per-item refusals.** `DELETE /notes/{id}` refuses
(409) while a note is `generating` or while another note is derived from it;
`DELETE /transcripts/{id}` refuses while a note cites the transcript. A bulk
deletion honours neither — it clears the blocking references first (a note's
`sourceNoteId`/`sourceTranscriptId`, including on **other users'** notes
derived from a transcript the caller shared) and deletes anyway. A surviving
note that cited a deleted transcript keeps its own text and loses only the
provenance link.

**Response:** `202`
```json
{
  "data": {
    "id": "…",
    "scope": "everything",
    "status": "pending",
    "requestedAt": "2026-09-14T12:00:00.000Z"
  }
}
```

**Error Cases:**
- `400` - `confirmation` did not exactly match the scope, uppercased
- `409` - A deletion is already `pending` or `running` for this caller — the message names the scope already in flight

---

### Onboarding

A persistent, resumable, **live-derived** first-run checklist for a fresh
deployment's administrator and a fresh account's ordinary user — issue #275
(epic #271, issues #272–#281). Full design (why completion is derived on
every read rather than stored, why the two routes are split rather than
merged, why there are three statuses rather than two, and every rejected
alternative) is [`docs/specs/onboarding.md`](specs/onboarding.md).

#### GET /onboarding

The caller's own activation steps: up to four, naming what this account
still has to do (add an AI provider key, transcribe something, generate a
note, set a display name).

**Requires:** Authenticated, **no permission** — the resource is the
caller's own state, scoped by their user id in the query itself, the same
ownership-scoped posture `/api/ai-credentials`, `/api/pat` and
`/api/user-data` already take. Readable by a Viewer holding no permissions
at all, which is what a freshly invited account looks like.

**Response:**
```json
{
  "data": {
    "audience": "user",
    "steps": [
      {
        "key": "user.ai_key",
        "tier": "required",
        "title": "Add your AI provider key",
        "description": "Notes are generated with your own API key, billed to your own account. Nobody else on this deployment can see it.",
        "actionLabel": "Add your key",
        "href": "/settings/ai",
        "status": "pending",
        "blockedReason": null,
        "skippable": false,
        "skipped": false
      },
      {
        "key": "user.first_transcript",
        "tier": "required",
        "title": "Transcribe your first recording",
        "description": "Upload or record audio and get back a speaker-separated, timestamped transcript you can correct.",
        "actionLabel": "New transcript",
        "href": "/transcripts/new",
        "status": "blocked",
        "blockedReason": "Your administrator has not connected a transcription provider yet, so there is nothing to send a recording to.",
        "skippable": false,
        "skipped": false
      },
      {
        "key": "user.profile",
        "tier": "optional",
        "title": "Set your display name",
        "description": "How you appear to the people you share transcripts and notes with.",
        "actionLabel": "Edit your profile",
        "href": "/settings/profile",
        "status": "pending",
        "blockedReason": null,
        "skippable": true,
        "skipped": false
      }
    ],
    "requiredRemaining": 2,
    "totalRemaining": 3,
    "allRequiredSatisfied": false
  }
}
```

---

#### GET /admin/onboarding

This deployment's setup steps: up to seven, ending with a real transcription
rather than a green tick on a form — `admin.smoke_test` is only satisfied
once the caller owns a transcript that actually reached `ready`.

**Requires:** `system_settings:read` — an administrator's configuration
read, deliberately **not** a permission of its own (epic #118 decision 8's
precedent, the same one the About card follows: every fact this route
reports is one the holder of that permission can already read directly).

**Response:**
```json
{
  "data": {
    "audience": "admin",
    "steps": [
      {
        "key": "admin.transcription",
        "tier": "required",
        "title": "Connect a transcription provider",
        "description": "Choose a speech-to-text provider and store its API key. Until this is done, nobody on this deployment can upload a recording.",
        "actionLabel": "Open transcription settings",
        "href": "/admin/settings/transcription",
        "status": "pending",
        "blockedReason": null,
        "skippable": false,
        "skipped": false
      },
      {
        "key": "admin.smoke_test",
        "tier": "required",
        "title": "Transcribe a test recording",
        "description": "Upload a short recording and watch it come back as a transcript. This is the only step that proves the provider key you saved actually works.",
        "actionLabel": "Upload a recording",
        "href": "/transcripts/new",
        "status": "blocked",
        "blockedReason": "Connect a transcription provider first — there is nothing to send a recording to yet.",
        "skippable": false,
        "skipped": false
      },
      {
        "key": "admin.access",
        "tier": "recommended",
        "title": "Invite somebody",
        "description": "This deployment restricts access to an email allowlist. Add the people who should be able to sign in.",
        "actionLabel": "Open users & allowlist",
        "href": "/admin/settings/users",
        "status": "pending",
        "blockedReason": null,
        "skippable": true,
        "skipped": false
      }
    ],
    "requiredRemaining": 3,
    "totalRemaining": 3,
    "allRequiredSatisfied": false
  }
}
```

**Response fields (both routes):**
- `steps[].status` — `satisfied` / `pending` / `blocked`, **derived on every
  read**, never stored. Rotating a provider key out of `credentials` flips
  the relevant step back to `pending` on the very next request, with
  nothing to clear.
- `steps[].blockedReason` — non-null exactly when `status` is `blocked`.
  Names the person who has to act — an administrator for a user's step, or
  an earlier admin step for `admin.smoke_test` — which is the one thing a
  blocked step tells a caller that a pending one does not.
- `steps[].skipped` — from the caller's own `onboarding.skipped[]` user
  setting (`PATCH /user-settings`). A skipped step is still **returned**,
  never filtered out, so a client can offer to un-skip it.
- A step whose destination permission the caller does not hold, or which is
  irrelevant to this deployment (no AI vendor configured, so no key to
  add), is **absent** from `steps` — never present-and-disabled.
- `requiredRemaining` / `totalRemaining` / `allRequiredSatisfied` — computed
  server-side, once, rather than left to three independent client
  derivations that could disagree.

**Error Cases:**
- `401 Unauthorized` - No valid token (both routes)
- `403 Forbidden` - Caller lacks `system_settings:read` (`GET /admin/onboarding` only)

---

### Health

**Public endpoints** - Used for Kubernetes liveness/readiness probes.

#### GET /health
Full health check - includes database connectivity test. Equivalent to GET /health/ready.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok"
  }
}
```

**Error Cases:**
- 503 Service Unavailable - Database connection failed

---

#### GET /health/live
Liveness check - always returns 200 if service is running.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

#### GET /health/ready
Readiness check - includes database connectivity test.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "checks": {
    "database": "ok"
  }
}
```

**Error Cases:**
- 503 Service Unavailable - Database connection failed

---

## HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | OK - Request successful |
| 201 | Created - Resource created successfully |
| 204 | No Content - Request successful, no response body |
| 400 | Bad Request - Invalid request format or validation error |
| 401 | Unauthorized - Missing or invalid authentication token |
| 403 | Forbidden - Insufficient permissions or user disabled |
| 404 | Not Found - Resource not found |
| 409 | Conflict - Resource already exists or version mismatch (optimistic concurrency) |
| 413 | Payload Too Large - Request body exceeds a configured size limit |
| 500 | Internal Server Error - Server error occurred |
| 503 | Service Unavailable - Service temporarily unavailable |

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `AUTH_REQUIRED` | 401 | No valid authentication token provided |
| `INVALID_TOKEN` | 401 | JWT token is invalid or expired |
| `FORBIDDEN` | 403 | User does not have required permissions |
| `USER_DISABLED` | 403 | User account is disabled |
| `NOT_FOUND` | 404 | Requested resource not found |
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `CONFLICT` | 409 | Resource already exists or version mismatch |
| `NOT_AUTHORIZED` | 403 | Email not in allowlist |
| `VERSION_MISMATCH` | 409 | Optimistic concurrency conflict (If-Match header) |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds a configured size limit (e.g. profile picture upload over 5MB) |

---

## Rate Limits

> **Note:** Rate limiting is recommended for production deployments but is not currently implemented in the application. Consider adding `@nestjs/throttler` or Nginx rate limiting before production deployment.

**Recommended limits:**

| Endpoint Pattern | Recommended Limit | Window |
|------------------|-------------------|--------|
| `/api/auth/*` | 10 requests | 1 minute |
| `/api/allowlist` (POST) | 30 requests | 1 minute |
| `/api/system-settings` (PUT/PATCH) | 30 requests | 1 minute |
| All other endpoints | 100 requests | 1 minute |

---

## OpenAPI Documentation

Interactive API documentation with request/response examples is available at:

**Development:** http://localhost:3535/api/docs

This serves a [Scalar](https://scalar.com) reference page (not Swagger UI) generated from the
OpenAPI 3.1 document at `/api/openapi.json`. It allows you to:
- Explore all endpoints, grouped into sections via `x-tagGroups`
- View request/response schemas, including the generated **Requires:** RBAC line per operation
- Test API calls directly from the browser
- Authenticate with one click via "Authorize with my session" (exchanges your existing browser
  session for an access token), a personal access token, or a device authorization grant

### How the document is built

Everything that shapes `/api/openapi.json` lives in `apps/api/src/openapi/` rather than in
`main.ts`, so it can be built by a test harness and by `scripts/dump-openapi.ts` (the `openapi:dump`
npm script) without booting a listening server — the document CI lints is the document users get.

- **`document.ts`** builds the base document with Nest's `SwaggerModule.createDocument`, then runs
  it through a fixed pipeline of enrichment passes (`rbac-docs.ts`, `data-envelope.ts`,
  `tags.ts`, `nullable.ts`, in that order — order matters, since later passes must see what
  earlier ones added). **`version.ts`** resolves the version stamped into `info.version`
  (`APP_VERSION`, then `npm_package_version`, then `apps/api/package.json`, never throwing).
  **`description.ts`** builds the Markdown intro shown at the top of the page and inside the
  downloaded spec itself.
- **`rbac-docs.ts`** renders each operation's `@Auth()` metadata (roles, permissions) into the
  **Requires:** line appended to its description — generated from the same decorator the guards
  read, so the documented requirement cannot drift from the enforced one.
- **`tags.ts`** is the single declaration of every `@ApiTags(...)` name, its description, and which
  sidebar section it belongs to, emitted as the `x-tagGroups` vendor extension Scalar reads to
  render the sectioned sidebar. A tag used by a controller but not declared here, or declared here
  and used by nobody, fails a test rather than silently rendering wrong.
- **`data-envelope.ts`** rewrites every documented 2xx JSON response to match what the global
  `TransformInterceptor` actually sends (`{ data, meta }`), since a handler's declared return type
  and its wire shape are two different things once that interceptor runs. **`nullable.ts`** rewrites
  `@ApiProperty({ nullable: true })`'s OpenAPI 3.0 spelling into the 3.1 type union the published
  document (3.1, driven by zod v4's JSON Schema 2020-12 output) actually requires.
- **`docs-page.ts`** renders the `/api/docs` page itself — a hand-written template rather than the
  `@scalar/nestjs-api-reference` package, because the one-click session auth below has to resolve a
  token before Scalar mounts, which that package's fixed template does not expose a seam for. See
  [One-click session auth](#one-click-session-auth) below.
- The Spectral lint (`npm run openapi:lint` against `.spectral.yaml`, run in CI via `openapi:dump`
  then `openapi:lint`) fails the build on a missing or duplicated operation id, an undeclared tag,
  or anything else that would quietly degrade the reference page.

#### One-click session auth

Landing on `/api/docs` while already signed in authorizes it automatically, with no manual token
step. The page's inline script (`buildDocsAuthScript` in `docs-page.ts`) runs before Scalar mounts:
it calls `POST /api/auth/refresh` with `credentials: 'include'` — required even same-origin, since
the refresh cookie is scoped to `/api/auth` — reads the access token out of the response envelope
(`body.data.accessToken`), and passes it to Scalar as a pre-authorized `securitySchemes` entry for
the `JWT-auth` scheme, rather than poking it into Scalar's internal store after the fact. A failed
or missing session leaves the reference unauthorized with a status message rather than blocking the
page; reloading after signing in re-runs the exchange, which is also how a 15-minute-old token gets
refreshed — there is no separate "re-authorize" action.

---

## CORS Policy

The API uses a **same-origin architecture**. Both the frontend and API are served from the same host (via Nginx reverse proxy):

- Frontend: `http://localhost:3535/`
- API: `http://localhost:3535/api`

This eliminates CORS complexity and improves security. No cross-origin requests are required.

---

## Security Headers

All API responses include security headers:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

---

## Versioning

The API currently does not use versioning (v1, v2, etc.). Breaking changes will be avoided when possible. When breaking changes are necessary, they will be:

1. Announced in advance
2. Documented in migration guides
3. Implemented with a transition period when feasible

For future versions, the API may adopt URL-based versioning: `/api/v2/...`
