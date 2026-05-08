import { type Conversation } from '@shared/conversations';

export interface ConversationProvider {
  startSession(
    conversation: Conversation,
    initialSize?: { cols: number; rows: number },
    isResuming?: boolean,
    initialPrompt?: string
  ): Promise<void>;
  stopSession(conversationId: string): Promise<void>;
  /**
   * Re-spawn any tracked conversation whose PTY is no longer running.
   * Idempotent — conversations that already have a live session are skipped.
   * Used to recover from initial-hydrate failures (e.g. SSH MaxSessions
   * saturation) and from SSH reconnects.
   */
  rehydrate(): Promise<void>;
  destroyAll(): Promise<void>;
  detachAll(): Promise<void>;
}

export type ConversationConfig = {
  autoApprove?: boolean;
};
