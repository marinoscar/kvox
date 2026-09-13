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

---

#### Get Upload Status

`GET /api/storage/objects/:id/upload/status`

**Requires Authentication** - Check progress of an in-progress upload.

**Response:**
```json
{
  "data": {
    "status": "uploading",
    "uploadedParts": 5,
    "totalParts": 10,
    "progress": 50
  }
}
```

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

**Response:** HTTP 204 No Content

**Error Cases:**
- 404 Not Found - Object not found
- 403 Forbidden - User does not own object (non-admin)

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
