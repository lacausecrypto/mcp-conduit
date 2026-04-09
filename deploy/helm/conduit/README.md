# conduit Helm Chart

Deploys [MCP Conduit](../../..) on Kubernetes via Helm.

## Quick Start

```bash
# Add the chart (or install from local path)
helm install conduit ./deploy/helm/conduit \
  --set gateway.adminKey=changeme \
  --set servers[0].id=my-server \
  --set servers[0].url=http://my-mcp-server:3001/mcp
```

## Prerequisites

- Kubernetes 1.23+
- Helm 3.10+

## Values Reference

| Key | Default | Description |
|-----|---------|-------------|
| `replicaCount` | `1` | Number of gateway replicas |
| `image.repository` | `conduitgateway/conduit` | Container image |
| `image.tag` | `0.1.0` | Image tag (defaults to Chart.AppVersion) |
| `image.pullPolicy` | `IfNotPresent` | Image pull policy |
| `gateway.port` | `8080` | Gateway HTTP port |
| `gateway.host` | `0.0.0.0` | Gateway bind address |
| `gateway.adminKey` | `""` | Bearer token for admin API (`/conduit/*`) |
| `gateway.existingSecret` | `""` | Use an existing Secret (must have `admin-key`) |
| `auth.method` | `none` | Auth method: `none`, `api_key`, or `jwt` |
| `auth.apiKeys` | `[]` | API keys (stored in Secret, for `api_key` auth) |
| `servers` | `[]` | Backend MCP servers (`id`, `url`, `cacheTtl`) |
| `cache.enabled` | `true` | Enable L1 in-memory cache |
| `cache.l1.maxEntries` | `10000` | Max cache entries |
| `cache.l1.maxEntrySizeKb` | `64` | Max entry size in KB |
| `metrics.enabled` | `true` | Expose Prometheus metrics |
| `metrics.port` | `9090` | Metrics port |
| `redis.enabled` | `false` | Enable Redis-backed rate limiting |
| `redis.url` | `redis://redis:6379` | Redis connection URL |
| `persistence.enabled` | `true` | Enable PVC for SQLite logs |
| `persistence.size` | `1Gi` | PVC size |
| `persistence.storageClass` | `""` | StorageClass (empty = cluster default) |
| `autoscaling.enabled` | `false` | Enable HPA |
| `autoscaling.minReplicas` | `1` | HPA minimum replicas |
| `autoscaling.maxReplicas` | `5` | HPA maximum replicas |
| `autoscaling.targetCPUUtilizationPercentage` | `80` | HPA CPU target |
| `ingress.enabled` | `false` | Create an Ingress resource |
| `serviceMonitor.enabled` | `false` | Create Prometheus ServiceMonitor |

## Examples

### Minimal (no auth)

```bash
helm install conduit ./deploy/helm/conduit \
  --set servers[0].id=salesforce \
  --set servers[0].url=http://salesforce-mcp:3001/mcp
```

### Production with auth and Redis

```bash
helm install conduit ./deploy/helm/conduit \
  --set gateway.adminKey=super-secret-admin-key \
  --set auth.method=api_key \
  --set auth.apiKeys="{agent-key-1,agent-key-2}" \
  --set redis.enabled=true \
  --set redis.url=redis://redis-master:6379 \
  --set servers[0].id=salesforce \
  --set servers[0].url=http://salesforce-mcp:3001/mcp \
  --set servers[1].id=github \
  --set servers[1].url=http://github-mcp:3002/mcp \
  --set autoscaling.enabled=true \
  --set autoscaling.maxReplicas=10
```

### With Ingress

```bash
helm install conduit ./deploy/helm/conduit \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set "ingress.hosts[0].host=conduit.example.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix"
```

## Hot-Reload Config

After updating `servers`, `auth`, `cache`, or `observability` values, you can
reload without restarting:

```bash
# 1. Upgrade the Helm release (updates the ConfigMap)
helm upgrade conduit ./deploy/helm/conduit --reuse-values \
  --set observability.logArgs=false

# 2a. Send SIGHUP to the running process
kubectl exec deployment/conduit-conduit -- kill -HUP 1

# 2b. Or call the admin API
kubectl port-forward svc/conduit-conduit 8080:8080 &
curl -X POST http://localhost:8080/conduit/config/reload
```

**Note:** Changes to `gateway.port`, `gateway.host`, TLS, or server URLs
require a full pod restart (`kubectl rollout restart deployment/...`).

## Upgrading

```bash
helm upgrade conduit ./deploy/helm/conduit --reuse-values
```

## Uninstalling

```bash
helm uninstall conduit
# PVC is NOT deleted automatically — delete it manually if needed:
kubectl delete pvc conduit-conduit
```
