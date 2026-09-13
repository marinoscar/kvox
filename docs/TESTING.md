# Testing Framework

This document describes the testing strategy, frameworks, and conventions used in this project. It serves as a guide for developers writing new tests and for AI agents that need to understand the testing approach.

## Table of Contents

1. [Testing Framework Overview](#testing-framework-overview)
2. [Test Structure](#test-structure)
3. [Running Tests](#running-tests)
4. [Test Patterns & Conventions](#test-patterns--conventions)
5. [Mocking Strategies](#mocking-strategies)
6. [Writing New Tests](#writing-new-tests)
7. [Test Configuration](#test-configuration)
8. [Best Practices](#best-practices)
9. [Visual Regression Testing](#visual-regression-testing)
10. [Real-Postgres Testing](#real-postgres-testing)

## Testing Framework Overview

### Backend (API)

**Framework:** Jest + Supertest + @nestjs/testing

**Why These Frameworks:**
- **Jest**: Industry-standard JavaScript testing framework with excellent TypeScript support, built-in mocking, and parallel test execution
- **Supertest**: HTTP assertion library that works seamlessly with NestJS applications, allowing end-to-end API testing without spinning up a real server
- **@nestjs/testing**: Official NestJS testing utilities that provide dependency injection and module compilation for isolated testing

**Key Features:**
- Unit tests run in isolation with mocked dependencies
- E2E tests use a real test database (PostgreSQL)
- OAuth strategies are mocked to avoid external dependencies
- Test database is reset between test suites for isolation

### Frontend (Web)

**Framework:** Vitest + React Testing Library + MSW (Mock Service Worker)

**Why These Frameworks:**
- **Vitest**: Fast, modern test runner built for Vite projects with Jest-compatible API, native ESM support, and excellent performance
- **React Testing Library**: Encourages testing components from the user's perspective rather than implementation details, promoting maintainable tests
- **MSW (Mock Service Worker)**: Intercepts network requests at the network level, providing realistic API mocking without changing application code
- **@testing-library/user-event**: Simulates real user interactions more accurately than fireEvent

**Key Features:**
- Component tests render UI in jsdom environment
- API calls are mocked with MSW handlers
- User interactions tested with user-event library
- Context providers (Auth, Theme) tested in isolation

## Test Structure

### Backend Test Organization

```
apps/api/
├── src/
│   └── **/*.spec.ts          # Unit tests (co-located with source)
├── test/
│   ├── jest.config.js         # Jest configuration
│   ├── setup.ts               # Global test setup
│   ├── teardown.ts            # Global test cleanup
│   ├── helpers/               # Test utilities
│   │   ├── test-app.helper.ts    # App creation/teardown
│   │   ├── auth.helper.ts        # User creation & JWT helpers
│   │   └── database.helper.ts    # DB seeding & cleanup
│   ├── mocks/                 # Mock implementations
│   │   ├── prisma.mock.ts        # Prisma client mocks
│   │   └── google-oauth.mock.ts  # OAuth strategy mocks
│   └── **/*.e2e.spec.ts       # E2E integration tests
└── .env.test                  # Test environment variables
```

**Test Types:**
- **Unit tests** (`*.spec.ts`): Located alongside source files, test individual services/controllers/guards in isolation
- **E2E tests** (`*.e2e.spec.ts`): Located in `test/` directory, test full request-response cycles with real database

### Frontend Test Organization

```
apps/web/
├── src/
│   ├── __tests__/
│   │   ├── setup.ts              # Test setup (MSW, mocks)
│   │   ├── utils/
│   │   │   └── test-utils.tsx    # Custom render utilities
│   │   ├── mocks/
│   │   │   ├── server.ts         # MSW server setup
│   │   │   └── handlers.ts       # API mock handlers
│   │   ├── components/
│   │   │   └── **/*.test.tsx     # Component tests
│   │   ├── contexts/
│   │   │   └── **/*.test.tsx     # Context/hook tests
│   │   └── pages/
│   │       └── **/*.test.tsx     # Page tests
└── vitest.config.ts          # Vitest configuration
```

**Test Types:**
- **Component tests**: Test individual React components in isolation
- **Page tests**: Test entire pages with routing and context
- **Context tests**: Test React contexts and custom hooks
- **Integration tests**: Test multiple components working together

## Running Tests

### Backend Tests

```bash
# Navigate to API directory
cd apps/api

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:cov

# Run only unit tests (exclude e2e)
npm run test:unit

# Run only e2e tests
npm run test:e2e

# Debug tests
npm run test:debug

# CI mode (coverage + junit reporter)
npm run test:ci
```

### Frontend Tests

```bash
# Navigate to web directory
cd apps/web

# Run all tests
npm test

# Run tests in watch mode (interactive)
npm run test:watch

# Run tests once (CI mode)
npm run test:run

# Run with coverage
npm run test:coverage

# Open Vitest UI
npm run test:ui

# CI mode (coverage + junit reporter)
npm run test:ci
```

### Environment Variables

Backend tests require a test database. Create `apps/api/.env.test`:

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/app_test"
JWT_SECRET="test-secret-key-min-32-characters"
NODE_ENV="test"
```

**Important:** The test database should be separate from development database. Tests will truncate all data between runs.

## Test Patterns & Conventions

### Naming Conventions

**Backend:**
- Unit tests: `*.spec.ts` (e.g., `auth.service.spec.ts`)
- E2E tests: `*.e2e.spec.ts` (e.g., `auth.e2e.spec.ts`)

**Frontend:**
- All tests: `*.test.tsx` or `*.test.ts`
- Test files mirror source structure (e.g., `LoginPage.tsx` → `LoginPage.test.tsx`)

### Test Structure Pattern

Use nested `describe` blocks to organize tests logically:

```typescript
describe('ComponentName or ServiceName', () => {
  // Setup
  beforeEach(() => {
    // Reset state before each test
  });

  describe('Feature Group 1', () => {
    it('should do something specific', () => {
      // Arrange
      // Act
      // Assert
    });

    it('should handle error case', () => {
      // Test error handling
    });
  });

  describe('Feature Group 2', () => {
    it('should behave differently', () => {
      // Another test
    });
  });
});
```

**Best Practices:**
- Group related tests in `describe` blocks
- Use descriptive test names starting with "should"
- Follow Arrange-Act-Assert pattern
- One logical assertion per test (exceptions for related assertions)
- Test both success and error cases

### Backend Test Pattern (Unit Test)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ServiceName } from './service-name.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService } from '../../test/mocks/prisma.mock';

describe('ServiceName', () => {
  let service: ServiceName;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceName,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ServiceName>(ServiceName);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('methodName', () => {
    it('should return expected result', async () => {
      // Arrange
      mockPrisma.model.findUnique.mockResolvedValue({ id: '1' });

      // Act
      const result = await service.methodName('1');

      // Assert
      expect(result).toEqual({ id: '1' });
      expect(mockPrisma.model.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
      });
    });
  });
});
```

### Backend Test Pattern (E2E Test)

```typescript
import request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import { createTestUser, authHeader } from '../helpers/auth.helper';

describe('Controller (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    await resetDatabase(context.prisma);
  });

  describe('GET /api/endpoint', () => {
    it('should return data for authenticated user', async () => {
      const user = await createTestUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/endpoint')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('should return 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/endpoint')
        .expect(401);
    });
  });
});
```

### Frontend Test Pattern (Component Test)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import { ComponentName } from '../../components/ComponentName';

describe('ComponentName', () => {
  beforeEach(() => {
    // Reset any state
  });

  describe('Rendering', () => {
    it('should render component with props', () => {
      render(<ComponentName title="Test" />);

      expect(screen.getByText('Test')).toBeInTheDocument();
    });
  });

  describe('User Interaction', () => {
    it('should handle button click', async () => {
      const user = userEvent.setup();
      const onClickMock = vi.fn();

      render(<ComponentName onClick={onClickMock} />);

      await user.click(screen.getByRole('button'));

      expect(onClickMock).toHaveBeenCalledTimes(1);
    });
  });
});
```

### Frontend Test Pattern (Hook Test)

```typescript
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCustomHook } from '../../hooks/useCustomHook';

describe('useCustomHook', () => {
  it('should return initial state', () => {
    const { result } = renderHook(() => useCustomHook());

    expect(result.current.value).toBe(null);
    expect(result.current.isLoading).toBe(false);
  });

  it('should update state on action', async () => {
    const { result } = renderHook(() => useCustomHook());

    act(() => {
      result.current.updateValue('new');
    });

    await waitFor(() => {
      expect(result.current.value).toBe('new');
    });
  });
});
```

## Mocking Strategies

### Backend Mocking

#### 1. Prisma Client Mocking (Unit Tests)

Use the provided mock factory for consistent Prisma mocking:

```typescript
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

let mockPrisma: MockPrismaService;

beforeEach(() => {
  mockPrisma = createMockPrismaService();

  // Configure specific mocks
  mockPrisma.user.findUnique.mockResolvedValue({ id: '1', email: 'test@example.com' });
});
```

The mock factory provides Jest mock functions for all Prisma operations (findUnique, findMany, create, update, delete, etc.).

#### 2. OAuth Strategy Mocking

Google OAuth is mocked using a custom Passport strategy:

```typescript
import { MockGoogleStrategy, createMockGoogleProfile } from '../../test/mocks/google-oauth.mock';

// Set mock profile for next auth
MockGoogleStrategy.setMockProfile({
  email: 'custom@example.com',
  displayName: 'Custom User',
});

// Reset to defaults
MockGoogleStrategy.resetMockProfile();
```

This allows E2E tests to simulate OAuth flows without calling Google's servers.

#### 3. JWT Service Mocking (Unit Tests)

```typescript
const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-jwt-token'),
  verify: jest.fn().mockReturnValue({ sub: '1', email: 'test@example.com' }),
} as any;
```

#### 4. Config Service Mocking

```typescript
const mockConfigService = {
  get: jest.fn((key: string) => {
    const config: Record<string, any> = {
      'jwt.secret': 'test-secret',
      'jwt.accessTtlMinutes': 15,
    };
    return config[key];
  }),
} as any;
```

### Frontend Mocking

#### 1. API Mocking with MSW

MSW intercepts HTTP requests at the network level. Handlers are defined in `apps/web/src/__tests__/mocks/handlers.ts`:

```typescript
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/auth/me', () => {
    return HttpResponse.json({
      data: {
        id: 'user-1',
        email: 'test@example.com',
        roles: ['viewer'],
      },
    });
  }),

  http.post('/api/auth/logout', () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
```

**Override handlers in specific tests:**

```typescript
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';

it('should handle error', async () => {
  server.use(
    http.get('/api/auth/me', () => {
      return new HttpResponse(null, { status: 500 });
    }),
  );

  // Test error handling
});
```

#### 2. Browser API Mocking

Common browser APIs are mocked in `setup.ts`:

```typescript
// Mock window.matchMedia (for MUI responsive components)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));
```

#### 3. Context Mocking

Use custom render utilities to wrap components with necessary providers:

```typescript
import { render } from '../utils/test-utils';

// Render with authenticated context
render(<Component />, {
  wrapperOptions: { authenticated: true },
});

// Render with unauthenticated context
render(<Component />, {
  wrapperOptions: { authenticated: false },
});
```

#### 4. Router Mocking

```typescript
import { MemoryRouter } from 'react-router-dom';

render(
  <MemoryRouter initialEntries={['/login']}>
    <LoginPage />
  </MemoryRouter>
);
```

## Writing New Tests

### Adding a Backend Unit Test

1. **Create test file** next to source file: `feature.service.spec.ts`
2. **Import testing utilities:**
   ```typescript
   import { Test, TestingModule } from '@nestjs/testing';
   ```
3. **Mock dependencies** using provided mock factories
4. **Test each method** with success and error cases
5. **Verify calls** to mocked dependencies

### Adding a Backend E2E Test

1. **Create test file** in `apps/api/test/` directory: `feature.e2e.spec.ts`
2. **Use test helpers:**
   ```typescript
   import { createTestApp, closeTestApp } from '../helpers/test-app.helper';
   import { resetDatabase } from '../helpers/database.helper';
   import { createTestUser, authHeader } from '../helpers/auth.helper';
   ```
3. **Set up test context** in `beforeAll`
4. **Reset database** in `beforeEach` for test isolation
5. **Test HTTP endpoints** with Supertest
6. **Test RBAC** by creating users with different roles

### Adding a Frontend Component Test

1. **Create test file** in `apps/web/src/__tests__/components/`: `Component.test.tsx`
2. **Import testing utilities:**
   ```typescript
   import { render } from '../utils/test-utils';
   import { screen, waitFor } from '@testing-library/react';
   import userEvent from '@testing-library/user-event';
   ```
3. **Test rendering** with different props
4. **Test user interactions** with `userEvent`
5. **Test async behavior** with `waitFor`
6. **Mock API calls** with MSW if needed

### Adding a Frontend Context/Hook Test

1. **Create test file** in `apps/web/src/__tests__/contexts/`: `Context.test.tsx`
2. **Use `renderHook`** from React Testing Library
3. **Create wrapper** with necessary providers
4. **Test state changes** with `act` and `waitFor`
5. **Test error handling** by mocking failing API calls

## Test Configuration

### Backend Configuration

**File:** `apps/api/test/jest.config.js`

```javascript
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/main.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  verbose: true,
};
```

**Key Settings:**
- `testRegex`: Matches `*.spec.ts` files
- `roots`: Includes both `src/` and `test/` directories
- `setupFilesAfterEnv`: Runs setup before tests
- `testTimeout`: 30 seconds for database operations
- `moduleNameMapper`: Supports `@/` path alias

### Frontend Configuration

**File:** `apps/web/vitest.config.ts`

```typescript
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'src/__tests__',
        '**/*.d.ts',
        '**/*.config.*',
        'src/main.tsx',
      ],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
```

**Key Settings:**
- `environment: 'jsdom'`: Browser-like environment for React
- `globals: true`: No need to import `describe`, `it`, `expect`
- `setupFiles`: Runs MSW setup and browser mocks
- `coverage.thresholds`: Enforces minimum 70% coverage
- `testTimeout`: 10 seconds for async operations

## Best Practices

### General

1. **Test Behavior, Not Implementation**
   - Test what the code does, not how it does it
   - Avoid testing internal state or private methods
   - Focus on public API and observable outcomes

2. **Test Isolation**
   - Each test should run independently
   - Use `beforeEach` to reset state
   - Don't rely on test execution order

3. **Clear Test Names**
   - Use descriptive names: `should return 401 when token is invalid`
   - Follow pattern: "should [expected behavior] when [condition]"

4. **Arrange-Act-Assert Pattern**
   - **Arrange:** Set up test data and mocks
   - **Act:** Execute the code under test
   - **Assert:** Verify the outcome

5. **Test Error Cases**
   - Always test both success and failure paths
   - Test edge cases and boundary conditions
   - Test validation errors and exceptions

### Backend-Specific

1. **Unit Test External Dependencies**
   - Mock Prisma, external APIs, file system
   - Unit tests should be fast (<100ms per test)

2. **E2E Test Critical Paths**
   - Auth flows (login, logout, refresh)
   - RBAC enforcement
   - Database transactions
   - API contract validation

3. **Use Test Helpers**
   - Leverage provided helpers for user creation, auth headers, DB reset
   - Keep test code DRY with shared utilities

4. **Database Isolation**
   - Always reset database in `beforeEach`
   - Use separate test database
   - Never use production data in tests

### Frontend-Specific

1. **Query by Accessibility**
   - Prefer `getByRole`, `getByLabelText`, `getByText`
   - Avoid `getByTestId` unless necessary
   - Mirrors how users interact with UI

2. **User-Centric Testing**
   - Use `userEvent` instead of `fireEvent`
   - Test user flows, not implementation
   - Wait for async updates with `waitFor`

3. **Mock Network at Network Level**
   - Use MSW for realistic API mocking
   - Define default handlers, override in tests
   - MSW works in both tests and browser

4. **Avoid Testing Implementation Details**
   - Don't test component state directly
   - Don't test CSS classes or internal methods
   - Test visible output and user interactions

### Coverage Guidelines

**Target Coverage:** 70% minimum (enforced in frontend)

**What to Focus On:**
- Business logic in services
- RBAC guards and decorators
- API controllers (especially auth)
- React contexts and custom hooks
- Critical user flows (login, settings)

**What Can Have Lower Coverage:**
- DTOs and type definitions
- Module configuration files
- Simple getter/setter methods
- UI styling components

### Debugging Tests

**Backend:**
```bash
# Run tests with Node debugger
npm run test:debug

# Add breakpoint in code
debugger;

# Run single test file
npm test -- auth.service.spec.ts

# Run single test by name
npm test -- -t "should create user"
```

**Frontend:**
```bash
# Open Vitest UI for interactive debugging
npm run test:ui

# Run single test file
npm test -- LoginPage.test.tsx

# Run with browser-like debugging
npm run test:ui
```

**Helpful Debugging Tools:**
- `screen.debug()` - Print current DOM state
- `screen.logTestingPlaygroundURL()` - Get query suggestions
- `console.log` in tests (shown in output)
- VS Code debugger integration

## Common Issues and Solutions

### Backend

**Issue:** Tests timeout waiting for database
- **Solution:** Check `DATABASE_URL` in `.env.test`, ensure test DB is running

**Issue:** Prisma mock not working as expected
- **Solution:** Clear mocks in `afterEach`, use `mockResolvedValue` for promises

**Issue:** JWT validation fails in tests
- **Solution:** Ensure `JWT_SECRET` is set in test environment

### Frontend

**Issue:** "Target container is not a DOM element"
- **Solution:** Ensure `jsdom` environment is set in vitest.config.ts

**Issue:** "window.matchMedia is not a function"
- **Solution:** Check that setup.ts is imported in vitest.config

**Issue:** MSW not intercepting requests
- **Solution:** Verify server.listen() is called in beforeAll

**Issue:** Async state not updating in tests
- **Solution:** Use `await waitFor()` to wait for async updates

## E2E Testing with Playwright

### Overview

The application supports end-to-end testing using Playwright with a dedicated test authentication mechanism that bypasses Google OAuth.

### Test Authentication

In development/test environments, a special login page at `/testing/login` allows Playwright tests to authenticate as any user with any role without going through Google OAuth.

**How it works:**
1. Backend provides `POST /api/auth/test/login` endpoint (disabled in production)
2. Frontend provides `/testing/login` page (excluded from production builds)
3. Tests can authenticate as admin, contributor, or viewer roles

### Directory Structure

```
tests/e2e/
├── playwright.config.ts       # Playwright configuration
├── helpers/
│   └── auth.helper.ts         # Login helper functions
├── fixtures/
│   └── auth.fixture.ts        # Pre-authenticated page fixtures
└── specs/
    ├── auth.spec.ts           # Authentication tests
    └── example.spec.ts        # Example feature tests
```

### Auth Helper

```typescript
// tests/e2e/helpers/auth.helper.ts
import { Page } from '@playwright/test';

export async function loginAsTestUser(
  page: Page,
  options: { email: string; role?: 'admin' | 'contributor' | 'viewer' }
): Promise<void> {
  await page.goto('/testing/login');
  await page.fill('[data-testid="test-email-input"]', options.email);
  if (options.role) {
    await page.click('[data-testid="test-role-select"]');
    await page.click(`[data-value="${options.role}"]`);
  }
  await page.click('[data-testid="test-login-button"]');
  await page.waitForURL('/');
}
```

### Auth Fixtures

```typescript
// tests/e2e/fixtures/auth.fixture.ts
import { test as base, Page } from '@playwright/test';
import { loginAsAdmin, loginAsViewer } from '../helpers/auth.helper';

export const test = base.extend<{
  adminPage: Page;
  viewerPage: Page;
}>({
  adminPage: async ({ page }, use) => {
    await loginAsAdmin(page);
    await use(page);
  },
  viewerPage: async ({ page }, use) => {
    await loginAsViewer(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
```

### Example Test

```typescript
// tests/e2e/specs/admin.spec.ts
import { test, expect } from '../fixtures/auth.fixture';

test.describe('Admin functionality', () => {
  test('can access users & allowlist', async ({ adminPage }) => {
    // /admin/users is a real redirect route (epic #90) — it resolves to
    // /admin/settings/users, the Users & Allowlist card's route within the
    // Console settings hub. See docs/specs/settings-ui.md.
    await adminPage.goto('/admin/users');
    await expect(adminPage).toHaveURL('/admin/settings/users');
  });

  test('viewer cannot access admin pages', async ({ viewerPage }) => {
    await viewerPage.goto('/admin/users');
    await expect(viewerPage).not.toHaveURL('/admin/settings/users');
  });
});
```

### Running E2E Tests

```bash
# Navigate to e2e test directory
cd tests/e2e

# Install dependencies (first time)
npm install
npx playwright install chromium

# Run all E2E tests
npm test

# Run with UI mode (interactive)
npm run test:ui

# Run in headed mode (see browser)
npm run test:headed

# Run specific test file
npx playwright test auth.spec.ts
```

### Security Note

The test authentication endpoint (`/api/auth/test/login`) and the test login page (`/testing/login`) are **completely disabled in production** through multiple security layers. See [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md#13-test-authentication-development-only) for details.

## Visual Regression Testing

### Overview

In addition to the Vitest component suite and the Playwright E2E suite above, the project maintains a third, narrower test suite dedicated to pixel-level visual regression testing. It lives in `tests/visual/` — a sibling to `tests/e2e/`, not a variant of it — and exists to catch layout bugs that neither of the other two suites can see, no matter how the assertions inside them are written.

This suite was built for issue #107 after epic #90 shipped 1,563 passing Vitest tests alongside two visible layout regressions (issue #105): the `Console` entry was rendering inline in the navigation rail instead of pinned at its foot, and collapsed-rail captions were truncating ("Setti…", "Cons…"). Both bugs were plainly visible in the running app, and neither was caught by 1,563 otherwise-passing tests.

### Why jsdom Can't Catch This

Vitest's component tests run in jsdom, which has no layout engine. `offsetWidth` and `offsetHeight` are always `0`, text never wraps, nothing overflows its container, and elements have no real font metrics — jsdom doesn't know what a font looks like, let alone measure text against one. A test can assert that a caption's DOM node contains the string `"Console"`, but it cannot ask whether that string rendered on one line or two, whether it got clipped with an ellipsis, or whether it pushed a sibling element out of the rail's fixed width. Both #105 bugs lived entirely in that blind spot: one was a layout-order mistake that only resolves into an actual on-screen position once a real layout engine runs, the other was a caption whose padding only becomes "too wide for the collapsed rail" once real text is laid out against a real font.

This is a structural gap in jsdom, not a coverage gap that more (or cleverer) Vitest tests can close. Anything that depends on real layout — text wrapping, ellipsis truncation, overflow, the settings hub's card-grid column count at a given viewport width, a long label widening a fixed-width shell — is invisible to a jsdom-based assertion regardless of how the test is written. Closing that gap requires an actual browser laying out actual pixels, which is what `tests/visual/` does: it renders the real app in real Chromium at fixed viewport sizes and asserts the rendered pixels against a checked-in baseline image, tolerant of only a handful of pixels of drift.

### The Harness

The suite doesn't screenshot the running application; it screenshots a small, purpose-built harness at `apps/web/visual/` (`index.html`, `main.tsx`, `vite.config.ts`, `tsconfig.json`). The harness is a separate Vite entry point from `apps/web/src/` — excluded from the production build and from `apps/web`'s `tsc --noEmit` app scope — but it mounts the **real** application components: `Layout`, `NavigationRail`, `AppBar`, and `SettingsHub` (via both `pages/Admin/SettingsHubPage` and `pages/UserSettingsHubPage`), wrapped in a fake `AuthContext.Provider`, the real `ThemeContextProvider` + MUI `ThemeProvider` + `CssBaseline`, and a `MemoryRouter`.

The harness takes its starting state entirely from query parameters on its own URL, so a spec can pin exactly the state it wants to screenshot:

| Param | Effect |
|---|---|
| `?route=` | Initial router entry |
| `?perms=` | Comma-separated permission strings, becomes `user.permissions` |
| `?roles=` | Comma-separated role strings, becomes `user.roles` |
| `?theme=` | `light` or `dark`, written to `localStorage.theme_mode` before mount |

There is no backend, no database, and no OAuth behind the harness. Calls the app's real hooks make under the hood (e.g. `useUserSettings`, used internally by `useNavigationPrefs`) are deliberately left unproxied, so they fail fast and the app's existing error handling degrades to a deterministic default state — that determinism is what makes the resulting screenshots stable enough to diff against a checked-in baseline.

### Fonts: The Harness Loads the App's, Not Its Own

Typography is load-bearing for this suite. The caption-truncation half of #105 is a bug about whether a word fits a fixed-width box, which is a question about *glyph metrics* — so the font the harness renders in has to be the font the application renders in, or the baselines describe a layout no user ever sees.

The harness originally solved this by shipping its own copy of Inter under `apps/web/visual/assets/fonts/` with its own `@font-face`, because at the time the application loaded no webfont at all: `src/theme/index.ts` declared `"Inter", "Roboto", "Helvetica", "Arial", sans-serif` but nothing ever fetched the first two, so real users got Arial, Helvetica or DejaVu depending on their OS. That was issue **#111**, and it made the harness's private copy the only Inter in the repository.

#111 fixed it at the root. The application now self-hosts Inter itself:

| File | Role |
|---|---|
| `apps/web/public/fonts/Inter-latin-variable.woff2` | The **only** font file in the repo (~48KB, latin subset, variable `wght` 100–900) |
| `apps/web/public/fonts/inter.css` | The **only** `@font-face` in the repo, `font-display: swap` |
| `apps/web/index.html` | `<link>`s that stylesheet — the real app |
| `apps/web/visual/index.html` | `<link>`s **the same** stylesheet at the same URL — the harness |

The harness sees `/fonts/...` because `apps/web/visual/vite.config.ts` points its `publicDir` at `apps/web/public` instead of Vite's `<root>/public` default. Nothing is duplicated: **one font file, one `@font-face`, both consumers.**

This is not tidiness, it's what makes the suite non-vacuous. While the harness owned a private font, the app could have lost Inter entirely — or never had it, which is what actually happened — and all 11 pixel baselines would still have passed, because they were measuring the harness's font loading rather than the application's. That coupling is now verified in both directions: deleting `apps/web/public/fonts/inter.css` fails the suite.

Because the shared stylesheet uses `font-display: swap` (correct for production — text must never be invisible while a font is in flight) rather than the `block` the harness previously used for its own convenience, specs must not screenshot during the swap window. Every spec therefore calls `waitForInter(page)` from `tests/visual/support/harness.ts` immediately after `page.goto()`. It awaits `document.fonts.load()` for each weight the theme uses, then asserts against the **FontFace set** — that exactly one `Inter` face is registered, that its `status` is `loaded`, and that it still carries the full `100 900` variable range.

That assertion is deliberately not `document.fonts.check('16px Inter')`, which is useless for this purpose: `check()` asks "can this be rendered?", and an undeclared family counts as an available system font, so it returns `true` in precisely the broken case the guard exists to catch. Confirmed empirically — with the stylesheet deleted, `check()` still returned `true` while the screenshots diffed by 11,589 pixels.

### Directory Structure

```
apps/web/public/fonts/            # Shared by the app AND the harness (#111)
├── Inter-latin-variable.woff2    # The repo's only font file
└── inter.css                     # The repo's only @font-face

apps/web/visual/                  # Harness — mounts real app components
├── index.html                    # <link>s the app's /fonts/inter.css
├── main.tsx
├── vite.config.ts                # publicDir -> apps/web/public
└── tsconfig.json

tests/visual/                     # Playwright project — sibling to tests/e2e/
├── playwright.config.ts          # Own testDir, own webServer (harness only)
├── package.json                  # @playwright/test pinned to exact 1.62.1 (no caret)
├── support/harness.ts            # URL builder + waitForInter() font guard
└── specs/                        # 11 specs across 7 files
```

`tests/visual/` is deliberately independent of `tests/e2e/`: it has its own `testDir`, its own `webServer` entry (which starts only the harness's Vite dev server — no Docker Compose stack, no API, no database), and its own pinned Playwright version. That pin is not incidental: `tests/e2e/package.json` floats `@playwright/test` on `^1.40.0`, which is fine for behavioral E2E, but pixel baselines are sensitive to the exact Chromium build a given Playwright version ships, not just its API surface — an unpinned range would let baselines drift out from under the suite on an unrelated `npm install`.

### What's Covered

The 11 specs cover the settings hub at three breakpoints — 1919×862 (3-up card grid, expanded Console rail), 767×844 (2-up grid, collapsed rail), and 551×840 (drill-down list) — plus the Console rail's group headers and "Back to library" control on `/admin/settings` at desktop width, the library rail with Console pinned at its foot (both collapsed and expanded on a non-admin route), the compact drill-down `AppBar`, a filtered search result and the empty "no results" state, a `users:read`-only user whose `General` settings group disappears entirely, and the user settings hub at `/settings`.

### Configuration

A few settings in `tests/visual/playwright.config.ts` exist specifically because this suite screenshots real layout rather than asserting on the DOM:

- **`animations: 'disabled'`** — removes MUI transition timing as a source of flaky diffs.
- **`maxDiffPixels: 4`** (an absolute count, not a ratio) — several specs screenshot a mostly-blank nav rail element where a real regression changes only a few hundred pixels out of roughly 47,000 total, comfortably under even a 1% ratio threshold. An absolute pixel count catches that; a percentage would not.
- **pixelmatch `threshold: 0.05`** (down from Playwright's default of `0.2`) — the #105 caption-padding regression's visual delta is a subtle tint-edge shift on a near-black dark theme background. At the default perceptual threshold, pixelmatch does not register it as different at all, despite a large, real, confirmed RGB delta.

Baselines are generated and verified **only** inside the pinned container, `mcr.microsoft.com/playwright:v1.62.1-noble` — never on a developer's host machine. Host Chromium's font hinting and antialiasing drift from CI's, and at this tight a pixel tolerance that drift alone is enough to fail a spec with no real regression present.

### CI Integration

A `visual` job in `.github/workflows/ci.yml` runs concurrently with the other CI jobs (no `needs:` dependency), inside `container: mcr.microsoft.com/playwright:v1.62.1-noble`. It invokes the pinned Playwright binary directly:

```bash
tests/visual/node_modules/.bin/playwright test --config=tests/visual/playwright.config.ts
```

It does **not** use `npx playwright`, which resolves a different, unpinned Playwright module instance from the repo root and throws a `"did not expect test() to be called here"` error from having two copies of the Playwright module loaded in the same process.

The job uploads `tests/visual/playwright-report/` via `actions/upload-artifact@v4` unconditionally (`if: always()`), so a failing run's HTML report — which embeds the expected, actual, and diff PNGs for every failed assertion — is downloadable directly from the Actions run without needing to reproduce the failure locally.

### Running Tests Locally

Playwright's `webServer` option starts the harness's Vite dev server automatically, so from `tests/visual/`, after `npm install`, a bare test run is normally sufficient:

```bash
cd tests/visual
npm install
npm test
# or directly:
npx playwright test --config=tests/visual/playwright.config.ts
```

(Manually starting the harness dev server yourself, from `apps/web/visual/`, is only needed if you want to poke at the harness in a browser outside of a test run.)

To generate or verify baselines, run the suite inside the exact pinned container instead — the point of the container is that the pixels it produces are the same pixels CI will produce. From the repo root:

```bash
REPO=$(git rev-parse --show-toplevel)
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$REPO:$REPO" \
  -w "$REPO" \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  tests/visual/node_modules/.bin/playwright test --config=tests/visual/playwright.config.ts
```

Three details in that command are load-bearing:

- **`--user "$(id -u):$(id -g)"`.** The image's default user is root, and Playwright writes `test-results/` and `playwright-report/` into the mount. Without this flag those directories come back owned by root: they are gitignored so they never reach a commit, but they are enough to make `git worktree remove` and `rm -rf` fail with *Permission denied* until you delete them from inside a container. Run as yourself and the problem does not arise.
- **The mount path equals the host path.** `node_modules` inside a worktree is a symlink into the main checkout, so mounting the repo root at its own absolute path is what keeps those symlinks resolvable inside the container. Mounting at `/app` instead leaves them dangling.
- **Invoking the pinned binary directly** rather than through `npx`. `npx` resolves the first Playwright it finds walking up from the working directory, which in this repo is the unpinned copy at the root — and a version mismatch against the container's browsers throws a module-duplication error rather than anything self-explanatory.

### Updating Baselines Deliberately

To regenerate baselines after an intentional visual change, run the suite with `--update-snapshots` inside the same pinned container — `tests/visual/package.json` provides `npm run test:update` for this. As with the run command above, this must happen inside `mcr.microsoft.com/playwright:v1.62.1-noble`, not on a host machine.

This is the most important paragraph in this section: **blessing a diff without opening the image and confirming the new pixels are the intended change is the standard failure mode of every snapshot-testing suite, and it would defeat the entire purpose of this one.** A rubber-stamped `--update-snapshots` run after a CI failure silently readmits the exact class of regression — #105 — that this suite exists to catch. Before running `test:update`, open the failing run's HTML report, look at the diff image for each failing spec, and understand specifically what changed and why. Only update the baseline once that change is confirmed intentional. If it isn't, the fix is to fix the code, not the baseline.

---

## Real-Postgres Testing

### Overview

Everything above this section runs against mocks (unit tests) or against the
shared, `beforeEach`-reset test database that `test/helpers/database.helper.ts`
truncates between tests. A third tier exists beside those: **`*.db.spec.ts`**
is the naming convention for a suite that must observe real PostgreSQL
behavior — a lock mode, a partial index, a foreign key's `ON DELETE`
behavior, a real `pg_dump`/`pg_restore` pair, two genuinely concurrent
connections racing each other — properties a mocked Prisma client cannot make
a claim about, because a mock returns whatever the test told it to return no
matter what SQL would really have done.

Those specs are deliberately excluded from every other Jest entry point.
`apps/api/package.json`'s `test`, `test:unit`, `test:cov` and `test:ci`
scripts all pass `--testPathIgnorePatterns='\.db\.spec\.ts$'` (alongside the
existing `e2e` exclusion), so a plain `npm test` never touches them. That
exclusion exists because no database is reachable in those contexts — without
it, a `.db.spec.ts` file would fail every ordinary test run with a confusing
connection error instead of being cleanly absent from it.

They run through one dedicated script instead:

```bash
npm run test:db --workspace=api
```

which is:

```
jest --config ./test/jest.config.js --testRegex '\.db\.spec\.ts$' --runInBand
```

If no Postgres is reachable at `POSTGRES_HOST`/`POSTGRES_PORT`, each suite
skips itself with a warning (via `resolveDbSuite` in
`apps/api/test/jobs/db-test-support.ts`) rather than failing — `npm run
test:db` is safe to run without a database up; it just proves nothing that
run.

### Where They Run in CI

The `smoke` job in `.github/workflows/ci.yml` is the only place in this
repository's CI where a real PostgreSQL is running (`postgres:16-alpine`, as
a service container). That job runs the compiled API artifact end to end —
build, migrate, seed, boot — and `npm run test:db --workspace=api` is one
step in that sequence, positioned deliberately: **after** `npm run
prisma:migrate --workspace=api` and **before** `npm run prisma:seed
--workspace=api`. The migration has to have actually run for the
hand-written indexes and constraints these suites check to exist at all; the
step runs before seeding so the suites see a freshly-migrated, unseeded
database, not one with the application's default rows already in it. It runs
with `NODE_ENV=test` explicitly set for that one step — overriding the job's
ambient (otherwise unset/production) value — because that is the
`NODE_ENV` these suites assume when they build their own connection string
from the job's `POSTGRES_*` environment variables (see
`apps/api/test/helpers/scratch-database.helper.ts` and
`apps/api/test/jobs/db-test-support.ts`).

### Running Them Locally

The API never reads `DATABASE_URL` from the environment — it always builds
the connection string from the individual `POSTGRES_*` variables (see
`src/config/configuration.ts` and `src/prisma/prisma.service.ts`), and the
Prisma CLI does the same through `scripts/prisma-env.js`. Point these suites
at a real, migrated PostgreSQL 16 the same way CI does, by setting
`POSTGRES_*`, not `DATABASE_URL`:

```bash
NODE_ENV=test \
POSTGRES_HOST=127.0.0.1 \
POSTGRES_PORT=5432 \
POSTGRES_USER=postgres \
POSTGRES_PASSWORD=postgres \
POSTGRES_DB=appdb \
POSTGRES_SSL=false \
JWT_SECRET=test-jwt-secret-not-a-real-secret-000000 \
COOKIE_SECRET=test-cookie-secret \
GOOGLE_CLIENT_ID=x \
GOOGLE_CLIENT_SECRET=y \
INITIAL_ADMIN_EMAIL=admin@example.test \
OTEL_ENABLED=false \
npm run test:db --workspace=api
```

The database must already be migrated (`npm run prisma:migrate:dev
--workspace=api` or `npm run prisma:migrate --workspace=api`, depending on
whether you want a dev-style or deploy-style migration run) before these
suites can pass — several of them assert on indexes and constraints that
only exist once the migration ledger has actually been applied, not merely
on what `schema.prisma` declares.

The backup- and restore-facing suites additionally shell out to the real
`pg_dump`, `pg_restore` and `psql` binaries, so those three must be on
`PATH`. Their major version must be compatible with the server's — see
[`docs/runbooks/postgres-client-version.md`](runbooks/postgres-client-version.md)
for that rule and how to fix a mismatch.

### Rules for a New `.db.spec.ts`

Every existing suite in this tier follows the same four conventions. A new
one must too:

1. **Scope every row behind a distinct type/name prefix, and clean up after
   yourself.** These suites all share one database (locally, `appdb`; in CI,
   the `smoke` job's service container), so nothing may assume it has that
   database to itself. The established pattern is a prefix keyed on the
   suite and the running process id — e.g. `` `test.claim.${process.pid}.` ``
   in `job-claim.db.spec.ts` — used for every job `type`, user `email` or
   node `name` the suite creates, deleted with a `startsWith` filter in
   `afterAll` (and often again in `beforeAll`, to clean up after a prior run
   that crashed before its own `afterAll` ran).

2. **`--runInBand`.** `test:db` always runs these suites serially, on
   purpose — several of them depend on being the only thing touching the
   rows they claim or lock at that instant, which is incompatible with
   Jest's default parallel workers.

3. **A destructive test must run against a throwaway database, never the
   shared database `test:db` itself relies on.** This is not advisory: a
   test that renames, drops, or otherwise mutates the database at the
   cluster level would corrupt every other suite in the same `test:db` run
   if it ran against `appdb`/the CI service database directly.
   `apps/api/test/helpers/scratch-database.helper.ts` exists for exactly
   this — it creates a uniquely-named database, migrates it for real with
   `prisma migrate deploy`, hands back a `PrismaClient`/connection bound to
   it, and drops it afterward. `database-restore-round-trip.db.spec.ts`
   shows the guard this rule earns: `assertNeverTheSharedDatabase` runs
   before anything else in that file and throws loudly if a derived "live"
   database name were ever miscomputed to collide with the real
   `POSTGRES_DB` — turning a bug in the suite into a failed test instead of
   a renamed shared database.

4. **Name it `<subject>.db.spec.ts` and put it where its siblings already
   are** (see the inventory below) so it is picked up by the `test:db`
   `testRegex` and excluded everywhere else automatically — no registration
   step beyond the filename itself.

### Inventory and Time Budget

As of this writing there are **17 suites / 119 tests** in this tier:

| Location | Suites | What the group proves |
|---|---|---|
| `apps/api/test/jobs/` | 6 | The queue's real-Postgres guarantees: the `FOR UPDATE SKIP LOCKED` claim never double-claims, enqueue dedup survives a race on the partial unique index, the lease reaper's three stuck-recovery signals each really match the rows they claim to (including `NULL < threshold` being `NULL`, not `false`), history purge is atomic and its counters conserve across a deliberate mid-transaction failure, insights queries are lock-free and numerically exact across a purge, and the three hand-written partial indexes on `jobs` actually exist after migration. |
| `apps/api/test/nodes/` | 4 | The fleet's real-Postgres guarantees: `worker_nodes`/`node_credentials` constraints and `jobs.claimed_by_node_id`'s `ON DELETE SET NULL` behavior, a node and the in-process worker never claiming the same row, the fleet lifecycle (heartbeat cutoffs, the FK's null-not-cascade behavior, the reaper picking up a job orphaned by a deleted node), and the `example.checksum` job running its entire real path — enqueue, claim, download URL, hash, submit, persist, settle. |
| `apps/api/test/broadcasts/` | 1 | The `NotificationBroadcast` schema's hand-declared indexes and column defaults are actually applied by the migration, not merely declared in `schema.prisma`. |
| `apps/api/src/db-backup/` | 2 | The cluster primitives a restore's swap is built from — `CREATE`/`RENAME`/`DROP DATABASE` from the maintenance connection, a rename onto a taken name failing rather than overwriting, no leaked session, a subselect FK resolving to `NULL` instead of aborting — and that the single-active-backup-run constraint is enforced by a real partial unique index, not by a `findFirst`-then-`create` race in the service. |
| `apps/api/test/integration/` | 4 | See below — the four specs added in Phase 8 of epic #254. |

Measured wall clock for the whole tier, run in isolation: **≈14s before**
Phase 8 added the four `test/integration/*.db.spec.ts` specs below, **≈27–31s
after** (higher under CPU contention). Each of those four files also carries
its own measured per-file estimate in its own header comment — see those
headers rather than this table for a per-file breakdown.

### The `test/integration/*.db.spec.ts` Specs

The four specs in `apps/api/test/integration/` (`queue-fleet-concurrency`,
`node-lease-boundary`, `db-backup-round-trip`, `database-restore-round-trip`)
are Phase 8 of epic #254, added for issue #290. Every other suite in this
tier proves one seam in isolation; these four exist because this epic's most
important remaining risks live precisely at the seams no single earlier
issue owned: two independent executors racing to claim the same row under
real contention rather than a single burst, a lease expiring in the gap
between a node computing a result and submitting it, a real `pg_dump`
process piping its stdout into a storage provider with both the dump's exit
code and the upload awaited, and a database renamed out from under a live
connection pool and then renamed back. None of those is something a mock can
show — each is a property of two real, concurrently-running things (two
Postgres sessions, a subprocess and a stream, a live pool and a `RENAME`)
disagreeing or agreeing about the same object at the same instant. Following
the convention the rest of this tier already uses, each of the four specs'
header comments names the specific epic #254 success criterion it is
evidence for (criteria 2, 3, 7, 8, 9 and 10 across the four files) — continue
that convention in any future spec added here rather than letting the
criterion-to-test mapping live only in the epic's issue thread.

---

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
- [MSW Documentation](https://mswjs.io/docs/)
- [NestJS Testing](https://docs.nestjs.com/fundamentals/testing)
- [Supertest Documentation](https://github.com/visionmedia/supertest)
- [Playwright Documentation](https://playwright.dev/)

## Summary

This project uses industry-standard testing frameworks tailored to each layer:

- **Backend:** Jest + Supertest for comprehensive API testing with real database
- **Frontend:** Vitest + React Testing Library + MSW for fast, user-centric component testing
- **Mocking:** Prisma mocks, OAuth mocks, MSW handlers for realistic test scenarios
- **Helpers:** Shared utilities for user creation, database reset, and test app setup

When writing tests, focus on behavior over implementation, maintain test isolation, and leverage the provided helpers for consistency. Target 70% coverage with emphasis on business logic, auth flows, and RBAC enforcement.
