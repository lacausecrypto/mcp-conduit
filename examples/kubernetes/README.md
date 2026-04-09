# Kubernetes Example

Plain Kubernetes manifests for deploying Conduit in a cluster.
For a more production-ready deployment use the [Helm chart](../../deploy/helm/conduit/).

## Files

| File | Description |
|------|-------------|
| `namespace.yaml` | Dedicated `conduit` namespace |
| `gateway-configmap.yaml` | Gateway config mounted as a volume |
| `gateway-deployment.yaml` | Deployment + ServiceAccount + PVC |
| `gateway-service.yaml` | ClusterIP Service + admin Secret |
| `redis-deployment.yaml` | Optional Redis for distributed rate limiting |

## Quick Start

```bash
# 1. Create namespace
kubectl apply -f namespace.yaml

# 2. Create the admin key secret (change the value!)
kubectl create secret generic conduit-secrets \
  --namespace conduit \
  --from-literal=admin-key=your-admin-key-here

# 3. Deploy gateway
kubectl apply -f gateway-configmap.yaml
kubectl apply -f gateway-deployment.yaml
kubectl apply -f gateway-service.yaml

# 4. (Optional) Deploy Redis for distributed rate limiting
kubectl apply -f redis-deployment.yaml
# Then update gateway-configmap.yaml to add:
#   rate_limits:
#     enabled: true
#     backend: redis
#     redis_url: "redis://redis.conduit.svc.cluster.local:6379"
# And apply + hot-reload or rollout restart.
```

## Accessing the gateway

```bash
# Port-forward locally
kubectl port-forward -n conduit svc/conduit 8080:8080

# Health check
curl http://localhost:8080/conduit/health

# Stats
curl -H "Authorization: Bearer your-admin-key-here" http://localhost:8080/conduit/stats
```

## Hot-reload after ConfigMap change

```bash
# Update the ConfigMap
kubectl edit configmap conduit-config -n conduit

# Send SIGHUP to the running process (no restart needed for ACL/TTL/observability changes)
kubectl exec -n conduit deployment/conduit -- kill -HUP 1

# Or via admin API
kubectl port-forward -n conduit svc/conduit 8080:8080 &
curl -X POST -H "Authorization: Bearer your-admin-key-here" \
  http://localhost:8080/conduit/config/reload
```

**Note:** Changes to `gateway.port`, TLS, or server URLs require a rollout restart:
```bash
kubectl rollout restart deployment/conduit -n conduit
```

## Security Notes

- The Secret in `gateway-service.yaml` uses `stringData` for readability — change the value before applying.
- For production, prefer `kubectl create secret` or a secrets manager (Vault, AWS Secrets Manager, etc.).
- The gateway runs as UID 1001 (non-root) with a read-only root filesystem.
