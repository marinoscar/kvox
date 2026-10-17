import { AskUserDataService } from '../src/ask/index.js';
import { createInMemoryAskDb } from '../src/ask/testing/index.js';

// =============================================================================
// AskUserDataService (issue #497, epic #491): the account-data deletion removes the asker's
// conversations and, with them, their messages, and nobody else's.
// =============================================================================

describe('AskUserDataService.deleteAll', () => {
  it('deletes only the account\'s conversations, cascading their messages, and counts both', async () => {
    const mem = createInMemoryAskDb();
    const mine = mem.addConversation({ ownerId: 'user-a' });
    const theirs = mem.addConversation({ ownerId: 'user-b' });
    mem.addMessage({ conversationId: mine.id, role: 'user', content: 'q' });
    mem.addMessage({ conversationId: mine.id, role: 'assistant', content: 'a' });
    mem.addMessage({ conversationId: theirs.id, role: 'user', content: 'q' });

    const service = new AskUserDataService(mem.db);

    await expect(service.deleteAll('user-a')).resolves.toEqual({ conversations: 1, messages: 2 });
    expect([...mem.conversations.keys()]).toEqual([theirs.id]);
    expect(mem.messages.size).toBe(1);
    // Idempotent.
    await expect(service.deleteAll('user-a')).resolves.toEqual({ conversations: 0, messages: 0 });
  });
});
