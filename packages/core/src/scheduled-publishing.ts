import type { ContentService } from './content.js';
import type { HookRegistry } from './hooks.js';
import type { JobQueue } from './jobs.js';
import { silentLogger, type Logger } from './logger.js';

/** Job type that publishes one scheduled item. */
export const PUBLISH_JOB_TYPE = 'content:publish';

interface PublishPayload {
  contentId: number;
  /** ISO time the item was scheduled for when the job was created. */
  publishAt: string;
}

export interface ScheduledPublisherOptions {
  content: ContentService;
  jobs: JobQueue;
  hooks: HookRegistry;
  logger?: Logger;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

function isPayload(value: unknown): value is PublishPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.contentId === 'number' && typeof p.publishAt === 'string';
}

/**
 * Publishes `scheduled` content when its time comes: every save of a scheduled item queues a
 * `content:publish` job for its publish time, and the job moves the item to `published`.
 * Rescheduling, un-scheduling or deleting an item just turns its old job into a no-op.
 */
export class ScheduledPublisher {
  readonly #content: ContentService;
  readonly #jobs: JobQueue;
  readonly #hooks: HookRegistry;
  readonly #logger: Logger;
  readonly #now: () => Date;
  #detach: (() => void)[] = [];

  constructor(options: ScheduledPublisherOptions) {
    this.#content = options.content;
    this.#jobs = options.jobs;
    this.#hooks = options.hooks;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? (() => new Date());
  }

  /** Register the job handler and start listening for scheduled saves. Safe to call twice. */
  attach(): void {
    if (this.#detach.length > 0) return;
    this.#detach.push(
      this.#jobs.registerJob<unknown>(
        {
          type: PUBLISH_JOB_TYPE,
          maxAttempts: 8,
          handler: async (payload) => {
            if (!isPayload(payload)) return; // nothing sensible to do with a malformed job
            await this.#publish(payload);
          },
        },
        'core:scheduled-publishing',
      ),
    );
    this.#detach.push(
      this.#hooks.addAction(
        'post:saved',
        async (item, info) => {
          if (item.status !== 'scheduled' || !item.publishedAt) return;
          const before = info.previous;
          if (
            before?.status === 'scheduled' &&
            before.publishedAt?.getTime() === item.publishedAt.getTime()
          ) {
            return; // same time as before: its job already exists
          }
          await this.#schedule(item.id, item.publishedAt);
        },
        { source: 'core:scheduled-publishing' },
      ),
    );
  }

  detach(): void {
    for (const off of this.#detach.splice(0)) off();
  }

  /**
   * Queue publish jobs for scheduled items that are already due, e.g. after downtime that lost
   * jobs. Returns how many were queued. Jobs are idempotent, so extra ones are harmless.
   */
  async sweep(): Promise<number> {
    const now = this.#now().getTime();
    const pageSize = 100;
    let queued = 0;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.#content.list({
        status: 'scheduled',
        limit: pageSize,
        offset,
      });
      for (const item of page) {
        if (item.publishedAt && item.publishedAt.getTime() <= now) {
          await this.#schedule(item.id, item.publishedAt);
          queued++;
        }
      }
      if (page.length < pageSize) break;
    }
    return queued;
  }

  async #schedule(contentId: number, publishAt: Date): Promise<void> {
    const payload: PublishPayload = { contentId, publishAt: publishAt.toISOString() };
    try {
      await this.#jobs.enqueue(PUBLISH_JOB_TYPE, payload, { runAt: publishAt });
    } catch (error) {
      // The save already succeeded; sweep() picks the item up later.
      this.#logger.error('Could not queue scheduled publish', {
        contentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #publish(payload: PublishPayload): Promise<void> {
    const item = await this.#content.get(payload.contentId);
    if (!item || item.status !== 'scheduled' || !item.publishedAt) return;
    // Rescheduled for later: a newer job will handle it.
    if (item.publishedAt.getTime() > this.#now().getTime()) return;
    await this.#content.update(item.id, { status: 'published' });
  }
}

export function createScheduledPublisher(options: ScheduledPublisherOptions): ScheduledPublisher {
  return new ScheduledPublisher(options);
}
