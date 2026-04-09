/**
 * Envoi de webhooks pour les alertes guardrails.
 *
 * Les webhooks sont fire-and-forget : ils ne bloquent jamais
 * le traitement de la requête et les erreurs sont loggées sans être propagées.
 */

/** Payload envoyé au webhook */
export interface WebhookPayload {
  event: 'guardrail_alert' | 'guardrail_block';
  rule_name: string;
  severity: string;
  client_id: string;
  server_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  message: string;
  timestamp: string;
  trace_id: string;
}

/**
 * Envoie un webhook de notification (fire-and-forget).
 * Les erreurs sont loggées mais jamais propagées — l'enforcement
 * des guardrails ne doit pas dépendre de la livraison du webhook.
 */
export function sendWebhook(url: string, payload: WebhookPayload): void {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    // Fire-and-forget : on ne propage pas l'erreur
  });
}
