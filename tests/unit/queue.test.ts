/**
 * Tests unitaires pour RequestQueue.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RequestQueue } from '../../src/rate-limit/queue.js';
import { SlidingWindowLimiter } from '../../src/rate-limit/limiter.js';

const DEFAULT_CONFIG = { enabled: true, max_wait_ms: 500, max_queue_size: 10 };

describe('RequestQueue', () => {
  let limiter: SlidingWindowLimiter;
  let queue: RequestQueue;

  beforeEach(() => {
    limiter = new SlidingWindowLimiter();
    queue = new RequestQueue(DEFAULT_CONFIG);
    vi.useFakeTimers();
  });

  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
  });

  it('résout immédiatement si la capacité est disponible', async () => {
    vi.useRealTimers();
    const q = new RequestQueue(DEFAULT_CONFIG);
    const newLimiter = new SlidingWindowLimiter();

    const promise = q.enqueue('key', 5, 60_000, newLimiter);
    await expect(promise).resolves.toBeUndefined();
    q.stop();
  });

  it('rejette immédiatement si la file est désactivée', async () => {
    vi.useRealTimers();
    const q = new RequestQueue({ enabled: false, max_wait_ms: 1000, max_queue_size: 10 });
    await expect(q.enqueue('key', 5, 60_000, limiter)).rejects.toThrow();
    q.stop();
  });

  it('rejette immédiatement si la file est pleine', async () => {
    vi.useRealTimers();
    const smallQueue = new RequestQueue({ enabled: true, max_wait_ms: 5000, max_queue_size: 2 });
    const blockingLimiter = new SlidingWindowLimiter();
    blockingLimiter.consume('key', 0, 60_000); // toujours bloqué (limite 0)

    // Remplir la file
    const p1 = smallQueue.enqueue('key', 0, 60_000, blockingLimiter).catch(() => {});
    const p2 = smallQueue.enqueue('key', 0, 60_000, blockingLimiter).catch(() => {});

    // La 3e entrée doit être rejetée immédiatement
    await expect(smallQueue.enqueue('key', 0, 60_000, blockingLimiter)).rejects.toThrow('pleine');

    smallQueue.stop();
    await Promise.all([p1, p2]);
  });

  it('résout quand la capacité se libère', async () => {
    vi.useRealTimers();
    const WINDOW = 200;
    const newLimiter = new SlidingWindowLimiter();
    const q = new RequestQueue({ enabled: true, max_wait_ms: 2000, max_queue_size: 10 });

    // Consommer la capacité
    newLimiter.consume('key', 1, WINDOW);

    // Mettre en file d'attente
    const promise = q.enqueue('key', 1, WINDOW, newLimiter);

    // Attendre que la fenêtre glisse
    await new Promise((r) => setTimeout(r, WINDOW + 150));

    await expect(promise).resolves.toBeUndefined();
    q.stop();
  });

  it('timeout si la capacité ne se libère pas à temps', async () => {
    vi.useRealTimers();
    const newLimiter = new SlidingWindowLimiter();
    const q = new RequestQueue({ enabled: true, max_wait_ms: 100, max_queue_size: 10 });

    // Bloquer totalement (limite = 0 tokens) pour 60 secondes
    // Simuler en consommant dans une grande fenêtre
    for (let i = 0; i < 100; i++) {
      newLimiter.consume('key', 100, 60_000);
    }

    await expect(q.enqueue('key', 1, 60_000, newLimiter)).rejects.toThrow('Timeout');
    q.stop();
  });
});
